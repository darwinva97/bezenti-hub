import type {
  EnvironmentId,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  CommandId,
  HUB_MACHINE_ENVIRONMENT_ID,
  isListedThreadLineage,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  OrchestrationGetWorkflowScriptError,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderSessionId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
  type UserId,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as AiAccountChoice from "../ai/AiAccountChoice.ts";
import * as ServerConfig from "../config.ts";
import { makeScratchThreads } from "../environment/ScratchWorkspace.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import { readThreadWorkflowScript } from "./workflowScriptQuery.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import type * as AccessPolicy from "../auth/AccessPolicy.ts";

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** The session's User; a new Thread is theirs whatever the client sent. */
  readonly ownerUserId?: UserId;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create": {
      // Only the server stamps a Thread's owner, so a client cannot set one.
      const { ownerUserId: _ownerUserId, ...rest } = command;
      return { ...rest, ...provenance };
    }
    case "thread.move": {
      // Who moves it is the sender, never what a client claims.
      const { ownerUserId: _ownerUserId, ...rest } = command;
      return provenance.ownerUserId === undefined
        ? rest
        : { ...rest, ownerUserId: provenance.ownerUserId };
    }
    case "message.dispatch":
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return {
        ...command,
        createdBy: provenance.createdBy,
        creationSource: provenance.creationSource,
      };
    default:
      return command;
  }
}

function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark and open stats; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.orphan.settle":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
  /**
   * Also wait until the thread's own delegated work settles: an ended run
   * still owes the thread's answer while a child, a background task or a
   * completion delivery will wake it again, as a delegated task's result does.
   */
  readonly untilDelegatedWorkSettled?: boolean;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
  /** With `untilDelegatedWorkSettled`, once settled: the run with the thread's final answer. */
  readonly resultRun?: OrchestrationV2Run;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.projectId === undefined
      ? "Unable to list threads."
      : `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export class ThreadManagementBackgroundWaitError extends Schema.TaggedError<ThreadManagementBackgroundWaitError>()(
  "ThreadManagementBackgroundWaitError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["unsupported", "unavailable", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This provider cannot mark background work as awaited.";
      case "unavailable":
        return "This thread has no live provider session.";
      case "failed":
        return "Failed to update the awaited background work.";
    }
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  /**
   * Refuses the action on the Thread when the current `CommandActor` may not take it: not found
   * when it is hidden from them, a permission error when they can see it.
   */
  readonly authorizeThread: (
    threadId: ThreadId,
    action: AccessPolicy.Action,
  ) => Effect.Effect<void, SpaceDirectory.ItemAccessError>;
  /** A new Thread is claimed for its Space here, so every caller is checked and stamped. */
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  /**
   * A workflow script a workflow of the Thread, or of a Thread below it the request may see
   * (`RequestVisibility`), recorded; any other path answers not-found.
   */
  readonly getWorkflowScript: (input: {
    readonly threadId: ThreadId;
    readonly scriptPath: string;
  }) => Effect.Effect<
    { readonly scriptPath: string; readonly contents: string; readonly truncated: boolean },
    OrchestrationGetWorkflowScriptError
  >;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadTranscript,
    Orchestrator.OrchestratorV2Error | ThreadTranscriptTooLargeError,
    ServerEnvironment.ServerEnvironmentIdentity
  >;
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getAgentAwarenessSnapshot: Orchestrator.OrchestratorV2["Service"]["getAgentAwarenessSnapshot"];
  readonly getShellSnapshot: (
    options?: Pick<
      ShellSnapshotOptions,
      "location" | "projectId" | "unsettledOnly" | "worktreePath" | "threadIds"
    >,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>;
  readonly listActiveSubagentThreadIds: Orchestrator.OrchestratorV2["Service"]["listActiveSubagentThreadIds"];
  readonly countThreads: Orchestrator.OrchestratorV2["Service"]["countThreads"];
  readonly listActiveShellIndex: Orchestrator.OrchestratorV2["Service"]["listActiveShellIndex"];
  readonly listOlderSettledThreads: Orchestrator.OrchestratorV2["Service"]["listOlderSettledThreads"];
  readonly readShellSnapshot: (
    options?: Pick<
      ShellSnapshotOptions,
      "location" | "familyOf" | "worktreePath" | "threadIds" | "spaceIds"
    >,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listAppOwnedChildThreadIds: Orchestrator.OrchestratorV2["Service"]["listAppOwnedChildThreadIds"];
  /** Omit `projectId` to list every project's threads. Side chats are never listed. */
  readonly listProjectThreads: (input: {
    readonly projectId?: ProjectId | undefined;
    readonly includeSubagents: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /** Receipt replays start no work; skip enablement checks with the same command id so settings cannot reject accepted retries. */
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /** Waits for the agent's run to end before settling its thread and stopping the session.
   * Other endings or settle refusals leave the thread active. */
  readonly settleAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly byOwnAgent: boolean;
  }) => Effect.Effect<
    { readonly sequence: number } | { readonly settlesWhenTurnEnds: true },
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Kills the thread's agent for a provider that no longer responds, then ends
   * its turn as interrupted. Never kills a process other working threads share.
   */
  readonly forceStopThread: (
    input: OrchestrationV2ForceStopThreadInput,
  ) => Effect.Effect<OrchestrationV2ForceStopThreadResult, OrchestrationV2ForceStopThreadError>;
  readonly awaitBackgroundTasks: (input: {
    readonly threadId: ThreadId;
    readonly taskIds: ReadonlyArray<string>;
    readonly awaited: boolean;
  }) => Effect.Effect<
    { readonly matched: ReadonlyArray<string>; readonly unmatched: ReadonlyArray<string> },
    ThreadManagementBackgroundWaitError
  >;
  readonly stopDelegatedTasks: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    void,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export function isTerminalRunStatus(
  status: OrchestrationV2Run["status"],
): status is ThreadManagementTerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "rolled_back"
  );
}

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestSteerableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
const FORCE_STOP_REASON = "Force stopped by user";
const FORCE_STOP_RELEASE_WAIT = "10 seconds";
const isForceStopThreadError = Schema.is(OrchestrationV2ForceStopThreadError);

/** A turn that is under way; on a machine that went offline it is paused until it returns. */
const PAUSABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Commands decided with the Thread's machine: a stopped Sandbox starts for them first. */
const MACHINE_DECIDED_COMMANDS: ReadonlySet<string> = new Set([
  "message.dispatch",
  "checkpoint.rollback",
  "provider.switch",
  "queued-run.start",
  "queue.resume",
  "queued-message.promote-to-steer",
]);

const makeWith = Effect.fn("ThreadManagementService.make")(function* (
  spaces: Option.Option<SpaceDirectory.SpaceDirectory["Service"]>,
  environments: Option.Option<EnvironmentRegistry.EnvironmentRegistry["Service"]> = Option.none(),
) {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const agentScope = yield* AgentScope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  // Which machines are connected right now; absent on hosts that run nothing remote.
  const executors = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  // Sandboxes the Hub starts for work; absent on a Hub without a Sandbox runtime.
  const demand = yield* Effect.serviceOption(EnvironmentDemand.EnvironmentDemand);
  // A Thread without a Project works in its own scratch folder, which any Environment makes.
  const scratchThreads = Option.map(
    Option.all({
      config: yield* Effect.serviceOption(ServerConfig.ServerConfig),
      path: yield* Effect.serviceOption(Path.Path),
      sql: yield* Effect.serviceOption(SqlClient.SqlClient),
    }),
    ({ config, path, sql }) => makeScratchThreads({ sql, path, baseDir: config.baseDir }),
  );
  const isScratchWorkspace = (projectId: ProjectId, worktreePath: string) =>
    Option.match(scratchThreads, {
      onNone: () => Effect.succeed(false),
      onSome: (threads) =>
        threads.isScratchFolder(projectId, worktreePath).pipe(Effect.orElseSucceed(() => false)),
    });

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) =>
                  resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId)
                    ? Effect.void
                    : new ThreadManagementProviderInstanceDisabledError({
                        projectId: input.projectId,
                        instanceId: input.instanceId,
                      }),
                ),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.isSome),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );
  // Full-thread exports can otherwise hold every SQLite reader and stall ordinary thread opens.
  const transcriptExportPermits = yield* Semaphore.make(2);
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      const { projection } = yield* getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
    transcriptExportPermits.withPermits(1),
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
    );

  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      case "prepared-run.release":
      case "prepared-run.retry":
        return orchestrator
          .getThreadRecords(command.threadId, ["runs"], { runIds: [command.runId] })
          .pipe(
            Effect.flatMap((projection) => {
              const run = projection.runs.find((candidate) => candidate.id === command.runId);
              return run === undefined
                ? Effect.void
                : assertProviderInstanceEnabled({
                    projectId: projection.thread.projectId,
                    commandId: command.commandId,
                    instanceId: run.providerInstanceId,
                  });
            }),
          );
      default:
        return Effect.void;
    }
  };

  // `ownerUserId` on a thread.create is the session's User, put there by the transport.
  const claimThreadSpace = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> => {
    if (command.type !== "thread.create" || Option.isNone(spaces)) return Effect.succeed(command);
    const { spaceId, ownerUserId, ...rest } = command;
    // A request with no User is refused here rather than created as the Owner's.
    return spaces.value.actingUser.pipe(
      Effect.flatMap((actor) =>
        spaces.value.claimCreation({
          action: "thread.create",
          actorUserId: ownerUserId ?? Option.getOrUndefined(actor),
          spaceId,
          projectId: command.projectId,
        }),
      ),
      Effect.map((stamp) => (stamp === undefined ? rest : { ...rest, ...stamp })),
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  };

  // The Hub, not the client, decides where a new Thread runs, and checks a requested choice.
  const placeThread = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> => {
    if (command.type !== "thread.create") return Effect.succeed(command);
    const reject = (cause: unknown) =>
      new Orchestrator.OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    if (Option.isNone(environments)) {
      // Without the Hub's Environments (orchestration-only hosts) only the Hub machine exists.
      return command.activeEnvironmentId === undefined ||
        command.activeEnvironmentId === HUB_MACHINE_ENVIRONMENT_ID
        ? Effect.succeed(command)
        : Effect.fail(reject("Only the Hub machine runs Threads here."));
    }
    return environments.value
      .chooseForThread({
        userId: command.ownerUserId,
        requested: command.activeEnvironmentId,
        projectId: command.projectId,
        providerInstanceId: command.modelSelection.instanceId,
        spaceId: command.spaceId,
      })
      .pipe(
        Effect.flatMap((activeEnvironmentId) => {
          const placed = Effect.succeed({ ...command, activeEnvironmentId });
          const worktreePath = command.worktreePath;
          if (activeEnvironmentId === HUB_MACHINE_ENVIRONMENT_ID || worktreePath === null) {
            return placed;
          }
          // Worktrees are still made on the Hub machine only; a scratch folder anywhere.
          return isScratchWorkspace(command.projectId, worktreePath).pipe(
            Effect.flatMap((scratch) =>
              scratch
                ? placed
                : Effect.fail(
                    new EnvironmentRegistry.ThreadEnvironmentUnavailableError({
                      environmentId: activeEnvironmentId,
                      reason: "worktree-unsupported",
                    }),
                  ),
            ),
          );
        }),
        Effect.mapError(reject),
      );
  };

  // A move's target must be one its sender may use, online, with the Thread's provider.
  const checkMoveTarget = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> => {
    if (command.type !== "thread.move") return Effect.succeed(command);
    const reject = (cause: unknown) =>
      new Orchestrator.OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    if (Option.isNone(environments)) {
      return Effect.fail(reject("Only the Hub machine runs Threads here."));
    }
    return orchestrator.getThreadRecords(command.threadId, []).pipe(
      Effect.mapError(reject),
      Effect.flatMap(({ thread }) =>
        environments.value
          .chooseForThread({
            userId: command.ownerUserId,
            requested: command.targetEnvironmentId,
            projectId: thread.projectId,
            providerInstanceId: thread.modelSelection.instanceId,
            threadId: command.threadId,
          })
          .pipe(Effect.mapError(reject)),
      ),
      Effect.as(command),
    );
  };

  /**
   * A message for a Thread whose machine is away: while its turn is paused (the Environment is
   * offline) it waits in the queue instead of steering a turn that cannot hear it, and it starts
   * when the turn resumes or ends there, or after a move. A Thread whose Environment was removed
   * («needs an environment») takes no new work until it moves.
   */
  const queueWhileAway = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> => {
    if (command.type !== "message.dispatch" || command.createdBy !== "user") {
      return Effect.succeed(command);
    }
    const reject = (cause: unknown) =>
      new Orchestrator.OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    return orchestrator.getThreadRecords(command.threadId, ["runs"]).pipe(
      Effect.option,
      Effect.flatMap((records) =>
        Effect.gen(function* () {
          // A Thread the projection does not have yet is decided by the Orchestrator as before.
          if (Option.isNone(records)) return command;
          const { thread, runs } = records.value;
          const environmentId = thread.activeEnvironmentId;
          if (environmentId === null) {
            return yield* reject(
              "This Thread needs an environment: the machine it ran on was removed or no longer runs Threads. Move it to another Environment to continue.",
            );
          }
          if (
            environmentId === undefined ||
            environmentId === HUB_MACHINE_ENVIRONMENT_ID ||
            Option.isNone(executors) ||
            command.dispatchMode.type === "queue_after_active" ||
            command.dispatchMode.type === "defer_start" ||
            !runs.some((run) => PAUSABLE_RUN_STATUSES.has(run.status))
          ) {
            return command;
          }
          const connected = yield* executors.value.get(environmentId).pipe(Effect.option);
          if (Option.isSome(connected)) return command;
          const { deliveryIntent: _deliveryIntent, ...rest } = command;
          return { ...rest, dispatchMode: { type: "queue_after_active" as const } };
        }),
      ),
    );
  };

  /**
   * A command the Orchestrator decides with the Thread's machine (its provider, its workspace)
   * waits for a stopped Sandbox to start, as does a move onto one; a start that fails refuses it
   * with why. Other commands, and effects (which wait unclaimed), never start it here. The command
   * claims the machine for the rest of its dispatch, so an image update never cuts it short.
   */
  const startMachine = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<
    OrchestrationV2ServerCommand,
    Orchestrator.OrchestratorCommandRejectedError,
    Scope.Scope
  > => {
    if (Option.isNone(demand) || Option.isNone(executors)) return Effect.succeed(command);
    const target: Effect.Effect<EnvironmentId> | undefined =
      command.type === "thread.move"
        ? Effect.succeed(command.targetEnvironmentId)
        : MACHINE_DECIDED_COMMANDS.has(command.type) && "threadId" in command
          ? executors.value.activeEnvironment(command.threadId)
          : undefined;
    if (target === undefined) return Effect.succeed(command);
    return target.pipe(
      Effect.flatMap((environmentId) =>
        demand.value.claim(environmentId).pipe(
          Effect.andThen(
            demand.value.awaitStarted(environmentId, {
              actorUserId: "ownerUserId" in command ? command.ownerUserId : undefined,
              explicit: true,
            }),
          ),
          Effect.mapError(
            (error) =>
              new Orchestrator.OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                cause: new EnvironmentRegistry.ThreadEnvironmentUnavailableError({
                  environmentId,
                  name: "The Sandbox",
                  reason: "sandbox-failed",
                  detail: error.detail,
                }),
              }),
          ),
        ),
      ),
      Effect.as(command),
    );
  };

  // Spec 4 ticket 08: the selection's AI account, checked (and filled in) for every transport.
  const aiAccountChoice = yield* Effect.serviceOption(AiAccountChoice.AiAccountChoice);
  /**
   * An instance's driver on the machine the Thread runs on (a Sandbox's own instances included),
   * asked of that machine's executor; none when it cannot answer now.
   */
  const resolveDriver = (
    instanceId: ProviderInstanceId,
    environmentId: EnvironmentId | undefined,
  ) =>
    Option.isNone(executors)
      ? Effect.succeed(Option.none<ProviderDriverKind>())
      : executors.value.get(environmentId ?? HUB_MACHINE_ENVIRONMENT_ID).pipe(
          Effect.flatMap((executor) => executor.provider.adapters.get(instanceId)),
          Effect.map((adapter) => adapter.driver),
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<ProviderDriverKind>()),
        );
  const settleAiAccount = (
    command: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorCommandRejectedError> =>
    Option.isNone(aiAccountChoice)
      ? Effect.succeed(command)
      : aiAccountChoice.value.settle(command, resolveDriver).pipe(
          Effect.mapError(
            (cause) =>
              new Orchestrator.OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    claimThreadSpace(command).pipe(
      Effect.flatMap(placeThread),
      Effect.flatMap(checkMoveTarget),
      Effect.flatMap(startMachine),
      // After the machine is up: an instance only it has is described by it.
      Effect.flatMap(settleAiAccount),
      Effect.flatMap(queueWhileAway),
      Effect.flatMap((claimed) =>
        ensureCommandTranscripts(claimed).pipe(
          Effect.andThen(assertDispatchTargetEnabled(claimed)),
          Effect.andThen(orchestrator.dispatch(claimed)),
        ),
      ),
      // The machine's claim (startMachine) ends with the dispatch.
      Effect.scoped,
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId).pipe(
      Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)),
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.filterOrFail(
        (projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null,
        (_projection) =>
          new ThreadManagementThreadNotFoundError({
            projectId: input.projectId,
            threadId: input.threadId,
          }),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator
      .getShellSnapshot({
        location: "active",
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectThreadsListError({
              projectId: input.projectId,
              cause,
            }),
        ),
        Effect.map((snapshot) =>
          snapshot.threads
            .filter((thread) =>
              input.includeSubagents
                ? thread.lineage.sideChat !== true
                : isListedThreadLineage(thread.lineage),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
                right.id.localeCompare(left.id),
            ),
        ),
      );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = Effect.fn(
    "ThreadManagementService.sendToThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    if (target.thread.archivedAt !== null) {
      return yield* new ThreadManagementThreadArchivedError({
        threadId: input.threadId,
      });
    }
    const steerableRun = latestSteerableRun(target);
    let dispatchMode: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"];
    if (input.mode === "steer" || input.mode === "restart") {
      if (steerableRun === undefined) {
        return yield* new ThreadManagementNoSteerableRunError({
          threadId: input.threadId,
          mode: input.mode,
        });
      }
      dispatchMode = {
        type: input.mode === "steer" ? "steer_active" : "restart_active",
        targetRunId: steerableRun.id,
      };
    } else if (input.mode === "auto" && steerableRun !== undefined) {
      dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
    } else {
      dispatchMode = {
        type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
      };
    }

    const dispatched = yield* dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      text: input.text,
      attachments: input.attachments,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      dispatchMode,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
      messageIds: [input.messageId],
      turnItemTypes: ["user_message"],
    });
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    const run =
      message?.runId === null || message?.runId === undefined
        ? undefined
        : projection.runs.find((candidate) => candidate.id === message.runId);
    const turnItem =
      projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      ) ?? null;
    if (
      message === undefined ||
      run === undefined ||
      (turnItem === null && run.status !== "queued")
    ) {
      return yield* new ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    }
    const delivery: ThreadManagementSendResult["delivery"] =
      turnItem === null || turnItem.inputIntent === "queued_turn"
        ? "queued"
        : turnItem.inputIntent === "turn_start"
          ? "started"
          : input.mode === "restart"
            ? "restarted"
            : "steered";
    return { dispatch: dispatched, projection, message, run, turnItem, delivery };
  });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = Effect.fn(
    "ThreadManagementService.waitForThread",
  )(function* (input) {
    const loadError = (cause: unknown) =>
      new ThreadManagementProjectionLoadError({
        projectId: input.projectId,
        threadId: input.threadId,
        cause,
      });
    // Taken before the first read, so a run update between that read and
    // the subscription below still replays.
    const afterSequence = yield* orchestrator
      .getThreadEventSequence(input.threadId)
      .pipe(Effect.mapError(loadError));
    const target = yield* getProjectThreadRecords(input, ["runs"]);
    const selectedRun =
      input.runId === undefined
        ? latestRun(target)
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && selectedRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (selectedRun === undefined) {
      return { threadId: input.threadId, run: null, timedOut: false };
    }
    // A restart cuts a run and continues it as a new run. Follow that chain,
    // so a cut run is not the answer while its continuation is pending.
    // Runs per matching event and is already covered by the waitForThread span.
    const outcome = Effect.fnUntraced(function* (runs: ReadonlyArray<OrchestrationV2Run>) {
      const current = runs.find((candidate) => candidate.id === selectedRun.id);
      if (current === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      }
      const run = latestRestartContinuation(runs, current);
      const pending =
        isTerminalRunStatus(run.status) && (yield* orchestrator.restartContinuationPending(run));
      return { run, pending, settled: isTerminalRunStatus(run.status) && !pending };
    });
    const untilDelegatedWorkSettled = input.untilDelegatedWorkSettled === true;
    const delegatedWorkResult = Effect.gen(function* () {
      const records = yield* getProjectThreadRecords(
        input,
        ["runs", "messages", "subagents", "providerThreads"],
        { messageRoles: ["user"], monitorNotificationsOnly: true },
      );
      const progress = delegatedTaskProgress(records);
      // A thread rolled back past all its work, with nothing left running, has no answer to wait for.
      if (
        progress.resultRun === undefined &&
        records.runs.every((run) => isTerminalRunStatus(run.status))
      ) {
        return latestRun(records);
      }
      if (progress.state !== "result_available") return undefined;
      const pending = yield* orchestrator
        .delegatedTaskResultPending(input.threadId)
        .pipe(Effect.mapError(loadError));
      return pending ? undefined : progress.resultRun;
    });
    const evaluate = Effect.fn("orchestrationV2.threadManagement.evaluate")(function* (
      runs: ReadonlyArray<OrchestrationV2Run>,
    ) {
      const current = yield* outcome(runs);
      if (!current.settled || !untilDelegatedWorkSettled) {
        return { ...current, resultRun: undefined };
      }
      const resultRun = yield* delegatedWorkResult;
      return { ...current, settled: resultRun !== undefined, resultRun };
    });
    const settledResult = (current: Effect.Success<ReturnType<typeof evaluate>>) => ({
      threadId: input.threadId,
      run: current.run,
      timedOut: !current.settled,
      ...(current.resultRun === undefined ? {} : { resultRun: current.resultRun }),
    });
    const initial = yield* evaluate(target.runs);
    if (initial.settled) return settledResult(initial);

    // A declined continuation records no event, so its effect settling wakes
    // the wait too.
    const wait = Stream.merge(
      Stream.mergeAll(
        (
          [
            "run.updated",
            "thread.deleted",
            // What delegated work reads besides runs: tasks and their
            // deliveries, and a provider thread's background tasks.
            ...(untilDelegatedWorkSettled
              ? (["subagent.updated", "provider-thread.updated"] as const)
              : []),
          ] as const
        ).map((eventType) =>
          orchestrator.streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            untilDelegatedWorkSettled ||
            stored.event.type !== "run.updated" ||
            stored.event.payload.id === selectedRun.id ||
            stored.event.payload.restartContinuationOfRunId !== undefined,
        ),
      ),
      initial.pending
        ? Stream.fromEffect(orchestrator.awaitRestartContinuation(initial.run))
        : Stream.empty,
    ).pipe(
      Stream.mapEffect(() =>
        getProjectThreadRecords(input, ["runs"]).pipe(
          Effect.flatMap((current) => evaluate(current.runs)),
        ),
      ),
      Stream.filter((current) => current.settled),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
    );
    const waited = Option.flatten(yield* wait);
    if (Option.isSome(waited)) return settledResult(waited.value);
    // The run may have reached a terminal status while the timeout was
    // winning the race; the final projection read decides what actually
    // happened, so only a still-active run counts as timed out.
    return settledResult(yield* evaluate((yield* getProjectThreadRecords(input, ["runs"])).runs));
  });

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    yield* dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`server:settle-after-run:${input.runId}`),
      threadId: input.threadId,
    });
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = Effect.fn(
    "ThreadManagementService.interruptThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    const explicitRun =
      input.runId === undefined
        ? undefined
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && explicitRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
      return {
        type: "already_terminal",
        run: explicitRun as OrchestrationV2Run & {
          readonly status: ThreadManagementTerminalRunStatus;
        },
      } as const;
    }
    const interruptibleRun = latestActiveRun(target);
    if (interruptibleRun === undefined) {
      if (input.runId === undefined) {
        return { type: "no_active_run" } as const;
      }
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    const dispatch = yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: interruptibleRun.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
  });

  const authorizeThread: ThreadManagementServiceShape["authorizeThread"] = Effect.fn(
    "ThreadManagementService.authorizeThread",
  )(function* (threadId, action) {
    if (Option.isNone(spaces)) return;
    const actor = yield* spaces.value.actingUser;
    if (Option.isNone(actor)) return;
    yield* spaces.value.authorizeItem(actor.value, action, { kind: "thread", id: threadId });
  });

  // Stopping kills the agent before any command is dispatched, so the Role rule is checked first.
  const mayStop = (threadId: ThreadId) =>
    authorizeThread(threadId, "thread.stop").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const forceStopThread: ThreadManagementServiceShape["forceStopThread"] = Effect.fn(
    "ThreadManagementService.forceStopThread",
  )(
    function* (input) {
      if (!(yield* mayStop(input.threadId))) {
        return yield* new OrchestrationV2ForceStopThreadError({
          threadId: input.threadId,
          reason: "not-permitted",
        });
      }
      // Under the thread lock no new run can be created between the check and the kill. The
      // settlement below dispatches, which takes that lock itself, so it runs after release.
      const { records, target, killed } = yield* threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const records = yield* orchestrator.getThreadRecords(input.threadId, [
            "runs",
            "providerThreads",
            "providerTurns",
          ]);
          // The run Force stop acts on: the active one, else the latest that started. Queued
          // follow-ups never ran, so they neither count as targets nor supersede the request.
          const target =
            latestActiveRun(records) ??
            records.runs
              .filter((run) => run.status !== "queued")
              .reduce<OrchestrationV2Run | undefined>(
                (current, run) =>
                  current === undefined || run.ordinal > current.ordinal ? run : current,
                undefined,
              );
          if (input.runId !== undefined && input.runId !== target?.id) {
            return yield* new OrchestrationV2ForceStopThreadError({
              threadId: input.threadId,
              reason: "superseded",
            });
          }
          // Shared scopes are never tracked per thread, so this only kills the thread's own agent.
          const killed = yield* agentScope.kill(input.threadId);
          return { records, target, killed };
        }),
      );
      const sessionIds = new Set(
        records.providerThreads.flatMap((providerThread) =>
          providerThread.appThreadId === input.threadId && providerThread.providerSessionId !== null
            ? [providerThread.providerSessionId]
            : [],
        ),
      );
      // A run that already ended may still hold background work; settling it is a no-op otherwise.
      const run = target;
      if (run !== undefined) {
        const active = isActiveRun(run);
        const providerTurn = records.providerTurns.findLast(
          (turn) =>
            turn.runAttemptId === run.activeAttemptId && (!active || turn.status === "running"),
        );
        const commandId = CommandId.make(
          `server:force-stop:${run.id}:${yield* Clock.currentTimeMillis}`,
        );
        yield* providerTurn === undefined && !active
          ? Effect.void
          : providerTurn === undefined
            ? orchestrator.dispatch({
                type: "run.interrupt",
                commandId,
                threadId: input.threadId,
                runId: run.id,
                reason: FORCE_STOP_REASON,
              })
            : orchestrator.dispatch({
                type: "thread.background-work.settle",
                commandId,
                threadId: input.threadId,
                providerThreadId: providerTurn.providerThreadId,
                providerTurnId: providerTurn.id,
                reason: FORCE_STOP_REASON,
              });
      }
      const ownProviderThreadIds = records.providerThreads.flatMap((providerThread) =>
        providerThread.appThreadId === input.threadId ? [providerThread.id] : [],
      );
      const detach = (providerSessionId: ProviderSessionId) =>
        sessions
          .detach({ providerSessionId, threadId: input.threadId, detail: FORCE_STOP_REASON })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.force-stop-detach-failed", {
                threadId: input.threadId,
                cause,
              }),
            ),
            Effect.forkIn(layerScope),
          );
      let shared = false;
      const sharedWith = new Set<ThreadId>();
      const releases: Array<{
        readonly providerSessionId: ProviderSessionId;
        readonly fiber: Fiber.Fiber<boolean, ProviderSessionManager.ProviderSessionManagerV2Error>;
      }> = [];
      for (const providerSessionId of sessionIds) {
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        // Decided just before teardown, so the reply matches what happens to the process.
        const others = yield* sessions.otherWorkingThreads({
          providerSessionId,
          threadId: input.threadId,
        });
        for (const threadId of others) sharedWith.add(threadId);
        if (others.length > 0) {
          shared = true;
          yield* detach(providerSessionId);
          continue;
        }
        // The session manager re-checks atomically with turn starts and keeps a session a
        // sibling began using in the meantime.
        const fiber = yield* sessions
          .releaseUnlessBusy({
            providerSessionId,
            ownProviderThreadIds,
            reason: "manual_shutdown",
            detail: FORCE_STOP_REASON,
          })
          .pipe(Effect.forkIn(layerScope));
        releases.push({ providerSessionId, fiber });
      }
      // Teardown waits on the provider's own exit paths; past this bound it keeps going on its own.
      let releasing = false;
      for (const release of releases) {
        const released = yield* Fiber.join(release.fiber).pipe(
          Effect.timeoutOption(FORCE_STOP_RELEASE_WAIT),
        );
        if (Option.isNone(released)) {
          releasing = true;
        } else if (!released.value) {
          shared = true;
          yield* detach(release.providerSessionId);
        }
      }
      return {
        outcome: killed ? "killed" : shared ? "shared" : releasing ? "releasing" : "released",
        sharedWithThreadIds: [...sharedWith],
      } as const;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isForceStopThreadError(cause)
            ? cause
            : new OrchestrationV2ForceStopThreadError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = Effect.fn(
    "ThreadManagementService.stopWorkflow",
  )(
    function* (input) {
      if (!(yield* mayStop(input.threadId))) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-permitted" });
      }
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // Check mode limits under the lock so users cannot raise modes between validation and Stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    },
    (effect, input) => effect.pipe((effect) => threadDispatch.withLock(input.threadId, effect)),
  );

  const awaitBackgroundTasks: ThreadManagementServiceShape["awaitBackgroundTasks"] = Effect.fn(
    "ThreadManagementService.awaitBackgroundTasks",
  )(function* (input) {
    const unavailable = (cause?: unknown) =>
      new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unavailable",
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId,
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* unavailable();
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime)) {
      return yield* unavailable();
    }
    if (runtime.value.awaitBackgroundTasks === undefined) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unsupported",
      });
    }
    const { matched } = yield* runtime.value
      .awaitBackgroundTasks({ providerThread, taskIds: input.taskIds, awaited: input.awaited })
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new ThreadManagementBackgroundWaitError({
              threadId: input.threadId,
              reason: "failed",
              cause,
            }),
        ),
      );
    const matchedIds = new Set(matched);
    return { matched, unmatched: input.taskIds.filter((taskId) => !matchedIds.has(taskId)) };
  });

  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
    > = [];
    const stoppedChildThreadIds = new Set<ThreadId>();
    for (const task of subagents) {
      if (task.origin !== "app_owned") continue;
      if (task.childThreadId === null) continue;
      const threadId = task.childThreadId;
      // Follow-up tasks reuse a child thread; walk its subtree only once.
      if (stoppedChildThreadIds.has(threadId)) continue;
      stoppedChildThreadIds.add(threadId);
      yield* dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
        threadId,
        stopDelegatedTasks: false,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }).pipe(
        Effect.andThen(stopDelegatedTasks({ ...input, threadId })),
        Effect.catch((error) =>
          Effect.logWarning("Unable to stop a delegated task", {
            parentThreadId: input.threadId,
            threadId,
            error,
          }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
        ),
      );
    }
    if (failures[0] !== undefined) return yield* failures[0];
  });

  const service: ThreadManagementService["Service"] = ThreadManagementService.of({
    getWorkflowScript: Effect.fn("ThreadManagementService.getWorkflowScript")(function* (input) {
      const visibility = yield* SpaceVisibility.RequestVisibility;
      return yield* readThreadWorkflowScript({
        ...input,
        threads: {
          family: Effect.flatten(
            service.readShellSnapshot({
              familyOf: input.threadId,
              spaceIds: SpaceVisibility.spaceFilter(visibility),
            }),
          ).pipe(Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads])),
          subagents: (threadId) =>
            service
              .getThreadRecords(threadId, ["subagents"])
              .pipe(Effect.map((records) => records.subagents)),
        },
      });
    }),
    authorizeThread,
    ensureLegacyTranscript,
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: Effect.fn("ThreadManagementService.searchThread")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      );
    }),
    dispatch,
    getThreadHistoryPage: Effect.fn("ThreadManagementService.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(
            orchestrator.getThreadHistoryPage(
              threadId,
              cursor,
              throughEntryId,
              conversationOnly,
              workMode,
            ),
          ),
        );
      },
    ),
    getTimelinePage: Effect.fn("ThreadManagementService.getTimelinePage")(
      function (threadId, options) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
        );
      },
    ),
    getMessageCount: Effect.fn("ThreadManagementService.getMessageCount")(function (threadId) {
      return ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      );
    }),
    getTurnItem: Effect.fn("ThreadManagementService.getTurnItem")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      );
    }),
    getThreadRecords: Effect.fn("ThreadManagementService.getThreadRecords")(
      function (threadId, fields, filter) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
        );
      },
    ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getAgentAwarenessSnapshot: orchestrator.getAgentAwarenessSnapshot,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listActiveSubagentThreadIds: orchestrator.listActiveSubagentThreadIds,
    countThreads: orchestrator.countThreads,
    listActiveShellIndex: orchestrator.listActiveShellIndex,
    listOlderSettledThreads: orchestrator.listOlderSettledThreads,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    listAppOwnedChildThreadIds: Effect.fn("ThreadManagementService.listAppOwnedChildThreadIds")(
      function (threadId) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.listAppOwnedChildThreadIds(threadId)),
        );
      },
    ),
    listProjectThreads,
    sendToThread,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    waitForThread,
    settleAfterRun,
    settleThread,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    forceStopThread,
    awaitBackgroundTasks,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
  return service;
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: Effect.fn("LegacyV1ThreadImporter.ensureTranscript")(function () {
      return Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 });
    }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

/** Without Spaces: Threads are not claimed. Tests only; the server uses `layerWithLegacyImporter`. */
export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, makeWith(Option.none())).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(ThreadCommandExecutor.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
  | SpaceDirectory.SpaceDirectory
> = Layer.effect(
  ThreadManagementService,
  Effect.gen(function* () {
    return yield* makeWith(
      Option.some(yield* SpaceDirectory.SpaceDirectory),
      // Where the server joins machines; a host without them runs every Thread on the Hub machine.
      yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry),
    );
  }),
).pipe(Layer.provide(ThreadCommandExecutor.layer));
