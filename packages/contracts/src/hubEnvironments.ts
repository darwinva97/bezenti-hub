import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  SpaceId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import {
  EnvironmentConnectionStatus,
  EnvironmentHostResources,
  EnvironmentProviderSummary,
} from "./environmentConnection.ts";
import { HUB_MACHINE_ENVIRONMENT_ID } from "./environmentExecutor.ts";
import { AuthReauth } from "./userAccounts.ts";

/**
 * The Hub machine runs in the Hub's own process (and runs Threads only in development,
 * `T3CODE_HUB_RUNS_AGENTS`); an external one joined with `t3 join`; a Sandbox is the Space's own
 * joined server, which the Hub runs for it.
 */
export const HubEnvironmentKind = Schema.Literals(["hub", "external", "sandbox"]);
export type HubEnvironmentKind = typeof HubEnvironmentKind.Type;

/**
 * `personal`: only its owner uses it, in any of their Spaces. `dedicated`: an external machine the
 * Owner gave to one Organization, used like its `sandbox` (which the Hub runs for its Space) by the
 * Users who work there, for that Space's Threads.
 */
export const HubEnvironmentMode = Schema.Literals(["personal", "dedicated", "sandbox"]);
export type HubEnvironmentMode = typeof HubEnvironmentMode.Type;

export const HubEnvironmentName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * A machine's connection, or a Sandbox's lifecycle while it is not connected: `stopped` (the Hub
 * starts it for work), `starting`, or `failed` (its last start failed; `startError` says why).
 */
export const HubEnvironmentStatus = Schema.Literals([
  ...EnvironmentConnectionStatus.literals,
  "stopped",
  "starting",
  "failed",
]);
export type HubEnvironmentStatus = typeof HubEnvironmentStatus.Type;

/** A Space's Sandbox has one id for its whole life, known before the Sandbox exists. */
export const sandboxEnvironmentIdOf = (spaceId: SpaceId): EnvironmentId =>
  EnvironmentId.make(`sandbox:${spaceId}`);

/** «<Space> Sandbox», as every client names it. */
export const sandboxEnvironmentName = (spaceName: string) =>
  `${spaceName.slice(0, 64 - " Sandbox".length).trim()} Sandbox`;

export const HubEnvironmentSummary = Schema.Struct({
  id: EnvironmentId,
  name: HubEnvironmentName,
  kind: HubEnvironmentKind,
  mode: HubEnvironmentMode,
  /**
   * Null for the Hub machine, which belongs to the Installation, and for Sandboxes and dedicated
   * machines, which belong to their Space.
   */
  ownerUserId: Schema.NullOr(UserId),
  /**
   * A Sandbox's or dedicated machine's Space; it runs only that Space's Threads. Absent from older
   * Hubs.
   */
  spaceId: Schema.optionalKey(Schema.NullOr(SpaceId)),
  status: HubEnvironmentStatus,
  /** Why a `failed` Sandbox's last start failed. Absent from older Hubs. */
  startError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  registeredAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  os: Schema.NullOr(TrimmedNonEmptyString),
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  providers: Schema.Array(EnvironmentProviderSummary),
  resources: Schema.NullOr(EnvironmentHostResources),
  runningThreadCount: NonNegativeInt,
  /**
   * A Sandbox on a machine lent to its Space (Grants): listed as that Space's dedicated machine,
   * with who lent it, who controls it and sees everything that runs on it. Absent otherwise.
   */
  lent: Schema.optionalKey(
    Schema.Struct({
      grantId: TrimmedNonEmptyString,
      lenderName: Schema.NullOr(Schema.String),
    }),
  ),
});
export type HubEnvironmentSummary = typeof HubEnvironmentSummary.Type;

/**
 * Whether a list of machines shows it: every machine, and a Space's Sandbox once it has run (the
 * Hub also lists one not made yet, as a choice in the composer). Web Settings and the Owner's
 * overview both use this.
 */
export const isListedMachine = (
  environment: Pick<HubEnvironmentSummary, "kind" | "lastSeenAt">,
): boolean => environment.kind !== "sandbox" || environment.lastSeenAt !== null;

type PlacementCandidate = Pick<HubEnvironmentSummary, "id" | "kind" | "status" | "providers"> & {
  readonly usable: boolean;
};

/**
 * Whether a new Thread can start on the Environment now: the User may use it, it is online (a
 * Sandbox counts while stopped or starting, not once its start failed: the Hub starts it for the
 * work) and it has the provider, as far as it is known (a Sandbox that never ran reported none).
 * A null provider (none chosen yet) asks only where the Thread can run.
 */
export function canStartThreadOn(
  candidate: PlacementCandidate,
  providerInstanceId: string | null,
  /** Whether the Hub runs Sandboxes at all: one it cannot run takes no Thread. */
  sandboxesRun = true,
): boolean {
  if (!candidate.usable) return false;
  if (candidate.kind === "hub") return true;
  if (candidate.kind === "sandbox" && !sandboxesRun) return false;
  if (candidate.kind === "sandbox" && candidate.status !== "online") {
    if (candidate.status === "failed") return false;
    if (candidate.providers.length === 0) return true;
  } else if (candidate.status !== "online") {
    return false;
  }
  if (providerInstanceId === null) return true;
  const provider = candidate.providers.find((entry) => entry.instanceId === providerInstanceId);
  return provider !== undefined && provider.enabled && provider.installed;
}

/**
 * Where a new Thread nobody placed starts, by the Hub and as clients preview it: the preferred
 * Environment while it can take the Thread, else the Space's Sandbox (even stopped or failed: its
 * work starts it), or the Hub machine instead while it runs agents (`T3CODE_HUB_RUNS_AGENTS`).
 * Null: nothing can run it.
 */
export function previewThreadPlacement(input: {
  readonly preferred: PlacementCandidate | undefined;
  readonly providerInstanceId: string | null;
  /** Whether the Hub machine runs Threads; the Hub lists it only then. */
  readonly hubMachine: boolean;
  /** The Space's Sandbox, when the User may run Threads there. */
  readonly spaceSandbox: { readonly id: EnvironmentId } | undefined;
  /** Whether the Hub runs Sandboxes (`sandboxesUnavailable` null); true when not known. */
  readonly sandboxesRun?: boolean;
}): EnvironmentId | null {
  const preferred = input.preferred;
  const sandboxesRun = input.sandboxesRun ?? true;
  if (
    preferred !== undefined &&
    canStartThreadOn(preferred, input.providerInstanceId, sandboxesRun)
  ) {
    return preferred.id;
  }
  if (input.hubMachine) return HUB_MACHINE_ENVIRONMENT_ID;
  return sandboxesRun ? (input.spaceSandbox?.id ?? null) : null;
}

/** What the Hub and the composer say when a new Thread has nowhere to run, and why. */
export const NO_ENVIRONMENT_TITLE = "No Environment can run this Thread";
export const noEnvironmentMessage = (why: string) => `${NO_ENVIRONMENT_TITLE}: ${why}`;

/** Why a Hub runs no Sandboxes, when it cannot say more (older Hubs, tests). */
export const SANDBOXES_NEED_PODMAN =
  "Sandboxes need Podman on the Hub, which this Hub does not have yet.";

/** What a User without a place for a new Thread can do about it. */
export const NO_ENVIRONMENT_ADVICE =
  "Choose one of your own machines, or see «Run Threads in your Space's Sandbox» in the install guide.";

export const HubEnvironmentList = Schema.Struct({
  environments: Schema.Array(HubEnvironmentSummary),
  /**
   * Why this Hub runs no Sandboxes (no rootless Podman or image, not on loopback only, turned
   * off); null while it runs them. Absent from older Hubs.
   */
  sandboxesUnavailable: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type HubEnvironmentList = typeof HubEnvironmentList.Type;

export const RenameHubEnvironmentRequest = Schema.Struct({
  environmentId: EnvironmentId,
  name: HubEnvironmentName,
});
export type RenameHubEnvironmentRequest = typeof RenameHubEnvironmentRequest.Type;

export const RemoveHubEnvironmentRequest = Schema.Struct({ environmentId: EnvironmentId });
export type RemoveHubEnvironmentRequest = typeof RemoveHubEnvironmentRequest.Type;

/**
 * The Owner turns a machine personal (their own) or dedicates it to an Organization, or moves it
 * to another one. Refused while it has Threads, which are named to be moved first.
 */
export const ChangeHubEnvironmentModeRequest = Schema.Struct({
  environmentId: EnvironmentId,
  mode: Schema.Literals(["personal", "dedicated"]),
  /** The Organization, for `dedicated`. */
  spaceId: Schema.optionalKey(SpaceId),
});
export type ChangeHubEnvironmentModeRequest = typeof ChangeHubEnvironmentModeRequest.Type;

/** A Space a machine can be dedicated to, as «Register this machine» offers it to the Owner. */
export const HubEnvironmentDedicatedSpace = Schema.Struct({
  id: SpaceId,
  name: TrimmedNonEmptyString,
});
export type HubEnvironmentDedicatedSpace = typeof HubEnvironmentDedicatedSpace.Type;

/** «Try again» on a Sandbox that failed to start: the Hub starts it, and answers at once. */
export const StartHubEnvironmentRequest = Schema.Struct({ environmentId: EnvironmentId });
export type StartHubEnvironmentRequest = typeof StartHubEnvironmentRequest.Type;

/**
 * A Sandbox's CPU, memory, PIDs and disk limits. In the Installation's defaults null is no limit;
 * in a Space's override null is the Installation's default.
 */
// The Hub refuses values below a Sandbox's floors or above its machine, saying which.
const CpuLimit = Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)));
const CountLimit = Schema.NullOr(PositiveInt);

export const SandboxLimits = Schema.Struct({
  cpus: CpuLimit,
  memoryBytes: CountLimit,
  pids: CountLimit,
  diskBytes: CountLimit,
});
export type SandboxLimits = typeof SandboxLimits.Type;

/** A change to limits: only the values given change; null clears one (the default, or none). */
export const SandboxLimitsChange = Schema.Struct({
  cpus: Schema.optionalKey(CpuLimit),
  memoryBytes: Schema.optionalKey(CountLimit),
  pids: Schema.optionalKey(CountLimit),
  diskBytes: Schema.optionalKey(CountLimit),
});
export type SandboxLimitsChange = typeof SandboxLimitsChange.Type;

/**
 * Which limits this Hub enforces on its Sandboxes. CPU, memory and PIDs need the Sandbox runtime
 * to give each container a cgroup of its own; disk is the Hub's own periodic check. `note` says,
 * in words for the Owner, why one is not enforced.
 */
export const SandboxLimitEnforcement = Schema.Struct({
  cpus: Schema.Boolean,
  memory: Schema.Boolean,
  pids: Schema.Boolean,
  disk: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type SandboxLimitEnforcement = typeof SandboxLimitEnforcement.Type;

/** What a Sandbox used at the last sample (CPU and memory while running) and its home's size. */
export const SandboxUsage = Schema.Struct({
  /** Percent of one CPU. */
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
  diskBytes: Schema.NullOr(Schema.Number),
  diskMeasuredAt: Schema.NullOr(IsoDateTime),
  /** Why its home's last measurement failed; three in a row stop it, as over its limit. */
  diskError: Schema.NullOr(Schema.String),
});
export type SandboxUsage = typeof SandboxUsage.Type;

/** One Sandbox as Settings → Environments «Sandboxes» shows it. */
export const HubSandboxDetail = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  name: HubEnvironmentName,
  status: HubEnvironmentStatus,
  /** Why it is `failed`: its start, or its disk being over its limit. */
  error: Schema.NullOr(Schema.String),
  runtime: Schema.Literals(["process", "podman"]),
  /** The image version it last started with, once the Hub records one. */
  imageVersion: Schema.NullOr(Schema.String),
  /** Since when it runs; null while it does not. */
  startedAt: Schema.NullOr(IsoDateTime),
  /** The limits it starts with: the Space's override over the Installation's defaults. */
  limits: SandboxLimits,
  /** The Space's own values; null where it takes the default. */
  overrides: SandboxLimits,
  /** What its running server was started with; null while it does not run. */
  appliedLimits: Schema.NullOr(SandboxLimits),
  /** The Owner stopped it: waiting work does not start it, a User or the Owner does. */
  heldByOwner: Schema.Boolean,
  /** Threads with a turn running in it, which stopping it interrupts. */
  runningThreadCount: NonNegativeInt,
  /** The background sampler's last reading. */
  usage: SandboxUsage,
  /** Whether the viewer (the Owner) may start, stop, restart it and change its limits. */
  manageable: Schema.Boolean,
});
export type HubSandboxDetail = typeof HubSandboxDetail.Type;

/**
 * A Space whose Sandbox runs only on machines dedicated to it (the Hub runs none for it): its row
 * for limits in «Sandboxes». The Owner changes them through any of its machines.
 */
export const HubDedicatedSpaceLimits = Schema.Struct({
  spaceId: SpaceId,
  /** As the Owner knows the Space; null when the Owner has no name for it. */
  spaceName: Schema.NullOr(Schema.String),
  machines: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      name: HubEnvironmentName,
      status: HubEnvironmentStatus,
    }),
  ),
  /** The Space's own values; null where it takes the default. */
  own: SandboxLimits,
  /** What its Sandboxes start with: its own over the Installation's defaults. */
  effective: SandboxLimits,
});
export type HubDedicatedSpaceLimits = typeof HubDedicatedSpaceLimits.Type;

export const HubSandboxList = Schema.Struct({
  /** The Installation's default limits; the Owner changes them. */
  defaults: SandboxLimits,
  enforcement: SandboxLimitEnforcement,
  sandboxes: Schema.Array(HubSandboxDetail),
  /** Whether the viewer is the Owner, who changes the defaults. */
  manageable: Schema.Boolean,
  /**
   * For the Owner: each Space with dedicated machines and no Hub Sandbox listed, with its limits.
   * Absent from older Hubs and for other Users.
   */
  dedicatedSpaces: Schema.optionalKey(Schema.Array(HubDedicatedSpaceLimits)),
  /**
   * After a change of limits: what was changed, the defaults (`spaceId` null) or a Space's own
   * values, with the limits that Space's Sandboxes (on the Hub or a dedicated machine) start with.
   */
  changed: Schema.optionalKey(
    Schema.Struct({
      spaceId: Schema.NullOr(SpaceId),
      own: SandboxLimits,
      effective: SandboxLimits,
    }),
  ),
});
export type HubSandboxList = typeof HubSandboxList.Type;

/** One machine as the Owner's read-only overview names it: mode, Space or owner, and status. */
export const HubEnvironmentOverviewEntry = Schema.Struct({
  id: EnvironmentId,
  name: HubEnvironmentName,
  kind: HubEnvironmentKind,
  mode: HubEnvironmentMode,
  /** A Sandbox's or dedicated machine's Space. */
  spaceId: Schema.NullOr(SpaceId),
  /** That Space as the Owner knows it; null when there is none or it has no name for them. */
  spaceName: Schema.NullOr(Schema.String),
  /** A personal machine's User. */
  ownerUserId: Schema.NullOr(UserId),
  ownerName: Schema.NullOr(Schema.String),
  status: HubEnvironmentStatus,
  startError: Schema.NullOr(Schema.String),
  os: Schema.NullOr(TrimmedNonEmptyString),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  runningThreadCount: NonNegativeInt,
});
export type HubEnvironmentOverviewEntry = typeof HubEnvironmentOverviewEntry.Type;

/** Every machine on the Hub, for the Owner only (mobile's read-only list); others get 403. */
export const HubEnvironmentOverview = Schema.Struct({
  environments: Schema.Array(HubEnvironmentOverviewEntry),
});
export type HubEnvironmentOverview = typeof HubEnvironmentOverview.Type;

/** The Owner starts, stops or restarts a Sandbox by hand. Answers at once for a start. */
export const HubSandboxActionRequest = Schema.Struct({
  environmentId: EnvironmentId,
  action: Schema.Literals(["start", "stop", "restart"]),
});
export type HubSandboxActionRequest = typeof HubSandboxActionRequest.Type;

/**
 * The Owner changes the Installation's defaults (no `environmentId`) or one Space's override.
 * Takes effect on the Sandbox's next start; the disk limit at its next check.
 */
export const HubSandboxLimitsRequest = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  limits: SandboxLimitsChange,
});
export type HubSandboxLimitsRequest = typeof HubSandboxLimitsRequest.Type;

/**
 * `t3 join` asks to join. It made the credential itself and sends only its SHA-256, so the
 * credential never leaves the machine; the PKCE challenge binds the request to that `t3 join`.
 */
export const EnvironmentJoinStartRequest = Schema.Struct({
  codeChallenge: TrimmedNonEmptyString,
  codeChallengeMethod: Schema.Literal("S256"),
  credentialHash: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  os: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  hostname: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  /** A loopback port `t3 join` listens on, so a browser on the machine returns at once. */
  redirectUri: Schema.optionalKey(TrimmedNonEmptyString),
  state: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * `t3 join --dedicated <Space>`: the Space (its name or id) the machine asks to be dedicated to.
   * Only a suggestion for the page: the Owner chooses the Space when approving.
   */
  dedicatedSpace: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type EnvironmentJoinStartRequest = typeof EnvironmentJoinStartRequest.Type;

export const EnvironmentJoinStartResult = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type EnvironmentJoinStartResult = typeof EnvironmentJoinStartResult.Type;

export const EnvironmentJoinRequestRef = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type EnvironmentJoinRequestRef = typeof EnvironmentJoinRequestRef.Type;

/**
 * What «Register this machine» shows. The labels come from `t3 join` on the machine, and only a
 * viewer who may approve gets them.
 */
export const EnvironmentJoinRequestView = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  name: Schema.optionalKey(HubEnvironmentName),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  hostname: Schema.optionalKey(TrimmedNonEmptyString),
  requestedAt: Schema.optionalKey(IsoDateTime),
  status: Schema.Literals(["pending", "awaiting-confirmation", "approved", "denied"]),
  /**
   * Whether the browser's signed-in User may approve it (the Owner, or `environments.registerOwn`);
   * absent when that is unknown, as when nobody is signed in. Approving checks again.
   */
  viewerMayApprove: Schema.optionalKey(Schema.Boolean),
  /** Why they may not, when they may not. */
  denialMessage: Schema.optionalKey(TrimmedNonEmptyString),
  /** What `t3 join --dedicated` asked for, as typed there; only for a viewer who may approve. */
  requestedDedicatedSpace: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * The Organizations the viewer may dedicate the machine to: only the Owner gets them. The one
   * `requestedDedicatedSpace` names, if any, comes first.
   */
  dedicatedSpaces: Schema.optionalKey(Schema.Array(HubEnvironmentDedicatedSpace)),
});
export type EnvironmentJoinRequestView = typeof EnvironmentJoinRequestView.Type;

/** The approval, with a passkey or a password and code in the same request. */
export const EnvironmentJoinApproveRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  name: HubEnvironmentName,
  reauth: Schema.optionalKey(AuthReauth),
  /** Dedicates the machine to this Organization instead of making it the approver's (Owner only). */
  dedicatedSpaceId: Schema.optionalKey(SpaceId),
});
export type EnvironmentJoinApproveRequest = typeof EnvironmentJoinApproveRequest.Type;

/** Where the browser goes next: the machine's loopback port, or nowhere when there is none. */
export const EnvironmentJoinDecisionResult = Schema.Struct({
  redirectTo: Schema.NullOr(TrimmedNonEmptyString),
});
export type EnvironmentJoinDecisionResult = typeof EnvironmentJoinDecisionResult.Type;

export const EnvironmentJoinStatusRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  codeVerifier: TrimmedNonEmptyString,
});
export type EnvironmentJoinStatusRequest = typeof EnvironmentJoinStatusRequest.Type;

/** Who approved a machine joining, so `t3 join` can check it is whom it expected. */
export const EnvironmentJoinApprover = Schema.Struct({
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  /** Null for a User who signs in with a passkey only; they are named by `userId`. */
  loginName: Schema.NullOr(Schema.String),
});
export type EnvironmentJoinApprover = typeof EnvironmentJoinApprover.Type;

/** `t3 join` accepts the approver it was told about, registering the machine, or refuses them. */
export const EnvironmentJoinConfirmRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  codeVerifier: TrimmedNonEmptyString,
  accept: Schema.Boolean,
});
export type EnvironmentJoinConfirmRequest = typeof EnvironmentJoinConfirmRequest.Type;

/**
 * Asked again until it is neither `pending` nor `awaiting-confirmation`; the same approval answers
 * every time. Once approved on the page the machine is told by whom and confirms (or refuses)
 * before anything is registered.
 */
export const EnvironmentJoinStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied", "expired"]) }),
  Schema.Struct({
    status: Schema.Literal("awaiting-confirmation"),
    name: HubEnvironmentName,
    approvedBy: EnvironmentJoinApprover,
    /** Dedicated to this Space, rather than the approver's personal machine. */
    dedicatedSpace: Schema.optionalKey(HubEnvironmentDedicatedSpace),
  }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    environmentId: EnvironmentId,
    hubEnvironmentId: EnvironmentId,
    name: HubEnvironmentName,
    dedicatedSpace: Schema.optionalKey(HubEnvironmentDedicatedSpace),
  }),
]);
export type EnvironmentJoinStatus = typeof EnvironmentJoinStatus.Type;

/**
 * One Sandbox a lent machine runs: its Grant's Environment on the Hub, the borrowing Space, its
 * limits (the host caps CPU and memory at what it has) and, only when the host asked for it, a new
 * credential for it, reaching that Space alone.
 */
export const LentSandboxAssignment = Schema.Struct({
  grantId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  name: HubEnvironmentName,
  limits: SandboxLimits,
  credential: Schema.optionalKey(Schema.String),
});
export type LentSandboxAssignment = typeof LentSandboxAssignment.Type;

/**
 * A machine asks, with its own credential, how the Hub uses it now: a dedicated machine's host
 * follows this, never what it remembers.
 */
export const EnvironmentSelfResult = Schema.Struct({
  environmentId: EnvironmentId,
  name: HubEnvironmentName,
  mode: HubEnvironmentMode,
  spaceId: Schema.NullOr(SpaceId),
  /**
   * A dedicated machine's: its Space's effective Sandbox limits (its own over the Installation's
   * defaults), which its host starts the Sandbox with, at most what the machine has (CPU, memory
   * and PIDs; disk is the Hub's own check, for its own Sandboxes). Absent from older Hubs and for
   * personal machines.
   */
  limits: Schema.optionalKey(Schema.NullOr(SandboxLimits)),
  /**
   * A dedicated machine's, while it serves a Space: a new credential for its Sandbox, the only
   * one that connects as the machine, replacing the last one issued. It ends with the machine's
   * mode or Space; the machine's own credential stays with its host.
   */
  sandboxCredential: Schema.optionalKey(Schema.String),
  /**
   * A personal machine's Sandboxes for the Spaces it is lent to (Grants), each by its Grant.
   * Absent from older Hubs and on `/self`; answered by `/self/report`.
   */
  lent: Schema.optionalKey(Schema.Array(LentSandboxAssignment)),
});
export type EnvironmentSelfResult = typeof EnvironmentSelfResult.Type;

/**
 * Whether a machine can run lent Sandboxes now, as it reports itself: rootless Podman with the
 * Sandbox image and nothing of the host reachable but the ports its owner listed. Which limits its
 * cgroups enforce, and its size and free disk for Sandboxes.
 */
export const SandboxHostReport = Schema.Struct({
  ready: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  limitSupport: Schema.Struct({
    cpus: Schema.Boolean,
    memory: Schema.Boolean,
    pids: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
  }),
  /** Ports of the host its owner let lent Sandboxes reach (`T3CODE_SANDBOX_HOST_PORTS`). */
  reachablePorts: Schema.Array(Schema.Int),
  hostCpus: Schema.Number,
  hostMemoryBytes: Schema.Number,
  hostFreeBytes: Schema.NullOr(Schema.Number),
  hostTotalBytes: Schema.NullOr(Schema.Number),
});
export type SandboxHostReport = typeof SandboxHostReport.Type;

/** How one lent Sandbox is doing on its host, and its home's size. */
export const LentSandboxReport = Schema.Struct({
  grantId: TrimmedNonEmptyString,
  state: Schema.Literals(["starting", "running", "restarting", "failed", "stopped"]),
  message: Schema.NullOr(Schema.String),
  /** Null until measured. */
  diskUsedBytes: Schema.NullOr(Schema.Number),
  /** Measurements that failed in a row. */
  diskMeasureFailures: Schema.Int,
});
export type LentSandboxReport = typeof LentSandboxReport.Type;

/**
 * A personal machine's host reports itself and asks which Sandboxes it runs (`/self/report`):
 * `credentialsFor` names the Grants whose Sandbox it is about to start, the only ones issued a new
 * credential, so a running Sandbox's stays valid.
 */
export const EnvironmentSelfReport = Schema.Struct({
  sandboxHost: SandboxHostReport,
  sandboxes: Schema.Array(LentSandboxReport),
  credentialsFor: Schema.Array(TrimmedNonEmptyString),
});
export type EnvironmentSelfReport = typeof EnvironmentSelfReport.Type;

export const EnvironmentLeaveResult = Schema.Struct({ removed: Schema.Boolean });
export type EnvironmentLeaveResult = typeof EnvironmentLeaveResult.Type;
