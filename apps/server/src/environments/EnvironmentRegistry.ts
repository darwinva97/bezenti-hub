/**
 * The machines registered with this Hub (`environments`, migrations 094 and 100) and their
 * credentials, kept only as SHA-256. A removed machine's row stays revoked, so its credential
 * answers "revoked". Each Space's Sandbox is one of them, made when first chosen (`Sandboxes`).
 * See docs/internals/environment-auth.md#joined-environments and docs/internals/sandboxes.md.
 */
import {
  type EnvironmentCloseReason,
  environmentConnectionStatus,
  EnvironmentHostResources,
  EnvironmentId,
  EnvironmentProviderSummary,
  type EnvironmentHeartbeatFrame,
  type EnvironmentHelloFrame,
  HUB_MACHINE_ENVIRONMENT_ID,
  isListedMachine,
  type EnvironmentSelfReport,
  type EnvironmentSelfResult,
  GrantLimits,
  type LentSandboxAssignment,
  SandboxHostReport,
  type HubDedicatedSpaceLimits,
  type HubEnvironmentDedicatedSpace,
  type HubEnvironmentOverview,
  type HubEnvironmentSummary,
  canStartThreadOn,
  NO_ENVIRONMENT_ADVICE,
  noEnvironmentMessage,
  type HubSandboxDetail,
  type HubSandboxList,
  type ProjectId,
  type ProviderInstanceId,
  SANDBOXES_NEED_PODMAN,
  sandboxEnvironmentIdOf,
  sandboxEnvironmentName,
  type SandboxLimits,
  type SandboxLimitsChange,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import {
  environmentCredentialIssuer,
  formatEnvironmentCredential,
  REGISTER_OWN_REQUIRED_MESSAGE,
} from "@t3tools/shared/environmentJoin";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as SandboxRuntimeFromConfig from "../sandboxes/sandboxRuntimeFromConfig.ts";
import { hostCapacity, NO_LIMITS } from "../sandboxes/sandboxLimits.ts";
import {
  changeLimits,
  deleteSpaceLimits,
  readDefaultLimits,
  readSpaceLimits,
  readSpacesLimitsWithOwn,
  SandboxLimitsInvalidError,
  type SandboxNotFoundError,
} from "../sandboxes/sandboxLimitStore.ts";
import { LentSandboxDisk, sandboxSpaceOf } from "../sandboxes/sandboxSpace.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentConnections from "./EnvironmentConnections.ts";

export class EnvironmentStorageError extends Schema.TaggedError<EnvironmentStorageError>()(
  "EnvironmentStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write the Hub's Environments.";
  }
}

/** Missing, removed, or not one the User may see: all answer alike. */
export class EnvironmentNotFoundError extends Schema.TaggedError<EnvironmentNotFoundError>()(
  "EnvironmentNotFoundError",
  {},
) {
  override get message(): string {
    return "There is no such Environment.";
  }
}

export class EnvironmentAccessDeniedError extends Schema.TaggedError<EnvironmentAccessDeniedError>()(
  "EnvironmentAccessDeniedError",
  { reason: Schema.String },
) {
  override get message(): string {
    switch (this.reason) {
      case "hub-machine":
        return "The Hub machine runs the Hub itself and can't be removed.";
      case "user-inactive":
        return "This account is turned off.";
      case "sandbox":
        return "A Space's Sandbox is run by the Hub: it is not renamed or removed as a machine.";
      case "not-usable":
        return "You can't run Threads in this Sandbox's Space.";
      case "space-archived":
        return "Its Organization is archived: restore it to start its Sandbox.";
      case "space-frozen":
        return "Its Personal space is frozen: nothing starts in it.";
      case "missing-installation-permission":
        return REGISTER_OWN_REQUIRED_MESSAGE;
      case "not-an-organization":
        return "A machine is dedicated to an Organization that is not archived.";
      case "not-external":
        return "Only a machine joined with `t3 join` changes mode.";
      default:
        return "Only the Owner manages this Hub's Environments.";
    }
  }
}

/**
 * Why a new Thread cannot start in a new worktree off the Hub machine (until Environments check out
 * from the Hub repository), said when it is made: the composer, MCP and scheduled tasks alike.
 */
export const WORKTREE_UNSUPPORTED_MESSAGE =
  "New worktrees are made only on the Hub machine for now, and this Thread runs elsewhere (a Sandbox or a joined machine cannot make one yet). Start it in the Project's checkout instead.";

/** Threads still have the machine as their Active environment: they move first. */
export class EnvironmentModeChangeRefusedError extends Schema.TaggedError<EnvironmentModeChangeRefusedError>()(
  "EnvironmentModeChangeRefusedError",
  {
    threads: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  },
) {
  override get message(): string {
    const titles = this.threads
      .slice(0, 5)
      .map((thread) => `«${thread.title}»`)
      .join(", ");
    const more = this.threads.length > 5 ? ` and ${this.threads.length - 5} more` : "";
    return `Move ${this.threads.length === 1 ? "this Thread" : `these ${this.threads.length} Threads`} to another Environment first: ${titles}${more}.`;
  }
}

/** Why a new Thread cannot run on the Environment it asked for. */
export class ThreadEnvironmentUnavailableError extends Schema.TaggedError<ThreadEnvironmentUnavailableError>()(
  "ThreadEnvironmentUnavailableError",
  {
    environmentId: EnvironmentId,
    name: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "not-usable",
      "offline",
      "provider-missing",
      "worktree-unsupported",
      "sandbox-failed",
      "sandbox-unavailable",
      "hub-machine",
      "no-environment",
    ]),
    providerInstanceId: Schema.optional(Schema.String),
    /** Why a Sandbox did not start, or why this Hub runs no Sandboxes. */
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const name = this.name ?? "This Environment";
    switch (this.reason) {
      case "hub-machine":
        return "The Hub machine does not run Threads on this Hub. Choose your Space's Sandbox or one of your own machines.";
      case "no-environment":
        return noEnvironmentMessage(
          `${this.detail ?? SANDBOXES_NEED_PODMAN} ${NO_ENVIRONMENT_ADVICE}`,
        );
      case "not-usable":
        return "You can't run Threads on this Environment.";
      case "offline":
        return `${name} is offline. Start it, or choose another Environment.`;
      case "provider-missing":
        return `${name} can't run ${this.providerInstanceId ?? "this provider"}. Choose another provider or Environment.`;
      case "worktree-unsupported":
        return WORKTREE_UNSUPPORTED_MESSAGE;
      case "sandbox-unavailable":
        return this.detail === undefined
          ? "Sandboxes need Podman on the Hub, which this Hub does not have yet. See «Run Threads in your Space's Sandbox» in the install guide."
          : `${this.detail} See «Run Threads in your Space's Sandbox» in the install guide.`;
      case "sandbox-failed":
        return `${name} could not start${this.detail === undefined ? "." : `: ${this.detail}`}`;
    }
  }
}

const isThreadEnvironmentUnavailable = Schema.is(ThreadEnvironmentUnavailableError);

/** The reason a launch was refused for its Environment, wherever it sits in the cause chain. */
export const environmentRefusalMessage = (cause: unknown): string | undefined => {
  let current = cause;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (isThreadEnvironmentUnavailable(current)) return current.message;
    current =
      typeof current === "object" && current !== null
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return undefined;
};

/** Live facts about the Hub machine; the server provides them, tests leave them empty. */
export class HubMachineSnapshot extends Context.Reference<{
  readonly providers: Effect.Effect<ReadonlyArray<EnvironmentProviderSummary>>;
  readonly resources: Effect.Effect<EnvironmentHostResources | null>;
}>("t3/environments/HubMachineSnapshot", {
  defaultValue: () => ({ providers: Effect.succeed([]), resources: Effect.succeed(null) }),
}) {}

export type CredentialCheck =
  | {
      readonly _tag: "valid";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      /** Null for a Sandbox, which belongs to its Space. */
      readonly ownerUserId: UserId | null;
      /** A Sandbox's or dedicated machine's Space: the only one its credential reaches. */
      readonly spaceId: SpaceId | null;
      readonly mode: "personal" | "dedicated" | "sandbox";
      /** A Sandbox on a lent machine (Grants): only its container connects, saying so. */
      readonly lent: boolean;
    }
  | { readonly _tag: "refused"; readonly reason: EnvironmentCloseReason };

interface EnvironmentRow {
  readonly environmentId: string;
  readonly name: string;
  readonly kind: "hub" | "external" | "sandbox";
  /** `lent`: a Sandbox on a machine lent to its Space (Grants), `kind = 'sandbox'`. */
  readonly mode: "personal" | "dedicated" | "sandbox" | "lent";
  /** A lent Sandbox's Grant and the machine that hosts it. */
  readonly grantId: string | null;
  readonly hostEnvironmentId: string | null;
  /** A lent Sandbox's lender, as the borrowers see it named. */
  readonly lenderName: string | null;
  /** A lent Sandbox works while its Grant is active and its host and lender are. */
  readonly lentLive: number;
  readonly ownerUserId: string | null;
  readonly spaceId: string | null;
  readonly registeredAt: string;
  readonly lastSeenAt: string | null;
  readonly lastOs: string | null;
  readonly lastHostname: string | null;
  readonly lastResourcesJson: string | null;
  readonly lastProvidersJson: string | null;
  readonly revokedAt: string | null;
  /** The owner was turned off or removed. */
  readonly ownerInactive: number;
  /** A Sandbox's lifecycle (`sandboxes.status`) and why its last start failed. */
  readonly sandboxStatus: "stopped" | "starting" | "running" | "failed" | null;
  readonly sandboxError: string | null;
}

type PolicyRow = Pick<EnvironmentRow, "kind" | "mode" | "ownerUserId" | "spaceId">;

/** Threads a machine no longer serves since its mode or Space changed. */
export interface ReleasedThreads {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

/** A Sandbox or a dedicated machine: it belongs to its Space and runs only that Space's Threads. */
const isSpaceBound = (row: Pick<PolicyRow, "kind" | "mode">) =>
  row.kind === "sandbox" || row.mode === "dedicated";

/**
 * A Space's Sandbox the Hub runs itself (`sandbox:<Space>`), as opposed to one on a lent machine,
 * which its host runs and which clients see as that Space's dedicated machine.
 */
const isHubSandbox = (row: Pick<PolicyRow, "kind" | "mode">) =>
  row.kind === "sandbox" && row.mode === "sandbox";

const decodeResources = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentHostResources));
const decodeProviders = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);
const encodeResources = Schema.encodeSync(Schema.fromJsonString(EnvironmentHostResources));
const decodeSandboxHost = Schema.decodeUnknownOption(Schema.fromJsonString(SandboxHostReport));
const encodeSandboxHost = Schema.encodeSync(Schema.fromJsonString(SandboxHostReport));
const decodeGrantLimits = Schema.decodeUnknownOption(Schema.fromJsonString(GrantLimits));

/** A lent Sandbox's Environment id: one per Grant, never `sandbox:` (a Hub Sandbox's). */
const lentEnvironmentIdOf = (grantId: string) => EnvironmentId.make(`lent:${grantId}`);

const encodeLentDisk = Schema.encodeSync(Schema.fromJsonString(LentSandboxDisk));
const encodeProviders = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);

/**
 * The machine as the policy decides on it: a Sandbox with its Space (absent when the Space is
 * gone, which the policy refuses), and `workSpaceId` the Space of the Thread it would run.
 */
const environmentResource = (
  row: PolicyRow,
  space: AccessPolicy.SpaceResource | undefined,
  workSpaceId?: SpaceId,
): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: row.kind,
  mode: row.mode,
  ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
  ...(space === undefined ? {} : { space }),
  ...(workSpaceId === undefined ? {} : { workSpaceId }),
});

/** `environmentResource` with a Sandbox's or dedicated machine's Space read for it. */
const resourceFor = Effect.fn("EnvironmentRegistry.resourceFor")(function* (
  row: PolicyRow,
  workSpaceId?: SpaceId,
) {
  const space =
    isSpaceBound(row) && row.spaceId !== null
      ? yield* (yield* SpaceDirectory.SpaceDirectory)
          .spaceById(SpaceId.make(row.spaceId))
          .pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })))
      : Option.none<{ readonly resource: AccessPolicy.SpaceResource }>();
  return environmentResource(
    row,
    Option.isSome(space) ? space.value.resource : undefined,
    workSpaceId,
  );
});

/**
 * Whether the User may run Threads on the Environment (a Sandbox: for `workSpaceId`'s Threads), as
 * a Project's preferred Environment must be for its setter. Unknown and removed machines answer
 * false; without a User any machine the Hub knows will do. A plain function, so Project services
 * can ask it without the registry's connections.
 */
export const mayUseEnvironment = Effect.fn("EnvironmentRegistry.mayUseEnvironment")(function* (
  userId: UserId | undefined,
  environmentId: EnvironmentId,
  workSpaceId?: SpaceId,
) {
  if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return true;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<PolicyRow>`
    SELECT kind, mode, owner_user_id AS "ownerUserId", space_id AS "spaceId" FROM environments
    WHERE environment_id = ${environmentId} AND revoked_at IS NULL
  `.pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })));
  if (row === undefined) return false;
  if (userId === undefined) return true;
  const principal = yield* (yield* SpaceDirectory.SpaceDirectory)
    .principalOf(userId)
    .pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })));
  return (
    principal.inactive !== true &&
    AccessPolicy.isAllowed(
      AccessPolicy.decide(principal, "environment.use", yield* resourceFor(row, workSpaceId)),
    )
  );
});

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    /**
     * This Hub's own identity (the server's persisted EnvironmentId), which its credentials and
     * `welcome` name. Not the Hub machine's row id, which is the same constant on every Hub.
     */
    readonly hubId: EnvironmentId;
    /**
     * Whether the Hub machine's in-process executor runs Threads (`T3CODE_HUB_RUNS_AGENTS`, for
     * development). Off, it is neither listed nor placed on, and its Threads need an environment.
     */
    readonly hubRunsAgents: boolean;
    /** Why this Hub runs no Sandboxes; null while it runs them. */
    readonly sandboxesUnavailable: string | null;
    /**
     * The Owner turned Sandboxes off (`T3CODE_SANDBOX_RUNTIME=off`): their Threads need an
     * environment as the Hub starts. Any other reason (no image yet, Podman away) may pass.
     */
    readonly sandboxesTurnedOff: boolean;
    /**
     * What the User may see, the Hub machine first (only while it runs Threads). A Space the User
     * works in whose Sandbox was never made lists it too, stopped, so it can be chosen and made.
     */
    readonly list: (
      viewer: UserId,
    ) => Effect.Effect<
      ReadonlyArray<HubEnvironmentSummary>,
      EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /**
     * Every machine the Owner sees, with its Space and owner by name: the Owner's read-only list
     * on mobile. Refused to anyone else.
     */
    readonly overview: (
      viewer: UserId,
    ) => Effect.Effect<
      HubEnvironmentOverview,
      EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    readonly rename: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
      readonly name: string;
    }) => Effect.Effect<
      HubEnvironmentSummary,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /** Revokes the credential and closes the machine's socket at once. */
    readonly remove: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
      /** `ssh`: an SSH install undoing the machine it registered; `settings` otherwise. */
      readonly via?: "settings" | "ssh";
    }) => Effect.Effect<
      void,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /**
     * Whether the User may approve their own machine joining (the Owner, or `registerOwn`);
     * checked before the strong factor. Refuses with the reason.
     */
    readonly authorizeRegister: (
      userId: UserId,
    ) => Effect.Effect<void, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /**
     * Stores a newly joined machine by its credential's hash as a personal machine of the User who
     * approved it, recording them.
     */
    readonly register: (input: {
      readonly approvedBy: UserId;
      readonly name: string;
      readonly os: string;
      readonly hostname: string;
      readonly credentialHash: string;
      /** Dedicated to this Organization instead (the Owner only). */
      readonly dedicatedSpaceId?: SpaceId | undefined;
      /** How it came: `t3 join` (the default), or the Hub's SSH install, on `host`. */
      readonly via?: { readonly _tag: "join" } | { readonly _tag: "ssh"; readonly host: string };
    }) => Effect.Effect<EnvironmentId, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /**
     * Whether a registered machine's server has reached the Hub with its credential: asked how it
     * is used (`/api/environments/self`, a dedicated machine's first call) or connected.
     */
    readonly hasReachedHub: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean, EnvironmentStorageError>;
    /**
     * The Organizations the User may dedicate a machine to: every one not archived, for the
     * Owner; refused for anyone else.
     */
    readonly dedicatedSpaces: (
      userId: UserId,
    ) => Effect.Effect<
      ReadonlyArray<HubEnvironmentDedicatedSpace>,
      EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /** Whether the User may dedicate machines (the Owner); refuses with the reason. */
    readonly authorizeDedicate: (
      userId: UserId,
    ) => Effect.Effect<void, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /**
     * The Owner makes a joined machine personal (their own) or dedicates it to an Organization.
     * Refused while Threads have it as their Active environment, naming them. Its socket is
     * closed, so the machine reconnects and learns its new mode.
     */
    readonly changeMode: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
      readonly mode: "personal" | "dedicated";
      readonly spaceId?: SpaceId | undefined;
    }) => Effect.Effect<
      HubEnvironmentSummary,
      | EnvironmentNotFoundError
      | EnvironmentAccessDeniedError
      | EnvironmentModeChangeRefusedError
      | EnvironmentStorageError
    >;
    /**
     * Revokes every machine the User owns, as their account is turned off or removed; run it in
     * that transaction. Answers what to disconnect once it commits.
     */
    readonly revokeOwnedBy: (input: {
      readonly userId: UserId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<Effect.Effect<void>, EnvironmentStorageError>;
    readonly checkCredential: (
      credential: string | undefined,
    ) => Effect.Effect<CredentialCheck, EnvironmentStorageError>;
    readonly recordHello: (
      environmentId: EnvironmentId,
      hello: EnvironmentHelloFrame,
    ) => Effect.Effect<void, EnvironmentStorageError>;
    readonly recordHeartbeat: (
      environmentId: EnvironmentId,
      heartbeat: EnvironmentHeartbeatFrame,
    ) => Effect.Effect<void, EnvironmentStorageError>;
    /** `t3 leave`: the machine removes itself with its own credential. A Sandbox never does. */
    readonly leave: (
      credential: string | undefined,
    ) => Effect.Effect<boolean, EnvironmentStorageError>;
    /**
     * Where a new Thread runs: the User's choice, else the preference while it can take it, else
     * the Space's Sandbox (the Hub machine while it runs agents), made if missing, never started
     * here. Nowhere to go refuses (`no-environment`): nothing falls back to the Hub machine.
     */
    readonly chooseForThread: (input: {
      readonly userId: UserId | undefined;
      readonly requested: EnvironmentId | undefined;
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
      /** The new Thread's Space, once claimed; else its Project's. */
      readonly spaceId?: SpaceId | undefined;
      /** A Thread that moves: its own Space is the one that counts. */
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<EnvironmentId, ThreadEnvironmentUnavailableError | EnvironmentStorageError>;
    /**
     * The Environment's name when the User may use it for the Thread (`environment.use`: a
     * personal machine is its owner's alone, a Sandbox its Space's), whether or not it is
     * online; None otherwise. Calls forwarded to a machine check it, so a Thread is never a way
     * onto a machine its User may not use.
     */
    readonly usableBy: (input: {
      readonly userId: UserId | undefined;
      readonly environmentId: EnvironmentId;
      /** The Thread the call is for; a Sandbox serves only its own Space's. */
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<Option.Option<{ readonly name: string }>, EnvironmentStorageError>;
    /**
     * Each Environment once its removal committed (from Settings, `t3 leave`, or its owner turned
     * off): its Threads then need an environment.
     */
    readonly removed: Stream.Stream<EnvironmentId>;
    /**
     * Archived Threads left on a machine whose mode or Space changed: they need an environment
     * from now on, as on a removed machine.
     */
    readonly released: Stream.Stream<ReleasedThreads>;
    /**
     * How the Hub uses the machine its own credential names now; None when it is refused. A
     * dedicated machine also gets a new credential for its Sandbox (`sandboxCredential`), and one
     * whose Space is gone answers `spaceId: null` until the Owner dedicates it elsewhere.
     */
    readonly selfOf: (
      credential: string | undefined,
    ) => Effect.Effect<Option.Option<EnvironmentSelfResult>, EnvironmentStorageError>;
    /**
     * Grants ticket 08: a personal machine reports whether it can run lent Sandboxes and how each
     * is doing, and is answered `selfOf` with the Sandboxes of its active Grants (`lent`), a new
     * credential for each it asked one for. None when its own credential is refused.
     */
    readonly reportSelf: (
      credential: string | undefined,
      report: EnvironmentSelfReport,
    ) => Effect.Effect<Option.Option<EnvironmentSelfResult>, EnvironmentStorageError>;
    /** What the machine last said of hosting Sandboxes; None when it never did. */
    readonly sandboxHostOf: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<SandboxHostReport>, EnvironmentStorageError>;
    /**
     * In the caller's transaction: the Grant's Sandbox on its host becomes an Environment of the
     * borrowing Space (`lent:<grantId>`), with no credential until its host asks for one.
     */
    readonly openLentSandbox: (input: {
      readonly grantId: string;
      readonly hostEnvironmentId: EnvironmentId;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<EnvironmentId, EnvironmentStorageError>;
    /**
     * In the caller's transaction: the Grant's Sandbox is removed and its credentials end. Then,
     * after the commit, `lentSandboxClosed`.
     */
    readonly closeLentSandbox: (
      grantId: string,
    ) => Effect.Effect<Option.Option<EnvironmentId>, EnvironmentStorageError>;
    /** After the commit: its socket closes and its Threads need an environment. */
    readonly lentSandboxClosed: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * «Try again» on a Sandbox that failed to start: a User who may run Threads in its Space starts
     * it. Answers at once with it `starting`; how the start ends shows in the list.
     */
    readonly startSandbox: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      HubEnvironmentSummary,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /**
     * Settings → Environments «Sandboxes»: the Sandboxes the User may inspect (`sandbox.inspect`:
     * the Owner every one, an Admin their Space's) with status, use, limits and image, and the
     * Installation's defaults.
     */
    readonly sandboxes: (
      viewer: UserId,
    ) => Effect.Effect<HubSandboxList, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /** The Owner starts (in the background), stops or restarts a Sandbox (`sandbox.manage`). */
    readonly sandboxAction: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
      readonly action: "start" | "stop" | "restart";
    }) => Effect.Effect<
      HubSandboxDetail,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /**
     * The Owner changes the Installation's defaults (no Environment) or a Space's own limits, on its
     * Sandbox or on a machine dedicated to it.
     */
    readonly setSandboxLimits: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId | undefined;
      readonly limits: SandboxLimitsChange;
    }) => Effect.Effect<
      HubSandboxList,
      | EnvironmentNotFoundError
      | EnvironmentAccessDeniedError
      | SandboxLimitsInvalidError
      | EnvironmentStorageError
    >;
    /** Each time the Hub ended a Sandbox's sessions as it stopped it (its disk). */
    readonly sandboxSessionsEnded: Stream.Stream<Sandboxes.SandboxSessionsEnded>;
    /** Its Organization was archived: its Sandbox stops, and starts no more while archived. */
    readonly stopSandbox: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, EnvironmentStorageError>;
    /**
     * Its Space is deleted: its Sandbox stops, its credential is revoked, its row and home go.
     * Its Threads then need an environment, as for a removed machine.
     */
    readonly deleteSandbox: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, EnvironmentStorageError>;
  }
>()("t3/environments/EnvironmentRegistry") {}

/** How long a dedicated Sandbox's replaced credential stays valid while the new one is unused. */
const SANDBOX_CREDENTIAL_OVERLAP_MINUTES = 10;

/** Why a registry without a runtime has no Sandboxes. */
export interface RegistryOptions {
  /** Why there are no Sandboxes, for a registry without a runtime. */
  readonly sandboxesUnavailable?: string;
  /** The Owner turned them off, rather than a runtime that may come back. */
  readonly sandboxesTurnedOff?: boolean;
}

const make = Effect.fn("EnvironmentRegistry.make")(function* (options: RegistryOptions) {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const connections = yield* EnvironmentConnections.EnvironmentConnections;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const hubId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  // Without a Sandbox runtime (the join flow's tests) Sandboxes are listed but never made.
  const sandboxes = yield* Effect.serviceOption(Sandboxes.Sandboxes);
  // Whether the Hub machine runs Threads (`T3CODE_HUB_RUNS_AGENTS`), as the server provides it.
  const hubRunsAgents = yield* HubRunsAgents.HubRunsAgents;
  const sandboxesUnavailable = Option.isSome(sandboxes)
    ? null
    : (options.sandboxesUnavailable ?? SANDBOXES_NEED_PODMAN);
  const sandboxesTurnedOff = Option.isNone(sandboxes) && options.sandboxesTurnedOff === true;
  const storageError = (cause: unknown) => new EnvironmentStorageError({ cause });
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const platform = yield* HostProcess.Platform;
  const removals = yield* PubSub.unbounded<EnvironmentId>();
  const releases = yield* PubSub.unbounded<ReleasedThreads>();

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  const selectRows = (conditions: Parameters<typeof sql.and>[0]) => sql<EnvironmentRow>`
    SELECT environment_id AS "environmentId", name, kind, mode, owner_user_id AS "ownerUserId",
      space_id AS "spaceId",
      registered_at AS "registeredAt", last_seen_at AS "lastSeenAt", last_os AS "lastOs",
      last_hostname AS "lastHostname", last_resources_json AS "lastResourcesJson",
      last_providers_json AS "lastProvidersJson", revoked_at AS "revokedAt",
      EXISTS (
        SELECT 1 FROM users AS owner WHERE owner.user_id = environments.owner_user_id
          AND (owner.disabled_at IS NOT NULL OR owner.removed_at IS NOT NULL)
      ) AS "ownerInactive",
      (
        SELECT sandbox.status FROM sandboxes AS sandbox
        WHERE sandbox.environment_id = environments.environment_id
      ) AS "sandboxStatus",
      (
        SELECT sandbox.last_error FROM sandboxes AS sandbox
        WHERE sandbox.environment_id = environments.environment_id
      ) AS "sandboxError",
      grant_id AS "grantId", host_environment_id AS "hostEnvironmentId",
      (
        SELECT lender.display_name FROM grants AS g
        JOIN users AS lender ON lender.user_id = g.lender_id
        WHERE g.grant_id = environments.grant_id
      ) AS "lenderName",
      (environments.mode <> 'lent' OR EXISTS (
        SELECT 1 FROM grants AS g
        JOIN environments AS host ON host.environment_id = environments.host_environment_id
        JOIN users AS lender ON lender.user_id = host.owner_user_id
        WHERE g.grant_id = environments.grant_id AND g.state = 'active'
          AND host.revoked_at IS NULL AND host.mode = 'personal'
          AND lender.disabled_at IS NULL AND lender.removed_at IS NULL
      )) AS "lentLive"
    FROM environments WHERE ${sql.and(conditions)}
    ORDER BY kind = 'hub' DESC, registered_at, environment_id
  `;

  const liveRow = (environmentId: EnvironmentId) =>
    selectRows([sql`environment_id = ${environmentId}`, sql`revoked_at IS NULL`]).pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

  /** Threads on the Environment with a run in progress. */
  const runningThreadCount = (environmentId: EnvironmentId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_threads AS thread
      WHERE thread.active_environment_id = ${environmentId}
        AND thread.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = thread.thread_id
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        )
    `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.orElseSucceed(() => 0),
    );

  /**
   * One machine as a viewer sees it. The Hub machine's load, providers and running Threads are the
   * whole Installation's, so only the Owner (`ownerView`) gets them. `name` replaces the stored
   * one: a Sandbox is named after its Space as the viewer calls it.
   */
  const summaryOf = Effect.fn("EnvironmentRegistry.summaryOf")(function* (
    row: EnvironmentRow,
    ownerView = true,
    name?: string,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (row.kind === "hub" && !ownerView) {
      return {
        id: EnvironmentId.make(row.environmentId),
        name: row.name,
        kind: row.kind,
        mode: "personal",
        ownerUserId: null,
        spaceId: null,
        status: "online",
        registeredAt: row.registeredAt,
        lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        os: platform,
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      } satisfies HubEnvironmentSummary;
    }
    if (row.kind === "hub") {
      const snapshot = yield* HubMachineSnapshot;
      return {
        id: EnvironmentId.make(row.environmentId),
        name: row.name,
        kind: row.kind,
        mode: "personal",
        ownerUserId: null,
        spaceId: null,
        status: "online",
        registeredAt: row.registeredAt,
        lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        os: platform,
        hostname: null,
        providers: yield* snapshot.providers,
        resources: yield* snapshot.resources,
        runningThreadCount: yield* runningThreadCount(HUB_MACHINE_ENVIRONMENT_ID),
      } satisfies HubEnvironmentSummary;
    }
    const environmentId = EnvironmentId.make(row.environmentId);
    const connected = yield* connections.isConnected(environmentId);
    const connection = environmentConnectionStatus({
      connected,
      lastSeenAtMs: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
      nowMs,
    });
    // A Sandbox on a lent machine is, to every client, its Space's dedicated machine: its host
    // runs it, so it is online once connected and nothing starts it for work.
    if (row.mode === "lent") {
      return {
        id: environmentId,
        name: name ?? row.name,
        kind: "external",
        mode: "dedicated",
        ownerUserId: null,
        spaceId: row.spaceId === null ? null : SpaceId.make(row.spaceId),
        status: connection,
        registeredAt: row.registeredAt,
        lastSeenAt: row.lastSeenAt,
        os: row.lastOs,
        hostname: row.lastHostname,
        providers: Option.getOrElse(decodeProviders(row.lastProvidersJson), () => []),
        resources: Option.getOrNull(decodeResources(row.lastResourcesJson)),
        runningThreadCount: yield* runningThreadCount(environmentId),
        lent: { grantId: row.grantId ?? "", lenderName: row.lenderName },
      } satisfies HubEnvironmentSummary;
    }
    const status: HubEnvironmentSummary["status"] =
      row.kind !== "sandbox"
        ? connection
        : // A Sandbox is online once started; until then the Hub starts it when work needs it.
          row.sandboxStatus === "starting"
          ? "starting"
          : connected
            ? connection
            : row.sandboxStatus === "failed"
              ? "failed"
              : row.sandboxStatus === "running"
                ? connection
                : "stopped";
    return {
      id: environmentId,
      name: name ?? row.name,
      kind: row.kind,
      mode: row.kind === "sandbox" ? "sandbox" : row.mode,
      // A dedicated machine is its Space's, whoever dedicated it.
      ownerUserId:
        row.ownerUserId === null || row.mode === "dedicated" ? null : UserId.make(row.ownerUserId),
      spaceId: row.spaceId === null ? null : SpaceId.make(row.spaceId),
      status,
      ...(row.kind === "sandbox"
        ? { startError: status === "failed" ? row.sandboxError : null }
        : {}),
      registeredAt: row.registeredAt,
      lastSeenAt: row.lastSeenAt,
      os: row.lastOs,
      hostname: row.lastHostname,
      providers: Option.getOrElse(decodeProviders(row.lastProvidersJson), () => []),
      resources: Option.getOrNull(decodeResources(row.lastResourcesJson)),
      runningThreadCount: yield* runningThreadCount(environmentId),
    } satisfies HubEnvironmentSummary;
  });

  const decide = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) => AccessPolicy.decide(principal, action, resource);

  const principalOf = (userId: UserId) =>
    spaces.principalOf(userId).pipe(Effect.mapError(storageError));

  const resourceOf = (row: PolicyRow, workSpaceId?: SpaceId) =>
    resourceFor(row, workSpaceId).pipe(
      Effect.provideService(SpaceDirectory.SpaceDirectory, spaces),
    );

  /** The list, with the Space names the viewer knows, which the Owner's overview reuses. */
  const listWithSpaceNames = Effect.fn("EnvironmentRegistry.listWithSpaceNames")(function* (
    viewer: UserId,
  ) {
    const principal = yield* principalOf(viewer);
    if (principal.inactive === true) {
      return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
    }
    const rows = yield* selectRows([sql`revoked_at IS NULL`]).pipe(Effect.mapError(storageError));
    // Each Space by the name this viewer knows it by (another User's Personal space included).
    const viewed = (yield* spaces.view(viewer).pipe(Effect.mapError(storageError))).spaces;
    const spaceNames = new Map<string, string>(viewed.map((space) => [space.id, space.name]));
    // One read for every Sandbox's Space and every Space that may get one.
    const spaceResources = yield* spaces
      .spacesById([
        ...rows.flatMap((row) =>
          isSpaceBound(row) && row.spaceId !== null ? [SpaceId.make(row.spaceId)] : [],
        ),
        ...viewed.map((space) => space.id),
      ])
      .pipe(Effect.mapError(storageError));
    const spaceOf = (spaceId: string | null) =>
      spaceId === null ? undefined : spaceResources.get(SpaceId.make(spaceId))?.resource;
    const summaries: Array<HubEnvironmentSummary> = [];
    for (const row of rows) {
      // A Hub machine that runs no Threads is nowhere to run one: it is not offered.
      if (row.kind === "hub" && !hubRunsAgents) continue;
      // Nor a Sandbox made by a runtime this Hub no longer runs (a lent one's host runs it).
      if (isHubSandbox(row) && Option.isNone(sandboxes)) continue;
      // Nor a lent Sandbox whose Grant, host or lender is gone.
      if (row.mode === "lent" && row.lentLive !== 1) continue;
      const resource = environmentResource(
        row,
        isSpaceBound(row) ? spaceOf(row.spaceId) : undefined,
      );
      if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) continue;
      const spaceName =
        isHubSandbox(row) && row.spaceId !== null ? spaceNames.get(row.spaceId) : undefined;
      summaries.push(
        yield* summaryOf(
          row,
          principal.isOwner,
          spaceName === undefined ? undefined : sandboxEnvironmentName(spaceName),
        ),
      );
    }
    const made = new Set(rows.flatMap((row) => (isHubSandbox(row) ? [row.spaceId] : [])));
    // Without a runtime that can run them, Sandboxes not made yet are not offered.
    if (Option.isNone(sandboxes)) return { summaries, spaceNames };
    const now = yield* nowIso;
    for (const space of viewed) {
      if (made.has(space.id)) continue;
      const resource = environmentResource(
        { kind: "sandbox", mode: "sandbox", ownerUserId: null, spaceId: space.id },
        spaceOf(space.id),
        space.id,
      );
      if (!AccessPolicy.isAllowed(decide(principal, "environment.use", resource))) continue;
      summaries.push({
        id: sandboxEnvironmentIdOf(space.id),
        name: sandboxEnvironmentName(space.name),
        kind: "sandbox",
        mode: "sandbox",
        ownerUserId: null,
        spaceId: space.id,
        status: "stopped",
        registeredAt: now,
        lastSeenAt: null,
        os: null,
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      });
    }
    return { summaries, spaceNames };
  });

  const list: EnvironmentRegistry["Service"]["list"] = (viewer) =>
    listWithSpaceNames(viewer).pipe(Effect.map(({ summaries }) => summaries));

  const overview: EnvironmentRegistry["Service"]["overview"] = Effect.fn(
    "EnvironmentRegistry.overview",
  )(function* (viewer) {
    const principal = yield* principalOf(viewer);
    if (principal.inactive === true) {
      return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
    }
    if (!principal.isOwner) {
      return yield* new EnvironmentAccessDeniedError({ reason: "owner-only" });
    }
    const listed = yield* listWithSpaceNames(viewer);
    const spaceNames = listed.spaceNames;
    // The same rule as web Settings: a Sandbox counts as a machine once it has run.
    const environments = listed.summaries.filter(isListedMachine);
    // Owners' names only when a personal machine is listed.
    const userNames = new Map<string, string>(
      environments.some((environment) => environment.ownerUserId !== null)
        ? (yield* spaces.listUsers(viewer).pipe(
            Effect.catchTags({
              SpaceAccessDeniedError: () =>
                Effect.fail(new EnvironmentAccessDeniedError({ reason: "owner-only" })),
              SpaceDirectoryStorageError: (cause) => Effect.fail(storageError(cause)),
            }),
          )).map((user) => [user.id, user.displayName])
        : [],
    );
    return {
      environments: environments.map((environment) => ({
        id: environment.id,
        name: environment.name,
        kind: environment.kind,
        mode: environment.mode,
        spaceId: environment.spaceId ?? null,
        spaceName:
          environment.spaceId == null ? null : (spaceNames.get(environment.spaceId) ?? null),
        ownerUserId: environment.ownerUserId,
        ownerName:
          environment.ownerUserId === null
            ? null
            : (userNames.get(environment.ownerUserId) ?? null),
        status: environment.status,
        startError: environment.startError ?? null,
        os: environment.os,
        lastSeenAt: environment.lastSeenAt,
        runningThreadCount: environment.runningThreadCount,
      })),
    };
  });

  /** A live row the User may see and act on; a hidden one answers like a missing one. */
  const authorize = Effect.fn("EnvironmentRegistry.authorize")(function* (
    actorUserId: UserId,
    environmentId: EnvironmentId,
    action: "environment.rename" | "environment.remove",
  ) {
    const principal = yield* principalOf(actorUserId);
    const row = yield* liveRow(environmentId);
    if (row === undefined) return yield* new EnvironmentNotFoundError({});
    const resource = yield* resourceOf(row);
    if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) {
      return yield* new EnvironmentNotFoundError({});
    }
    const decision = decide(principal, action, resource);
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
    return row;
  });

  const rename: EnvironmentRegistry["Service"]["rename"] = Effect.fn("EnvironmentRegistry.rename")(
    function* ({ actorUserId, environmentId, name }) {
      const renamed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* authorize(actorUserId, environmentId, "environment.rename");
            if (row.name === name) return row;
            yield* sql`UPDATE environments SET name = ${name} WHERE environment_id = ${environmentId}`;
            yield* audit
              .record({
                actor: AuditLog.userActor(actorUserId),
                action: "environment.rename",
                target: { kind: "environment", id: environmentId, name },
                detail: { from: row.name, to: name },
              })
              .pipe(Effect.mapError(storageError));
            return { ...row, name };
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      return yield* summaryOf(renamed);
    },
  );

  const revoke = Effect.fn("EnvironmentRegistry.revoke")(function* (input: {
    readonly row: EnvironmentRow;
    readonly actor: AuditLog.AuditActor;
    readonly via: "settings" | "leave" | "userTurnedOff" | "ssh";
  }) {
    yield* sql`
        UPDATE environments SET revoked_at = ${yield* nowIso}
        WHERE environment_id = ${input.row.environmentId} AND revoked_at IS NULL
      `;
    yield* sql`
      DELETE FROM dedicated_sandbox_credentials WHERE environment_id = ${input.row.environmentId}
    `;
    yield* audit
      .record({
        actor: input.actor,
        action: "environment.remove",
        target: { kind: "environment", id: input.row.environmentId, name: input.row.name },
        detail: { via: input.via },
      })
      .pipe(Effect.mapError(storageError));
  });

  const remove: EnvironmentRegistry["Service"]["remove"] = Effect.fn("EnvironmentRegistry.remove")(
    function* ({ actorUserId, environmentId, via = "settings" }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* authorize(actorUserId, environmentId, "environment.remove");
            yield* revoke({ row, actor: AuditLog.userActor(actorUserId), via });
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      // After the commit: a socket closed first could reconnect before the revocation lands.
      yield* connections.close(environmentId, "environment-removed");
      yield* PubSub.publish(removals, environmentId);
    },
  );

  const authorizeRegister: EnvironmentRegistry["Service"]["authorizeRegister"] = Effect.fn(
    "EnvironmentRegistry.authorizeRegister",
  )(function* (userId) {
    const decision = decide(
      yield* principalOf(userId),
      "environment.register",
      AccessPolicy.installation,
    );
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
  });

  const authorizeDedicate: EnvironmentRegistry["Service"]["authorizeDedicate"] = Effect.fn(
    "EnvironmentRegistry.authorizeDedicate",
  )(function* (userId) {
    const decision = decide(
      yield* principalOf(userId),
      "environment.dedicate",
      AccessPolicy.installation,
    );
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
  });

  /** An Organization a machine can be dedicated to: present and not archived. */
  const dedicationTarget = Effect.fn("EnvironmentRegistry.dedicationTarget")(function* (
    spaceId: SpaceId,
  ) {
    const space = yield* spaces.spaceById(spaceId).pipe(Effect.mapError(storageError));
    if (
      Option.isNone(space) ||
      space.value.resource.kind !== "organization" ||
      space.value.resource.archived ||
      space.value.resource.frozen
    ) {
      return yield* new EnvironmentAccessDeniedError({ reason: "not-an-organization" });
    }
    return space.value;
  });

  const dedicatedSpaces: EnvironmentRegistry["Service"]["dedicatedSpaces"] = Effect.fn(
    "EnvironmentRegistry.dedicatedSpaces",
  )(function* (userId) {
    yield* authorizeDedicate(userId);
    const viewed = yield* spaces.view(userId).pipe(Effect.mapError(storageError));
    return viewed.spaces
      .filter((space) => space.kind === "organization" && space.archived !== true)
      .map((space) => ({ id: space.id, name: space.name }));
  });

  const register: EnvironmentRegistry["Service"]["register"] = Effect.fn(
    "EnvironmentRegistry.register",
  )(function* ({
    approvedBy,
    name,
    os,
    hostname,
    credentialHash,
    dedicatedSpaceId,
    via = { _tag: "join" },
  }) {
    const sshHost = via._tag === "ssh" ? via.host : undefined;
    const environmentId = EnvironmentId.make(yield* random.uuidV4());
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Asked again in the transaction: the approver may have lost the right since approving.
          yield* authorizeRegister(approvedBy);
          if (dedicatedSpaceId !== undefined) {
            yield* authorizeDedicate(approvedBy);
            yield* dedicationTarget(dedicatedSpaceId);
          }
          const mode = dedicatedSpaceId === undefined ? "personal" : "dedicated";
          const now = yield* nowIso;
          // A dedicated machine is the Installation's, owned by nobody: who dedicated it is on
          // record in `credential_issued_by` and the audit log only.
          yield* sql`
          INSERT INTO environments (
            environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
            credential_issued_at, credential_issued_by, registered_at, last_os, last_hostname
          ) VALUES (
            ${environmentId}, ${name}, 'external', ${mode},
            ${dedicatedSpaceId === undefined ? approvedBy : null}, ${dedicatedSpaceId ?? null},
            ${credentialHash}, ${now}, ${approvedBy}, ${now}, ${os}, ${hostname}
          )
        `;
          yield* audit
            .record({
              actor: AuditLog.userActor(approvedBy),
              action: "environment.register",
              target: { kind: "environment", id: environmentId, name },
              detail: {
                kind: "external",
                os,
                mode,
                via: via._tag,
                ...(sshHost === undefined ? {} : { host: sshHost }),
                ...(dedicatedSpaceId === undefined ? {} : { spaceId: dedicatedSpaceId }),
              },
            })
            .pipe(Effect.mapError(storageError));
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    return environmentId;
  });

  /** Threads that have the machine as their Active environment, newest first. */
  const threadsOn = (environmentId: EnvironmentId) =>
    sql<{ readonly threadId: string; readonly title: string; readonly archived: number }>`
      SELECT thread_id AS "threadId", title, archived_at IS NOT NULL AS archived
      FROM orchestration_v2_projection_threads
      WHERE active_environment_id = ${environmentId} AND deleted_at IS NULL
      ORDER BY updated_at DESC, thread_id
    `.pipe(Effect.mapError(storageError));

  const changeMode: EnvironmentRegistry["Service"]["changeMode"] = Effect.fn(
    "EnvironmentRegistry.changeMode",
  )(function* ({ actorUserId, environmentId, mode, spaceId }) {
    const changed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const principal = yield* principalOf(actorUserId);
          const row = yield* liveRow(environmentId);
          if (row === undefined) return yield* new EnvironmentNotFoundError({});
          const resource = yield* resourceOf(row);
          if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) {
            return yield* new EnvironmentNotFoundError({});
          }
          yield* authorizeDedicate(actorUserId);
          if (row.kind !== "external") {
            return yield* new EnvironmentAccessDeniedError({ reason: "not-external" });
          }
          const toSpaceId = mode === "dedicated" ? spaceId : undefined;
          if (mode === "dedicated") {
            if (toSpaceId === undefined) {
              return yield* new EnvironmentAccessDeniedError({ reason: "not-an-organization" });
            }
            yield* dedicationTarget(toSpaceId);
          }
          const fromSpaceId = row.mode === "dedicated" ? row.spaceId : null;
          if (row.mode === mode && fromSpaceId === (toSpaceId ?? null)) {
            return { row, changed: false, archived: [] as Array<ThreadId> };
          }
          const threads = yield* threadsOn(environmentId);
          // Active Threads move first; archived ones would wake on a machine no longer theirs, so
          // they need an environment from now on instead.
          const active = threads.filter((thread) => thread.archived !== 1);
          if (active.length > 0) {
            return yield* new EnvironmentModeChangeRefusedError({
              threads: active.map(({ threadId, title }) => ({ threadId, title })),
            });
          }
          // Personal: the actor's own. Dedicated: the Installation's, owned by nobody.
          yield* sql`
            UPDATE environments SET mode = ${mode}, space_id = ${toSpaceId ?? null},
              owner_user_id = ${mode === "personal" ? actorUserId : null}
            WHERE environment_id = ${environmentId} AND revoked_at IS NULL
          `;
          // What its Sandbox held ends here: its host asks for another for the new Space.
          yield* sql`
            DELETE FROM dedicated_sandbox_credentials WHERE environment_id = ${environmentId}
          `;
          yield* audit
            .record({
              actor: AuditLog.userActor(actorUserId),
              action: "environment.mode.change",
              target: { kind: "environment", id: environmentId, name: row.name },
              detail: {
                from: row.mode,
                to: mode,
                fromSpaceId,
                toSpaceId: toSpaceId ?? null,
              },
            })
            .pipe(Effect.mapError(storageError));
          const next: EnvironmentRow = {
            ...row,
            mode,
            spaceId: toSpaceId ?? null,
            ownerUserId: mode === "personal" ? actorUserId : null,
          };
          return {
            row: next,
            changed: true,
            archived: threads.map(({ threadId }) => ThreadId.make(threadId)),
          };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    // After the commit: the machine reconnects, and its welcome names the new mode.
    if (changed.changed) {
      yield* connections.close(environmentId, "environment-mode-changed");
      if (changed.archived.length > 0) {
        yield* PubSub.publish(releases, { environmentId, threadIds: changed.archived });
      }
    }
    return yield* summaryOf(changed.row);
  });

  const revokeOwnedBy: EnvironmentRegistry["Service"]["revokeOwnedBy"] = Effect.fn(
    "EnvironmentRegistry.revokeOwnedBy",
  )(
    function* ({ userId, actor }) {
      const rows = yield* selectRows([
        sql`owner_user_id = ${userId}`,
        sql`revoked_at IS NULL`,
      ]).pipe(Effect.mapError(storageError));
      for (const row of rows) yield* revoke({ row, actor, via: "userTurnedOff" });
      return Effect.forEach(
        rows,
        (row) =>
          connections
            .close(EnvironmentId.make(row.environmentId), "owner-inactive")
            .pipe(Effect.andThen(PubSub.publish(removals, EnvironmentId.make(row.environmentId)))),
        { discard: true },
      );
    },
    Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
  );

  /**
   * The machine a credential names, and whose it is: the machine's own (`machine`), or one the
   * Hub issued a dedicated machine's Sandbox for `sandboxSpaceId`.
   */
  const findByCredential = Effect.fn("EnvironmentRegistry.findByCredential")(function* (
    credential: string,
  ) {
    const credentialHash = yield* sha256(credential);
    const [row] = yield* selectRows([sql`credential_hash = ${credentialHash}`]).pipe(
      Effect.mapError(storageError),
    );
    if (row !== undefined) return { row, holder: "machine" as const, sandboxSpaceId: null };
    const now = yield* nowIso;
    // Looked up, and the one it replaced ended on its first use, in one transaction.
    const issued = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [found] = yield* sql<{
            readonly environmentId: string;
            readonly spaceId: string;
            readonly newest: number;
            readonly superseding: number;
          }>`
            SELECT environment_id AS "environmentId", space_id AS "spaceId",
              credential_hash = ${credentialHash} AS newest,
              previous_credential_hash IS NOT NULL AS superseding
            FROM dedicated_sandbox_credentials
            WHERE credential_hash = ${credentialHash}
              OR (previous_credential_hash = ${credentialHash} AND previous_expires_at > ${now})
          `;
          if (found !== undefined && found.newest === 1 && found.superseding === 1) {
            yield* sql`
              UPDATE dedicated_sandbox_credentials
              SET previous_credential_hash = NULL, previous_expires_at = NULL
              WHERE environment_id = ${found.environmentId} AND credential_hash = ${credentialHash}
            `;
          }
          return found;
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (issued === undefined) return undefined;
    const [machine] = yield* selectRows([sql`environment_id = ${issued.environmentId}`]).pipe(
      Effect.mapError(storageError),
    );
    if (machine === undefined) return undefined;
    return { row: machine, holder: "sandbox" as const, sandboxSpaceId: issued.spaceId };
  });

  /** The machine a credential of this Hub names, or why it is refused before anything else. */
  const credentialRow = Effect.fn("EnvironmentRegistry.credentialRow")(function* (
    credential: string | undefined,
  ) {
    if (credential === undefined || credential.length === 0) {
      return { _tag: "refused", reason: "credential-missing" } as const;
    }
    const issuer = environmentCredentialIssuer(credential);
    if (issuer === undefined) return { _tag: "refused", reason: "credential-unknown" } as const;
    if (issuer !== hubId) {
      return { _tag: "refused", reason: "credential-other-hub" } as const;
    }
    const found = yield* findByCredential(credential);
    if (found === undefined) return { _tag: "refused", reason: "credential-unknown" } as const;
    return { _tag: "found", ...found } as const;
  });

  /** Why the machine works for nobody now: removed, its owner off, its Space gone. */
  const rowRefusal = Effect.fn("EnvironmentRegistry.rowRefusal")(function* (row: EnvironmentRow) {
    // A personal machine has its owner; a Sandbox and a dedicated machine, their Space.
    if (isSpaceBound(row) ? row.spaceId === null : row.ownerUserId === null) {
      return "credential-unknown" as const;
    }
    if (row.revokedAt !== null) return "credential-revoked" as const;
    if (row.ownerInactive === 1) return "owner-inactive" as const;
    // A lent Sandbox ends with its Grant, its host or its lender.
    if (row.mode === "lent" && row.lentLive !== 1) return "credential-revoked" as const;
    // A dedicated machine whose Space was deleted works for nobody until the Owner acts.
    if (row.mode === "dedicated" && row.spaceId !== null) {
      const space = yield* spaces
        .spaceById(SpaceId.make(row.spaceId))
        .pipe(Effect.mapError(storageError));
      if (Option.isNone(space)) return "space-missing" as const;
    }
    return undefined;
  });

  const validCheck = (row: EnvironmentRow) => {
    // A dedicated machine works for its Space, never as the Owner who dedicated it.
    const spaceId = isSpaceBound(row) && row.spaceId !== null ? SpaceId.make(row.spaceId) : null;
    return {
      _tag: "valid",
      environmentId: EnvironmentId.make(row.environmentId),
      name: row.name,
      ownerUserId:
        row.ownerUserId === null || spaceId !== null ? null : UserId.make(row.ownerUserId),
      spaceId,
      mode: row.kind === "sandbox" || row.mode === "lent" ? ("sandbox" as const) : row.mode,
      lent: row.mode === "lent",
    } as const;
  };

  /**
   * What connects and reaches git: a machine's own credential, but for a dedicated machine only
   * the one issued to its Sandbox for the Space it serves now; its own stays with its host.
   */
  const checkCredential: EnvironmentRegistry["Service"]["checkCredential"] = Effect.fn(
    "EnvironmentRegistry.checkCredential",
  )(function* (credential) {
    const named = yield* credentialRow(credential);
    if (named._tag === "refused") return named;
    const refusal = yield* rowRefusal(named.row);
    if (refusal !== undefined) return { _tag: "refused", reason: refusal } as const;
    if (named.row.mode === "dedicated" && named.holder === "machine") {
      return { _tag: "refused", reason: "not-sandboxed" } as const;
    }
    // A Sandbox's credential: a dedicated machine's, or a lent Sandbox's (Grants), for its Space.
    if (
      named.holder === "sandbox" &&
      ((named.row.mode !== "dedicated" && named.row.mode !== "lent") ||
        named.sandboxSpaceId !== named.row.spaceId)
    ) {
      return { _tag: "refused", reason: "credential-unknown" } as const;
    }
    return validCheck(named.row);
  });

  /** The machine its own credential names, as `/self` and `leave` take it: never its Sandbox's. */
  const machineOf = Effect.fn("EnvironmentRegistry.machineOf")(function* (
    credential: string | undefined,
  ) {
    const named = yield* credentialRow(credential);
    return named._tag === "found" && named.holder === "machine"
      ? Option.some(named.row)
      : Option.none<EnvironmentRow>();
  });

  const recordHello: EnvironmentRegistry["Service"]["recordHello"] = Effect.fn(
    "EnvironmentRegistry.recordHello",
  )(function* (environmentId, hello) {
    yield* sql`
        UPDATE environments SET last_seen_at = ${yield* nowIso}, last_os = ${hello.os},
          last_hostname = ${hello.hostname}, last_protocol_version = ${hello.protocolVersion},
          last_resources_json = ${encodeResources({ hostResources: hello.hostResources, disk: hello.disk })},
          last_providers_json = ${encodeProviders(hello.providers)}
        WHERE environment_id = ${environmentId} AND revoked_at IS NULL
      `;
  }, Effect.mapError(storageError));

  // One write per heartbeat per machine, every ten seconds: too frequent for a span each.
  const recordHeartbeat: EnvironmentRegistry["Service"]["recordHeartbeat"] = Effect.fnUntraced(
    function* (environmentId, heartbeat) {
      const providers =
        heartbeat.providers === undefined ? null : encodeProviders(heartbeat.providers);
      yield* sql`
        UPDATE environments SET last_seen_at = ${yield* nowIso},
          last_resources_json = ${encodeResources({ hostResources: heartbeat.hostResources, disk: heartbeat.disk })},
          last_providers_json = COALESCE(${providers}, last_providers_json)
        WHERE environment_id = ${environmentId} AND revoked_at IS NULL
      `;
    },
    Effect.mapError(storageError),
  );

  const leave: EnvironmentRegistry["Service"]["leave"] = Effect.fn("EnvironmentRegistry.leave")(
    function* (credential) {
      const machine = yield* machineOf(credential);
      if (Option.isNone(machine)) return false;
      // A Sandbox is the Hub's own: it does not remove itself.
      if ((yield* rowRefusal(machine.value)) !== undefined || machine.value.kind === "sandbox") {
        return false;
      }
      const check = { environmentId: EnvironmentId.make(machine.value.environmentId) };
      const left = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* liveRow(check.environmentId);
            if (row === undefined) return false;
            // Run on the machine, with its own credential: by its owner, or by the machine itself
            // for a dedicated one, which nobody owns.
            const actor: AuditLog.AuditActor =
              row.ownerUserId === null
                ? AuditLog.cliActor
                : { source: "cli", userId: UserId.make(row.ownerUserId) };
            yield* revoke({ row, actor, via: "leave" });
            return true;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      if (left) {
        yield* connections.close(check.environmentId, "environment-removed");
        yield* PubSub.publish(removals, check.environmentId);
      }
      return left;
    },
  );

  const selfOf: EnvironmentRegistry["Service"]["selfOf"] = Effect.fn("EnvironmentRegistry.selfOf")(
    function* (credential) {
      const sandboxCredential = formatEnvironmentCredential(
        hubId,
        base64UrlEncode(yield* random.randomBytes(32).pipe(Effect.orDie)),
      );
      const sandboxHash = yield* sha256(sandboxCredential);
      // Read and issued in one transaction: a change of mode or Space drops what it issued.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const machine = yield* machineOf(credential);
            if (Option.isNone(machine)) return Option.none<EnvironmentSelfResult>();
            const row = machine.value;
            const refusal = yield* rowRefusal(row);
            const named = { environmentId: EnvironmentId.make(row.environmentId), name: row.name };
            // Its Space was deleted: it serves none until the Owner dedicates it elsewhere.
            if (refusal === "space-missing") {
              return Option.some({ ...named, mode: "dedicated" as const, spaceId: null });
            }
            if (refusal !== undefined) return Option.none<EnvironmentSelfResult>();
            const { mode, spaceId } = validCheck(row);
            if (mode !== "dedicated" || spaceId === null) {
              return Option.some({ ...named, mode, spaceId });
            }
            // The one it replaces (the newest until now) stays valid for a while, so an answer
            // lost on its way leaves the Sandbox working; any older one ends here.
            const now = yield* DateTime.now;
            yield* sql`
              INSERT INTO dedicated_sandbox_credentials (
                environment_id, space_id, credential_hash, issued_at
              ) VALUES (
                ${row.environmentId}, ${spaceId}, ${sandboxHash}, ${DateTime.formatIso(now)}
              )
              ON CONFLICT (environment_id) DO UPDATE SET space_id = excluded.space_id,
                previous_credential_hash = dedicated_sandbox_credentials.credential_hash,
                previous_expires_at = ${DateTime.formatIso(
                  DateTime.add(now, { minutes: SANDBOX_CREDENTIAL_OVERLAP_MINUTES }),
                )},
                credential_hash = excluded.credential_hash, issued_at = excluded.issued_at
            `;
            return Option.some({
              ...named,
              mode,
              spaceId,
              // Its Sandbox runs with the limits a Hub gives its own; the host caps them at what
              // the machine has.
              limits: yield* withLimitStore(readSpaceLimits(spaceId)),
              sandboxCredential,
            });
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    },
  );

  /** A new credential for a lent Sandbox; the one it replaces stays valid as a dedicated one's. */
  const issueLentCredential = Effect.fn("EnvironmentRegistry.issueLentCredential")(function* (
    environmentId: string,
    spaceId: string,
  ) {
    const credential = formatEnvironmentCredential(
      hubId,
      base64UrlEncode(yield* random.randomBytes(32).pipe(Effect.orDie)),
    );
    const hash = yield* sha256(credential);
    const now = yield* DateTime.now;
    yield* sql`
      INSERT INTO dedicated_sandbox_credentials (
        environment_id, space_id, credential_hash, issued_at
      ) VALUES (${environmentId}, ${spaceId}, ${hash}, ${DateTime.formatIso(now)})
      ON CONFLICT (environment_id) DO UPDATE SET space_id = excluded.space_id,
        previous_credential_hash = dedicated_sandbox_credentials.credential_hash,
        previous_expires_at = ${DateTime.formatIso(
          DateTime.add(now, { minutes: SANDBOX_CREDENTIAL_OVERLAP_MINUTES }),
        )},
        credential_hash = excluded.credential_hash, issued_at = excluded.issued_at
    `;
    return credential;
  });

  const reportSelf: EnvironmentRegistry["Service"]["reportSelf"] = Effect.fn(
    "EnvironmentRegistry.reportSelf",
  )(function* (credential, report) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const machine = yield* machineOf(credential);
          if (Option.isNone(machine)) return Option.none<EnvironmentSelfResult>();
          const row = machine.value;
          if ((yield* rowRefusal(row)) !== undefined) return Option.none<EnvironmentSelfResult>();
          const named = { environmentId: EnvironmentId.make(row.environmentId), name: row.name };
          const at = yield* nowIso;
          yield* sql`
            UPDATE environments SET sandbox_host_json = ${encodeSandboxHost(report.sandboxHost)}
            WHERE environment_id = ${row.environmentId}
          `;
          // Only a personal machine is lent; a dedicated one serves its own Space as before.
          if (row.kind !== "external" || row.mode !== "personal") {
            const { mode, spaceId } = validCheck(row);
            return Option.some({ ...named, mode, spaceId, lent: [] });
          }
          for (const sandbox of report.sandboxes) {
            yield* sql`
              UPDATE environments SET last_disk_json = ${encodeLentDisk({
                state: sandbox.state,
                message: sandbox.message,
                usedBytes: sandbox.diskUsedBytes,
                failures: sandbox.diskMeasureFailures,
                measuredAt: at,
              })}
              WHERE grant_id = ${sandbox.grantId} AND host_environment_id = ${row.environmentId}
                AND mode = 'lent'
            `;
          }
          const assigned = yield* sql<{
            readonly environmentId: string;
            readonly grantId: string;
            readonly spaceId: string;
            readonly name: string;
            readonly limitsJson: string;
          }>`
            SELECT e.environment_id AS "environmentId", e.grant_id AS "grantId",
              e.space_id AS "spaceId", e.name AS name, g.limits_json AS "limitsJson"
            FROM environments e JOIN grants g ON g.grant_id = e.grant_id
            WHERE e.mode = 'lent' AND e.host_environment_id = ${row.environmentId}
              AND e.revoked_at IS NULL AND g.state = 'active'
            ORDER BY e.registered_at, e.environment_id
          `;
          const asked = new Set(report.credentialsFor);
          const lent: Array<LentSandboxAssignment> = [];
          for (const entry of assigned) {
            const limits = Option.getOrUndefined(decodeGrantLimits(entry.limitsJson));
            lent.push({
              grantId: entry.grantId,
              environmentId: EnvironmentId.make(entry.environmentId),
              spaceId: SpaceId.make(entry.spaceId),
              name: entry.name,
              limits:
                limits === undefined
                  ? NO_LIMITS
                  : {
                      cpus: limits.cpus,
                      memoryBytes: limits.memoryBytes,
                      pids: limits.pids,
                      diskBytes: limits.diskBytes,
                    },
              ...(asked.has(entry.grantId)
                ? { credential: yield* issueLentCredential(entry.environmentId, entry.spaceId) }
                : {}),
            });
          }
          return Option.some({ ...named, mode: "personal" as const, spaceId: null, lent });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
  });

  const sandboxHostOf: EnvironmentRegistry["Service"]["sandboxHostOf"] = Effect.fn(
    "EnvironmentRegistry.sandboxHostOf",
  )(function* (environmentId) {
    const [row] = yield* sql<{ readonly json: string | null }>`
      SELECT sandbox_host_json AS json FROM environments WHERE environment_id = ${environmentId}
    `.pipe(Effect.mapError(storageError));
    return row?.json == null ? Option.none<SandboxHostReport>() : decodeSandboxHost(row.json);
  });

  const openLentSandbox: EnvironmentRegistry["Service"]["openLentSandbox"] = Effect.fn(
    "EnvironmentRegistry.openLentSandbox",
  )(function* (input) {
    const environmentId = lentEnvironmentIdOf(input.grantId);
    const [host] = yield* sql<{ readonly name: string }>`
      SELECT name FROM environments WHERE environment_id = ${input.hostEnvironmentId}
    `.pipe(Effect.mapError(storageError));
    // «<machine> (lent)», within a machine name's 64 characters.
    const name = `${(host?.name ?? "Machine").slice(0, 64 - " (lent)".length).trim()} (lent)`;
    yield* sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
        registered_at, grant_id, host_environment_id
      ) VALUES (
        ${environmentId}, ${name}, 'sandbox', 'lent', NULL, ${input.spaceId}, NULL,
        ${yield* nowIso}, ${input.grantId}, ${input.hostEnvironmentId}
      )
    `.pipe(Effect.mapError(storageError));
    return environmentId;
  });

  const closeLentSandbox: EnvironmentRegistry["Service"]["closeLentSandbox"] = Effect.fn(
    "EnvironmentRegistry.closeLentSandbox",
  )(function* (grantId) {
    const environmentId = lentEnvironmentIdOf(grantId);
    const closed = yield* sql<{ readonly environmentId: string }>`
      UPDATE environments SET revoked_at = ${yield* nowIso}
      WHERE environment_id = ${environmentId} AND revoked_at IS NULL
      RETURNING environment_id AS "environmentId"
    `.pipe(Effect.mapError(storageError));
    // What its container holds reaches nothing from the commit on.
    yield* sql`
      DELETE FROM dedicated_sandbox_credentials WHERE environment_id = ${environmentId}
    `.pipe(Effect.mapError(storageError));
    return closed.length === 0 ? Option.none<EnvironmentId>() : Option.some(environmentId);
  });

  const lentSandboxClosed: EnvironmentRegistry["Service"]["lentSandboxClosed"] = (environmentId) =>
    connections
      .close(environmentId, "credential-revoked")
      .pipe(Effect.andThen(PubSub.publish(removals, environmentId)), Effect.asVoid);

  /** The Space a new or moving Thread works in: its own, else the claimed one, else its Project's. */
  const workSpaceOf = Effect.fn("EnvironmentRegistry.workSpaceOf")(function* (input: {
    readonly projectId: ProjectId;
    readonly spaceId?: SpaceId | undefined;
    readonly threadId?: ThreadId | undefined;
  }) {
    if (input.threadId !== undefined) {
      const space = yield* spaces.spaceOf({ kind: "thread", id: input.threadId });
      if (Option.isSome(space)) return space.value.id;
    }
    if (input.spaceId !== undefined) return input.spaceId;
    const space = yield* spaces.spaceOf({ kind: "project", id: input.projectId });
    return Option.getOrUndefined(Option.map(space, (found) => found.id));
  }, Effect.mapError(storageError));

  interface Placement {
    readonly userId: UserId | undefined;
    readonly projectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly spaceId?: SpaceId | undefined;
    readonly threadId?: ThreadId | undefined;
  }

  /**
   * The Environment checked for the Thread: usable by the User for the Thread's Space (`byHub`:
   * the Space's own Sandbox, which the Hub places on with or without a User), a Sandbox made if
   * missing, online or a Sandbox that starts for the work, with the provider once known.
   */
  const placeOn = Effect.fn("EnvironmentRegistry.placeOn")(function* (
    input: Placement & { readonly environmentId: EnvironmentId; readonly byHub: boolean },
  ) {
    const { environmentId, userId, providerInstanceId } = input;
    const existing = yield* liveRow(environmentId);
    // A Space's Sandbox can be chosen before it exists: choosing it makes it.
    const sandboxSpace = sandboxSpaceOf(environmentId);
    const row: PolicyRow | undefined =
      existing ??
      (sandboxSpace !== undefined
        ? { kind: "sandbox", mode: "sandbox", ownerUserId: null, spaceId: sandboxSpace }
        : undefined);
    const principal = userId === undefined ? undefined : yield* principalOf(userId);
    const workSpaceId =
      row !== undefined && isSpaceBound(row) ? yield* workSpaceOf(input) : undefined;
    const usable =
      row !== undefined &&
      // A lent Sandbox only while its Grant is active and its host and lender are.
      (existing === undefined || existing.mode !== "lent" || existing.lentLive === 1) &&
      (principal === undefined
        ? input.byHub
        : principal.inactive !== true &&
          AccessPolicy.isAllowed(
            decide(principal, "environment.use", yield* resourceOf(row, workSpaceId)),
          ));
    if (row === undefined || !usable) {
      return yield* new ThreadEnvironmentUnavailableError({ environmentId, reason: "not-usable" });
    }
    if (isHubSandbox(row) && row.spaceId !== null) {
      if (Option.isNone(sandboxes)) {
        return yield* new ThreadEnvironmentUnavailableError({
          environmentId,
          reason: "sandbox-unavailable",
          ...(sandboxesUnavailable === null ? {} : { detail: sandboxesUnavailable }),
        });
      }
      // Made here, started by the Thread's first work: placing never waits for it to boot.
      yield* sandboxes.value
        .ensureCreated({ spaceId: SpaceId.make(row.spaceId), actorUserId: userId })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadEnvironmentUnavailableError({
                environmentId,
                reason: "sandbox-failed",
                detail: error.detail,
              }),
          ),
        );
    }
    const current = existing ?? (yield* liveRow(environmentId));
    if (current === undefined) {
      return yield* new ThreadEnvironmentUnavailableError({ environmentId, reason: "not-usable" });
    }
    const summary = yield* summaryOf(current);
    // A Sandbox not running starts for the work; its providers are known once it ran.
    const startsForWork = isHubSandbox(current) && summary.status !== "online";
    if (summary.status !== "online" && !startsForWork) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: current.name,
        reason: "offline",
      });
    }
    if (startsForWork && summary.providers.length === 0) return environmentId;
    const provider = summary.providers.find((entry) => entry.instanceId === providerInstanceId);
    if (provider === undefined || !provider.enabled || !provider.installed) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: current.name,
        reason: "provider-missing",
        providerInstanceId,
      });
    }
    return environmentId;
  });

  /** The Project's preferred Environment, when the User may use it and it can take the Thread now. */
  const preferredFor = Effect.fn("EnvironmentRegistry.preferredFor")(function* (input: Placement) {
    const [project] = yield* sql<{ readonly environmentId: string | null }>`
      SELECT preferred_environment_id AS "environmentId"
      FROM projection_projects WHERE project_id = ${input.projectId}
    `.pipe(Effect.mapError(storageError));
    const preferred = project?.environmentId ?? null;
    // The Hub machine is stored as no preference.
    if (preferred === null || preferred === HUB_MACHINE_ENVIRONMENT_ID) return undefined;
    const environmentId = EnvironmentId.make(preferred);
    const row = yield* liveRow(environmentId);
    if (row === undefined || input.userId === undefined) return undefined;
    const principal = yield* principalOf(input.userId);
    const workSpaceId = isSpaceBound(row) ? yield* workSpaceOf(input) : undefined;
    // A preference set by someone else, for a machine this User may not use, is passed over.
    const usable =
      principal.inactive !== true &&
      AccessPolicy.isAllowed(
        decide(principal, "environment.use", yield* resourceOf(row, workSpaceId)),
      );
    const summary = yield* summaryOf(row);
    // As the composer previews it: a Sandbox this Hub cannot run takes nothing.
    return canStartThreadOn(
      { ...summary, usable },
      input.providerInstanceId,
      Option.isSome(sandboxes),
    )
      ? environmentId
      : undefined;
  });

  const chooseForThread: EnvironmentRegistry["Service"]["chooseForThread"] = Effect.fn(
    "EnvironmentRegistry.chooseForThread",
  )(function* (input) {
    const { requested } = input;
    if (requested === HUB_MACHINE_ENVIRONMENT_ID) {
      if (hubRunsAgents) return requested;
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId: requested,
        name: "The Hub machine",
        reason: "hub-machine",
      });
    }
    if (requested !== undefined) {
      return yield* placeOn({ ...input, environmentId: requested, byHub: false });
    }
    // Nobody chose: the Project's preference while it can take the Thread, as the composer previews.
    const preferred = yield* preferredFor(input);
    if (preferred !== undefined) return preferred;
    // Otherwise where the Space's work runs: its Sandbox (the Hub machine while it runs agents).
    if (hubRunsAgents) return HUB_MACHINE_ENVIRONMENT_ID;
    const workSpaceId = yield* workSpaceOf(input);
    if (Option.isNone(sandboxes) || workSpaceId === undefined) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId:
          workSpaceId === undefined
            ? HUB_MACHINE_ENVIRONMENT_ID
            : sandboxEnvironmentIdOf(workSpaceId),
        reason: "no-environment",
        detail: sandboxesUnavailable ?? "This Thread's Project belongs to no Space.",
      });
    }
    return yield* placeOn({
      ...input,
      environmentId: sandboxEnvironmentIdOf(workSpaceId),
      byHub: true,
    });
  });

  const usableBy: EnvironmentRegistry["Service"]["usableBy"] = Effect.fn(
    "EnvironmentRegistry.usableBy",
  )(function* ({ userId, environmentId, threadId }) {
    const row = yield* liveRow(environmentId);
    if (row === undefined || userId === undefined) return Option.none();
    const principal = yield* principalOf(userId);
    const workSpace =
      isSpaceBound(row) && threadId !== undefined
        ? yield* spaces
            .spaceOf({ kind: "thread", id: threadId })
            .pipe(Effect.mapError(storageError))
        : Option.none<AccessPolicy.SpaceResource>();
    if (
      principal.inactive === true ||
      !AccessPolicy.isAllowed(
        decide(
          principal,
          "environment.use",
          yield* resourceOf(row, Option.isSome(workSpace) ? workSpace.value.id : undefined),
        ),
      )
    ) {
      return Option.none();
    }
    return Option.some({ name: row.name });
  });

  const startSandbox: EnvironmentRegistry["Service"]["startSandbox"] = Effect.fn(
    "EnvironmentRegistry.startSandbox",
  )(function* ({ actorUserId, environmentId }) {
    const row = yield* liveRow(environmentId);
    if (row === undefined || row.kind !== "sandbox" || row.spaceId === null) {
      return yield* new EnvironmentNotFoundError({});
    }
    const spaceId = SpaceId.make(row.spaceId);
    const principal = yield* principalOf(actorUserId);
    const resource = yield* resourceOf(row, spaceId);
    if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) {
      return yield* new EnvironmentNotFoundError({});
    }
    if (
      principal.inactive === true ||
      !AccessPolicy.isAllowed(decide(principal, "environment.use", resource))
    ) {
      return yield* new EnvironmentAccessDeniedError({ reason: "not-usable" });
    }
    if (Option.isSome(sandboxes)) {
      // The Hub's own start (joined if one is under way); answers once it is `starting`.
      yield* sandboxes.value.requestStart({ spaceId, actorUserId, via: "retry" });
    }
    const current = yield* liveRow(environmentId);
    return yield* summaryOf(current ?? row, principal.isOwner);
  });

  const sandboxFailure = (cause: unknown) => storageError(cause);

  /** The Sandbox limit store over this Hub's database and audit log. */
  const withLimitStore = <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | AuditLog.AuditLog>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(AuditLog.AuditLog, audit),
    );

  /** Each Sandbox the viewer may inspect, by Space, as the policy decides on it. */
  const inspectableSandboxes = Effect.fn("EnvironmentRegistry.inspectableSandboxes")(function* (
    principal: AccessPolicy.Principal,
    viewer: UserId,
  ) {
    const rows = yield* selectRows([
      sql`kind = 'sandbox'`,
      sql`mode = 'sandbox'`,
      sql`revoked_at IS NULL`,
    ]);
    const spaceIds = rows.flatMap((row) =>
      row.spaceId === null ? [] : [SpaceId.make(row.spaceId)],
    );
    const resources = yield* spaces.spacesById(spaceIds);
    const names = new Map<string, string>(
      (yield* spaces.view(viewer)).spaces.map((space) => [space.id, space.name]),
    );
    const allowed = new Map<
      SpaceId,
      { readonly row: EnvironmentRow; readonly name: string; readonly manageable: boolean }
    >();
    for (const row of rows) {
      if (row.spaceId === null) continue;
      const spaceId = SpaceId.make(row.spaceId);
      const resource = environmentResource(row, resources.get(spaceId)?.resource);
      if (!AccessPolicy.isAllowed(decide(principal, "sandbox.inspect", resource))) continue;
      const spaceName = names.get(spaceId);
      allowed.set(spaceId, {
        row,
        name: spaceName === undefined ? row.name : sandboxEnvironmentName(spaceName),
        manageable: AccessPolicy.isAllowed(decide(principal, "sandbox.manage", resource)),
      });
    }
    return allowed;
  }, Effect.mapError(storageError));

  /**
   * For the Owner's «Sandboxes»: each Space with machines dedicated to it whose Sandbox the Hub
   * does not list (`listed`), with its own limits and the ones its Sandboxes start with.
   */
  const dedicatedSpaceLimits = Effect.fn("EnvironmentRegistry.dedicatedSpaceLimits")(function* (
    viewer: UserId,
    listed: ReadonlySet<string>,
  ) {
    const rows = yield* selectRows([
      sql`kind = 'external'`,
      sql`mode = 'dedicated'`,
      sql`revoked_at IS NULL`,
    ]).pipe(Effect.mapError(storageError));
    const bySpace = new Map<SpaceId, Array<EnvironmentRow>>();
    for (const row of rows) {
      if (row.spaceId === null || listed.has(row.spaceId)) continue;
      const spaceId = SpaceId.make(row.spaceId);
      bySpace.set(spaceId, [...(bySpace.get(spaceId) ?? []), row]);
    }
    if (bySpace.size === 0) return [];
    const names = new Map<string, string>(
      (yield* spaces.view(viewer).pipe(Effect.mapError(storageError))).spaces.map((space) => [
        space.id,
        space.name,
      ]),
    );
    const limits = yield* withLimitStore(readSpacesLimitsWithOwn([...bySpace.keys()])).pipe(
      Effect.mapError(storageError),
    );
    return yield* Effect.forEach(
      [...bySpace],
      ([spaceId, machines]) =>
        Effect.forEach(machines, (row) => summaryOf(row, true), { concurrency: "unbounded" }).pipe(
          Effect.map((summaries): HubDedicatedSpaceLimits => ({
            spaceId,
            spaceName: names.get(spaceId) ?? null,
            machines: summaries.map((summary) => ({
              environmentId: summary.id,
              name: summary.name,
              status: summary.status,
            })),
            // Every Space asked for is in the answer.
            own: limits.get(spaceId)?.own ?? NO_LIMITS,
            effective: limits.get(spaceId)?.effective ?? NO_LIMITS,
          })),
        ),
      { concurrency: "unbounded" },
    );
  });

  const sandboxList = Effect.fn("EnvironmentRegistry.sandboxList")(function* (viewer: UserId) {
    const principal = yield* principalOf(viewer);
    if (principal.inactive === true) {
      return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
    }
    if (Option.isNone(sandboxes)) {
      return {
        // A Hub with only dedicated machines still keeps the defaults they start with.
        defaults: yield* withLimitStore(readDefaultLimits).pipe(Effect.mapError(storageError)),
        enforcement: {
          cpus: false,
          memory: false,
          pids: false,
          disk: false,
          note: "This Hub runs no Sandboxes: it has no Sandbox runtime.",
        },
        sandboxes: [],
        manageable: principal.isOwner,
        ...(principal.isOwner
          ? { dedicatedSpaces: yield* dedicatedSpaceLimits(viewer, new Set()) }
          : {}),
      } satisfies HubSandboxList;
    }
    const allowed = yield* inspectableSandboxes(principal, viewer);
    const overview = yield* sandboxes.value
      .overview((spaceId) => allowed.has(spaceId))
      .pipe(Effect.mapError(sandboxFailure));
    const details: Array<HubSandboxDetail> = [];
    for (const sandbox of overview.sandboxes) {
      const entry = allowed.get(sandbox.spaceId);
      if (entry === undefined) continue;
      const summary = yield* summaryOf(entry.row, principal.isOwner, entry.name);
      details.push({
        environmentId: sandbox.environmentId,
        spaceId: sandbox.spaceId,
        name: summary.name,
        status: summary.status,
        error: summary.status === "failed" ? entry.row.sandboxError : null,
        runtime: sandbox.runtime,
        imageVersion: sandbox.imageVersion,
        startedAt: summary.status === "online" ? sandbox.startedAt : null,
        limits: sandbox.limits,
        overrides: sandbox.overrides,
        appliedLimits: sandbox.appliedLimits,
        heldByOwner: sandbox.heldByOwner,
        runningThreadCount: summary.runningThreadCount,
        usage: sandbox.usage,
        manageable: entry.manageable,
      });
    }
    return {
      defaults: overview.defaults,
      enforcement: overview.enforcement,
      sandboxes: details,
      manageable: principal.isOwner,
      ...(principal.isOwner
        ? {
            dedicatedSpaces: yield* dedicatedSpaceLimits(
              viewer,
              new Set(details.map((detail) => detail.spaceId)),
            ),
          }
        : {}),
    } satisfies HubSandboxList;
  });

  /** A Sandbox the Owner manages; one the actor may not see answers like a missing one. */
  const authorizeSandbox = Effect.fn("EnvironmentRegistry.authorizeSandbox")(function* (
    actorUserId: UserId,
    environmentId: EnvironmentId,
  ) {
    const row = yield* liveRow(environmentId);
    if (row === undefined || row.kind !== "sandbox" || row.spaceId === null) {
      return yield* new EnvironmentNotFoundError({});
    }
    const principal = yield* principalOf(actorUserId);
    const resource = yield* resourceOf(row);
    if (principal.inactive === true) {
      return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
    }
    if (!AccessPolicy.isAllowed(decide(principal, "sandbox.inspect", resource))) {
      return yield* new EnvironmentNotFoundError({});
    }
    const decision = decide(principal, "sandbox.manage", resource);
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
    if (Option.isNone(sandboxes)) return yield* new EnvironmentNotFoundError({});
    return {
      spaceId: SpaceId.make(row.spaceId),
      sandboxes: sandboxes.value,
      space: resource.space,
    };
  });

  const sandboxAction: EnvironmentRegistry["Service"]["sandboxAction"] = Effect.fn(
    "EnvironmentRegistry.sandboxAction",
  )(function* ({ actorUserId, environmentId, action }) {
    const {
      spaceId,
      sandboxes: service,
      space,
    } = yield* authorizeSandbox(actorUserId, environmentId);
    const actor = AuditLog.userActor(actorUserId);
    // An archived Organization's Sandbox stays stopped until it is restored.
    if (action !== "stop" && (space?.archived === true || space?.frozen === true)) {
      return yield* new EnvironmentAccessDeniedError({
        reason: space.archived ? "space-archived" : "space-frozen",
      });
    }
    switch (action) {
      case "start":
        // Answers once it is `starting`; how the start ends shows in the list.
        yield* service.requestStart({ spaceId, actorUserId, via: "settings" });
        break;
      case "stop":
        yield* service
          .stop({ spaceId, actor, via: "settings" })
          .pipe(Effect.mapError(sandboxFailure));
        break;
      case "restart":
        yield* service.restart({ spaceId, actorUserId }).pipe(Effect.mapError(sandboxFailure));
        break;
    }
    const listed = yield* sandboxList(actorUserId);
    const detail = listed.sandboxes.find((entry) => entry.environmentId === environmentId);
    if (detail === undefined) return yield* new EnvironmentNotFoundError({});
    return detail;
  });

  const setSandboxLimits: EnvironmentRegistry["Service"]["setSandboxLimits"] = Effect.fn(
    "EnvironmentRegistry.setSandboxLimits",
  )(function* ({ actorUserId, environmentId, limits }) {
    const ownerOnly = Effect.gen(function* () {
      const principal = yield* principalOf(actorUserId);
      const decision =
        principal.inactive === true
          ? AccessPolicy.deny("user-inactive")
          : principal.isOwner
            ? AccessPolicy.allow
            : AccessPolicy.deny("owner-only");
      if (decision._tag === "Deny") {
        return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
      }
    });
    let spaceId: SpaceId | undefined;
    const row = environmentId === undefined ? undefined : yield* liveRow(environmentId);
    if (environmentId === undefined) {
      yield* ownerOnly;
    } else if (row?.mode === "dedicated" && row.spaceId !== null) {
      // A machine dedicated to a Space: the Space's own limits, which its Sandbox starts with,
      // whether or not the Hub also runs a Sandbox for that Space.
      yield* ownerOnly;
      spaceId = SpaceId.make(row.spaceId);
    } else {
      spaceId = (yield* authorizeSandbox(actorUserId, environmentId)).spaceId;
    }
    const actor = AuditLog.userActor(actorUserId);
    // Through the Sandboxes where the Hub runs them (a lower disk limit is checked at once); else
    // straight to the store, as a Hub with only dedicated machines.
    const target = environmentId === undefined ? {} : { environmentId };
    const change: Effect.Effect<
      { readonly own: SandboxLimits; readonly effective: SandboxLimits },
      SandboxNotFoundError | SandboxLimitsInvalidError | EnvironmentStorageError
    > = Option.isSome(sandboxes)
      ? sandboxes.value
          .setLimits({ spaceId, limits, actor, ...target })
          .pipe(
            Effect.catchTags({ SandboxStartError: (cause) => Effect.fail(storageError(cause)) }),
          )
      : withLimitStore(
          changeLimits({ spaceId, limits, actor, host: hostCapacity(null), ...target }),
        ).pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(storageError(cause)),
            AuditLogWriteError: (cause) => Effect.fail(storageError(cause)),
          }),
        );
    const changed = yield* change.pipe(
      Effect.catchTags({
        SandboxNotFoundError: () => Effect.fail(new EnvironmentNotFoundError({})),
      }),
    );
    return {
      ...(yield* sandboxList(actorUserId)),
      changed: { spaceId: spaceId ?? null, ...changed },
    };
  });

  const hasReachedHub: EnvironmentRegistry["Service"]["hasReachedHub"] = Effect.fn(
    "EnvironmentRegistry.hasReachedHub",
  )(function* (environmentId) {
    if (yield* connections.isConnected(environmentId)) return true;
    const [row] = yield* sql<{ readonly reached: number }>`
      SELECT (e.last_seen_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM dedicated_sandbox_credentials d WHERE d.environment_id = e.environment_id
      )) AS reached
      FROM environments e
      WHERE e.environment_id = ${environmentId} AND e.revoked_at IS NULL
    `.pipe(Effect.mapError(storageError));
    return row?.reached === 1;
  });

  return EnvironmentRegistry.of({
    hubId,
    hasReachedHub,
    hubRunsAgents,
    sandboxesUnavailable,
    sandboxesTurnedOff,
    startSandbox,
    sandboxes: sandboxList,
    sandboxSessionsEnded: Option.isSome(sandboxes) ? sandboxes.value.sessionsEnded : Stream.empty,
    sandboxAction,
    setSandboxLimits,
    chooseForThread,
    usableBy,
    list,
    overview,
    rename,
    remove,
    authorizeRegister,
    register,
    dedicatedSpaces,
    authorizeDedicate,
    changeMode,
    revokeOwnedBy,
    checkCredential,
    recordHello,
    recordHeartbeat,
    leave,
    removed: Stream.fromPubSub(removals),
    released: Stream.fromPubSub(releases),
    selfOf,
    reportSelf,
    sandboxHostOf,
    openLentSandbox,
    closeLentSandbox,
    lentSandboxClosed,
    stopSandbox: Effect.fn("EnvironmentRegistry.stopSandbox")(function* (input) {
      if (Option.isNone(sandboxes)) return;
      yield* sandboxes.value.stop(input).pipe(Effect.mapError(storageError));
    }),
    deleteSandbox: Effect.fn("EnvironmentRegistry.deleteSandbox")(function* (input) {
      const environmentId = sandboxEnvironmentIdOf(input.spaceId);
      if (Option.isSome(sandboxes)) {
        yield* sandboxes.value.delete(input).pipe(Effect.mapError(storageError));
      } else {
        // Made by a runtime this Hub no longer runs: its rows still go.
        yield* sql`
          UPDATE environments SET revoked_at = ${yield* nowIso}
          WHERE environment_id = ${environmentId} AND revoked_at IS NULL
        `.pipe(Effect.mapError(storageError));
        yield* sql`DELETE FROM sandboxes WHERE space_id = ${input.spaceId}`.pipe(
          Effect.mapError(storageError),
        );
      }
      // Its own limits go with the Space, whether a Hub Sandbox or a dedicated machine used them.
      yield* withLimitStore(deleteSpaceLimits(input.spaceId)).pipe(Effect.mapError(storageError));
      yield* PubSub.publish(removals, environmentId);
    }),
  });
});

/** The registry without Sandboxes (the join flow's tests, a Hub without a runtime). */
export const layerWith = (options: RegistryOptions = {}) =>
  Layer.effect(EnvironmentRegistry, make(options)).pipe(
    Layer.provide(AuditLog.layer),
    Layer.provideMerge(EnvironmentConnections.layer),
  );

/** The registry without Sandboxes (tests, the join flow); the Hub machine runs Threads as provided. */
export const layer = layerWith();

/**
 * The registry as the server runs it: with Sandboxes only when a runtime that runs them is on,
 * and the Hub machine running Threads only with `T3CODE_HUB_RUNS_AGENTS` (or a dev Hub without
 * Sandboxes).
 */
export const layerFromConfig = Layer.unwrap(
  Effect.gen(function* () {
    const sandboxes = yield* SandboxRuntimeFromConfig.fromConfig;
    const hubRunsAgents = yield* HubRunsAgents.HubRunsAgents;
    if (hubRunsAgents) {
      yield* Effect.logWarning(
        "The Hub machine runs Threads in the Hub's own process (development only: T3CODE_HUB_RUNS_AGENTS).",
      );
    } else if (sandboxes.unavailable !== null) {
      yield* Effect.logWarning(
        `No Environment runs new Threads by default: ${sandboxes.unavailable} Threads run only on machines their Users choose.`,
      );
    }
    return Option.isNone(sandboxes.runtime)
      ? layerWith({
          ...(sandboxes.unavailable === null
            ? {}
            : { sandboxesUnavailable: sandboxes.unavailable }),
          sandboxesTurnedOff: sandboxes.turnedOff,
        })
      : layerWithSandboxes(sandboxes.runtime.value);
  }),
);

/**
 * The registry with each Space's Sandbox run by `runtime`. The Sandboxes share the registry's
 * connections, so a Sandbox counts as started once its socket is the registry's.
 */
export const layerWithSandboxes = <E, R>(
  runtime: Layer.Layer<SandboxRuntime.SandboxRuntime, E, R>,
) =>
  Layer.effect(EnvironmentRegistry, make({})).pipe(
    // Sandboxes start for work and stop when idle: the orchestration and the workspace RPCs ask
    // through `EnvironmentDemand`, which they see beside the registry.
    Layer.provideMerge(Sandboxes.layer.pipe(Layer.provide(runtime))),
    Layer.provide(AuditLog.layer),
    Layer.provideMerge(EnvironmentConnections.layer),
  );
