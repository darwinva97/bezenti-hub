// @effect-diagnostics nodeBuiltinImport:off -- the tests make links, FIFOs and replacements on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as JoinedWorkspaceRoots from "../workspace/JoinedWorkspaceRoots.ts";
import { inspectOnMachine, type MachineAssetError, readOnMachine } from "./MachineAssets.ts";

const notInternal = () => Effect.succeed(false);

/** A Thread's workspace on the machine, and a folder beside it the Thread must never reach. */
const workspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machine-assets-" });
  const root = `${base}/workspace`;
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(`${root}/site`, { recursive: true });
    await NodeFSP.mkdir(`${base}/outside`, { recursive: true });
    await NodeFSP.writeFile(`${root}/site/index.html`, "<p>inside</p>");
    await NodeFSP.writeFile(`${base}/outside/secret.pdf`, "%PDF outside");
    await NodeFSP.symlink(`${base}/outside/secret.pdf`, `${root}/escape.pdf`);
    await NodeFSP.symlink(`${root}/site/index.html`, `${root}/alias.html`);
  });
  return { base, root };
});

const inRoot = <A, E>(
  root: string,
  use: (workspace: JoinedWorkspaceRoots.Workspace) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(JoinedWorkspaceRoots.JoinedWorkspaceRoots, (roots) => roots.withRoot(root, use));

const layer = JoinedWorkspaceRoots.layer.pipe(Layer.provideMerge(NodeServices.layer));

const reasonOf = (error: MachineAssetError | JoinedWorkspaceRoots.WorkspaceRootEscapeError) =>
  error._tag === "MachineAssetError" ? error.reason : error._tag;

describe("MachineAssets: a Thread's file, on its machine", () => {
  it.live("is looked at inside the Thread's workspace only, links followed", () =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      const inspected = yield* inRoot(root, (ws) =>
        inspectOnMachine(ws, "site/index.html", notInternal),
      );
      assert.equal(inspected.relativePath, "site/index.html");
      assert.equal(inspected.size, "<p>inside</p>".length);
      // A link inside the workspace is judged as the file it leads to.
      const alias = yield* inRoot(root, (ws) => inspectOnMachine(ws, "alias.html", notInternal));
      assert.equal(alias.relativePath, "site/index.html");
      for (const path of ["escape.pdf", "../outside/secret.pdf", "/etc/hostname", "."]) {
        const refused = yield* Effect.flip(
          inRoot(root, (ws) => inspectOnMachine(ws, path, notInternal)),
        );
        assert.equal(reasonOf(refused), "outside", path);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("is never a folder, a FIFO, missing, or the machine's own state", () =>
    Effect.gen(function* () {
      const { root } = yield* workspace;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            NodeChildProcess.execFile("mkfifo", [`${root}/pipe.pdf`], (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
      );
      for (const path of ["site", "pipe.pdf", "missing.pdf"]) {
        const refused = yield* Effect.flip(
          inRoot(root, (ws) => inspectOnMachine(ws, path, notInternal)),
        );
        assert.equal(reasonOf(refused), "not_found", path);
      }
      const internal = yield* Effect.flip(
        inRoot(root, (ws) => inspectOnMachine(ws, "site/index.html", () => Effect.succeed(true))),
      );
      assert.equal(reasonOf(internal), "not_found");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("is read again from the path, and only while it is the file the Hub looked at", () =>
    Effect.gen(function* () {
      const { base, root } = yield* workspace;
      const inspected = yield* inRoot(root, (ws) =>
        inspectOnMachine(ws, "site/index.html", notInternal),
      );
      const read = (relativePath: string) =>
        inRoot(root, (ws) =>
          readOnMachine(
            ws,
            { relativePath, identity: inspected.identity, offset: 3, length: 6 },
            notInternal,
          ),
        );
      const items = yield* read("site/index.html");
      assert.deepEqual(items[0], {
        _tag: "head",
        relativePath: "site/index.html",
        size: inspected.size,
        identity: inspected.identity,
      });
      assert.equal(
        items
          .slice(1)
          .map((item) => (item._tag === "chunk" ? Buffer.from(item.base64, "base64") : ""))
          .join(""),
        "inside",
      );
      // Replaced since (an editor's atomic save, a link swapped in): another file, refused.
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(`${root}/site/next.html`, "<p>replaced</p>");
        await NodeFSP.rename(`${root}/site/next.html`, `${root}/site/index.html`);
      });
      assert.equal(reasonOf(yield* Effect.flip(read("site/index.html"))), "changed");
      yield* Effect.promise(async () => {
        await NodeFSP.rm(`${root}/site/index.html`);
        await NodeFSP.symlink(`${base}/outside/secret.pdf`, `${root}/site/index.html`);
      });
      assert.equal(reasonOf(yield* Effect.flip(read("site/index.html"))), "outside");
      // A window larger than one read, or before the start: refused as asked.
      const tooLarge = yield* Effect.flip(
        inRoot(root, (ws) =>
          readOnMachine(
            ws,
            {
              relativePath: "alias.html",
              identity: inspected.identity,
              offset: 0,
              length: 9 * 1024 * 1024,
            },
            notInternal,
          ),
        ),
      );
      assert.equal(reasonOf(tooLarge), "invalid");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
