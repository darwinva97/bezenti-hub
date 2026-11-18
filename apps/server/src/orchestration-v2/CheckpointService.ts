import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointSkipped,
  type ProjectId,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { scratchFolderName, type ThreadRepository } from "../environment/ScratchWorkspace.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
    /**
     * With it, a ref the workspace lacks is fetched from the Hub's repository of the Project, or
     * of the Thread for one without a Project.
     */
    readonly projectId?: ProjectId;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const crypto = yield* Digest.Digest;
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  const scopeId = yield* input.idAllocator.allocate.checkpointScope({
    threadId: input.threadId,
    name: ROOT_CHECKPOINT_SCOPE_NAME,
  });
  return {
    id: scopeId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    parentScopeId: null,
    providerThreadId: input.providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: input.cwd,
    createdAt: input.createdAt,
  } satisfies OrchestrationV2CheckpointScope;
});

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
  readonly skipped?: OrchestrationV2CheckpointSkipped | undefined;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
    ...(input.status === "ready" ? { uploadedToHub: false } : {}),
    ...(input.skipped !== undefined &&
    (input.skipped.fileCount > 0 || input.skipped.folderCount > 0)
      ? { skipped: input.skipped }
      : {}),
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  CheckpointStore.CheckpointStore | Digest.Digest | IdAllocator.IdAllocatorV2
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Digest.Digest;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Digest.Digest, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    // Absent where no Environment executors run (orchestration-only hosts).
    const hubRepository = yield* Effect.serviceOption(EnvironmentExecutor.HubRepositoryTransfers);
    const hubRepositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    /**
     * Whether the scope's workspace takes checkpoints. A Thread without a Project whose folder is
     * from before folders got git gets its repository here, where the Thread runs.
     */
    const ensureCheckpointable = Effect.fn("CheckpointService.ensureCheckpointable")(
      function* (scope: OrchestrationV2CheckpointScope) {
        if (yield* isGitCheckpointable(scope.cwd)) return true;
        if (Option.isNone(hubRepositories) || Option.isNone(hubRepository)) return false;
        const scratch = yield* hubRepositories.value.threads.scratchWorkspaceOf(scope.threadId);
        if (scratch === undefined || scratchFolderName(scope.cwd) !== scratch.folder) return false;
        yield* hubRepository.value.ensureScratch(scope.cwd);
        return yield* isGitCheckpointable(scope.cwd);
      },
      (effect, scope) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not give a Thread's folder its git repository", {
              scopeId: scope.id,
              cause: String(cause),
            }).pipe(Effect.as(false)),
          ),
        ),
    );

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (!(yield* ensureCheckpointable(input.scope))) {
            return;
          }

          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: input.scope.cwd,
            checkpointRef,
          });
          if (exists) {
            return;
          }

          yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
            })
            .pipe(
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.void,
              }),
            );
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointable =
              input.forceMissing !== true && (yield* isGitCheckpointable(input.scope.cwd));
            const available = checkpointable
              ? yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  )
              : false;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
              files: [],
              capturedAt: input.scope.createdAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: input.ordinalWithinScope - 1,
                })
              : null;
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const previousCheckpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });

          if (input.forceMissing === true || !(yield* ensureCheckpointable(input.scope))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const captured = yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
            })
            .pipe(
              Effect.map((skipped) => ({ status: "ready" as const, skipped })),
              Effect.catchTags({
                VcsUnsupportedOperationError: () =>
                  Effect.succeed({ status: "missing" as const, skipped: undefined }),
              }),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: input.scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as({ status: "error" as const, skipped: undefined })),
              ),
            );
          const captureStatus = captured.status;
          // A file that grew past the limit is absent from this checkpoint, not deleted.
          const skippedPaths = new Set(captured.skipped?.files.map((file) => file.path) ?? []);

          if (captureStatus !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: captureStatus,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const previousExists = yield* checkpointStore
            .hasCheckpointRef({
              cwd: input.scope.cwd,
              checkpointRef: previousCheckpointRef,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                  scopeId: input.scope.id,
                  checkpointRef: previousCheckpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          const refs = {
            cwd: input.scope.cwd,
            fromCheckpointRef: previousCheckpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          const files = previousExists
            ? yield* Effect.all([
                checkpointStore.diffCheckpoints({
                  ...refs,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
                }),
                checkpointStore.listAuthoredPaths(refs).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                      scopeId: input.scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                ),
              ]).pipe(
                Effect.map(([diff, authoredPaths]) =>
                  parseTurnDiffFilesFromNumstat(diff)
                    .filter(
                      (file) => !isGitImport(file, authoredPaths) && !skippedPaths.has(file.path),
                    )
                    .map((file) => ({
                      path: file.path,
                      kind: "modified",
                      additions: file.additions,
                      deletions: file.deletions,
                    })),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                    scopeId: input.scope.id,
                    checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as([])),
                ),
              )
            : [];

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files,
            capturedAt: input.capturedAt,
            skipped: captured.skipped,
          });
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const projectId = input.projectId;
          if (projectId !== undefined && Option.isSome(hubRepository)) {
            const present = yield* checkpointStore.hasCheckpointRef({
              cwd: input.scope.cwd,
              checkpointRef: input.checkpoint.ref,
            });
            // Captured elsewhere (before a move) or pruned here: the Hub's copy restores it. A
            // failed fetch leaves the restore below to report the ref unavailable.
            if (!present) {
              // A Thread without a Project fetches from its own repository.
              const transfers = hubRepository.value;
              yield* Effect.gen(function* () {
                const repository = Option.isSome(hubRepositories)
                  ? yield* hubRepositories.value.threads.repositoryOfThread(input.scope.threadId)
                  : Option.none<ThreadRepository>();
                yield* transfers.fetch({
                  cwd: input.scope.cwd,
                  ...HubRepository.keyOf(
                    Option.match(repository, {
                      onNone: () => ({ projectId }),
                      onSome: (found) => found.key,
                    }),
                  ),
                  checkpointRefs: [input.checkpoint.ref],
                });
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not fetch a checkpoint from the Hub repository", {
                    scopeId: input.scope.id,
                    checkpointRef: input.checkpoint.ref,
                    cause: String(cause),
                  }),
                ),
              );
            }
          }
          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        checkpointStore.deleteCheckpointRefs({
          cwd: input.scope.cwd,
          checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointDeleteStaleRefsError({
              scopeId: input.scope.id,
              checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
              cause,
            }),
        ),
      );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      restore,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
