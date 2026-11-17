/**
 * A removed machine's Threads end their turns and need an environment; a returning machine
 * hands over, one Thread at a time, changes kept in moved Threads' own worktrees (never a shared
 * checkout) on a branch of the Hub. See docs/internals/overview.md, «Disconnections».
 */
import {
  CheckpointRef,
  CommandId,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItem,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as EventSink from "./EventSink.ts";
import { interruptRunsOnHub } from "./HubRunInterrupt.ts";
import { drainLentSandbox } from "./LentSandboxDrain.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2TurnItemJson));

/** A file- and ref-safe instant: one path segment of `refs/t3/recovered/<threadId>/return/`. */
const stampOf = (now: DateTime.Utc) => DateTime.formatIso(now).replace(/[:.]/g, "-");

/** What a machine was last known to hold of a Thread that moved away from it. */
interface FormerThread {
  readonly threadId: ThreadId;
  /** The latest move away from the machine. */
  readonly moveId: string;
  readonly sourceOffline: boolean;
  /** What the machine last handed over: the move's checkpoint, or a later recovery. */
  readonly baseRef: string | null;
  /** Trees already recovered from `baseRef`'s line, never handed over again. */
  readonly knownTrees: ReadonlyArray<string>;
}

export const layer: Layer.Layer<
  never,
  never,
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ThreadCommandExecutor.ThreadCommandExecutor
  | ProjectionStore.ProjectionStoreV2
  | Orchestrator.OrchestratorV2
  | TurnItemPositionStore.TurnItemPositionStoreV2
  | SqlClient.SqlClient
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const executors = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    // The server provides these; orchestration-only hosts join no machines.
    const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    const scope = yield* Effect.scope;

    const logged =
      (message: string, detail: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning(message, { ...detail, cause: Cause.pretty(cause) }),
          ),
          Effect.asVoid,
        );

    const nameOf = (environmentId: EnvironmentId) =>
      sql<{ readonly name: string }>`
        SELECT name FROM environments WHERE environment_id = ${environmentId}
      `.pipe(
        Effect.map((rows) => rows[0]?.name ?? environmentId),
        Effect.orElseSucceed(() => environmentId as string),
      );

    /**
     * Every Thread on a removed Environment (or only `environmentId`'s), and at startup every
     * Thread on a Hub machine that no longer runs Threads, has none from now on:
     * «needs an environment», its history intact, until it moves. Its unfinished turns end on the
     * Hub, whatever the Hub still knows of their sessions (nothing, after a restart).
     */
    const releaseRemoved = Effect.fn("EnvironmentReturns.releaseRemoved")(function* (
      environmentId?: EnvironmentId,
    ) {
      // A Hub machine that runs no Threads (`T3CODE_HUB_RUNS_AGENTS` off) is gone for its Threads
      // as a removed machine is: checked as the Hub starts.
      const hubMachineGone =
        environmentId === undefined &&
        Option.isSome(environments) &&
        !environments.value.hubRunsAgents;
      // So is a Sandbox once the Owner turned Sandboxes off (T3CODE_SANDBOX_RUNTIME=off). A
      // runtime away for now (its image not built after an upgrade, Podman failing) is not:
      // those Threads wait, offline, for it to come back.
      const sandboxesGone =
        environmentId === undefined &&
        Option.isSome(environments) &&
        environments.value.sandboxesTurnedOff;
      const rows = yield* sql<{
        readonly threadId: string;
        readonly environmentId: string;
        readonly kind: string;
        readonly mode: string;
        readonly revoked: number;
      }>`
        SELECT thread.thread_id AS "threadId", thread.active_environment_id AS "environmentId",
          environments.kind AS kind, environments.mode AS mode,
          environments.revoked_at IS NOT NULL AS revoked
        FROM orchestration_v2_projection_threads thread
        JOIN environments ON environments.environment_id = thread.active_environment_id
        WHERE thread.deleted_at IS NULL
          AND (environments.revoked_at IS NOT NULL
            OR (${hubMachineGone ? 1 : 0} = 1 AND environments.kind = 'hub')
            OR (${sandboxesGone ? 1 : 0} = 1 AND environments.kind = 'sandbox'
              AND environments.mode = 'sandbox'))
          AND (${environmentId ?? null} IS NULL OR environments.environment_id = ${environmentId ?? null})
      `;
      const released: Array<{
        readonly threadId: ThreadId;
        readonly name: string;
        readonly why: "removed" | "lent-ended" | "hub-machine" | "no-sandboxes";
      }> = [];
      for (const row of rows) {
        const threadId = ThreadId.make(row.threadId);
        const why =
          row.revoked === 1
            ? row.mode === "lent"
              ? "lent-ended"
              : "removed"
            : row.kind === "hub"
              ? "hub-machine"
              : "no-sandboxes";
        const name = yield* nameOf(row.environmentId as EnvironmentId);
        yield* threadLocks.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(threadId);
            // A Thread on the Hub machine may name none: absent means the Hub machine.
            if ((thread.activeEnvironmentId ?? HUB_MACHINE_ENVIRONMENT_ID) !== row.environmentId) {
              return;
            }
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "thread.metadata-updated",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: now,
                  payload: { ...thread, activeEnvironmentId: null },
                },
              ],
            });
          }),
        );
        released.push({ threadId, name, why });
      }
      // Threads already without an Environment (released before a restart) whose turns did not
      // end yet end now too.
      const stranded =
        environmentId !== undefined
          ? []
          : yield* sql<{ readonly threadId: string }>`
              SELECT DISTINCT thread.thread_id AS "threadId"
              FROM orchestration_v2_projection_threads thread
              JOIN orchestration_v2_projection_runs run ON run.thread_id = thread.thread_id
              WHERE thread.active_environment_id IS NULL AND thread.deleted_at IS NULL
                AND run.status IN ('preparing', 'starting', 'running', 'waiting')
            `;
      for (const row of stranded) {
        released.push({
          threadId: ThreadId.make(row.threadId),
          name: "Its Environment",
          why: "removed",
        });
      }
      // Outside the Thread's lock: ending a turn is a command, which takes it.
      for (const { threadId, name, why } of released) {
        yield* interruptRunsOnHub(orchestrator, {
          threadId,
          reason:
            why === "hub-machine"
              ? "The Hub machine no longer runs Threads, so this turn ended. Move the Thread to another Environment to continue."
              : why === "no-sandboxes"
                ? `This Hub no longer runs Sandboxes, so ${name} cannot go on with this turn. Move the Thread to another Environment to continue.`
                : why === "lent-ended"
                  ? `${name} is no longer lent to this Space, so this turn ended. Move the Thread to another Environment to continue.`
                  : `${name} was removed from the Hub while this turn ran there. Move the Thread to another Environment to continue.`,
          key: "environment-removed",
        });
      }
    });

    /** Threads on the Environment with a turn not finished. */
    const runningThreadsOn = (environmentId: EnvironmentId) =>
      sql<{ readonly threadId: string }>`
        SELECT DISTINCT thread.thread_id AS "threadId"
        FROM orchestration_v2_projection_threads thread
        JOIN orchestration_v2_projection_runs run ON run.thread_id = thread.thread_id
        WHERE thread.active_environment_id = ${environmentId} AND thread.deleted_at IS NULL
          AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      `.pipe(Effect.orElseSucceed(() => []));

    /** Stop, as a person's Stop does: the machine ends each turn and uploads its checkpoint. */
    const stopRunsOn = Effect.fn("EnvironmentReturns.stopRunsOn")(function* (
      environmentId: EnvironmentId,
    ) {
      const at = yield* DateTime.now;
      for (const row of yield* runningThreadsOn(environmentId)) {
        const threadId = ThreadId.make(row.threadId);
        yield* orchestrator
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(
              `server:lent-ended:${threadId}:${DateTime.toEpochMillis(at)}`,
            ),
            threadId,
            reason: "The machine's loan to this Space ended.",
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not stop a turn on a lent Sandbox", { threadId, cause }),
            ),
          );
      }
    });

    /** No turn running there, and no checkpoint of its Threads left to upload. */
    const idleOn = (environmentId: EnvironmentId) =>
      sql<{ readonly busy: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads thread
          JOIN orchestration_v2_projection_runs run ON run.thread_id = thread.thread_id
          WHERE thread.active_environment_id = ${environmentId} AND thread.deleted_at IS NULL
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads thread
          JOIN orchestration_v2_projection_checkpoints checkpoint
            ON checkpoint.thread_id = thread.thread_id
          WHERE thread.active_environment_id = ${environmentId} AND thread.deleted_at IS NULL
            AND checkpoint.status = 'ready' AND checkpoint.uploaded_to_hub = 0
        ) AS busy
      `.pipe(
        Effect.map((rows) => rows[0]?.busy !== 1),
        Effect.orElseSucceed(() => true),
      );

    /**
     * Archived Threads left on a machine dedicated elsewhere (or made personal): they need an
     * environment from now on, so unarchiving one never puts it back on a machine not its own.
     */
    const releaseThreads = Effect.fn("EnvironmentReturns.releaseThreads")(function* (
      environmentId: EnvironmentId,
      threadIds: ReadonlyArray<ThreadId>,
    ) {
      for (const threadId of threadIds) {
        yield* threadLocks.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(threadId);
            if (thread.activeEnvironmentId !== environmentId) return;
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "thread.metadata-updated",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: now,
                  payload: { ...thread, activeEnvironmentId: null },
                },
              ],
            });
          }),
        );
      }
    });

    /**
     * The Threads that moved away from the machine and run elsewhere now, with what each was
     * last known to hold there: the checkpoint it continued from, or what was recovered since.
     */
    const formerThreads = Effect.fn("EnvironmentReturns.formerThreads")(function* (
      environmentId: EnvironmentId,
      only?: ThreadId,
    ) {
      const rows = yield* sql<{ readonly threadId: string; readonly payload: string }>`
        SELECT item.thread_id AS "threadId", item.payload_json AS payload
        FROM orchestration_v2_projection_turn_items item
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = item.thread_id
        WHERE thread.deleted_at IS NULL
          AND (${only ?? null} IS NULL OR thread.thread_id = ${only ?? null})
          AND (thread.active_environment_id IS NULL OR thread.active_environment_id != ${environmentId})
          AND (
            (item.type = 'environment_move'
              AND json_extract(item.payload_json, '$.sourceEnvironmentId') = ${environmentId}
              AND json_extract(item.payload_json, '$.outcome') IS NOT 'cancelled')
            OR (item.type = 'recovered_changes'
              AND json_extract(item.payload_json, '$.environmentId') = ${environmentId})
          )
        ORDER BY item.updated_at, item.turn_item_id
      `;
      const latest = new Map<ThreadId, FormerThread>();
      for (const row of rows) {
        const item = decodeItem(row.payload);
        if (Option.isNone(item)) continue;
        const threadId = ThreadId.make(row.threadId);
        if (item.value.type === "environment_move") {
          latest.set(threadId, {
            threadId,
            moveId: item.value.moveId,
            sourceOffline: item.value.sourceOffline,
            baseRef: item.value.continuesFrom.ref,
            knownTrees: [],
          });
        } else if (item.value.type === "recovered_changes") {
          const known = latest.get(threadId);
          if (known === undefined) continue;
          latest.set(threadId, {
            ...known,
            baseRef: item.value.ref,
            knownTrees:
              item.value.tree === undefined
                ? known.knownTrees
                : [...known.knownTrees, item.value.tree],
          });
        }
      }
      return [...latest.values()];
    });

    /** A notice of the Thread's own, after its latest run's items: its place is when it happened. */
    const noticeEvent = Effect.fn("EnvironmentReturns.noticeEvent")(function* (
      threadId: ThreadId,
      now: DateTime.Utc,
      item: (base: {
        readonly id: TurnItemId;
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
        readonly nodeId: null;
        readonly providerThreadId: null;
        readonly providerTurnId: null;
        readonly nativeItemRef: null;
        readonly parentItemId: null;
        readonly ordinal: number;
        readonly status: "completed";
        readonly startedAt: DateTime.Utc;
        readonly completedAt: DateTime.Utc;
        readonly updatedAt: DateTime.Utc;
      }) => OrchestrationV2TurnItem,
      id: TurnItemId,
    ) {
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
        turnItemTypes: [],
      });
      const latestRun = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const ordinal = yield* positions.allocate({
        threadId,
        turnItemId: id,
        runId: null,
        runOrdinal: latestRun?.ordinal ?? 0,
      });
      const current = yield* projections.getThread(threadId);
      return {
        id: yield* ids.allocate.event({ threadId }),
        type: "turn-item.updated" as const,
        threadId,
        providerInstanceId: current.providerInstanceId,
        occurredAt: now,
        payload: item({
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        }),
      };
    });

    /** Asks the machine for what it kept of one Thread that left it; under the Thread's lock. */
    const recoverThread = Effect.fn("EnvironmentReturns.recoverThread")(function* (
      executor: EnvironmentExecutor.EnvironmentExecutor,
      former: FormerThread,
    ) {
      const environmentId = executor.environmentId;
      const { threadId } = former;
      const thread = yield* projections.getThread(threadId);
      // A move under way to or from this machine settles first; it asks again when it ends.
      const move = thread.move;
      if (
        move != null &&
        move.status === "running" &&
        (move.sourceEnvironmentId === environmentId || move.targetEnvironmentId === environmentId)
      ) {
        return;
      }
      const environmentName = yield* nameOf(environmentId);
      const worktree = thread.move?.knownWorktrees?.[environmentId];
      if (worktree === undefined) {
        // It ran in the shared checkout there: never read, since others share it. Only a move
        // made while the machine was away can have left something behind; say where.
        if (!former.sourceOffline) return;
        const id = TurnItemId.make(
          `turn-item:changes-may-remain:${threadId}:${environmentId}:${former.moveId}`,
        );
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["system_notice"],
        });
        if (turnItems.some((item) => item.id === id)) return;
        const checkout = yield* executor.workspace.paths.checkout(thread.projectId);
        const where = Option.isSome(checkout) ? checkout.value : "the Project's checkout";
        const now = yield* DateTime.now;
        yield* threadLocks.withLock(
          threadId,
          Effect.gen(function* () {
            yield* eventSink.write({
              events: [
                yield* noticeEvent(
                  threadId,
                  now,
                  (base) => ({
                    ...base,
                    title: `Changes may remain on ${environmentName}`,
                    type: "system_notice",
                    message: `Changes made on ${environmentName} after this Thread's last upload may remain in ${where} on ${environmentName}. That folder is shared, so they were not collected.`,
                  }),
                  id,
                ),
              ],
            });
          }),
        );
        return;
      }
      const repository = Option.isNone(repositories)
        ? undefined
        : Option.getOrUndefined(yield* repositories.value.threads.repositoryOfThread(threadId));
      const key = repository?.key ?? { projectId: thread.projectId };
      const now = yield* DateTime.now;
      const recoveredRef = CheckpointRef.make(
        `${HubRepository.threadRefPrefixes(threadId)[1]}return/${stampOf(now)}`,
      );
      // The machine may create exactly this ref, once, for a short while.
      if (Option.isSome(remote)) {
        yield* remote.value.grantRecovery({ environmentId, key, ref: recoveredRef });
      }
      yield* threadLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const result = yield* executor.workspace.move.recover({
            cwd: worktree,
            projectId: thread.projectId,
            threadId,
            ...(key.scratchThreadId === undefined ? {} : { scratchThreadId: key.scratchThreadId }),
            baseRef: former.baseRef === null ? null : CheckpointRef.make(former.baseRef),
            recoveredRef,
            knownTrees: former.knownTrees,
          });
          if (result.status !== "recovered") return;
          yield* eventSink.write({
            events: [
              yield* noticeEvent(
                threadId,
                now,
                (base) => ({
                  ...base,
                  title: `Recovered changes from ${environmentName}`,
                  type: "recovered_changes",
                  environmentId,
                  environmentName,
                  ref: recoveredRef,
                  baseRef: former.baseRef,
                  ...(result.tree === undefined ? {} : { tree: result.tree }),
                }),
                TurnItemId.make(`turn-item:recovered-changes:${recoveredRef}`),
              ),
            ],
          });
        }),
      );
    });

    // One machine is asked about one Thread at a time, so a machine that flaps never hands over
    // the same changes twice.
    const perMachine = new Map<EnvironmentId, Semaphore.Semaphore>();
    const machineLock = Effect.fn("EnvironmentReturns.machineLock")(function* (
      environmentId: EnvironmentId,
    ) {
      const known = perMachine.get(environmentId);
      if (known !== undefined) return known;
      const made = yield* Semaphore.make(1);
      perMachine.set(environmentId, made);
      return made;
    });

    const recoverOn = Effect.fn("EnvironmentReturns.recoverOn")(function* (
      environmentId: EnvironmentId,
      only?: ThreadId,
    ) {
      const lock = yield* machineLock(environmentId);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          // The machine as it is connected now, each time: a socket replaced meanwhile is used.
          const executor = yield* executors.get(environmentId).pipe(Effect.option);
          if (Option.isNone(executor)) return;
          for (const former of yield* formerThreads(environmentId, only)) {
            yield* recoverThread(executor.value, former).pipe(
              logged("Could not look for a moved Thread's changes on its former machine", {
                environmentId,
                threadId: former.threadId,
              }),
            );
          }
        }),
      );
    });

    // A machine that connects (again) hands over what it kept of the Threads that left it.
    const known = new Map<EnvironmentId, EnvironmentExecutor.EnvironmentExecutor>();
    const lookAtConnected = Effect.gen(function* () {
      const connected = new Set(yield* executors.list);
      for (const environmentId of known.keys()) {
        if (!connected.has(environmentId)) known.delete(environmentId);
      }
      for (const environmentId of connected) {
        if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) continue;
        const executor = yield* executors.get(environmentId).pipe(Effect.option);
        if (Option.isNone(executor) || known.get(environmentId) === executor.value) continue;
        known.set(environmentId, executor.value);
        yield* recoverOn(environmentId).pipe(
          logged("Could not look for recovered changes", { environmentId }),
          Effect.forkIn(scope),
        );
      }
    });
    const changes = yield* executors.changes;
    yield* lookAtConnected;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(lookAtConnected),
      Effect.forever,
      Effect.forkIn(scope),
    );

    // A move skipped above is looked at again once it ends, on the machines it involved.
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "thread.move-updated") return Effect.void;
        const move = event.payload.move;
        if (move == null || move.status === "running") return Effect.void;
        return Effect.forEach(
          [move.sourceEnvironmentId, move.targetEnvironmentId],
          (environmentId) =>
            environmentId === null || environmentId === HUB_MACHINE_ENVIRONMENT_ID
              ? Effect.void
              : recoverOn(environmentId, event.threadId).pipe(
                  logged("Could not look for recovered changes after a move", { environmentId }),
                  Effect.forkIn(scope),
                ),
          { discard: true },
        );
      }),
      logged("Recovered changes stopped following moves", {}),
      Effect.forkIn(scope),
    );

    // A removed machine's sessions end and its Threads need an environment, at once and after a
    // restart for removals the Hub did not get to.
    if (Option.isSome(environments)) {
      yield* environments.value.released.pipe(
        Stream.runForEach(({ environmentId, threadIds }) =>
          releaseThreads(environmentId, threadIds).pipe(
            logged("Could not release a rededicated machine's archived Threads", {
              environmentId,
            }),
          ),
        ),
        Effect.forkIn(scope),
      );
      yield* environments.value.removed.pipe(
        Stream.runForEach((environmentId) =>
          (Option.isSome(remote)
            ? remote.value.environmentRemoved(environmentId)
            : Effect.void
          ).pipe(
            Effect.andThen(releaseRemoved(environmentId)),
            logged("Could not release a removed Environment's Threads", { environmentId }),
          ),
        ),
        Effect.forkIn(scope),
      );
      // Grants ticket 10: a lent Sandbox whose loan ended stops its turns (each uploads its
      // checkpoint as any stop does) for a while before it is closed and its Threads released.
      const registry = environments.value;
      yield* registry.lentEndings.pipe(
        Stream.runForEach(({ grantId, environmentId }) =>
          drainLentSandbox({
            stopRunning: stopRunsOn(environmentId),
            idle: idleOn(environmentId),
            close: registry
              .finishLentSandbox(grantId)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not close a lent Sandbox", { grantId, cause }),
                ),
              ),
            drainMs: EnvironmentRegistry.LENT_DRAIN_MS,
          }).pipe(
            logged("Could not stop a lent Sandbox's turns", { environmentId }),
            Effect.forkIn(scope),
          ),
        ),
        Effect.forkIn(scope),
      );
    }
    // A Sandbox stopped for its disk or by the Owner: its turns end interrupted, with why.
    if (Option.isSome(environments) && Option.isSome(remote)) {
      yield* environments.value.sandboxSessionsEnded.pipe(
        Stream.runForEach(({ environmentId, reason }) =>
          remote.value
            .sandboxSessionsEnded(environmentId, reason)
            .pipe(logged("Could not end a stopped Sandbox's sessions", { environmentId })),
        ),
        Effect.forkIn(scope),
      );
    }
    // Before the Hub recovers its runs (serverRuntimeStartup), never beside it: a Thread left on a
    // machine that runs nothing here must not be continued there first.
    yield* releaseRemoved().pipe(
      logged("Could not release the Threads of removed Environments", {}),
      Effect.ignore,
    );
  }),
);
