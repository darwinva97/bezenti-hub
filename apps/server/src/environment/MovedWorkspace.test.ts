// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write real temporary repositories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CheckpointRef, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MovedWorkspace from "./MovedWorkspace.ts";

const layer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({ operation: "MovedWorkspace.test", command: "git", cwd, args }),
  ).pipe(Effect.map((output) => output.stdout.trim()));

const write = (path: string, text: string) => Effect.promise(() => NodeFSP.writeFile(path, text));
const read = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

/**
 * A machine's checkout with one commit, and a checkpoint the source captured on a commit of its
 * own (`moves/one`): `notes.md` written there by hand.
 */
const machine = Effect.fn(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-moved-")),
  );
  const checkout = NodePath.join(root, "repo");
  const worktreesDir = NodePath.join(root, "worktrees");
  yield* Effect.promise(() => NodeFSP.mkdir(checkout));
  yield* git(checkout, "init", "--initial-branch=main", "--quiet");
  yield* git(checkout, "config", "user.email", "t@example.com");
  yield* git(checkout, "config", "user.name", "T");
  yield* write(`${checkout}/README.md`, "# repo\n");
  yield* git(checkout, "add", "README.md");
  yield* git(checkout, "commit", "--quiet", "-m", "init");
  const init = yield* git(checkout, "rev-parse", "HEAD");
  // The source's branch: one commit more, then a checkpoint over it with an uncommitted file.
  yield* git(checkout, "checkout", "--quiet", "-b", "source-side");
  yield* write(`${checkout}/src.md`, "on the source\n");
  yield* git(checkout, "add", "src.md");
  yield* git(checkout, "commit", "--quiet", "-m", "source");
  const sourceHead = yield* git(checkout, "rev-parse", "HEAD");
  yield* write(`${checkout}/notes.md`, "typed by hand\n");
  const ref = CheckpointRef.make("refs/t3/threads/thread%3Aone/moves/one");
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  yield* checkpoints.captureCheckpoint({ cwd: checkout, checkpointRef: ref });
  yield* Effect.promise(() => NodeFSP.rm(`${checkout}/notes.md`));
  yield* git(checkout, "checkout", "--quiet", "main");
  yield* git(checkout, "branch", "--quiet", "-D", "source-side");
  return { root, checkout, worktreesDir, ref, init, sourceHead };
});

const prepare = (
  setup: Effect.Success<ReturnType<typeof machine>>,
  input: Partial<MovedWorkspace.MovePrepareInput>,
) =>
  Effect.gen(function* () {
    return yield* MovedWorkspace.prepareMovedWorkspace(
      {
        vcs: yield* VcsProcess.VcsProcess,
        checkpoints: yield* CheckpointStore.CheckpointStore,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        worktreesDir: setup.worktreesDir,
        platform: "linux",
        scriptEnv: (runtimeEnv) => ({ PATH: process.env.PATH, ...runtimeEnv }),
      },
      {
        checkout: setup.checkout,
        projectId: ProjectId.make("project:one"),
        threadId: ThreadId.make("thread:one"),
        ref: setup.ref,
        branch: null,
        knownWorktree: null,
        setAsidePrefix: "refs/t3/recovered/thread%3Aone/",
        setupScript: null,
        ...input,
      },
    );
  });

describe("MovedWorkspace.prepare", () => {
  it.live("keeps a branch the target had before moving it to the source's commit", () =>
    Effect.gen(function* () {
      const setup = yield* machine();
      // The target has its own commit on the Thread's branch, which the source never had.
      yield* git(setup.checkout, "branch", "feature", setup.init);
      yield* git(setup.checkout, "checkout", "--quiet", "feature");
      yield* write(`${setup.checkout}/target.md`, "only here\n");
      yield* git(setup.checkout, "add", "target.md");
      yield* git(setup.checkout, "commit", "--quiet", "-m", "target only");
      const targetTip = yield* git(setup.checkout, "rev-parse", "HEAD");
      yield* git(setup.checkout, "checkout", "--quiet", "main");

      const result = yield* prepare(setup, { branch: "feature" });
      assert.equal(yield* git(setup.checkout, "rev-parse", "refs/heads/feature"), setup.sourceHead);
      const kept = yield* git(
        setup.checkout,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/t3/recovered/",
      );
      assert.include(kept, targetTip);
      assert.isNotEmpty(result.setAsideRefs);
    }).pipe(Effect.provide(layer)),
  );

  it.live("never takes over a folder that is not a worktree of this checkout", () =>
    Effect.gen(function* () {
      const setup = yield* machine();
      // Another repository's worktree sits where a folder name alone would put this Thread.
      const other = NodePath.join(setup.root, "other", "repo");
      yield* Effect.promise(() => NodeFSP.mkdir(other, { recursive: true }));
      yield* git(other, "init", "--initial-branch=main", "--quiet");
      yield* git(other, "config", "user.email", "t@example.com");
      yield* git(other, "config", "user.name", "T");
      yield* write(`${other}/other.md`, "other project\n");
      yield* git(other, "add", "other.md");
      yield* git(other, "commit", "--quiet", "-m", "other");
      const squatted = NodePath.join(setup.worktreesDir, "repo", "thread-one");
      yield* git(other, "worktree", "add", "--quiet", "--detach", squatted, "HEAD");

      const result = yield* prepare(setup, { knownWorktree: squatted });
      assert.notEqual(result.cwd, squatted);
      assert.equal(yield* read(`${result.cwd}/notes.md`), "typed by hand\n");
      assert.equal(yield* read(`${squatted}/other.md`), "other project\n");

      // At the very path this Thread would get, the folder is refused rather than taken over.
      const planned = MovedWorkspace.movedWorktreePath(
        yield* Path.Path,
        setup.worktreesDir,
        "project:two",
        "thread:one",
      );
      yield* git(other, "worktree", "add", "--quiet", "--detach", planned, "HEAD");
      const refused = yield* prepare(setup, { projectId: ProjectId.make("project:two") }).pipe(
        Effect.flip,
      );
      assert.include(refused.message, "not a worktree of this Project's checkout");
      assert.equal(yield* read(`${planned}/other.md`), "other project\n");
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    "works in a worktree of its own, never the shared checkout, and removes it on failure",
    () =>
      Effect.gen(function* () {
        const setup = yield* machine();
        // Someone's work in the shared checkout, on the branch the Thread also names.
        yield* write(`${setup.checkout}/wip.md`, "not committed\n");
        const head = yield* git(setup.checkout, "rev-parse", "HEAD");

        const failing = yield* prepare(setup, {
          branch: "main",
          setupScript: { name: "Setup", command: "echo installing; exit 3" },
        }).pipe(Effect.flip);
        assert.include(failing.message, "installing");
        const planned = MovedWorkspace.movedWorktreePath(
          yield* Path.Path,
          setup.worktreesDir,
          "project:one",
          "thread:one",
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(planned).then(
              () => true,
              () => false,
            ),
          ),
        );

        const result = yield* prepare(setup, { branch: "main" });
        assert.equal(result.cwd, planned);
        assert.isTrue(result.detached);
        assert.equal(yield* read(`${result.cwd}/notes.md`), "typed by hand\n");
        assert.equal(yield* read(`${setup.checkout}/wip.md`), "not committed\n");
        assert.equal(yield* git(setup.checkout, "rev-parse", "HEAD"), head);
        assert.equal(yield* git(setup.checkout, "branch", "--show-current"), "main");
      }).pipe(Effect.provide(layer)),
  );
});

const exists = (target: string) =>
  Effect.promise(() =>
    NodeFSP.access(target).then(
      () => true,
      () => false,
    ),
  );

const remove = (
  setup: Effect.Success<ReturnType<typeof machine>>,
  input: Partial<MovedWorkspace.MoveRemoveInput> & { readonly cwd: string },
) =>
  Effect.gen(function* () {
    return yield* MovedWorkspace.removeMovedWorktree(
      {
        vcs: yield* VcsProcess.VcsProcess,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        worktreesDir: setup.worktreesDir,
      },
      {
        checkout: setup.checkout,
        projectId: ProjectId.make("project:one"),
        threadId: ThreadId.make("thread:one"),
        ...input,
      },
    );
  });

describe("MovedWorkspace.remove (Makita ticket 28)", () => {
  it.live(
    "removes the Thread's worktree with its uncommitted changes, then answers that it is gone",
    () =>
      Effect.gen(function* () {
        const setup = yield* machine();
        const made = yield* prepare(setup, {});
        yield* write(`${made.cwd}/wip.md`, "never committed\n");

        assert.deepEqual(yield* remove(setup, { cwd: made.cwd }), { status: "removed" });
        assert.isFalse(yield* exists(made.cwd));
        assert.notInclude(yield* git(setup.checkout, "worktree", "list", "--porcelain"), made.cwd);
        assert.deepEqual(yield* remove(setup, { cwd: made.cwd }), { status: "absent" });
        // The checkout itself is untouched.
        assert.equal(yield* read(`${setup.checkout}/README.md`), "# repo\n");
      }).pipe(Effect.provide(layer)),
  );

  it.live(
    "refuses another Thread's worktree, the checkout and a folder the checkout does not list",
    () =>
      Effect.gen(function* () {
        const setup = yield* machine();
        const made = yield* prepare(setup, {});
        // Another Thread's id: its worktree would be elsewhere, so this one is not its to remove.
        const asOther = yield* remove(setup, {
          cwd: made.cwd,
          threadId: ThreadId.make("thread:two"),
        });
        assert.equal(asOther.status, "refused");
        assert.isTrue(yield* exists(made.cwd));
        // The checkout, never.
        const checkout = yield* remove(setup, { cwd: setup.checkout });
        assert.equal(checkout.status, "refused");
        assert.isTrue(yield* exists(`${setup.checkout}/README.md`));
        // A folder at the planned path that the checkout does not list (another repository's).
        const planned = MovedWorkspace.movedWorktreePath(
          yield* Path.Path,
          setup.worktreesDir,
          "project:one",
          "thread:three",
        );
        yield* Effect.promise(() => NodeFSP.mkdir(planned, { recursive: true }));
        yield* write(`${planned}/keep.md`, "someone's\n");
        const unlisted = yield* remove(setup, {
          cwd: planned,
          threadId: ThreadId.make("thread:three"),
        });
        assert.deepEqual(unlisted, {
          status: "refused",
          detail: "That folder is not a worktree of this Project's checkout.",
        });
        assert.equal(yield* read(`${planned}/keep.md`), "someone's\n");
      }).pipe(Effect.provide(layer)),
  );
});
