// @effect-diagnostics nodeBuiltinImport:off -- the tests lay out real files, links, and dirs.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FILE_ROOTS_ENV, MAX_PROVIDER_FILE_BYTES, readProviderFile } from "./fileRoots.ts";

/** A temp tree: `roots/a` (a root), `roots/linked` (a root that is a link), and `outside`. */
function layout() {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-roots-")));
  const root = NodePath.join(base, "roots", "a");
  const realLinked = NodePath.join(base, "real-linked");
  const linkedRoot = NodePath.join(base, "roots", "linked");
  const outside = NodePath.join(base, "outside");
  for (const dir of [root, realLinked, outside]) NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.symlinkSync(realLinked, linkedRoot);
  NodeFS.writeFileSync(NodePath.join(root, "token"), "jwt-in-root");
  NodeFS.writeFileSync(NodePath.join(realLinked, "token"), "jwt-in-linked-root");
  NodeFS.writeFileSync(NodePath.join(outside, "secret"), "do-not-send");
  NodeFS.symlinkSync(NodePath.join(outside, "secret"), NodePath.join(root, "escape"));
  NodeFS.mkdirSync(NodePath.join(root, "dir"));
  NodeFS.writeFileSync(NodePath.join(root, "big"), "x".repeat(MAX_PROVIDER_FILE_BYTES + 1));
  return { base, root, linkedRoot, outside };
}

/** The Node file system, recording every path opened or read whole. */
function recordingFileSystem(roots: string) {
  const opened: Array<string> = [];
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        ...fs,
        open: (path: string, options?: Parameters<FileSystem.FileSystem["open"]>[1]) => {
          opened.push(path);
          return fs.open(path, options);
        },
        readFile: (path: string) => {
          opened.push(path);
          return fs.readFile(path);
        },
        readFileString: (path: string, encoding?: string) => {
          opened.push(path);
          return fs.readFileString(path, encoding);
        },
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [FILE_ROOTS_ENV]: roots } }))),
  );
  return { layer, opened };
}

describe("provider files", () => {
  it.effect("reads a regular file under a root, also through a root that is a link", () => {
    const tree = layout();
    const fs = recordingFileSystem(`${tree.root}:${tree.linkedRoot}`);
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* readProviderFile(NodePath.join(tree.root, "token")), {
        _tag: "ok",
        content: "jwt-in-root",
      });
      assert.deepStrictEqual(yield* readProviderFile(NodePath.join(tree.linkedRoot, "token")), {
        _tag: "ok",
        content: "jwt-in-linked-root",
      });
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("refuses a path outside the roots, and never opens it", () => {
    const tree = layout();
    const fs = recordingFileSystem(tree.root);
    return Effect.gen(function* () {
      const result = yield* readProviderFile(NodePath.join(tree.outside, "secret"));
      assert.deepStrictEqual(result, { _tag: "refused", reason: "outside-roots" });
      assert.deepStrictEqual(fs.opened, []);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("refuses a `..` path, even one that would land back inside a root", () => {
    const tree = layout();
    const fs = recordingFileSystem(tree.root);
    return Effect.gen(function* () {
      for (const path of [
        `${tree.root}/../../outside/secret`,
        `${tree.root}/dir/../token`,
        `${tree.root}/./token`,
        `${tree.root}//token`,
        "relative/token",
      ]) {
        const result = yield* readProviderFile(path);
        assert.deepStrictEqual(result, { _tag: "refused", reason: "outside-roots" }, path);
      }
      assert.deepStrictEqual(fs.opened, []);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("refuses a link inside a root that points outside it, and never opens it", () => {
    const tree = layout();
    const fs = recordingFileSystem(tree.root);
    return Effect.gen(function* () {
      const result = yield* readProviderFile(NodePath.join(tree.root, "escape"));
      assert.deepStrictEqual(result, { _tag: "refused", reason: "outside-roots" });
      assert.deepStrictEqual(fs.opened, []);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("refuses a directory, a missing file, and a file over the size cap", () => {
    const tree = layout();
    const fs = recordingFileSystem(tree.root);
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* readProviderFile(NodePath.join(tree.root, "dir")), {
        _tag: "refused",
        reason: "not-a-file",
      });
      assert.deepStrictEqual(yield* readProviderFile(NodePath.join(tree.root, "missing")), {
        _tag: "refused",
        reason: "unreadable",
      });
      assert.deepStrictEqual(yield* readProviderFile(NodePath.join(tree.root, "big")), {
        _tag: "refused",
        reason: "too-large",
      });
      assert.deepStrictEqual(fs.opened, []);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("ignores relative and missing roots; a file is never a root of itself", () => {
    const tree = layout();
    const fs = recordingFileSystem(`relative/dir::${tree.base}/nowhere:${tree.root}/token`);
    return Effect.gen(function* () {
      const result = yield* readProviderFile(NodePath.join(tree.root, "token"));
      assert.deepStrictEqual(result, { _tag: "refused", reason: "outside-roots" });
      assert.deepStrictEqual(fs.opened, []);
    }).pipe(Effect.provide(fs.layer));
  });

  it.effect("allows only /var/run/secrets when the operator sets no roots", () => {
    const tree = layout();
    const layer = NodeFileSystem.layer.pipe(
      Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );
    return Effect.gen(function* () {
      const result = yield* readProviderFile(NodePath.join(tree.root, "token"));
      assert.deepStrictEqual(result, { _tag: "refused", reason: "outside-roots" });
    }).pipe(Effect.provide(layer));
  });
});
