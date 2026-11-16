// @effect-diagnostics nodeBuiltinImport:off - a real tmpfs folder, links planted in it and modes read back.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type SecretEnv, SecretFilesError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ThreadSecretFiles from "./ThreadSecretFiles.ts";

const FOLDER = "0123456789abcdef0123456789abcdef";
const KUBECONFIG = "apiVersion: v1\nkind: Config\n";

const isTmpfs = (() => {
  try {
    return NodeFS.statfsSync("/dev/shm").type === 0x01021994;
  } catch {
    return false;
  }
})();

/** A fresh root under the real /dev/shm, the way a machine finds it. */
const tmpfsRoot = () => {
  const base = NodeFS.mkdtempSync("/dev/shm/t3-thread-files-test-");
  made.push(base);
  return Effect.provideService(
    ThreadSecretFiles.resolveSecretFilesRoot("/state/of/this/test"),
    HostProcess.Environment,
    { T3CODE_SHM_DIR: base },
  ).pipe(Effect.map((root) => ({ base, root })));
};

const withFiles = (files: SecretEnv["files"]): SecretEnv => ({
  fingerprint: "f1",
  variables: [{ name: "PLAIN", value: "x" }],
  files: files ?? [],
  filesFolder: FOLDER,
});

const made: Array<string> = [];
afterAll(() => {
  for (const dir of made) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (path: string) => NodeFS.lstatSync(path).mode & 0o777;

describe.runIf(isTmpfs)("ThreadSecretFiles", () => {
  it.effect("writes owner-only files in memory and puts each one's path in its variable", () =>
    Effect.gen(function* () {
      const { root } = yield* tmpfsRoot();
      assert.isTrue(root.inMemory);
      const files = yield* ThreadSecretFiles.make(root);
      const done = yield* files.materialize(
        withFiles([
          { name: "KUBECONFIG", content: KUBECONFIG, mode: 0o600 },
          { name: "KUBE_TOKEN", content: "t0k3n-value", mode: 0o400 },
        ]),
      );
      const folder = NodePath.join(root.path, FOLDER);
      assert.equal(modeOf(root.path), 0o700);
      assert.equal(modeOf(folder), 0o700);
      assert.equal(modeOf(NodePath.join(folder, "KUBECONFIG")), 0o600);
      assert.equal(modeOf(NodePath.join(folder, "KUBE_TOKEN")), 0o400);
      assert.equal(NodeFS.readFileSync(NodePath.join(folder, "KUBECONFIG"), "utf8"), KUBECONFIG);
      // The values leave the environment: only paths, which are no secret.
      assert.deepEqual(done.secretEnv, {
        fingerprint: "f1",
        variables: [
          { name: "PLAIN", value: "x" },
          { name: "KUBECONFIG", value: NodePath.join(folder, "KUBECONFIG"), plain: true },
          { name: "KUBE_TOKEN", value: NodePath.join(folder, "KUBE_TOKEN"), plain: true },
        ],
      });
      // No temporary file is left next to them.
      assert.deepEqual(NodeFS.readdirSync(folder).toSorted(), ["KUBECONFIG", "KUBE_TOKEN"]);
    }),
  );

  it.effect("never writes through a link planted at a file's path or as the folder", () =>
    Effect.gen(function* () {
      const { root } = yield* tmpfsRoot();
      const files = yield* ThreadSecretFiles.make(root);
      const elsewhere = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-elsewhere-"));
      made.push(elsewhere);
      const victim = NodePath.join(elsewhere, "victim");
      NodeFS.writeFileSync(victim, "untouched");
      // A link where the file goes: replaced, never followed.
      const folder = NodePath.join(root.path, FOLDER);
      NodeFS.mkdirSync(folder, { mode: 0o700 });
      NodeFS.symlinkSync(victim, NodePath.join(folder, "KUBECONFIG"));
      const done = yield* files.materialize(
        withFiles([{ name: "KUBECONFIG", content: KUBECONFIG, mode: 0o600 }]),
      );
      assert.equal(NodeFS.readFileSync(victim, "utf8"), "untouched");
      assert.isFalse(NodeFS.lstatSync(NodePath.join(folder, "KUBECONFIG")).isSymbolicLink());
      done.release();
      // A link as the folder itself: refused, nothing written where it points.
      const other = "fedcba9876543210fedcba9876543210";
      NodeFS.symlinkSync(elsewhere, NodePath.join(root.path, other));
      const refused = yield* Effect.flip(
        files.materialize({
          fingerprint: "f2",
          files: [{ name: "KUBECONFIG", content: KUBECONFIG, mode: 0o600 }],
          filesFolder: other,
        }),
      );
      assert.equal(refused.reason, "unsafe-folder");
      assert.deepEqual(NodeFS.readdirSync(elsewhere), ["victim"]);
      // A folder another can enter is closed before use, and a folder name is never a path.
      const bad = yield* Effect.flip(
        files.materialize({
          ...withFiles([]),
          files: [{ name: "A", content: "x", mode: 0o600 }],
          filesFolder: "../escape",
        }),
      );
      assert.equal(bad.reason, "invalid");
    }),
  );

  it.effect("rewrites a held folder's files in place, and the last process to end removes it", () =>
    Effect.gen(function* () {
      const { root } = yield* tmpfsRoot();
      const files = yield* ThreadSecretFiles.make(root);
      const folder = NodePath.join(root.path, FOLDER);
      const file = NodePath.join(folder, "KUBE_TOKEN");
      const first = yield* files.materialize(
        withFiles([{ name: "KUBE_TOKEN", content: "token-1", mode: 0o600 }]),
      );
      const second = yield* files.materialize(
        withFiles([{ name: "KUBE_TOKEN", content: "token-1", mode: 0o600 }]),
      );
      assert.equal(
        yield* files.refresh({
          filesFolder: FOLDER,
          files: [{ name: "KUBE_TOKEN", content: "token-2", mode: 0o600 }],
        }),
        "refreshed",
      );
      assert.equal(NodeFS.readFileSync(file, "utf8"), "token-2");
      first.release();
      first.release();
      assert.isTrue(NodeFS.existsSync(file), "another process still holds it");
      second.release();
      assert.isFalse(NodeFS.existsSync(folder));
      // With nobody holding it, a refresh writes nothing (and makes no folder).
      assert.equal(
        yield* files.refresh({
          filesFolder: FOLDER,
          files: [{ name: "KUBE_TOKEN", content: "token-3", mode: 0o600 }],
        }),
        "not-held",
      );
      assert.isFalse(NodeFS.existsSync(folder));
    }),
  );

  it.effect("sweeps what a previous run left at the start", () =>
    Effect.gen(function* () {
      const { root } = yield* tmpfsRoot();
      const left = NodePath.join(root.path, FOLDER);
      NodeFS.mkdirSync(left, { mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(left, "KUBECONFIG"), KUBECONFIG);
      yield* Effect.provide(
        Effect.service(ThreadSecretFiles.ThreadSecretFiles),
        ThreadSecretFiles.layerAt(root),
      );
      assert.deepEqual(NodeFS.readdirSync(root.path), []);
    }),
  );
});

describe("ThreadSecretFiles without memory", () => {
  it.effect("a machine whose only folder is on a disk takes no Secret file, and writes none", () =>
    Effect.gen(function* () {
      const onDisk = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-disk-"));
      made.push(onDisk);
      const root = yield* Effect.provideService(
        ThreadSecretFiles.resolveSecretFilesRoot("/state/of/this/test"),
        HostProcess.Environment,
        // /dev/shm stood in by a disk folder, and no runtime dir: nothing in memory.
        { T3CODE_SHM_DIR: onDisk },
      );
      assert.deepEqual(root, { path: "", inMemory: false });
      const files = yield* ThreadSecretFiles.make(root);
      const refused = yield* Effect.flip(
        files.materialize(withFiles([{ name: "KUBECONFIG", content: KUBECONFIG, mode: 0o600 }])),
      );
      assert.instanceOf(refused, SecretFilesError);
      assert.equal(refused.reason, "not-in-memory");
      assert.deepEqual(NodeFS.readdirSync(onDisk), []);
      // Without files, nothing changes.
      const plain = yield* files.materialize({ fingerprint: "f", variables: [] });
      assert.deepEqual(plain.secretEnv, { fingerprint: "f", variables: [] });
    }),
  );
});
