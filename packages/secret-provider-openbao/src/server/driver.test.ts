// @effect-diagnostics nodeBuiltinImport:off -- the tests lay out token files on disk.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readError, readValue } from "@t3tools/secret-provider-core/server/driver";

import {
  baoModel,
  eventually,
  type Reply,
  type SeenRequest,
  startFakeOpenBao,
  TEST_TLS,
} from "../../test/fakeOpenBao.ts";
import { FILE_ROOTS_ENV } from "./fileRoots.ts";
import { driver } from "./driver.ts";

const fileRoot = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bao-")));
const tokenFile = NodePath.join(fileRoot, "token");
NodeFS.writeFileSync(tokenFile, "jwt-from-file\n");
const outsideFile = NodePath.join(
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-out-"))),
  "secret",
);
NodeFS.writeFileSync(outsideFile, "not-for-openbao");

const logged: Array<string> = [];
const layer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeCrypto.layer,
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("OpenBao never spawns")),
  ),
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [FILE_ROOTS_ENV]: fileRoot } })),
  Logger.layer(
    [
      Logger.make(({ message, cause }) => {
        logged.push(JSON.stringify(message) + Cause.pretty(cause));
      }),
    ],
    { mergeWithExisting: false },
  ),
);

const MOUNTS = [
  { path: "kv", version: 2 },
  { path: "legacy", version: 1 },
];
const approle = (address: string, extra: Record<string, unknown> = {}) => ({
  address,
  mounts: MOUNTS,
  authMethod: "approle",
  roleId: "r-1",
  secretId: "s-1",
  ...extra,
});

const KV2 = {
  "kv/data/acme/app": [
    { token: "v1-token" },
    { token: "v2-token", user: "svc", port: 5432, on: true, nested: { a: 1 } },
  ],
  "kv/data/acme/other": [{ key: "other-key" }],
};
const KV1 = { "legacy/db": { password: "legacy-pass" } };

const reads = (seen: ReadonlyArray<SeenRequest>) =>
  seen.filter((request) => request.method === "GET" && !request.url.startsWith("/v1/auth/"));
const logins = (seen: ReadonlyArray<SeenRequest>) =>
  seen.filter((request) => /^\/v1\/auth\/.+\/login$/.test(request.url));

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(layer));

describe("OpenBao driver", () => {
  it.effect("signs in with AppRole once, then reads KV v2, KV v1, and a pinned version", () =>
    run(
      Effect.gen(function* () {
        const bao = baoModel({ kv2: KV2, kv1: KV1 });
        const fake = yield* startFakeOpenBao(bao.route);
        const config = approle(fake.address, { namespace: "team-a" });
        const first = yield* driver.read(config, [
          "kv/acme/app#token",
          "kv/acme/app?version=1#token",
          "legacy/db#password",
        ]);
        assert.deepStrictEqual(first, [
          { _tag: "value", value: "v2-token", version: "2" },
          { _tag: "value", value: "v1-token", version: "1" },
          readValue("legacy-pass"),
        ]);
        const second = yield* driver.read(config, ["kv/acme/other#key"]);
        assert.deepStrictEqual(second, [{ _tag: "value", value: "other-key", version: "1" }]);
        const signIns = logins(fake.seen);
        assert.strictEqual(signIns.length, 1);
        assert.strictEqual(signIns[0]!.url, "/v1/auth/approle/login");
        assert.deepStrictEqual(signIns[0]!.body, { role_id: "r-1", secret_id: "s-1" });
        for (const request of reads(fake.seen)) {
          assert.strictEqual(request.headers["x-vault-token"], "hvs.test-token-1");
          assert.strictEqual(request.headers["x-vault-namespace"], "team-a");
        }
        assert.deepStrictEqual(
          reads(fake.seen).map((request) => request.url),
          [
            "/v1/kv/data/acme/app",
            "/v1/kv/data/acme/app?version=1",
            "/v1/legacy/db",
            "/v1/kv/data/acme/other",
          ],
        );
      }),
    ),
  );

  it.effect("shares one sign-in among reads that need it at the same time", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2 }).route);
        const config = approle(fake.address, { roleId: "r-shared" });
        const results = yield* Effect.all(
          [1, 2, 3].map(() => driver.read(config, ["kv/acme/other#key"])),
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(results.flat(), [
          { _tag: "value", value: "other-key", version: "1" },
          { _tag: "value", value: "other-key", version: "1" },
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.strictEqual(logins(fake.seen).length, 1);
      }),
    ),
  );

  it.effect("reads each path once per batch and gives every field its own outcome", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2 }).route);
        const results = yield* driver.read(approle(fake.address), [
          "kv/acme/app#user",
          "kv/acme/app#port",
          "kv/acme/app#on",
          "kv/acme/app#nested",
          "kv/acme/app#missing",
          "kv/acme/gone#token",
          "elsewhere/app#token",
          "legacy/db?version=2#password",
        ]);
        assert.deepStrictEqual(results, [
          { _tag: "value", value: "svc", version: "2" },
          { _tag: "value", value: "5432", version: "2" },
          { _tag: "value", value: "true", version: "2" },
          readError("not-found"),
          readError("not-found"),
          readError("not-found"),
          readError("invalid"),
          readError("invalid"),
        ]);
        assert.deepStrictEqual(
          reads(fake.seen).map((request) => request.url),
          ["/v1/kv/data/acme/app", "/v1/kv/data/acme/gone"],
        );
      }),
    ),
  );

  it.effect("signs in to Kubernetes and JWT with the token file under the operator's roots", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2 }).route);
        const base = { address: fake.address, mounts: MOUNTS };
        yield* driver.read(
          { ...base, authMethod: "kubernetes", authRole: "t3-hub", authMount: "k8s", tokenFile },
          ["kv/acme/other#key"],
        );
        yield* driver.read({ ...base, authMethod: "jwt", authRole: "ci", tokenFile }, [
          "kv/acme/other#key",
        ]);
        assert.deepStrictEqual(
          logins(fake.seen).map((request) => [request.url, request.body]),
          [
            ["/v1/auth/k8s/login", { role: "t3-hub", jwt: "jwt-from-file" }],
            ["/v1/auth/jwt/login", { role: "ci", jwt: "jwt-from-file" }],
          ],
        );
      }),
    ),
  );

  it.effect(
    "never reads a token file outside the roots: the read is invalid, nothing is sent",
    () =>
      run(
        Effect.gen(function* () {
          const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2 }).route);
          const config = {
            address: fake.address,
            mounts: MOUNTS,
            authMethod: "jwt",
            authRole: "ci",
            tokenFile: outsideFile,
          };
          assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
            readError("invalid"),
          ]);
          assert.deepStrictEqual(yield* driver.test(config), { ok: false, error: "invalid" });
          assert.deepStrictEqual(fake.seen, []);
          assert.match((yield* driver.configProblem!(config)) ?? "", new RegExp(FILE_ROOTS_ENV));
          assert.strictEqual(yield* driver.configProblem!({ ...config, tokenFile }), undefined);
        }),
      ),
  );

  it.effect("uses a token as given, after looking it up", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(
          baoModel({ kv2: KV2, staticTokens: ["hvs.static"] }).route,
        );
        const config = {
          address: fake.address,
          mounts: MOUNTS,
          authMethod: "token",
          token: "hvs.static",
        };
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.deepStrictEqual(yield* driver.test(config), { ok: true });
        assert.deepStrictEqual(
          yield* driver.read({ ...config, token: "hvs.wrong" }, ["kv/acme/other#key"]),
          [readError("forbidden")],
        );
        assert.deepStrictEqual(
          yield* driver.read({ ...config, token: "" }, ["kv/acme/other#key"]),
          [readError("invalid")],
        );
      }),
    ),
  );

  it.effect("signs in with a client certificate over mutual TLS, trusting the given CA", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(
          baoModel({
            kv2: KV2,
            acceptLogin: (mount, _body, clientName) =>
              mount === "cert" && clientName === "t3-hub-test-client",
          }).route,
          "mutual",
        );
        const config = {
          address: fake.address.replace("127.0.0.1", "localhost"),
          mounts: MOUNTS,
          authMethod: "cert",
          authRole: "hub",
          caCert: TEST_TLS.ca,
          clientCert: TEST_TLS.clientCert,
          clientKey: TEST_TLS.clientKey,
        };
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.deepStrictEqual(logins(fake.seen)[0]!.body, { name: "hub" });
      }),
    ),
  );

  it.effect("trusts a server only through the system CAs or the one configured", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2 }).route, "server");
        const config = approle(fake.address);
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          readError("unavailable"),
        ]);
        assert.deepStrictEqual(
          yield* driver.read({ ...config, caCert: TEST_TLS.otherCa }, ["kv/acme/other#key"]),
          [readError("unavailable")],
        );
        assert.deepStrictEqual(fake.seen, []);
        assert.deepStrictEqual(
          yield* driver.read({ ...config, caCert: TEST_TLS.ca }, ["kv/acme/other#key"]),
          [{ _tag: "value", value: "other-key", version: "1" }],
        );
      }),
    ),
  );

  it.effect("renews at two thirds of the lease in the background, reads go on meanwhile", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(baoModel({ kv2: KV2, leaseSeconds: 300 }).route);
        const config = approle(fake.address);
        yield* driver.read(config, ["kv/acme/other#key"]);
        yield* TestClock.adjust("199 seconds");
        yield* driver.read(config, ["kv/acme/other#key"]);
        assert.isFalse(fake.seen.some((request) => request.url === "/v1/auth/token/renew-self"));
        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.isTrue(
          yield* eventually(() =>
            fake.seen.some((request) => request.url === "/v1/auth/token/renew-self"),
          ),
        );
        // Renewed: past the first lease's end, no new login is needed.
        yield* TestClock.adjust("200 seconds");
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.strictEqual(logins(fake.seen).length, 1);
      }),
    ),
  );

  it.effect("signs in again once a token that cannot be renewed has expired", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(
          baoModel({ kv2: KV2, leaseSeconds: 60, renewable: false }).route,
        );
        const config = approle(fake.address, { roleId: "r-expiry" });
        yield* driver.read(config, ["kv/acme/other#key"]);
        yield* TestClock.adjust("61 seconds");
        assert.deepStrictEqual(yield* driver.read(config, ["kv/acme/other#key"]), [
          { _tag: "value", value: "other-key", version: "1" },
        ]);
        assert.isTrue(yield* eventually(() => logins(fake.seen).length === 2));
        assert.isFalse(fake.seen.some((request) => request.url === "/v1/auth/token/renew-self"));
      }),
    ),
  );

  it.effect("a lost token: one new sign-in and one retry, then the value", () =>
    run(
      Effect.gen(function* () {
        const bao = baoModel({ kv2: KV2 });
        const fake = yield* startFakeOpenBao(bao.route);
        const config = approle(fake.address, { roleId: "r-lost" });
        yield* driver.read(config, ["kv/acme/other#key"]);
        bao.revokeAll();
        assert.deepStrictEqual(
          yield* driver.read(config, ["kv/acme/other#key", "kv/acme/app#user"]),
          [
            { _tag: "value", value: "other-key", version: "1" },
            { _tag: "value", value: "svc", version: "2" },
          ],
        );
        assert.strictEqual(logins(fake.seen).length, 2);
      }),
    ),
  );

  it.effect(
    "a 403 that stays: at most one new sign-in and one retry per read, then forbidden",
    () =>
      run(
        Effect.gen(function* () {
          const bao = baoModel({ kv2: KV2 });
          const fake = yield* startFakeOpenBao((request) =>
            request.method === "GET" ? { status: 403 } : bao.route(request),
          );
          const config = approle(fake.address, { roleId: "r-denied" });
          assert.deepStrictEqual(
            yield* driver.read(config, ["kv/acme/other#key", "kv/acme/app#user"]),
            [readError("forbidden"), readError("forbidden")],
          );
          assert.strictEqual(logins(fake.seen).length, 2);
          assert.strictEqual(reads(fake.seen).length, 4);
        }),
      ),
  );

  it.effect("classifies by status alone", () =>
    run(
      Effect.gen(function* () {
        const statuses: Record<string, number> = { a: 404, b: 400, c: 429, d: 503, e: 500 };
        const bao = baoModel();
        const fake = yield* startFakeOpenBao((request) => {
          const name = /\/v1\/kv\/data\/(\w)$/.exec(request.url)?.[1];
          return name === undefined ? bao.route(request) : { status: statuses[name]! };
        });
        assert.deepStrictEqual(
          yield* driver.read(approle(fake.address), [
            "kv/a#f",
            "kv/b#f",
            "kv/c#f",
            "kv/d#f",
            "kv/e#f",
          ]),
          [
            readError("not-found"),
            readError("invalid"),
            readError("unavailable"),
            readError("unavailable"),
            readError("unavailable"),
          ],
        );
      }),
    ),
  );

  it.effect("follows a redirect to the same origin once, never one to another host", () =>
    run(
      Effect.gen(function* () {
        const elsewhere = yield* startFakeOpenBao(() => ({ status: 200, json: {} }));
        const bao = baoModel({ kv2: KV2 });
        const fake = yield* startFakeOpenBao((request) => {
          if (request.url === "/v1/kv/data/moved/here") {
            return { status: 307, location: "/v1/kv/data/acme/other" };
          }
          if (request.url === "/v1/kv/data/moved/away") {
            return { status: 307, location: `${elsewhere.address}/v1/kv/data/acme/other` };
          }
          return bao.route(request);
        });
        assert.deepStrictEqual(
          yield* driver.read(approle(fake.address), ["kv/moved/here#key", "kv/moved/away#key"]),
          [{ _tag: "value", value: "other-key", version: "1" }, readError("unavailable")],
        );
        assert.deepStrictEqual(elsewhere.seen, []);
      }),
    ),
  );

  it.effect("no token, secret, or response body reaches a result or a log", () =>
    run(
      Effect.gen(function* () {
        logged.length = 0;
        let loginAnswer: Reply = { status: 400, text: "bad secret_id s3cr3t-login-body" };
        const fake = yield* startFakeOpenBao((request) => {
          if (request.url.endsWith("/login")) return loginAnswer;
          return { status: 500, text: "boom: s3cr3t-in-body hvs.LEAK-LOGIN" };
        });
        const config = approle(fake.address, { roleId: "r-leak", secretId: "s3cr3t-secret-id" });
        const refused = yield* driver.read(config, ["kv/acme/app#token"]);
        loginAnswer = {
          status: 200,
          json: { auth: { client_token: "hvs.LEAK-LOGIN", lease_duration: 600, renewable: true } },
        };
        const failed = yield* driver.read(config, ["kv/acme/app#token"]);
        loginAnswer = {
          status: 200,
          json: { auth: { client_token: "hvs.LEAK-LOGIN", lease_duration: "x" } },
        };
        const malformed = yield* driver.read(approle(fake.address, { roleId: "r-leak-2" }), [
          "kv/acme/app#token",
        ]);
        const tested = yield* driver.test(config);
        const visible = JSON.stringify([refused, failed, malformed, tested]) + logged.join("\n");
        assert.isAbove(logged.length, 0);
        for (const secret of [
          "s3cr3t-login-body",
          "s3cr3t-in-body",
          "hvs.LEAK-LOGIN",
          "s3cr3t-secret-id",
        ]) {
          assert.notInclude(visible, secret);
        }
        assert.deepStrictEqual(refused, [readError("invalid")]);
        assert.deepStrictEqual(failed, [readError("unavailable")]);
        assert.deepStrictEqual(malformed, [readError("unavailable")]);
      }),
    ),
  );

  it.effect("test: a fresh sign-in, then the token's own lookup", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* startFakeOpenBao(
          baoModel({
            acceptLogin: (_mount, body) => (body as { secret_id: string }).secret_id === "s-1",
          }).route,
        );
        assert.deepStrictEqual(yield* driver.test(approle(fake.address)), { ok: true });
        assert.isTrue(fake.seen.some((request) => request.url === "/v1/auth/token/lookup-self"));
        assert.deepStrictEqual(yield* driver.test(approle(fake.address, { secretId: "wrong" })), {
          ok: false,
          error: "invalid",
        });
      }),
    ),
  );
});
