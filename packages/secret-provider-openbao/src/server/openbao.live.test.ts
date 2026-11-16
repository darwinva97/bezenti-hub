// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- drives a real `bao server -dev`.
/**
 * Against a real OpenBao: skipped unless T3CODE_TEST_LIVE_OPENBAO=1 and `bao` is on the PATH.
 * Starts `bao server -dev` on a free loopback port, sets up KV v1/v2 and AppRole through its
 * API, reads with the driver, and stops the server it started (by its own handle).
 */
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { driver } from "./driver.ts";

const enabled =
  process.env.T3CODE_TEST_LIVE_OPENBAO === "1" &&
  NodeChildProcess.spawnSync("bao", ["version"], { stdio: "ignore" }).status === 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** Resolves once the dev server prints its root token: it is listening by then. */
const started = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("Root Token:")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`bao server -dev exited (${code})`)));
  });

/** KV v1/v2 data, a read policy, and an AppRole, set up through the API as root. */
async function setUpBao(address: string, rootToken: string) {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${address}/v1/${path}`, {
      method,
      headers: { "X-Vault-Token": rootToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  };
  // `secret/` is KV v2 in dev mode; add a KV v1 mount and AppRole.
  await api("POST", "secret/data/acme/app", { data: { token: "live-v1" } });
  await api("POST", "secret/data/acme/app", { data: { token: "live-v2" } });
  await api("POST", "sys/mounts/legacy", { type: "kv", options: { version: "1" } });
  await api("POST", "legacy/db", { password: "live-legacy" });
  await api("POST", "sys/policies/acl/hub", {
    policy: 'path "secret/data/acme/*" { capabilities = ["read"] }',
  });
  await api("POST", "sys/auth/approle", { type: "approle" });
  await api("POST", "auth/approle/role/hub", { token_policies: ["hub"], token_ttl: "10m" });
  const roleId: string = (await api("GET", "auth/approle/role/hub/role-id")).data.role_id;
  const secretId: string = (await api("POST", "auth/approle/role/hub/secret-id")).data.secret_id;
  return { roleId, secretId };
}

const layer = Layer.mergeAll(
  NodeFileSystem.layer,
  PlatformNodeCrypto.layer,
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("OpenBao never spawns")),
  ),
);

describe.skipIf(!enabled)("OpenBao driver, live", () => {
  it.live(
    "reads KV v1 and v2 with a token and with AppRole",
    () =>
      Effect.gen(function* () {
        const port = yield* Effect.promise(freePort);
        const address = `http://127.0.0.1:${port}`;
        const rootToken = `root-${NodeCrypto.randomUUID()}`;
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              "bao",
              [
                "server",
                "-dev",
                `-dev-root-token-id=${rootToken}`,
                `-dev-listen-address=127.0.0.1:${port}`,
              ],
              { stdio: ["ignore", "pipe", "ignore"] },
            ),
          ),
          (child) => Effect.sync(() => child.kill("SIGTERM")),
        );
        yield* Effect.promise(() => started(server));
        const { roleId, secretId } = yield* Effect.promise(() => setUpBao(address, rootToken));

        const mounts = [
          { path: "secret", version: 2 },
          { path: "legacy", version: 1 },
        ];
        const withToken = { address, mounts, authMethod: "token", token: rootToken };
        assert.deepStrictEqual(yield* driver.test(withToken), { ok: true });
        assert.deepStrictEqual(
          yield* driver.read(withToken, [
            "secret/acme/app#token",
            "secret/acme/app?version=1#token",
            "legacy/db#password",
          ]),
          [
            { _tag: "value", value: "live-v2", version: "2" },
            { _tag: "value", value: "live-v1", version: "1" },
            { _tag: "value", value: "live-legacy" },
          ],
        );
        const withAppRole = { address, mounts, authMethod: "approle", roleId, secretId };
        assert.deepStrictEqual(yield* driver.test(withAppRole), { ok: true });
        // The role's policy reads secret/acme/* only.
        assert.deepStrictEqual(
          yield* driver.read(withAppRole, ["secret/acme/app#token", "legacy/db#password"]),
          [
            { _tag: "value", value: "live-v2", version: "2" },
            { _tag: "error", error: "forbidden" },
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30_000,
  );
});
