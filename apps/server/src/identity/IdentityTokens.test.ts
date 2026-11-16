// @effect-diagnostics globalDate:off globalDateInEffect:off -- a verifier's clock for jose.
/**
 * Workload identity tokens (Vaults ticket 07): a standard verifier (`jose`) checks them against
 * the JWKS the Hub publishes; keys rotate with an overlap; nothing private is ever published, and
 * the token itself never reaches a log or an audit row.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Jose from "jose";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as IdentityIssuer from "./IdentityIssuer.ts";
import * as IdentityKeys from "./IdentityKeys.ts";
import * as IdentityTokens from "./IdentityTokens.ts";

const ISSUER = "https://hub.example.com";
const INSTALLATION = EnvironmentId.make("environment:installation-1");
const AT = "2026-11-17T00:00:00.000Z";
const DAY = 24 * 60 * 60;

const audits: Array<AuditLog.AuditRecord> = [];
const logged: Array<string> = [];
const sealed = new Map<string, Uint8Array>();

const layerFor = (issuer: string | undefined) =>
  Layer.effect(IdentityTokens.IdentityTokens, IdentityTokens.make).pipe(
    Layer.provideMerge(Layer.effect(IdentityKeys.IdentityKeys, IdentityKeys.make)),
    Layer.provideMerge(
      Layer.succeed(
        IdentityIssuer.IdentityIssuer,
        IdentityIssuer.make({
          configured: issuer,
          publicUrl: new URL("https://hub.example.com"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(sealed.get(name))),
        set: (name, value) => Effect.sync(() => void sealed.set(name, value)),
        remove: (name) => Effect.sync(() => void sealed.delete(name)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(AuditLog.AuditLog)({
        record: (entry) => Effect.sync(() => void audits.push(entry)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(INSTALLATION),
      }),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(
      Logger.layer(
        [
          Logger.make(({ message, cause }) => {
            logged.push(JSON.stringify(message) + Cause.pretty(cause));
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );

const USER = UserId.make("user-ada");
const SPACE = SpaceId.make("space-acme");
const THREAD = ThreadId.make("thread-1");

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`
    INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
    VALUES (${USER}, 'Ada', 'ada', 0, ${AT})
  `;
  yield* sql`
    INSERT INTO spaces (space_id, kind, name, created_at)
    VALUES (${SPACE}, 'organization', 'Acme', ${AT})
  `;
  yield* sql`
    INSERT INTO space_memberships (space_id, user_id, role, created_at)
    VALUES (${SPACE}, ${USER}, 'member', ${AT})
  `;
});

const facts = {
  threadId: THREAD,
  userId: USER,
  spaceId: SPACE,
  environmentId: HUB_MACHINE_ENVIRONMENT_ID,
};

const reset = Effect.sync(() => {
  audits.length = 0;
  logged.length = 0;
  sealed.clear();
});

/** The JWKS as the route serves it: its raw JSON, read back as a verifier would. */
const servedJwks = Effect.gen(function* () {
  const keys = yield* IdentityKeys.IdentityKeys;
  const raw = JSON.stringify({ keys: yield* keys.published });
  return { raw, set: Jose.createLocalJWKSet(JSON.parse(raw) as Jose.JSONWebKeySet) };
});

const verify = (
  token: string,
  jwks: Jose.JWTVerifyGetKey,
  options: { readonly audience?: string; readonly at?: number } = {},
) =>
  Effect.promise(() =>
    Jose.jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: options.audience ?? "kubernetes",
      algorithms: ["ES256"],
      ...(options.at === undefined ? {} : { currentDate: new Date(options.at * 1000) }),
    }).then(
      (result) => ({ ok: true as const, payload: result.payload }),
      (error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code ?? "?" }),
    ),
  );

describe("IdentityTokens", () => {
  it.effect("a standard verifier accepts the token against the served JWKS, and nothing else", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      yield* TestClock.setTime(Date.parse(AT));
      const tokens = yield* IdentityTokens.IdentityTokens;
      const issued = yield* tokens.forThread({
        facts,
        entryId: "entry-kube",
        audience: "kubernetes",
        ttlSeconds: 600,
      });
      const { set } = yield* servedJwks;
      // The verifier's clock: the Hub's at issue (tests run on a fixed epoch).
      const iat = Math.floor(issued.issuedAt / 1000);
      const accepted = yield* verify(issued.token, set, { at: iat });
      assert.isTrue(accepted.ok);
      // Wrong audience, after `exp`, before `nbf`: refused.
      assert.deepInclude(yield* verify(issued.token, set, { audience: "vault", at: iat }), {
        ok: false,
      });
      assert.deepInclude(yield* verify(issued.token, set, { at: iat + 601 }), {
        ok: false,
        code: "ERR_JWT_EXPIRED",
      });
      assert.deepInclude(yield* verify(issued.token, set, { at: iat - 61 }), {
        ok: false,
        code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      });
      // A verifier whose clock is 45 s behind still accepts (nbf is 60 s before iat).
      assert.isTrue((yield* verify(issued.token, set, { at: iat - 45 })).ok);
      // An unknown `kid`: another Hub's JWKS does not verify it.
      const other = yield* Effect.promise(() => Jose.generateKeyPair("ES256"));
      const otherJwk = yield* Effect.promise(() => Jose.exportJWK(other.publicKey));
      const foreign = Jose.createLocalJWKSet({
        keys: [{ ...otherJwk, kid: "other", alg: "ES256" }],
      });
      assert.deepInclude(yield* verify(issued.token, foreign, { at: iat }), {
        ok: false,
        code: "ERR_JWKS_NO_MATCHING_KEY",
      });
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("claims come from the rows: the User, the Space, the Thread; never a Vault", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      yield* TestClock.setTime(Date.parse(AT));
      const tokens = yield* IdentityTokens.IdentityTokens;
      const issued = yield* tokens.forThread({
        facts,
        entryId: "entry-kube",
        audience: "kubernetes",
        ttlSeconds: 600,
      });
      const payload = Jose.decodeJwt(issued.token);
      assert.deepInclude(payload, {
        iss: ISSUER,
        aud: "kubernetes",
        sub: `t3:space:${SPACE}:project:-:user:ada`,
        username: "ada",
        groups: [`t3:space:${SPACE}`],
        installation: INSTALLATION,
        user_id: USER,
        space_id: SPACE,
        space_name: "Acme",
        organization: SPACE,
        project_id: null,
        thread_id: THREAD,
        root_thread_id: THREAD,
        environment_id: HUB_MACHINE_ENVIRONMENT_ID,
        environment_kind: "hub",
        role: "member",
      });
      assert.strictEqual(payload.exp! - payload.iat!, 600);
      assert.notMatch(JSON.stringify(payload), /vault/iu);
      // One audience, a string: never a list a token could be replayed against.
      assert.isString(payload.aud);
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("reuses a token while a third of its life is left, then issues a new one", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      yield* TestClock.setTime(Date.parse(AT));
      const tokens = yield* IdentityTokens.IdentityTokens;
      const input = { facts, entryId: "entry-kube", audience: "kubernetes", ttlSeconds: 600 };
      const first = yield* tokens.forThread(input);
      yield* TestClock.adjust("399 seconds");
      assert.strictEqual((yield* tokens.forThread(input)).jti, first.jti);
      yield* TestClock.adjust("2 seconds");
      assert.notStrictEqual((yield* tokens.forThread(input)).jti, first.jti);
      // Another audience is another token.
      const vault = yield* tokens.forThread({ ...input, entryId: "entry-bao", audience: "vault" });
      assert.notStrictEqual(vault.jti, first.jti);
      assert.lengthOf(
        audits.filter((entry) => entry.action === "identity.issue"),
        3,
      );
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("keys rotate with an overlap: the next is published before it signs", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      yield* TestClock.setTime(Date.parse(AT));
      const start = Math.floor(Date.parse(AT) / 1000);
      const tokens = yield* IdentityTokens.IdentityTokens;
      const keys = yield* IdentityKeys.IdentityKeys;
      const hub = { audience: "vault", scopeId: null };
      const old = yield* tokens.forHub(hub);
      const oldKid = Jose.decodeProtectedHeader(old.token).kid!;
      assert.deepStrictEqual(
        (yield* keys.published).map((key) => key.kid),
        [oldKid],
      );
      // Day 23: the next key is published, the old one still signs.
      yield* TestClock.adjust(`${23 * DAY + 60} seconds`);
      const published = (yield* keys.published).map((key) => key.kid);
      assert.lengthOf(published, 2);
      const nextKid = published.find((kid) => kid !== oldKid)!;
      assert.strictEqual(Jose.decodeProtectedHeader((yield* tokens.forHub(hub)).token).kid, oldKid);
      // Day 30: the next key signs; the old one still verifies its tokens.
      yield* TestClock.adjust(`${7 * DAY} seconds`);
      assert.strictEqual(
        Jose.decodeProtectedHeader((yield* tokens.forHub(hub)).token).kid,
        nextKid,
      );
      const during = yield* servedJwks;
      assert.isTrue((yield* verify(old.token, during.set, { audience: "vault", at: start })).ok);
      // Day 37: the old key is gone; its tokens no longer verify.
      yield* TestClock.adjust(`${7 * DAY} seconds`);
      const after = yield* servedJwks;
      assert.notInclude(after.raw, oldKid);
      assert.deepInclude(yield* verify(old.token, after.set, { audience: "vault", at: start }), {
        ok: false,
        code: "ERR_JWKS_NO_MATCHING_KEY",
      });
      assert.isFalse([...sealed.keys()].some((name) => name.endsWith(oldKid)));
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("after a restore drops the sealed keys, the Hub makes and publishes new ones", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      const keys = yield* IdentityKeys.IdentityKeys;
      const before = Jose.decodeProtectedHeader(
        (yield* tokens.forHub({ audience: "vault", scopeId: null })).token,
      ).kid!;
      // `t3 secrets key import` removes the sealed halves; the rows are left behind.
      sealed.clear();
      const after = (yield* keys.published).map((key) => key.kid);
      assert.lengthOf(after, 1);
      assert.notInclude(after, before);
      const next = yield* tokens.forHub({ audience: "vault", scopeId: null });
      assert.strictEqual(Jose.decodeProtectedHeader(next.token).kid, after[0]);
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("the JWKS never carries a private member, checked on its raw JSON", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      yield* tokens.forHub({ audience: "vault", scopeId: "scope-1" });
      const { raw } = yield* servedJwks;
      for (const member of ["d", "p", "q", "dp", "dq", "qi", "k", "oth"]) {
        assert.notInclude(raw, `"${member}":`, member);
      }
      const keys = (JSON.parse(raw) as { keys: Array<Record<string, unknown>> }).keys;
      for (const key of keys) {
        assert.sameMembers(Object.keys(key), ["kty", "crv", "x", "y", "kid", "alg", "use"]);
      }
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("the Hub's own token names the installation and the scope", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      const issued = yield* tokens.forHub({ audience: "vault", scopeId: "scope-1" });
      assert.deepInclude(Jose.decodeJwt(issued.token) as Record<string, unknown>, {
        sub: `t3:hub:${INSTALLATION}`,
        scope: "scope-1",
        aud: "vault",
      });
      const direct = yield* tokens.forHub({ audience: "vault", scopeId: null });
      assert.strictEqual(Jose.decodeJwt(direct.token).scope, "direct");
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("no token for the Hub itself, a list of audiences, or without an issuer", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      for (const audience of [
        "https://hub.example.com",
        "https://hub.example.com/x",
        "a b",
        "a,b",
        "",
      ]) {
        const refused = yield* tokens.forHub({ audience, scopeId: null }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "audience", audience);
      }
      assert.lengthOf(audits, 0);
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );

  it.effect("workload identity is off without an issuer", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      const refused = yield* tokens.forHub({ audience: "vault", scopeId: null }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "no-issuer");
    }).pipe(
      Effect.provide(
        Layer.effect(IdentityTokens.IdentityTokens, IdentityTokens.make).pipe(
          Layer.provideMerge(Layer.effect(IdentityKeys.IdentityKeys, IdentityKeys.make)),
          Layer.provideMerge(
            Layer.succeed(
              IdentityIssuer.IdentityIssuer,
              IdentityIssuer.make({ configured: undefined, publicUrl: undefined }),
            ),
          ),
          Layer.provideMerge(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedNone,
              set: () => Effect.void,
              remove: () => Effect.void,
            }),
          ),
          Layer.provideMerge(Layer.mock(AuditLog.AuditLog)({ record: () => Effect.void })),
          Layer.provideMerge(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(INSTALLATION),
            }),
          ),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  );

  it.effect("the token reaches no log and no audit row; the audit row says who and what", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* seed;
      const tokens = yield* IdentityTokens.IdentityTokens;
      const issued = yield* tokens.forThread({
        facts,
        entryId: "entry-kube",
        audience: "kubernetes",
        ttlSeconds: 600,
      });
      const signature = issued.token.split(".")[2]!;
      const visible = JSON.stringify(audits) + logged.join("\n");
      assert.notInclude(visible, issued.token);
      assert.notInclude(visible, signature);
      const row = audits.find((entry) => entry.action === "identity.issue")!;
      assert.deepInclude(row.detail ?? {}, {
        aud: "kubernetes",
        sub: `t3:space:${SPACE}:project:-:user:ada`,
        jti: issued.jti,
        thread: THREAD,
      });
    }).pipe(Effect.provide(layerFor(ISSUER))),
  );
});
