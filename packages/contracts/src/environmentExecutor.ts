/**
 * What the Hub asks of the machine that runs a Thread, grouped as provider, workspace and host.
 * The Hub machine runs it in process; a joined Environment carries it over its WebSocket. Bump the
 * version on any change a peer on the previous version would misread.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProviderSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  EnvironmentHostResources,
  EnvironmentProviderCapabilitySnapshot,
  EnvironmentUnavailableProvider,
} from "./environmentConnection.ts";

/**
 * 8: Hub previews. 9: checkouts from the Hub. 10: `secretEnv`. 11: `aiGateway` in
 * `provider.openSession`. 12: shells keep and report their `facts`, and `terminal.reconcile`; the
 * Hub refuses terminals of a machine before 12. 13: `secretEnv.aiCredential` (a direct AI
 * account's credential, every ambient one dropped). 15 and 16: see below.
 */
export const ENVIRONMENT_EXECUTOR_CONTRACT_VERSION = 16;

/** 15: `files.inspectAsset` and `files.streamAsset`, a Thread's files served by URL (ticket 15). */
export const REMOTE_ASSETS_CONTRACT_VERSION = 15;

/** 16: secret files (`secretEnv.files`, `secrets.refreshFiles`, `secretFilesRoot` in the hello). */
export const SECRET_FILES_CONTRACT_VERSION = 16;

/** The first contract whose shells report their facts (spec 5 ticket 07). */
export const SHELL_FACTS_CONTRACT_VERSION = 12;

/**
 * The Hub machine's Environment id. It is a constant so the `environments` table can seed the
 * Hub machine's row; it is not the server's connection `EnvironmentId` (`ServerEnvironment`).
 */
export const HUB_MACHINE_ENVIRONMENT_ID = EnvironmentId.make("environment:hub-machine");

/** The Environment has no executor right now (never joined, removed, or not connected). */
export class EnvironmentExecutorUnavailableError extends Schema.TaggedError<EnvironmentExecutorUnavailableError>()(
  "EnvironmentExecutorUnavailableError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has no executor.`;
  }
}

/**
 * A provider session that ran on a joined Environment is gone with its process: the machine came
 * back without it (`process-ended`), it was removed, or the Thread moved away while the turn was
 * paused on it. Its turn ends as interrupted, not failed, and the Thread goes on there or elsewhere.
 */
export class EnvironmentSessionLostError extends Schema.TaggedError<EnvironmentSessionLostError>()(
  "EnvironmentSessionLostError",
  {
    environmentId: EnvironmentId,
    environmentName: Schema.String,
    reason: Schema.Literals([
      "process-ended",
      "environment-removed",
      "moved-while-offline",
      "sandbox-disk-full",
      "sandbox-stopped",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "environment-removed":
        return `${this.environmentName} was removed from the Hub while this turn ran there. Move the Thread to another Environment to continue.`;
      case "moved-while-offline":
        return `This turn was paused on ${this.environmentName}, which was offline, and was stopped to move the Thread.`;
      case "sandbox-disk-full":
        return `${this.environmentName} ran out of disk space (over its limit, or the Hub's disk is almost full), so this turn was stopped. See Settings → Environments → Sandboxes.`;
      case "sandbox-stopped":
        return `The Owner stopped ${this.environmentName}, so this turn was stopped. Send a message to start it again and continue.`;
      case "process-ended":
        return `The agent on ${this.environmentName} stopped while ${this.environmentName} was offline. Send a message to continue here, or move the Thread to another Environment.`;
    }
  }
}

const isEnvironmentSessionLost = Schema.is(EnvironmentSessionLostError);

/** The first error `is` accepts in an error and the causes it wraps (`cause`, nested). */
export const findInErrorChain = <A>(
  error: unknown,
  is: (value: unknown) => value is A,
): A | undefined => {
  let current = error;
  for (let depth = 0; depth < 12 && typeof current === "object" && current !== null; depth += 1) {
    if (is(current)) return current;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

/** The `EnvironmentSessionLostError` an error carries, through the errors that wrap it. */
export const findEnvironmentSessionLost = (
  error: unknown,
): EnvironmentSessionLostError | undefined => findInErrorChain(error, isEnvironmentSessionLost);

/** Whether an error, or one it wraps, says the Environment has no executor (it is away). */
export const isEnvironmentAwayError = (error: unknown): boolean =>
  findInErrorChain(error, Schema.is(EnvironmentExecutorUnavailableError)) !== undefined;

export const EnvironmentExecutorTransport = Schema.Literals(["in-process", "remote"]);
export type EnvironmentExecutorTransport = typeof EnvironmentExecutorTransport.Type;

/** Every operation the Hub can ask of an executor, by group. */
const ENVIRONMENT_EXECUTOR_OPERATIONS = {
  provider: [
    "provider.openSession",
    "provider.ensureThread",
    "provider.resumeThread",
    "provider.startTurn",
    "provider.compactThread",
    "provider.interrupt",
    "provider.steer",
    "provider.respond",
    "provider.readThreadSnapshot",
    "provider.rollback",
    "provider.forkThread",
    "provider.injectHistory",
    "provider.stopTask",
    "provider.unloadThread",
    "provider.hasPendingBackgroundWork",
    "provider.detach",
    "textGeneration.threadHandoff",
    "textGeneration.threadTitle",
  ],
  workspace: [
    "checkpoint.isGitRepository",
    "checkpoint.hasRef",
    "checkpoint.capture",
    "checkpoint.restore",
    "checkpoint.diff",
    "checkpoint.listAuthoredPaths",
    "checkpoint.deleteRefs",
    "checkpoint.push",
    "checkpoint.fetch",
    "checkpoint.ensureScratch",
    "move.publishScratch",
    "move.fetch",
    "move.prepare",
    "move.recover",
    "runtimePolicy.resolve",
    "launch.prepareWorktree",
    "launch.runSetupScript",
    "files.read",
    "files.write",
    "files.metadata",
    "files.inspectAsset",
    "files.streamAsset",
    "search.paths",
    "search.contents",
    "entries.list",
    "entries.listIgnored",
    "entries.browse",
    "terminal.open",
    "terminal.write",
    "terminal.resize",
    "terminal.clear",
    "terminal.close",
    "terminal.stream",
    "preview.open",
    "preview.resize",
    "preview.adjust",
    "preview.close",
    "preview.list",
    "preview.reportStatus",
    "preview.events",
    "preview.proxyHttp",
    "preview.proxySocket",
    "preview.proxySocketSend",
    "ports.scan",
    "ports.stopServer",
  ],
  host: ["host.describe"],
} as const;

export const EnvironmentExecutorOperationGroup = Schema.Literals(["provider", "workspace", "host"]);
export type EnvironmentExecutorOperationGroup = typeof EnvironmentExecutorOperationGroup.Type;

export const EnvironmentExecutorOperation = Schema.Literals([
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.provider,
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.workspace,
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.host,
]);
export type EnvironmentExecutorOperation = typeof EnvironmentExecutorOperation.Type;

/** The executor's self-description. A remote Environment's capabilities come from its last one. */
export const EnvironmentExecutorSnapshot = Schema.Struct({
  contractVersion: Schema.Number,
  environmentId: EnvironmentId,
  transport: EnvironmentExecutorTransport,
  providers: Schema.Array(EnvironmentProviderCapabilitySnapshot),
  unavailableProviders: Schema.Array(EnvironmentUnavailableProvider),
  resources: Schema.optional(EnvironmentHostResources),
  observedAt: IsoDateTime,
});
export type EnvironmentExecutorSnapshot = typeof EnvironmentExecutorSnapshot.Type;

/** A Hub → Environment request. Requests made by an effect carry `effectId:attempt`. */
export const EnvironmentExecutorRequest = Schema.Struct({
  contractVersion: Schema.Number,
  requestId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  operation: EnvironmentExecutorOperation,
  idempotencyKey: Schema.optional(TrimmedNonEmptyString),
  payload: Schema.Unknown,
});
export type EnvironmentExecutorRequest = typeof EnvironmentExecutorRequest.Type;

export const EnvironmentExecutorResponse = Schema.Union([
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("succeeded"),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("failed"),
    error: Schema.Unknown,
  }),
]);
export type EnvironmentExecutorResponse = typeof EnvironmentExecutorResponse.Type;

/**
 * An Environment → Hub provider event (frame method `provider.event`), ordered and deduplicated
 * by `(providerSessionId, seq)`. Live-only output (`command_output.delta`) carries no `seq`: it
 * is never spooled or resent. `event` is a `ProviderAdapterV2Event` in its JSON encoding.
 */
export const EnvironmentExecutorProviderEvent = Schema.Struct({
  providerSessionId: ProviderSessionId,
  seq: Schema.optionalKey(NonNegativeInt),
  event: Schema.Unknown,
});
export type EnvironmentExecutorProviderEvent = typeof EnvironmentExecutorProviderEvent.Type;

/** The Environment's provider session ended on its own (process exit, failure). */
export const EnvironmentExecutorSessionEnded = Schema.Struct({
  providerSessionId: ProviderSessionId,
  /** In the session's event order: spooled and resent like its events until acknowledged. */
  seq: Schema.optionalKey(NonNegativeInt),
  /** A `ProviderAdapterV2Error` in its JSON encoding, when the stream failed. */
  error: Schema.optionalKey(Schema.Unknown),
});
export type EnvironmentExecutorSessionEnded = typeof EnvironmentExecutorSessionEnded.Type;

/** Hub → Environment (frame method `provider.ack`): the highest `seq` committed per session. */
export const EnvironmentExecutorEventAck = Schema.Struct({
  acks: Schema.Array(Schema.Struct({ providerSessionId: ProviderSessionId, seq: NonNegativeInt })),
});
export type EnvironmentExecutorEventAck = typeof EnvironmentExecutorEventAck.Type;

/**
 * Hub → Environment (frame method `provider.retired`), right after a connection is welcomed: the
 * sessions the machine reported that the Hub no longer has (after a Hub restart, or ones it ended).
 * The machine detaches them instead of keeping their processes alive.
 */
export const EnvironmentExecutorRetiredSessions = Schema.Struct({
  providerSessionIds: Schema.Array(ProviderSessionId),
});
export type EnvironmentExecutorRetiredSessions = typeof EnvironmentExecutorRetiredSessions.Type;

/**
 * Environment → Hub request (method `attachment.read`): a Thread attachment the Hub stores,
 * asked for by id and content hash while a turn on this Environment needs it.
 */
export const EnvironmentAttachmentReadRequest = Schema.Struct({
  threadId: ThreadId,
  attachmentId: TrimmedNonEmptyString,
  sha256: TrimmedNonEmptyString,
});
export type EnvironmentAttachmentReadRequest = typeof EnvironmentAttachmentReadRequest.Type;

export const EnvironmentAttachmentReadResult = Schema.Struct({ base64: Schema.String });
export type EnvironmentAttachmentReadResult = typeof EnvironmentAttachmentReadResult.Type;

/** Frame methods outside the operation catalog. */
export const ENVIRONMENT_EXECUTOR_FRAME_METHODS = {
  providerEvent: "provider.event",
  sessionEnded: "provider.sessionEnded",
  ack: "provider.ack",
  retired: "provider.retired",
  attachmentRead: "attachment.read",
  workspaceStreamItem: "workspace.stream",
  workspaceStreamEnd: "workspace.streamEnd",
  workspaceStreamCancel: "workspace.streamCancel",
  textGenerationCancel: "textGeneration.cancel",
} as const;

/**
 * Hub → Environment (frame method `textGeneration.cancel`): stop the text generation the Hub asked
 * for under `generationId` (a move's handoff summary that took too long).
 */
export const EnvironmentTextGenerationCancel = Schema.Struct({
  generationId: TrimmedNonEmptyString,
});
export type EnvironmentTextGenerationCancel = typeof EnvironmentTextGenerationCancel.Type;

/**
 * Environment → Hub (frame method `workspace.stream`): one item of a stream the Hub opened with a
 * workspace request (`terminal.stream`, `preview.events`). Live only: never spooled or resent; a
 * dropped socket ends the stream on the Hub, and the client opens it again.
 */
export const EnvironmentWorkspaceStreamItem = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
  item: Schema.Unknown,
});
export type EnvironmentWorkspaceStreamItem = typeof EnvironmentWorkspaceStreamItem.Type;

/** Environment → Hub (`workspace.streamEnd`): the stream ended there, with its error if it failed. */
export const EnvironmentWorkspaceStreamEnd = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
  error: Schema.optionalKey(Schema.Unknown),
});
export type EnvironmentWorkspaceStreamEnd = typeof EnvironmentWorkspaceStreamEnd.Type;

/** Hub → Environment (`workspace.streamCancel`): nobody reads the stream any more. */
export const EnvironmentWorkspaceStreamCancel = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
});
export type EnvironmentWorkspaceStreamCancel = typeof EnvironmentWorkspaceStreamCancel.Type;
