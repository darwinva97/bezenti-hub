// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointRef, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const MiB = 1024 * 1024;

const layerVcsProcessTest = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const ref = (name: string) => CheckpointRef.make(`refs/t3/checkpoints/large-files/${name}`);

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "CheckpointLargeFiles.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });
}

const write = (cwd: string, path: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(NodePath.dirname(NodePath.join(cwd, path)), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(NodePath.join(cwd, path), contents);
  });

/** A sparse file: `head` first, then zeros up to `bytes`. */
const writeBig = (cwd: string, path: string, bytes: number, head = "big") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* write(cwd, path, head);
    yield* fileSystem.truncate(NodePath.join(cwd, path), bytes);
  });

const read = (cwd: string, path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem.readFile(NodePath.join(cwd, path));
    return { size: bytes.length, head: Buffer.from(bytes.subarray(0, 16)).toString("utf8") };
  });

const exists = (cwd: string, path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.exists(NodePath.join(cwd, path));
  });

const treeOf = (cwd: string, checkpointRef: CheckpointRef) =>
  git(cwd, ["ls-tree", "-r", "--name-only", checkpointRef]).pipe(
    Effect.map((out) => out.split("\n").filter((line) => line.length > 0)),
  );

const makeRepo: Effect.Effect<
  string,
  VcsError | PlatformError.PlatformError,
  FileSystem.FileSystem | VcsProcess.VcsProcess | Scope.Scope
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-large-" });
  yield* git(tmp, ["init"]);
  yield* git(tmp, ["config", "user.email", "test@test.com"]);
  yield* git(tmp, ["config", "user.name", "Test"]);
  yield* write(tmp, "README.md", "# test\n");
  yield* git(tmp, ["add", "."]);
  yield* git(tmp, ["commit", "-m", "initial commit"]);
  return tmp;
});

it.layer(layerTest)("checkpoints and large files", (it) => {
  it.effect("leaves a file over 50 MiB out of the checkpoint and reports it", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      yield* write(tmp, "notes.txt", "small\n");
      yield* writeBig(tmp, "media/intro.mp4", 51 * MiB);
      yield* writeBig(tmp, "media/exactly-50.bin", 50 * MiB);

      const report = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("a") });

      const tree = yield* treeOf(tmp, ref("a"));
      expect(tree).toContain("notes.txt");
      expect(tree).toContain("media/exactly-50.bin");
      expect(tree).not.toContain("media/intro.mp4");
      expect(report).toEqual({
        maxFileBytes: 50 * MiB,
        files: [{ path: "media/intro.mp4", sizeBytes: 51 * MiB }],
        fileCount: 1,
        folders: [],
        folderCount: 0,
      });
    }),
  );

  it.effect("restore keeps a skipped file, even one the user changed since", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      yield* write(tmp, "notes.txt", "before\n");
      yield* writeBig(tmp, "video.mp4", 60 * MiB, "take one");
      yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("b") });

      yield* write(tmp, "notes.txt", "after\n");
      yield* writeBig(tmp, "video.mp4", 70 * MiB, "user edit");
      expect(yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("b") })).toBe(true);

      expect((yield* read(tmp, "notes.txt")).head).toBe("before\n");
      expect(yield* read(tmp, "video.mp4")).toEqual({
        size: 70 * MiB,
        head: "user edit\0\0\0\0\0\0\0",
      });
    }),
  );

  it.effect("restore keeps a small captured file that has since grown past the limit", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      yield* write(tmp, "clip.bin", "tiny");
      yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("c0") });
      expect(yield* treeOf(tmp, ref("c0"))).toContain("clip.bin");

      yield* writeBig(tmp, "clip.bin", 55 * MiB, "grown");
      const report = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("c1") });
      expect(report?.files).toEqual([{ path: "clip.bin", sizeBytes: 55 * MiB }]);

      yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("c0") });
      expect(yield* read(tmp, "clip.bin")).toEqual({
        size: 55 * MiB,
        head: "grown\0\0\0\0\0\0\0\0\0\0\0",
      });
    }),
  );

  it.effect("fails a restore it cannot make safe instead of deleting left-out files", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      const names = Array.from(
        { length: 160 },
        (_, index) => `renders/${"take-".repeat(20)}${String(index).padStart(3, "0")}.mov`,
      );
      for (const name of names) yield* writeBig(tmp, name, 51 * MiB);
      yield* write(tmp, "notes.txt", "before\n");

      // git add reads the exclusions from stdin, so the capture still works.
      const report = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("many") });
      expect(report?.fileCount).toBe(names.length);
      expect(report?.files.length).toBe(50);
      expect(
        (yield* treeOf(tmp, ref("many"))).filter((path) => path.startsWith("renders/")),
      ).toEqual([]);

      // git clean cannot, and the exclusions exceed the command line it may use.
      yield* write(tmp, "notes.txt", "after\n");
      const restored = yield* Effect.exit(
        store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("many") }),
      );
      expect(restored._tag).toBe("Failure");
      for (const name of names) expect(yield* exists(tmp, name)).toBe(true);
      expect((yield* read(tmp, "notes.txt")).head).toBe("after\n");
    }),
  );

  it.effect("respects .gitignore: an ignored big file is neither captured nor reported", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      yield* write(tmp, ".gitignore", "*.mov\n");
      yield* writeBig(tmp, "raw.mov", 80 * MiB);

      const report = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("d") });
      expect(yield* treeOf(tmp, ref("d"))).not.toContain("raw.mov");
      expect(report?.fileCount ?? 0).toBe(0);

      yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("d") });
      expect((yield* read(tmp, "raw.mov")).size).toBe(80 * MiB);
    }),
  );

  it.effect("leaves dependency and build folders out unless tracked or re-included", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      yield* write(tmp, "target/committed.txt", "kept\n");
      yield* git(tmp, ["add", "target/committed.txt"]);
      yield* git(tmp, ["commit", "-m", "track target"]);
      yield* write(tmp, "node_modules/left-pad/index.js", "module.exports = 1;\n");
      yield* write(tmp, "packages/web/node_modules/react/index.js", "x\n");
      yield* write(tmp, "dist/app.js", "built\n");
      yield* write(tmp, "target/committed.txt", "changed\n");
      yield* write(tmp, "src/main.ts", "main\n");

      const report = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("e0") });
      const tree = yield* treeOf(tmp, ref("e0"));
      expect(tree).toContain("src/main.ts");
      expect(tree).toContain("target/committed.txt");
      expect(
        tree.filter((path) => path.includes("node_modules/") || path.startsWith("dist/")),
      ).toEqual([]);
      expect(yield* git(tmp, ["show", `${ref("e0")}:target/committed.txt`])).toBe("changed");
      expect(report?.folders).toEqual(["dist/", "node_modules/", "packages/web/node_modules/"]);
      expect(report?.folderCount).toBe(3);

      // A restore must not delete what the checkpoint left out.
      yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("e0") });
      expect(yield* exists(tmp, "node_modules/left-pad/index.js")).toBe(true);
      expect(yield* exists(tmp, "packages/web/node_modules/react/index.js")).toBe(true);
      expect(yield* exists(tmp, "dist/app.js")).toBe(true);

      yield* write(tmp, ".gitignore", "!dist/\n");
      const reincluded = yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("e1") });
      expect(yield* treeOf(tmp, ref("e1"))).toContain("dist/app.js");
      expect(reincluded?.folders).toEqual(["node_modules/", "packages/web/node_modules/"]);
    }),
  );

  it.effect("keeps the user's global ignores working inside checkpoints", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      // The repository's own setting stands in for the user's global core.excludesFile.
      yield* write(tmp, "../t3-global-ignore", "*.log\n");
      yield* git(tmp, ["config", "core.excludesFile", NodePath.join(tmp, "../t3-global-ignore")]);
      yield* write(tmp, "debug.log", "noise\n");
      yield* write(tmp, "kept.txt", "kept\n");

      yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("f0") });
      const tree = yield* treeOf(tmp, ref("f0"));
      expect(tree).toContain("kept.txt");
      expect(tree).not.toContain("debug.log");
      yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("f0") });
      expect(yield* exists(tmp, "debug.log")).toBe(true);
    }),
  );

  it.effect("keeps the XDG default global ignore file working inside checkpoints", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      const xdg = NodePath.join(tmp, "..", `${NodePath.basename(tmp)}-xdg`);
      yield* write(xdg, "git/ignore", "*.tmp\n");
      yield* write(xdg, "empty-gitconfig", "");
      yield* write(tmp, "scratch.tmp", "noise\n");
      const saved = {
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      };
      yield* Effect.gen(function* () {
        process.env.XDG_CONFIG_HOME = xdg;
        process.env.GIT_CONFIG_GLOBAL = NodePath.join(xdg, "empty-gitconfig");
        yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("g0") });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }),
        ),
      );
      expect(yield* treeOf(tmp, ref("g0"))).not.toContain("scratch.tmp");
    }),
  );

  it.effect("leaves the user's repository settings and ignore files untouched", () =>
    Effect.gen(function* () {
      const tmp = yield* makeRepo;
      const store = yield* CheckpointStore.CheckpointStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const infoExclude = NodePath.join(tmp, ".git/info/exclude");
      const before = {
        config: yield* git(tmp, ["config", "--list", "--local"]),
        exclude: yield* fileSystem.readFileString(infoExclude),
      };
      yield* write(tmp, "node_modules/x.js", "x\n");
      yield* writeBig(tmp, "big.bin", 51 * MiB);
      yield* store.captureCheckpoint({ cwd: tmp, checkpointRef: ref("h0") });
      yield* store.restoreCheckpoint({ cwd: tmp, checkpointRef: ref("h0") });

      expect(yield* git(tmp, ["config", "--list", "--local"])).toBe(before.config);
      expect(yield* fileSystem.readFileString(infoExclude)).toBe(before.exclude);
      expect(yield* exists(tmp, ".gitignore")).toBe(false);
      expect(
        (yield* fileSystem.readDirectory(NodePath.join(tmp, ".git"))).filter((name) =>
          name.startsWith("t3-checkpoint-"),
        ),
      ).toEqual([]);
      // The user's own git still sees both, exactly as before.
      expect(yield* git(tmp, ["status", "--porcelain", "--untracked-files=normal"])).toBe(
        "?? big.bin\n?? node_modules/".trim(),
      );
    }),
  );
});
