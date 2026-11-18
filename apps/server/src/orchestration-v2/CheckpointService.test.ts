import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.live("restores a checkpoint the workspace lacks from the Hub's repository of the Project", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* VcsProcess.VcsProcess;
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      vcs.run({ operation: "CheckpointService.test.git", command: "git", cwd, args });
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-machine-" });
    const hub = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-hub-" });
    yield* git(cwd, "init", "--initial-branch=main");
    yield* git(cwd, "config", "user.email", "machine@example.com");
    yield* git(cwd, "config", "user.name", "Machine");
    yield* fs.writeFileString(`${cwd}/notes.md`, "committed\n");
    yield* git(cwd, "add", "notes.md");
    yield* git(cwd, "commit", "-m", "Initial commit");
    yield* git(hub, "init", "--bare", "--quiet", hub);

    const projectId = ProjectId.make("project:restore");
    // The Hub machine's side of it: the repository is on this disk.
    const transfers = Layer.succeed(EnvironmentExecutor.HubRepositoryTransfers, {
      push: (input) =>
        HubRepository.pushRefs({ ...input, remote: { url: hub }, refs: input.checkpointRefs }).pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcs),
        ),
      fetch: (input) =>
        HubRepository.fetchMissingRefs({
          ...input,
          remote: { url: hub },
          refs: input.checkpointRefs,
        }).pipe(Effect.provideService(VcsProcess.VcsProcess, vcs)),
      ensureScratch: () => Effect.void,
    });
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:restore"),
      threadId: ThreadId.make("thread:restore"),
      runId: RunId.make("run:restore:1"),
      nodeId: NodeId.make("node:restore:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:restore"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd,
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const hubRepository = yield* EnvironmentExecutor.HubRepositoryTransfers;
      yield* fs.writeFileString(`${cwd}/notes.md`, "the turn's edit\n");
      const checkpoint = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId,
        nodeId: scope.nodeId,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      assert.equal(checkpoint.uploadedToHub, false);
      yield* hubRepository.push({ cwd, projectId, checkpointRefs: [checkpoint.ref] });
      // This machine never had the ref (it moved here), and its files are something else.
      yield* git(cwd, "update-ref", "-d", checkpoint.ref);
      yield* fs.writeFileString(`${cwd}/notes.md`, "later\n");

      yield* checkpoints.restore({ scope, checkpoint, projectId });
      assert.equal(yield* fs.readFileString(`${cwd}/notes.md`), "the turn's edit\n");
    }).pipe(
      Effect.provide(
        CheckpointService.layer.pipe(
          Layer.provideMerge(transfers),
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              CheckpointStore.layer.pipe(
                Layer.provide(VcsDriverRegistry.layer),
                Layer.provide(VcsProcess.layer),
              ),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.live("records what a checkpoint left out and keeps it out of the turn's files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* VcsProcess.VcsProcess;
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      vcs.run({ operation: "CheckpointService.test.git", command: "git", cwd, args });
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-skipped-" });
    yield* git(cwd, "init", "--initial-branch=main");
    yield* git(cwd, "config", "user.email", "machine@example.com");
    yield* git(cwd, "config", "user.name", "Machine");
    yield* fs.writeFileString(`${cwd}/notes.md`, "committed\n");
    yield* git(cwd, "add", "notes.md");
    yield* git(cwd, "commit", "-m", "Initial commit");
    yield* fs.writeFileString(`${cwd}/clip.mp4`, "small for now");
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:skipped"),
      threadId: ThreadId.make("thread:skipped"),
      runId: RunId.make("run:skipped:1"),
      nodeId: NodeId.make("node:skipped:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:skipped"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd,
      createdAt: DateTime.makeUnsafe("2026-11-18T00:00:00.000Z"),
    };
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      yield* fs.writeFileString(`${cwd}/notes.md`, "the turn's edit\n");
      yield* fs.truncate(`${cwd}/clip.mp4`, 51 * 1024 * 1024);
      yield* fs.makeDirectory(`${cwd}/node_modules/pkg`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/node_modules/pkg/index.js`, "x\n");
      const checkpoint = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId,
        nodeId: scope.nodeId,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      assert.deepEqual(
        checkpoint.files.map((file) => file.path),
        ["notes.md"],
      );
      assert.deepEqual(checkpoint.skipped, {
        maxFileBytes: 50 * 1024 * 1024,
        files: [{ path: "clip.mp4", sizeBytes: 51 * 1024 * 1024 }],
        fileCount: 1,
        folders: ["node_modules/"],
        folderCount: 1,
      });
    }).pipe(
      Effect.provide(
        CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              CheckpointStore.layer.pipe(
                Layer.provide(VcsDriverRegistry.layer),
                Layer.provide(VcsProcess.layer),
              ),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
