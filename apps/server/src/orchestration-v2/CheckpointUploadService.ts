/**
 * Uploads each Thread's checkpoints to its Project's Hub repository after capture, marking each
 * (`checkpoint.uploaded`). One machine uploads to one repository at a time, and a failure backs off
 * the repository as a whole, whatever asks; why goes to `HubRepositoryUploadIssues`. See
 * docs/internals/overview.md, «Hub repository».
 */
import {
  type CheckpointId,
  type EnvironmentId,
  type HubRepositoryUploadIssueKind,
  type OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointJson,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as HubRepositoryUploadIssues from "../checkpointing/HubRepositoryUploadIssues.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import type { ThreadRepository } from "../environment/ScratchWorkspace.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

/** A Thread whose machine was not there (or a step failed unexpectedly): its own backoff. */
const RETRY_BASE = Duration.seconds(1);
const RETRY_CAP = Duration.minutes(5);
/** A repository whose upload failed: base and caps of its backoff, by why it failed. */
const REPOSITORY_RETRY_BASE = Duration.seconds(30);
const REPOSITORY_RETRY_CAP = Duration.minutes(30);
/** Too large or refused: the same upload fails until something changes, so it waits longer. */
const REPOSITORY_LASTING_RETRY_CAP = Duration.hours(2);
/** Refs per push: bounds the command line and what one failure holds back. */
const MAX_REFS_PER_PUSH = 64;
const ISSUE_DETAIL_MAX = 600;

const decodeCheckpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJson),
);

export interface CheckpointUploadsShape {
  /** Uploads the Thread's checkpoints the Hub's repository lacks, in the background. */
  readonly request: (threadId: ThreadId) => Effect.Effect<void>;
}

export class CheckpointUploads extends Context.Service<CheckpointUploads, CheckpointUploadsShape>()(
  "t3/orchestration-v2/CheckpointUploadService/CheckpointUploads",
) {}

interface PendingCheckpoint {
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly cwd: string;
}

/**
 * One Thread's uploads; no entry is idle. Only the running upload leaves `running`, and every
 * transition happens without yielding, so a Thread never has two uploads at once. A retry waits
 * either on the Thread's own backoff (`gate` undefined: a connect wakes it) or on its repository's.
 */
type ThreadUpload =
  | { readonly _tag: "running"; again: boolean; readonly failures: number }
  | {
      readonly _tag: "retryScheduled";
      readonly failures: number;
      readonly token: object;
      readonly gate: string | undefined;
    };

/**
 * One machine's uploads to one repository: one at a time, and after a failure none before
 * `nextAttemptAt`. A transient failure lets the machine's next connect try once more.
 */
interface RepositoryGate {
  readonly lock: Semaphore.Semaphore;
  readonly environmentId: EnvironmentId;
  readonly key: HubRepository.HubRepositoryKey;
  failures: number;
  nextAttemptAt: number;
  wakeOnConnect: boolean;
  since: string | null;
}

type UploadOutcome =
  | "done"
  | "more"
  | "failed"
  | { readonly _tag: "deferred"; readonly gate: string; readonly at: number };

const sameCapture = (a: OrchestrationV2Checkpoint, b: OrchestrationV2Checkpoint) =>
  a.ref === b.ref && DateTime.toEpochMillis(a.capturedAt) === DateTime.toEpochMillis(b.capturedAt);

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const gateKeyOf = (environmentId: EnvironmentId, key: HubRepository.HubRepositoryKey) =>
  JSON.stringify([environmentId, key.projectId, key.scratchThreadId ?? null]);

const issueKindOf = (failure: HubRepository.HubPushFailure): HubRepositoryUploadIssueKind =>
  failure === "tooLarge" ? "too-large" : failure === "refused" ? "refused" : "failing";

const detailOf = (error: unknown) => {
  const detail =
    typeof error === "object" && error !== null && "detail" in error
      ? String((error as { readonly detail: unknown }).detail)
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { readonly message: unknown }).message)
        : String(error);
  const line = detail.trim().replace(/\s+/gu, " ");
  return line.length > ISSUE_DETAIL_MAX ? `${line.slice(0, ISSUE_DETAIL_MAX - 1)}…` : line;
};

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : "unknown";

/** The backoff after the `failures`-th failure in a row of a repository, with ±20% jitter. */
const repositoryRetryDelayMs = (
  failures: number,
  failure: HubRepository.HubPushFailure,
  unit: number,
) => {
  const cap =
    failure === "tooLarge" || failure === "refused"
      ? REPOSITORY_LASTING_RETRY_CAP
      : REPOSITORY_RETRY_CAP;
  const base =
    Duration.toMillis(REPOSITORY_RETRY_BASE) * 2 ** Math.min(Math.max(failures - 1, 0), 16);
  return Math.round(Math.min(base, Duration.toMillis(cap)) * (0.8 + 0.4 * unit));
};

export const layer: Layer.Layer<
  CheckpointUploads,
  never,
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ThreadCommandExecutor.ThreadCommandExecutor
  | SqlClient.SqlClient
> = Layer.effect(
  CheckpointUploads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    // Which repository each Thread uploads to; absent off the Hub (orchestration-only tests).
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    // Where the Environments list reads why uploads fail; absent where no registry lists them.
    const issues = yield* Effect.serviceOption(HubRepositoryUploadIssues.HubRepositoryUploadIssues);
    /** Each Thread's repository, read once while its Project stays the same. */
    const keys = new Map<ThreadId, HubRepository.HubRepositoryKey>();
    const scope = yield* Effect.scope;
    const uploads = new Map<ThreadId, ThreadUpload>();
    const gates = new Map<string, RepositoryGate>();
    /**
     * Checkpoints whose ref the Thread's machine lacks (captured on the machine it left), with
     * that machine: they wait for the Thread to run where the ref is, and hold back nothing.
     */
    const needsSource = new Map<CheckpointId, EnvironmentId>();

    const gateOf = (environmentId: EnvironmentId, key: HubRepository.HubRepositoryKey) => {
      const gateKey = gateKeyOf(environmentId, key);
      const existing = gates.get(gateKey);
      if (existing !== undefined) return { gateKey, gate: existing };
      const gate: RepositoryGate = {
        lock: Semaphore.makeUnsafe(1),
        environmentId,
        key,
        failures: 0,
        nextAttemptAt: 0,
        wakeOnConnect: false,
        since: null,
      };
      gates.set(gateKey, gate);
      return { gateKey, gate };
    };

    const recordIssue = (
      gateKey: string,
      gate: RepositoryGate,
      issue: Parameters<
        HubRepositoryUploadIssues.HubRepositoryUploadIssues["Service"]["record"]
      >[2],
    ) =>
      Option.isNone(issues) ? Effect.void : issues.value.record(gate.environmentId, gateKey, issue);

    /** Ready checkpoints of the Thread not yet in the Hub's repository, with their workspace. */
    const pendingOf = Effect.fn("CheckpointUploads.pendingOf")(function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly payload: string; readonly cwd: string | null }>`
        SELECT checkpoint.payload_json AS payload,
          json_extract(scope.payload_json, '$.cwd') AS cwd
        FROM orchestration_v2_projection_checkpoints checkpoint
        JOIN orchestration_v2_projection_checkpoint_scopes scope
          ON scope.scope_id = checkpoint.scope_id
        WHERE checkpoint.thread_id = ${threadId}
          AND checkpoint.status = 'ready' AND checkpoint.uploaded_to_hub = 0
        ORDER BY checkpoint.scope_id, checkpoint.ordinal_within_scope
      `;
      const pending: Array<PendingCheckpoint> = [];
      for (const row of rows) {
        if (row.cwd === null) continue;
        pending.push({ checkpoint: yield* decodeCheckpoint(row.payload), cwd: row.cwd });
      }
      return pending;
    });

    /** Marks what was pushed, unless a rollback and a new capture reused its ref meanwhile. */
    const markUploaded = Effect.fn("CheckpointUploads.markUploaded")(function* (
      threadId: ThreadId,
      pushed: ReadonlyArray<PendingCheckpoint>,
    ) {
      return yield* threadLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const { checkpoint } of yield* pendingOf(threadId)) {
            const entry = pushed.find((candidate) => candidate.checkpoint.id === checkpoint.id);
            if (entry === undefined || !sameCapture(entry.checkpoint, checkpoint)) continue;
            needsSource.delete(checkpoint.id);
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "checkpoint.uploaded",
              threadId,
              ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
              nodeId: checkpoint.nodeId,
              occurredAt: now,
              payload: { checkpointId: checkpoint.id },
            });
          }
          if (events.length > 0) yield* eventSink.write({ events });
          return events.length;
        }),
      );
    });

    /**
     * One upload of what is pending: "more" when it marked some (more may have come since),
     * "failed" when the machine was not there to push, "deferred" while (or once) its repository
     * backs off.
     */
    const uploadOnce = Effect.fn("CheckpointUploads.uploadOnce")(function* (
      threadId: ThreadId,
    ): Effect.fn.Return<UploadOutcome, unknown> {
      const [thread] = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `;
      if (thread === undefined) return "done";
      const executor = yield* registry.forThread(threadId);
      const pendingNow = Effect.map(pendingOf(threadId), (pending) =>
        pending.filter(
          ({ checkpoint }) => needsSource.get(checkpoint.id) !== executor.environmentId,
        ),
      );
      if ((yield* pendingNow).length === 0) return "done";
      // A Thread without a Project uploads to its own repository. A failed read fails the
      // upload (it retries), never sends it to another repository.
      const projectId = ProjectId.make(thread.projectId);
      let key = keys.get(threadId);
      if (key === undefined || key.projectId !== projectId) {
        const found = Option.isSome(repositories)
          ? yield* repositories.value.threads.repositoryOfThread(threadId)
          : Option.none<ThreadRepository>();
        if (Option.isNone(found) && Option.isSome(repositories)) return "done";
        key = Option.match(found, { onNone: () => ({ projectId }), onSome: (entry) => entry.key });
        keys.set(threadId, key);
      }
      const repositoryKey = key;
      const { gateKey, gate } = gateOf(executor.environmentId, repositoryKey);
      const deferred = { _tag: "deferred", gate: gateKey } as const;
      if (gate.nextAttemptAt > (yield* Clock.currentTimeMillis)) {
        return { ...deferred, at: gate.nextAttemptAt };
      }
      return yield* gate.lock.withPermits(1)(
        Effect.gen(function* (): Effect.fn.Return<UploadOutcome, unknown> {
          // Another Thread's upload to the same repository may have failed while this one waited.
          if (gate.nextAttemptAt > (yield* Clock.currentTimeMillis)) {
            return { ...deferred, at: gate.nextAttemptAt };
          }
          // Read again under the lock: an upload that just ended may have marked some.
          const pending = yield* pendingNow;
          if (pending.length === 0) return "done";
          const { hubRepository, checkpoints } = executor.workspace;
          const push = (cwd: string, batch: ReadonlyArray<PendingCheckpoint>) =>
            hubRepository
              .push({
                cwd,
                ...HubRepository.keyOf(repositoryKey),
                checkpointRefs: batch.map(({ checkpoint }) => checkpoint.ref),
              })
              .pipe(Effect.result);
          const byWorkspace = new Map<string, Array<PendingCheckpoint>>();
          for (const entry of pending) {
            byWorkspace.set(entry.cwd, [...(byWorkspace.get(entry.cwd) ?? []), entry]);
          }
          const pushed: Array<PendingCheckpoint> = [];
          let failure:
            | { readonly kind: HubRepository.HubPushFailure; readonly error: unknown }
            | undefined;
          let unavailable = false;
          const failWith = (error: unknown) => {
            const kind = HubRepository.classifyPushFailure({
              _tag: tagOf(error),
              detail: detailOf(error),
            });
            if (kind === "unavailable") unavailable = true;
            else failure = { kind, error };
          };
          workspaces: for (const [cwd, entries] of byWorkspace) {
            for (const batch of chunks(entries, MAX_REFS_PER_PUSH)) {
              const result = yield* push(cwd, batch);
              if (result._tag === "Success") {
                pushed.push(...batch);
                continue;
              }
              const kind = HubRepository.classifyPushFailure({
                _tag: tagOf(result.failure),
                detail: detailOf(result.failure),
              });
              if (kind === "missingRef") {
                // A ref the checkout lacks fails the whole push: set those aside, push the rest.
                const present: Array<PendingCheckpoint> = [];
                for (const entry of batch) {
                  const has = yield* checkpoints
                    .hasCheckpointRef({ cwd, checkpointRef: entry.checkpoint.ref })
                    .pipe(Effect.orElseSucceed(() => true));
                  if (has) present.push(entry);
                  else needsSource.set(entry.checkpoint.id, executor.environmentId);
                }
                if (present.length === 0) continue;
                if (present.length === batch.length) {
                  failWith(result.failure);
                  break workspaces;
                }
                const retried = yield* push(cwd, present);
                if (retried._tag === "Success") {
                  pushed.push(...present);
                  continue;
                }
                failWith(retried.failure);
                break workspaces;
              }
              if (kind === "tooLarge" && batch.length > 1) {
                // The newest alone may fit (the workspace got smaller since): it is what a move
                // continues from. The older ones wait for the repository's next attempt.
                const newest = batch.toSorted(
                  (a, b) =>
                    DateTime.toEpochMillis(b.checkpoint.capturedAt) -
                    DateTime.toEpochMillis(a.checkpoint.capturedAt),
                )[0]!;
                const alone = yield* push(cwd, [newest]);
                if (alone._tag === "Success") pushed.push(newest);
              }
              failWith(result.failure);
              break workspaces;
            }
          }
          const marked = pushed.length === 0 ? 0 : yield* markUploaded(threadId, pushed);
          if (unavailable) return "failed";
          const now = yield* Clock.currentTimeMillis;
          if (failure !== undefined) {
            gate.failures += 1;
            const delay = repositoryRetryDelayMs(gate.failures, failure.kind, yield* Random.next);
            gate.nextAttemptAt = now + delay;
            gate.wakeOnConnect = failure.kind === "transient";
            gate.since ??= DateTime.formatIso(DateTime.makeUnsafe(now));
            const left = (yield* pendingNow).length;
            yield* Effect.logWarning("Checkpoint upload to the Hub repository failed", {
              threadId,
              environmentId: executor.environmentId,
              projectId: repositoryKey.projectId,
              kind: failure.kind,
              failures: gate.failures,
              retryInMs: delay,
              detail: detailOf(failure.error),
            });
            yield* recordIssue(gateKey, gate, {
              projectId: repositoryKey.projectId,
              ...(repositoryKey.scratchThreadId === undefined
                ? {}
                : { threadId: repositoryKey.scratchThreadId }),
              kind: issueKindOf(failure.kind),
              detail: detailOf(failure.error),
              since: gate.since,
              nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(gate.nextAttemptAt)),
              pendingCheckpoints: left,
            });
            return { ...deferred, at: gate.nextAttemptAt };
          }
          if (gate.failures > 0 || gate.since !== null) {
            gate.failures = 0;
            gate.nextAttemptAt = 0;
            gate.wakeOnConnect = false;
            gate.since = null;
            yield* recordIssue(gateKey, gate, null);
          }
          return marked > 0 ? "more" : "done";
        }),
      );
    });

    /** The Thread's next run at `at`, unless something supersedes it meanwhile. */
    const scheduleRetry = Effect.fn("CheckpointUploads.scheduleRetry")(function* (
      threadId: ThreadId,
      failures: number,
      gate: string | undefined,
      at: number,
    ) {
      const token = {};
      uploads.set(threadId, { _tag: "retryScheduled", failures, token, gate });
      const delay = Math.max(0, at - (yield* Clock.currentTimeMillis));
      yield* Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const waiting = uploads.get(threadId);
            if (waiting?._tag !== "retryScheduled" || waiting.token !== token) {
              return Effect.void;
            }
            uploads.set(threadId, { _tag: "running", again: false, failures: waiting.failures });
            return run(threadId);
          }),
        ),
        Effect.forkIn(scope),
      );
    });

    const start = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.suspend(() => {
          const current = uploads.get(threadId);
          if (current?._tag === "running") {
            current.again = true;
            return Effect.void;
          }
          // Its repository backs off: the retry already waiting runs it then, not this.
          if (current?._tag === "retryScheduled" && current.gate !== undefined) {
            const gate = gates.get(current.gate);
            if (gate !== undefined && gate.nextAttemptAt > now) return Effect.void;
          }
          // A retry waiting is superseded: its token no longer matches, so it does nothing.
          uploads.set(threadId, {
            _tag: "running",
            again: false,
            failures: current?.failures ?? 0,
          });
          return run(threadId).pipe(Effect.forkIn(scope), Effect.asVoid);
        }),
      );

    const run: (threadId: ThreadId) => Effect.Effect<void> = Effect.fn("CheckpointUploads.run")(
      function* (threadId: ThreadId) {
        while (true) {
          const state = uploads.get(threadId);
          if (state?._tag !== "running") return;
          state.again = false;
          const outcome = yield* uploadOnce(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Checkpoint upload to the Hub repository failed", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as const)),
            ),
          );
          if (outcome === "more" || (outcome === "done" && state.again)) continue;
          if (outcome === "done") {
            uploads.delete(threadId);
            return;
          }
          if (outcome !== "failed") {
            return yield* scheduleRetry(threadId, state.failures, outcome.gate, outcome.at);
          }
          const delay = Duration.min(
            Duration.times(RETRY_BASE, 2 ** Math.min(state.failures, 16)),
            RETRY_CAP,
          );
          const now = yield* Clock.currentTimeMillis;
          return yield* scheduleRetry(
            threadId,
            state.failures + 1,
            undefined,
            now + Duration.toMillis(delay),
          );
        }
      },
    );

    // A connecting Environment may be where a failed upload has to run: try those now. A
    // repository that backs off is tried once more only after a transient failure, and only once
    // its machine is back.
    const changes = yield* registry.changes;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (const gate of gates.values()) {
            if (!gate.wakeOnConnect) continue;
            const back = yield* registry.get(gate.environmentId).pipe(Effect.option);
            if (Option.isNone(back)) continue;
            gate.wakeOnConnect = false;
            gate.nextAttemptAt = 0;
          }
          yield* Effect.forEach(
            [...uploads].flatMap(([threadId, state]) =>
              state._tag === "retryScheduled" ? [threadId] : [],
            ),
            start,
            { discard: true },
          );
        }),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );

    // Requests come from inside effects; uploads start from here so they carry none of their
    // context (the effect's Environment, its idempotency keys).
    const requests = yield* Queue.unbounded<ThreadId>();
    yield* Queue.take(requests).pipe(Effect.flatMap(start), Effect.forever, Effect.forkIn(scope));

    // What a previous run left pending, such as uploads that failed until the Hub stopped.
    yield* sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId" FROM orchestration_v2_projection_checkpoints
      WHERE status = 'ready' AND uploaded_to_hub = 0
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => start(ThreadId.make(row.threadId)), { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not list the checkpoints left to upload", { cause }),
      ),
      Effect.forkIn(scope),
    );

    return CheckpointUploads.of({
      request: Effect.fn("CheckpointUploads.request")(function* (threadId) {
        yield* Queue.offer(requests, threadId);
      }),
    });
  }),
);
