import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import type { ThreadRepository } from "../environment/ScratchWorkspace.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as HubRepository from "./HubRepository.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const DIFF_TRUNCATED_MARKER = "\n\n[truncated]";

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;
  // Absent on hosts without Environments or a Hub repository (orchestration-only tests).
  const hubRepositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
  const environments = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);

  type CheckpointReads = Pick<
    CheckpointStore.CheckpointStore["Service"],
    "diffCheckpoints" | "listAuthoredPaths"
  >;
  /**
   * Where a diff reads both refs: the Hub repository once both checkpoints are marked uploaded
   * (a ref there may be an older capture of a reused ordinal), so it needs no machine; else the
   * workspace on the Thread's Active environment, which captured them.
   */
  const readsFor = Effect.fn("CheckpointDiffQuery.readsFor")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | undefined;
    readonly workspaceCwd: string;
    readonly refs: ReadonlyArray<CheckpointRef>;
    readonly checkpoints: ProjectionCheckpointContext["checkpoints"];
  }) {
    const uploaded = input.refs.every((ref) =>
      input.checkpoints.some(
        (checkpoint) =>
          checkpoint.ref === ref && checkpoint.status === "ready" && checkpoint.uploadedToHub === 1,
      ),
    );
    if (uploaded && input.projectId !== undefined && Option.isSome(hubRepositories)) {
      const repositories = hubRepositories.value;
      // A Thread without a Project reads its own repository; one that cannot be read now reads
      // the workspace, as before an upload.
      const repository = yield* repositories.threads
        .repositoryOfThread(input.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<ThreadRepository>()));
      if (
        Option.isSome(repository) &&
        (yield* repositories.hasRefs(repository.value.key, input.refs))
      ) {
        const cwd = yield* repositories.ensure(repository.value.key);
        return { cwd, reads: repositories.checkpoints as CheckpointReads };
      }
    }
    const onEnvironment = <A, E>(effect: Effect.Effect<A, E>) =>
      Option.isSome(environments)
        ? environments.value.onActiveEnvironment(input.threadId)(effect)
        : effect;
    const reads: CheckpointReads = {
      diffCheckpoints: (diff) => onEnvironment(checkpointStore.diffCheckpoints(diff)),
      listAuthoredPaths: (paths) => onEnvironment(checkpointStore.listAuthoredPaths(paths)),
    };
    return { cwd: input.workspaceCwd, reads };
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const readyCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "ready" &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const maxTurnCount = readyCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = readyCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      // Capture compares against the preceding scope ordinal, even when that
      // checkpoint belongs to a stopped run or has no run.
      const parentCheckpoint =
        input.fromTurnCount === input.toTurnCount - 1
          ? projection.checkpoints.find(
              (checkpoint) =>
                checkpoint.status === "ready" &&
                checkpoint.scopeId === toCheckpoint.scopeId &&
                checkpoint.ordinalWithinScope === toCheckpoint.ordinalWithinScope - 1,
            )
          : undefined;

      const firstScope =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
          : undefined;
      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : yield* checkpointRefForScopeOrdinal({
                scopeId: firstScope.id,
                ordinalWithinScope: 0,
              }).pipe(Effect.provideService(Digest.Digest, digest))
          : (
              parentCheckpoint ??
              readyCheckpoints.find(
                (checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount,
              )
            )?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const { cwd, reads } = yield* readsFor({
        threadId: input.threadId,
        projectId: projection.projectId,
        workspaceCwd: toScope.cwd,
        refs: [fromCheckpointRef, toCheckpoint.ref],
        checkpoints: projection.checkpoints,
      });
      const comparison = {
        cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
      };
      const authoredPaths = yield* reads
        .listAuthoredPaths(comparison)
        .pipe(Effect.orElseSucceed(() => null));
      // A file the capture left out (it grew past the size limit) is absent, not deleted.
      const skippedPaths = new Set(toCheckpoint.skippedFiles?.map((file) => file.path) ?? []);
      const files =
        authoredPaths === null && skippedPaths.size === 0
          ? []
          : yield* reads.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
              Effect.map(parseTurnDiffFilesFromNumstat),
              Effect.orElseSucceed(() => []),
            );
      const retainedFiles = files.filter(
        (file) => !isGitImport(file, authoredPaths) && !skippedPaths.has(file.path),
      );
      // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
      const pathBatches =
        retainedFiles.length === files.length ? [undefined] : batchFilePaths(retainedFiles);
      let diff = "";
      let remainingBytes = CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
      for (const filePaths of pathBatches) {
        const patch = yield* reads
          .diffCheckpoints({
            ...comparison,
            ...(filePaths === undefined ? {} : { filePaths }),
            // One extra byte distinguishes an exact fit from a truncated patch.
            maxOutputBytes: remainingBytes + 1,
          })
          .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
        const patchBytes = Buffer.byteLength(patch);
        diff += patch;
        if (patchBytes > remainingBytes) {
          // Reserve marker space only on overflow, which may trim an earlier batch.
          // Streaming decode drops an incomplete final UTF-8 character at the byte boundary.
          diff =
            new TextDecoder().decode(
              Buffer.from(diff).subarray(
                0,
                CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
              ),
              { stream: true },
            ) + DIFF_TRUNCATED_MARKER;
          break;
        }
        remainingBytes -= patchBytes;
      }

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  // Spec 5 ticket 05: a diff reaches a client with the Thread's secret values as `[NAME]`.
  const masked = <A extends { readonly threadId: ThreadId; readonly diff: string }>(result: A) =>
    Option.isNone(masker)
      ? Effect.succeed(result)
      : Effect.orDie(masker.value.forThread(result.threadId)).pipe(
          Effect.map((threadMasker): A => {
            const diff = threadMasker.mask(result.diff);
            return diff === result.diff ? result : { ...result, diff };
          }),
        );

  return CheckpointDiffQuery.of({
    getTurnDiff: Effect.fn("CheckpointDiffQuery.getTurnDiff.masked")(function* (input) {
      return yield* masked(yield* getTurnDiff(input));
    }),
    getFullThreadDiff: Effect.fn("CheckpointDiffQuery.getFullThreadDiff.masked")(function* (input) {
      return yield* masked(yield* getFullThreadDiff(input));
    }),
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
