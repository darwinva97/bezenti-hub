/**
 * The Hub ↔ Environment connection: one outbound WebSocket from the Environment, carrying JSON
 * frames, versioned apart from the client RPC protocol. The Environment sends `hello`, the Hub
 * answers `welcome` or closes with a reason, then `heartbeat`s follow.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2ProviderCapabilities } from "./orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { SecretFilesRoot } from "./secretEnv.ts";

export const ENVIRONMENT_CONNECTION_PROTOCOL_VERSION = 2;
export const ENVIRONMENT_CONNECT_PATH = "/api/environment/connect";

export const ENVIRONMENT_HEARTBEAT_INTERVAL_MS = 10_000;
/** No frame for this long: the Hub shows `reconnecting` and drops the socket. */
export const ENVIRONMENT_RECONNECTING_AFTER_MS = 30_000;
/** No frame for this long: `offline`. */
const ENVIRONMENT_OFFLINE_AFTER_MS = 60_000;
/** How long the Hub waits for `hello` after the upgrade. */
export const ENVIRONMENT_HELLO_TIMEOUT_MS = 10_000;

export const EnvironmentConnectionStatus = Schema.Literals(["online", "reconnecting", "offline"]);
export type EnvironmentConnectionStatus = typeof EnvironmentConnectionStatus.Type;

/** Free and total bytes of the disk holding the machine's T3 home. */
export const EnvironmentDiskSpace = Schema.Struct({
  totalBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
});
export type EnvironmentDiskSpace = typeof EnvironmentDiskSpace.Type;

/** What the machine has left: CPU and memory as the Hub samples its own, and the disk. */
export const EnvironmentHostResources = Schema.Struct({
  hostResources: HostResourcesSnapshot,
  disk: Schema.NullOr(EnvironmentDiskSpace),
});
export type EnvironmentHostResources = typeof EnvironmentHostResources.Type;

export const EnvironmentProviderCapabilities = Schema.Struct({
  runtimeModes: Schema.Array(TrimmedNonEmptyString),
  conversationRollback: Schema.Boolean,
  textGeneration: Schema.Boolean,
});
export type EnvironmentProviderCapabilities = typeof EnvironmentProviderCapabilities.Type;

export const EnvironmentProviderSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: EnvironmentProviderCapabilities,
});
export type EnvironmentProviderSummary = typeof EnvironmentProviderSummary.Type;

/** What an Environment publishes about one provider instance, in its hello and each heartbeat. */
export const EnvironmentProviderCapabilitySnapshot = Schema.Struct({
  instanceId: EnvironmentProviderSummary.fields.instanceId,
  provider: EnvironmentProviderSummary.fields.provider,
  enabled: EnvironmentProviderSummary.fields.enabled,
  continuationKey: TrimmedNonEmptyString,
  /** What the Orchestrator decides from; the summary's `capabilities` are what Settings shows. */
  capabilities: OrchestrationV2ProviderCapabilities,
});
export type EnvironmentProviderCapabilitySnapshot =
  typeof EnvironmentProviderCapabilitySnapshot.Type;

/** A provider instance the Environment has but could not describe, and why. */
export const EnvironmentUnavailableProvider = Schema.Struct({
  instanceId: EnvironmentProviderSummary.fields.instanceId,
  reason: TrimmedNonEmptyString,
});
export type EnvironmentUnavailableProvider = typeof EnvironmentUnavailableProvider.Type;

/** The orchestration capabilities of every provider instance, as the Hub's cache keeps them. */
export const EnvironmentOrchestrationCapabilities = Schema.Struct({
  providers: Schema.Array(EnvironmentProviderCapabilitySnapshot),
  unavailableProviders: Schema.Array(EnvironmentUnavailableProvider),
});
export type EnvironmentOrchestrationCapabilities = typeof EnvironmentOrchestrationCapabilities.Type;

/** A provider session the Environment still runs, so the Hub can resume its event stream. */
export const EnvironmentLiveProviderSession = Schema.Struct({
  providerSessionId: TrimmedNonEmptyString,
  threadId: ThreadId,
  lastSeq: NonNegativeInt,
});
export type EnvironmentLiveProviderSession = typeof EnvironmentLiveProviderSession.Type;

export const EnvironmentHelloFrame = Schema.Struct({
  type: Schema.Literal("hello"),
  protocolVersion: Schema.Int,
  os: TrimmedNonEmptyString,
  hostname: TrimmedNonEmptyString,
  providers: Schema.Array(EnvironmentProviderSummary),
  hostResources: HostResourcesSnapshot,
  disk: Schema.NullOr(EnvironmentDiskSpace),
  sessions: Schema.Array(EnvironmentLiveProviderSession),
  /** Where this machine keeps Project checkouts: `<workspaceRoot>/<Project slug>` by default. */
  workspaceRoot: TrimmedNonEmptyString,
  orchestration: EnvironmentOrchestrationCapabilities,
  /**
   * The executor contract the machine runs (`ENVIRONMENT_EXECUTOR_CONTRACT_VERSION`); a machine
   * from before it was sent runs 7. Operations newer than it are refused on the Hub.
   */
  executorContractVersion: Schema.optionalKey(Schema.Int),
  /**
   * Contract 14: where the machine writes Secret files, and whether that is in memory; null when
   * it has no such folder. The Hub renders `{{ X | path }}` with it and sends files only in memory.
   */
  secretFilesRoot: Schema.optionalKey(Schema.NullOr(SecretFilesRoot)),
  /**
   * Set only by a server running inside a Sandbox (a Hub's, or a dedicated machine's container),
   * from the state its host wrote: a dedicated machine connects only this way.
   */
  sandbox: Schema.optionalKey(Schema.Struct({ runtime: Schema.Literals(["podman", "process"]) })),
});
export type EnvironmentHelloFrame = typeof EnvironmentHelloFrame.Type;

export const EnvironmentHeartbeatFrame = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  hostResources: HostResourcesSnapshot,
  disk: Schema.NullOr(EnvironmentDiskSpace),
  /** Sent when the providers changed since the last frame. */
  providers: Schema.optionalKey(Schema.Array(EnvironmentProviderSummary)),
  orchestration: Schema.optionalKey(EnvironmentOrchestrationCapabilities),
});
export type EnvironmentHeartbeatFrame = typeof EnvironmentHeartbeatFrame.Type;

export const EnvironmentWelcomeFrame = Schema.Struct({
  type: Schema.Literal("welcome"),
  protocolVersion: Schema.Int,
  hubEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  /**
   * How the Hub uses this machine. A server joined as personal that hears `dedicated` stops
   * serving: a dedicated machine runs its work in a Sandbox container. Absent from older Hubs.
   */
  mode: Schema.optionalKey(Schema.Literals(["personal", "dedicated", "sandbox"])),
  /** A dedicated machine's or Sandbox's Space. Absent from older Hubs. */
  spaceId: Schema.optionalKey(SpaceId),
});
export type EnvironmentWelcomeFrame = typeof EnvironmentWelcomeFrame.Type;

/** A call from one side to the other; `idempotencyKey` is `effectId:attempt` for effects. */
export const EnvironmentRequestFrame = Schema.Struct({
  type: Schema.Literal("request"),
  requestId: TrimmedNonEmptyString,
  method: TrimmedNonEmptyString,
  idempotencyKey: Schema.optionalKey(TrimmedNonEmptyString),
  payload: Schema.Unknown,
});
export type EnvironmentRequestFrame = typeof EnvironmentRequestFrame.Type;

export const EnvironmentResponseFrame = Schema.Struct({
  type: Schema.Literal("response"),
  requestId: TrimmedNonEmptyString,
  result: Schema.Union([
    Schema.TaggedStruct("success", { value: Schema.Unknown }),
    Schema.TaggedStruct("failure", { error: Schema.Unknown }),
  ]),
});
export type EnvironmentResponseFrame = typeof EnvironmentResponseFrame.Type;

export const EnvironmentEventFrame = Schema.Struct({
  type: Schema.Literal("event"),
  method: TrimmedNonEmptyString,
  payload: Schema.Unknown,
});
export type EnvironmentEventFrame = typeof EnvironmentEventFrame.Type;

/** Frames the Environment sends. */
export const EnvironmentToHubFrame = Schema.Union([
  EnvironmentHelloFrame,
  EnvironmentHeartbeatFrame,
  EnvironmentRequestFrame,
  EnvironmentResponseFrame,
  EnvironmentEventFrame,
]);
export type EnvironmentToHubFrame = typeof EnvironmentToHubFrame.Type;

/** Frames the Hub sends. */
export const HubToEnvironmentFrame = Schema.Union([
  EnvironmentWelcomeFrame,
  EnvironmentRequestFrame,
  EnvironmentResponseFrame,
  EnvironmentEventFrame,
]);
export type HubToEnvironmentFrame = typeof HubToEnvironmentFrame.Type;

/**
 * Why the Hub closed the connection. A `final` reason means reconnecting cannot help: the
 * Environment stops and says so, and the Owner has to act.
 */
export const ENVIRONMENT_CLOSE_REASONS = {
  "incompatible-version": { code: 4400, final: true },
  "credential-missing": { code: 4401, final: true },
  "credential-unknown": { code: 4402, final: true },
  "credential-revoked": { code: 4403, final: true },
  "credential-other-hub": { code: 4404, final: true },
  "environment-removed": { code: 4405, final: true },
  "insecure-transport": { code: 4406, final: true },
  "owner-inactive": { code: 4407, final: true },
  "protocol-error": { code: 4410, final: false },
  "hello-timeout": { code: 4411, final: false },
  "heartbeat-timeout": { code: 4412, final: false },
  replaced: { code: 4413, final: true },
  "hub-shutting-down": { code: 4414, final: false },
  "environment-mode-changed": { code: 4415, final: false },
  "space-missing": { code: 4416, final: true },
  "not-sandboxed": { code: 4417, final: true },
  "sandbox-disk-full": { code: 4418, final: true },
} as const;

export type EnvironmentCloseReason = keyof typeof ENVIRONMENT_CLOSE_REASONS;
export const EnvironmentCloseReason = Schema.Literals(
  Object.keys(ENVIRONMENT_CLOSE_REASONS) as Array<EnvironmentCloseReason>,
);

/** The reason a close code names, if it is one of ours. */
export const environmentCloseReasonOf = (code: number): EnvironmentCloseReason | undefined =>
  (Object.keys(ENVIRONMENT_CLOSE_REASONS) as Array<EnvironmentCloseReason>).find(
    (reason) => ENVIRONMENT_CLOSE_REASONS[reason].code === code,
  );

/** Shown by `t3 status` and the Hub's logs. */
export const ENVIRONMENT_CLOSE_MESSAGES: Record<EnvironmentCloseReason, string> = {
  "incompatible-version":
    "This T3 Code version speaks another Environment protocol than the Hub. Update one of them.",
  "credential-missing": "No Environment credential was sent. Run `t3 join` again.",
  "credential-unknown": "The Hub does not know this machine. Run `t3 join` again.",
  "credential-revoked": "The Hub removed this machine. Run `t3 join` to add it again.",
  "credential-other-hub": "This credential belongs to another Hub. Run `t3 join` for this one.",
  "environment-removed": "The Hub removed this machine. Run `t3 join` to add it again.",
  "insecure-transport": "The Hub accepts Environments only over HTTPS.",
  "owner-inactive": "The Hub turned off the User this machine belongs to.",
  "protocol-error": "The connection sent a frame the other side could not read.",
  "hello-timeout": "The Hub did not receive this machine's hello in time.",
  "heartbeat-timeout": "The Hub stopped hearing from this machine.",
  replaced:
    "Another process is using this machine's credential, and the Hub kept the newer connection.",
  "hub-shutting-down": "The Hub is restarting.",
  "environment-mode-changed":
    "The Owner changed this machine's mode or Space; it reconnects to learn the new one.",
  "space-missing":
    "This machine is dedicated to a Space the Hub no longer has. The Owner can remove it or dedicate it elsewhere.",
  "not-sandboxed":
    "This machine is dedicated to a Space, so only its Sandbox container's server may connect. Restart it with `t3 serve`.",
  "sandbox-disk-full":
    "The Hub stopped this Sandbox: its disk is over its limit, or the Hub's disk is almost full.",
};

/**
 * Online while a socket is open and heard from within `ENVIRONMENT_RECONNECTING_AFTER_MS`,
 * reconnecting until `ENVIRONMENT_OFFLINE_AFTER_MS` of silence, then offline.
 */
export const environmentConnectionStatus = (input: {
  readonly connected: boolean;
  readonly lastSeenAtMs: number | null;
  readonly nowMs: number;
}): EnvironmentConnectionStatus => {
  if (input.lastSeenAtMs === null) return "offline";
  const silentMs = input.nowMs - input.lastSeenAtMs;
  if (input.connected && silentMs < ENVIRONMENT_RECONNECTING_AFTER_MS) return "online";
  return silentMs < ENVIRONMENT_OFFLINE_AFTER_MS ? "reconnecting" : "offline";
};
