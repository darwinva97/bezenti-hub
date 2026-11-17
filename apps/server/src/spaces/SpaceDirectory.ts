import {
  InstallationPermission,
  type InstallationUser,
  InstallationUserStatus,
  type MemberList,
  type MemberSummary,
  type ProjectId,
  SpaceId,
  SpaceResourceNotFoundError,
  type ThreadId,
  type SpaceDirectoryView,
  SpaceKind,
  SpaceRole,
  type SpaceSummary,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import * as AccessChanges from "../auth/AccessChanges.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import {
  PROJECT_FOLDER_CHANGE_REFUSED,
  PROJECT_FOLDER_REFUSED,
  THREAD_WORKTREE_REFUSED,
} from "./directoryRoots.ts";

export class SpaceDirectoryStorageError extends Schema.TaggedError<SpaceDirectoryStorageError>()(
  "SpaceDirectoryStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write Spaces.";
  }
}

const DENIED_ACTION_LABELS: Record<string, string> = {
  "space.view": "see what is",
  "thread.create": "create Threads",
  "project.create": "create Projects",
  "organization.create": "create Organizations",
  "installationPermission.manage": "grant Installation permissions",
  "invitation.create": "invite people",
  "invitation.manage": "manage Invitations",
  "guestLink.create": "create guest links",
  "admin.manage": "name or remove Admins",
  "membership.changeRole": "change this person's Role",
  "membership.remove": "remove this person",
  "membership.leave": "leave for someone else",
  "membership.resetLink": "give this person a reset link",
  "user.disable": "disable this User",
  "user.remove": "remove this User",
  "thread.continue": "continue this Thread",
  "thread.archive": "archive or restore this Thread",
  "thread.stop": "stop this Thread",
  "thread.delete": "permanently delete this Thread",
  "project.archive": "archive or restore this Project",
  "project.manage": "change this Project",
  "project.delete": "permanently delete this Project",
  "project.move": "move this Project",
  "organization.archive": "archive this Organization",
  "organization.restore": "restore this Organization",
  "organization.delete": "permanently delete this Organization",
};

/** What to tell someone who can see the item but may not act on it. */
const deniedMessage = (action: string, reason: string): string | undefined => {
  if (reason === "folder-not-allowed") return PROJECT_FOLDER_REFUSED;
  if (reason === "folder-owner-only") return PROJECT_FOLDER_CHANGE_REFUSED;
  if (reason === "worktree-not-allowed") return THREAD_WORKTREE_REFUSED;
  if (reason === "space-limited") {
    return "This agent works only in the Space of the machine it runs on.";
  }
  if (reason === "icon-owner-only") {
    return "Only the Owner of this Hub can use an image outside the Project as its icon.";
  }
  if (action === "thread.continue" && reason === "not-yours") {
    return "Only the person who started this Thread can continue it. Start a new Thread to build on it.";
  }
  if (reason === "not-yours") {
    return `Only its creator or an Admin can ${DENIED_ACTION_LABELS[action] ?? "do that"}.`;
  }
  if (action.startsWith("organization.") && reason === "owner-only") {
    return "Only the Owner archives, restores or deletes an Organization.";
  }
  if (action === "organization.delete" && reason === "not-archived") {
    return "Archive the Organization before deleting it permanently.";
  }
  if (reason === "not-archived") return "Archive it before deleting it permanently.";
  if (reason === "project-moving") {
    return "This Project is moving to another Space. Try again in a moment.";
  }
  if (reason === "space-deleting") {
    return "This Organization is being deleted. Delete it again to finish.";
  }
  if (action === "thread.continue" && reason === "space-archived") {
    return "This Organization is archived: nothing runs or starts in it.";
  }
  if (
    action === "project.move" &&
    (reason === "role-not-allowed" ||
      reason === "not-a-member" ||
      reason === "not-your-personal-space")
  ) {
    return "Moving a Project takes being an Admin where it is and where it goes (or the User of the Personal space it leaves or enters).";
  }
  if (action === "project.move" && reason === "space-archived") {
    return "Nothing moves into an archived Organization, and only the Owner moves out of one.";
  }
  if (action === "project.move" && reason === "space-frozen") {
    return "Nothing moves into a removed User's Personal space.";
  }
  if (reason === "personal-space-read-only") {
    return "This is someone else's Personal space: you can read it but not change anything in it.";
  }
  if (reason === "missing-installation-permission") {
    return "This needs an Installation permission the Owner has not given you.";
  }
  if (action === "installationPermission.manage") {
    return "Only the Owner grants Installation permissions.";
  }
  if (reason === "owner-protected") return "The Owner can't be disabled or removed.";
  if (reason === "user-removed") return "A removed User stays removed.";
  if (action === "user.disable" || action === "user.remove") {
    return "Only the Owner disables or removes Users.";
  }
  if (reason === "user-inactive") return "This account can no longer sign in.";
  if (reason === "space-frozen") {
    return "This Personal space belonged to a removed User: it can only be read, or its content deleted.";
  }
  if (reason === "no-such-member") return "That person is not in this Organization.";
  if (action.startsWith("membership.") && reason === "owner-only") {
    return "Only the Owner names, changes or removes Admins.";
  }
  if (reason === "no-user") return "This session belongs to no User. Sign in again.";
  if (
    (action === "thread.delete" || action === "project.delete") &&
    reason === "role-not-allowed"
  ) {
    return "Only an Admin can permanently delete.";
  }
  if (action === "guestLink.create") {
    return "Only an Admin can create guest links, and only in an Organization.";
  }
  if (action === "environment.use") {
    return "You can't run Threads on that Environment, so it can't be this Project's preferred one.";
  }
  return undefined;
};

export class SpaceAccessDeniedError extends Schema.TaggedError<SpaceAccessDeniedError>()(
  "SpaceAccessDeniedError",
  { action: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    const specific = deniedMessage(this.action, this.reason);
    if (specific !== undefined) return specific;
    const what = DENIED_ACTION_LABELS[this.action] ?? "do that";
    return `You can't ${what} in this Space.`;
  }
}

export class InstallationUserNotFoundError extends Schema.TaggedError<InstallationUserNotFoundError>()(
  "InstallationUserNotFoundError",
  { userId: UserId },
) {
  override get message(): string {
    return `User ${this.userId} does not exist.`;
  }
}

export class SpaceNotFoundError extends Schema.TaggedError<SpaceNotFoundError>()(
  "SpaceNotFoundError",
  { spaceId: SpaceId },
) {
  override get message(): string {
    return `Space ${this.spaceId} does not exist.`;
  }
}

/**
 * The Spaces an action on `resource` concerns; one with no Space (the Installation, a User)
 * concerns one no Space-limited agent has, `"installation"`.
 */
const spacesOf = (resource: AccessPolicy.Resource): ReadonlyArray<string> => {
  switch (resource.kind) {
    case "organization":
    case "personal":
      return [resource.id];
    case "thread":
    case "project":
    case "membership":
      return [resource.space.id];
    case "move":
      return [resource.from.id, resource.to.id];
    case "environment":
      return resource.space === undefined ? [] : [resource.space.id];
    // The Owner's own Vaults (the Main vault among them) are no Space's.
    case "vault":
      return resource.space === null ? ["installation"] : [resource.space.id];
    default:
      return ["installation"];
  }
};

/**
 * A Project's Space in SQL, given its `space_id` column: a Project from before Spaces is the
 * Owner's Personal space's. The one rule; whoever selects Projects by Space uses it.
 */
export const projectSpaceSql = (column: string) =>
  `COALESCE(${column}, 'personal:' || (SELECT user_id FROM users WHERE is_owner = 1))`;

const isAccessDenied = Schema.is(SpaceAccessDeniedError);
const isNotFound = Schema.is(SpaceNotFoundError);

/** The refusal to show a user when a create failed because of its Space, however it was wrapped. */
export const spaceRefusalMessage = (cause: unknown): string | undefined => {
  let current = cause;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (isAccessDenied(current) || isNotFound(current)) return current.message;
    current =
      typeof current === "object" && current !== null
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return undefined;
};

export type SpaceClaimError =
  | SpaceAccessDeniedError
  | SpaceNotFoundError
  | SpaceDirectoryStorageError;

/** A Thread or Project a command acts on. */
export type ItemRef =
  | { readonly kind: "thread"; readonly id: ThreadId }
  | { readonly kind: "project"; readonly id: ProjectId };

export type ItemAccessError =
  | SpaceAccessDeniedError
  | SpaceResourceNotFoundError
  | SpaceDirectoryStorageError;

/** The Space a new Project or Thread belongs to and the User who owns it. */
/** Where a Project moves from and to, once the policy allowed it. */
export interface ProjectMove {
  readonly from: SpaceId;
  readonly to: SpaceId;
}

export type ProjectMoveError =
  | SpaceAccessDeniedError
  | SpaceNotFoundError
  | SpaceResourceNotFoundError
  | SpaceDirectoryStorageError;

export interface CreationStamp {
  readonly spaceId: SpaceId;
  readonly ownerUserId: UserId;
}

export interface CreationClaim {
  readonly action: "project.create" | "thread.create";
  /**
   * The User creating it, taken from their session or MCP scope, never from a client payload.
   * Only callers with no User (scheduled task runs, `t3 project`, before an Owner) leave it out
   * and act as the Owner.
   */
  readonly actorUserId?: UserId | undefined;
  /** The client's current Space. */
  readonly spaceId?: SpaceId | undefined;
  /** A Thread's Project, whose Space wins over the requested one. */
  readonly projectId?: ProjectId | undefined;
}

// Created with the User by a trigger (migration 085).
/** A User's Personal space id: the one rule, also for whoever must name it in a transaction. */
export const personalSpaceIdOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);

const SpaceRow = Schema.Struct({
  spaceId: SpaceId,
  kind: SpaceKind,
  name: Schema.String,
  personalOwnerUserId: Schema.NullOr(UserId),
  archived: Schema.BooleanFromBit,
  frozen: Schema.BooleanFromBit,
});
type SpaceRow = typeof SpaceRow.Type;

const toResource = (row: SpaceRow): AccessPolicy.SpaceResource => ({
  id: row.spaceId,
  kind: row.kind,
  personalOwnerUserId: row.personalOwnerUserId,
  archived: row.archived,
  frozen: row.frozen,
});

export interface UserStatusChange {
  readonly userId: UserId;
  /** False once disabled or removed. */
  readonly active: boolean;
}

export class SpaceDirectory extends Context.Service<
  SpaceDirectory,
  {
    /** What the policy needs to know about a User: Owner or not, Roles, Installation permissions. */
    readonly principalOf: (
      userId: UserId,
    ) => Effect.Effect<AccessPolicy.Principal, SpaceDirectoryStorageError>;
    /** The Spaces a User can switch to, starting with their own Personal space. */
    readonly view: (
      userId: UserId,
    ) => Effect.Effect<SpaceDirectoryView, SpaceDirectoryStorageError>;
    /** Every User with what the Owner granted them; Owner only. */
    readonly listUsers: (
      actorUserId: UserId,
    ) => Effect.Effect<
      ReadonlyArray<InstallationUser>,
      SpaceAccessDeniedError | SpaceDirectoryStorageError
    >;
    /**
     * Grants or revokes one Installation permission; Owner only. Takes effect at once: cached
     * principals go stale and the User's open connections hear it on `subscribeAccessChanges`.
     */
    readonly setInstallationPermission: (input: {
      readonly actorUserId: UserId;
      readonly userId: UserId;
      readonly permission: InstallationPermission;
      readonly granted: boolean;
    }) => Effect.Effect<
      InstallationUser,
      SpaceAccessDeniedError | InstallationUserNotFoundError | SpaceDirectoryStorageError
    >;
    /**
     * Refuses a change to the User's status the policy denies (only the Owner, never on the Owner)
     * and returns them as they are now.
     */
    readonly authorizeUserChange: (input: {
      readonly actorUserId: UserId;
      readonly action: "user.disable" | "user.remove";
      readonly userId: UserId;
    }) => Effect.Effect<
      InstallationUser,
      SpaceAccessDeniedError | InstallationUserNotFoundError | SpaceDirectoryStorageError
    >;
    /**
     * What a disabled or removed User loses in the Spaces, in the caller's transaction: the
     * Invitations they made stop, and on removal their Memberships end and their Personal space
     * freezes. Then `membershipsChanged` after it.
     */
    readonly endAccessOf: (input: {
      readonly userId: UserId;
      readonly removed: boolean;
    }) => Effect.Effect<void, SpaceDirectoryStorageError>;
    /**
     * After a User's status change commits: whoever runs work as them (scheduled tasks, turns)
     * hears it on `userStatusChanges` and pauses or resumes it.
     */
    readonly userStatusChanged: (change: UserStatusChange) => Effect.Effect<void>;
    /** Subscribes now; every status change committed after this returns is delivered. */
    readonly subscribeUserStatusChanges: Effect.Effect<
      Stream.Stream<UserStatusChange>,
      never,
      Scope.Scope
    >;
    /** Whether the User may still sign in and act. */
    readonly isActive: (userId: UserId) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    readonly installationUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<InstallationUser>, SpaceDirectoryStorageError>;
    /**
     * Subscribes now (so nothing published after it returns is missed) to changes of the
     * User's access that a cached read cannot follow (a Space they saw is now hidden), so their
     * open connections reload what they show. Bursts coalesce into one.
     */
    readonly subscribeAccessChanges: (
      userId: UserId,
    ) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    readonly createOrganization: (
      userId: UserId,
      name: string,
    ) => Effect.Effect<SpaceSummary, SpaceAccessDeniedError | SpaceDirectoryStorageError>;
    /**
     * Archives or restores an Organization (the Owner's). Archiving hides it from its Members at
     * once, like a removal: their connections close and resume without it. Restoring shows it
     * again on their open connections. False when it already was in that state.
     */
    readonly setOrganizationArchived: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
      readonly archived: boolean;
    }) => Effect.Effect<boolean, SpaceClaimError>;
    /**
     * Removes an archived Organization's Memberships, Invitations and row in one transaction.
     * Its Projects and Threads go first, through their own delete paths; refused unless archived.
     */
    readonly removeArchivedOrganization: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<void, SpaceAccessDeniedError | SpaceDirectoryStorageError>;
    /**
     * Checks that the User may move the Project to `spaceId` (`project.move`, on its Space and
     * the destination). A hidden Project or destination answers like a missing one. No User is the
     * server's own work, checked only for existence.
     */
    readonly authorizeProjectMove: (input: {
      readonly actor: UserId | undefined;
      /** The Project, or one of its Threads, whose own Space is the origin. */
      readonly item: ItemRef;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<ProjectMove, ProjectMoveError>;
    /**
     * Starts an archived Organization's deletion (`organization.delete`): from here on it is
     * never restored, so nothing comes back half-deleted.
     */
    readonly beginOrganizationDeletion: (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<void, SpaceClaimError>;
    /**
     * Runs `effect` with the Project marked moving: no Thread is created or started in it, and no
     * machine takes new access to it (`holdProjectAccess`).
     */
    readonly whileProjectMoves: <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** How many moves of the Project went ahead; read before checking a machine's access. */
    readonly projectMoveEpoch: (projectId: ProjectId) => Effect.Effect<number>;
    /**
     * The move goes ahead (its checks passed): every access a machine holds on the Project ends
     * now, and none checked before this registers after it.
     */
    readonly projectAccessEnds: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * A machine's request on the Project, authorized at move count `epoch`, for the scope's life:
     * None while it moves or once a move went ahead since (checked anew on retry); else an effect
     * that completes when one goes ahead, so the request ends there.
     */
    readonly holdProjectAccess: (
      projectId: ProjectId,
      epoch: number,
    ) => Effect.Effect<Option.Option<Effect.Effect<void>>, never, Scope.Scope>;
    /** Completes once a machine holds access to the Project (tests wait on it, never a clock). */
    readonly projectAccessHeld: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * After a Project and its Threads moved: the Users who see either Space reload what their
     * open connections show (the origin's lose it, the destination's gain it).
     */
    readonly projectMoved: (move: ProjectMove) => Effect.Effect<void, SpaceDirectoryStorageError>;
    /**
     * The Space a Thread or Project is in: a Thread's own, else its Project's, else the Owner's
     * Personal space. None when the item or its Space is missing.
     */
    readonly spaceOf: (
      item: ItemRef,
    ) => Effect.Effect<Option.Option<AccessPolicy.SpaceResource>, SpaceDirectoryStorageError>;
    /**
     * Spec 5 ticket 03: a Thread's Space (as `spaceOf`) and its Project, for what the Thread
     * receives (EffectiveVaults). None when the Thread or its Space is missing.
     */
    readonly placementOf: (threadId: ThreadId) => Effect.Effect<
      Option.Option<{
        readonly space: AccessPolicy.SpaceResource;
        readonly projectId: ProjectId | null;
      }>,
      SpaceDirectoryStorageError
    >;
    /** A Space as the policy decides on it, with its stored name; None when missing. */
    readonly spaceById: (
      spaceId: SpaceId,
    ) => Effect.Effect<
      Option.Option<{ readonly resource: AccessPolicy.SpaceResource; readonly name: string }>,
      SpaceDirectoryStorageError
    >;
    /** Several Spaces in one read, as `spaceById`; missing ones are left out. */
    readonly spacesById: (
      spaceIds: ReadonlyArray<SpaceId>,
    ) => Effect.Effect<
      ReadonlyMap<
        SpaceId,
        { readonly resource: AccessPolicy.SpaceResource; readonly name: string }
      >,
      SpaceDirectoryStorageError
    >;
    /** The state of the Thread's or Project's Space; work runs only in an open one. */
    readonly spaceState: (
      item: ItemRef,
    ) => Effect.Effect<"open" | "archived" | "frozen" | "missing", SpaceDirectoryStorageError>;
    /**
     * Why nothing may start in the Thread, whoever asks (the server's own work included): its
     * Space is archived or frozen, or its Project is moving. Undefined when work may start.
     */
    readonly workBlocked: (
      threadId: ThreadId,
    ) => Effect.Effect<
      "space-archived" | "space-frozen" | "project-moving" | undefined,
      SpaceDirectoryStorageError
    >;
    /**
     * Where a new Project or Thread belongs, once the policy allows it. A Thread joins its
     * Project's Space (the Owner's Personal space for a Project from before Spaces); otherwise
     * the requested Space, or the creator's Personal space. None before the Owner exists.
     */
    readonly claimCreation: (
      claim: CreationClaim,
    ) => Effect.Effect<CreationStamp | undefined, SpaceClaimError>;
    /**
     * Refuses the action on a Thread or Project the User may not take: not found when it is
     * missing or its Space is hidden from them (alike), a permission error when they can see it.
     */
    readonly authorizeItem: (
      userId: UserId,
      action: AccessPolicy.Action,
      item: ItemRef,
    ) => Effect.Effect<void, ItemAccessError>;
    /** The User who created the Thread (its root's for a child, the Owner's from before Spaces). */
    /**
     * The User the current command acts for (`CommandActor`), None for the server's own work.
     * A request whose session names no User is refused once an Owner exists; an agent in a
     * Thread from before owners were recorded acts as the Owner.
     */
    readonly actingUser: Effect.Effect<
      Option.Option<UserId>,
      SpaceAccessDeniedError | SpaceDirectoryStorageError
    >;
    readonly threadOwner: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<UserId>, SpaceDirectoryStorageError>;
    /** The Space, once the policy allows the User the action there. */
    readonly authorize: (
      userId: UserId,
      action: AccessPolicy.Action,
      spaceId: SpaceId,
    ) => Effect.Effect<{ readonly id: SpaceId; readonly name: string }, SpaceClaimError>;
    /**
     * What the User may do, decided once per request: the policy, and nothing outside the one
     * Space an agent bound to a Space's machine may act in (`CommandActor.spaceLimit`).
     */
    readonly authorizer: (
      userId: UserId,
    ) => Effect.Effect<
      (action: AccessPolicy.Action, resource: AccessPolicy.Resource) => boolean,
      SpaceDirectoryStorageError
    >;
    /**
     * Makes the User a Member of the Organization with the Role; false when they already are one.
     * Run it in the caller's transaction (accepting an Invitation), then `changed` after it.
     */
    readonly addMembership: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
      readonly role: SpaceRole;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * The Organization's Members with what the viewer may do to each. An Organization the viewer
     * cannot see fails exactly like one that does not exist.
     */
    readonly members: (
      viewer: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<MemberList, SpaceNotFoundError | SpaceDirectoryStorageError>;
    /**
     * Refuses a Membership action the policy denies, and returns the target's current Role. A
     * hidden Organization answers like a missing one; a target who is not a Member is refused.
     */
    readonly authorizeMembership: (input: {
      readonly actor: UserId;
      readonly action: AccessPolicy.Action;
      readonly spaceId: SpaceId;
      readonly target: UserId;
      readonly nextRole?: SpaceRole;
    }) => Effect.Effect<SpaceRole, SpaceClaimError>;
    /** Gives a Member another Role; false when they are not one. Run it in the caller's transaction. */
    readonly setRole: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
      readonly role: SpaceRole;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * Ends a Membership (what they created stays in the Organization) and marks when the User lost
     * access; false when they were not a Member. Run it in the caller's transaction.
     */
    readonly removeMembership: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * After a transaction that changed these Users' Memberships commits: bumps `revision` and
     * tells each User's open connections, which close so their client reloads what it may see.
     */
    readonly membershipsChanged: (userIds: ReadonlyArray<UserId>) => Effect.Effect<void>;
    /** Subscribes now; each User whose Memberships changed, as `membershipsChanged` names them. */
    readonly subscribeMembershipChanges: Effect.Effect<Stream.Stream<UserId>, never, Scope.Scope>;
    /** Subscribes now; the returned effect completes at the User's next Membership change. */
    readonly nextMembershipChange: (
      userId: UserId,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    /** The event sequence when the User last lost a Membership; 0 when never. */
    readonly accessNarrowedThrough: (
      userId: UserId,
    ) => Effect.Effect<number, SpaceDirectoryStorageError>;
    /**
     * The Spaces whose content the User may see (the policy's `space.view`), or "all" for the
     * Owner. Read on the writer connection, so a change committed before the call is seen.
     */
    readonly viewableSpaces: (
      userId: UserId,
    ) => Effect.Effect<"all" | ReadonlyArray<SpaceId>, SpaceDirectoryStorageError>;
    /**
     * Grows whenever a Space or a Membership changes, so a cached `viewableSpaces` answer can
     * tell it is stale. Every such write goes through this service.
     */
    readonly revision: Effect.Effect<number>;
    /**
     * Bumps `revision`. Callers that write Memberships inside their own transaction run it once
     * that transaction ends, so no viewer caches what it read before the commit.
     */
    readonly changed: Effect.Effect<void>;
  }
>()("t3/spaces/SpaceDirectory") {}

const SPACE_COLUMNS = `space_id AS "spaceId", kind, name, personal_owner_user_id AS "personalOwnerUserId",
  archived_at IS NOT NULL AS "archived", frozen_at IS NOT NULL AS "frozen"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const audit = yield* AuditLog.AuditLog;
  const storageError = (cause: unknown) => new SpaceDirectoryStorageError({ cause });
  const revision = yield* Ref.make(0);
  const changed = Ref.update(revision, (current) => current + 1);
  // One hub per User who has a connection open, so a change reaches only that User's streams.
  const accessHubs = new Map<UserId, PubSub.PubSub<void>>();
  const subscribeAccessChanges = Effect.fn("SpaceDirectory.subscribeAccessChanges")(function* (
    userId: UserId,
  ) {
    const created = yield* PubSub.sliding<void>(1);
    const hub = accessHubs.get(userId) ?? created;
    accessHubs.set(userId, hub);
    return Stream.fromSubscription(yield* PubSub.subscribe(hub));
  });
  const accessChanged = (userId: UserId) =>
    Effect.suspend(() => {
      const hub = accessHubs.get(userId);
      return hub === undefined ? Effect.void : PubSub.publish(hub, undefined);
    });

  const findSpace = SqlSchema.findOneOption({
    Request: SpaceId,
    Result: SpaceRow,
    execute: (spaceId) =>
      sql`SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces WHERE space_id = ${spaceId}`,
  });
  const listSpaces = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SpaceRow,
    execute: () => sql`SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces`,
  });
  const listOrganizations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SpaceRow,
    execute: () => sql`
      SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces WHERE kind = 'organization'
      ORDER BY created_at ASC, space_id ASC
    `,
  });
  // The User row and their memberships in one read.
  const findPrincipalRows = SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({
      isOwner: Schema.BooleanFromBit,
      spaceId: Schema.NullOr(SpaceId),
      role: Schema.NullOr(SpaceRole),
      strongSignIn: Schema.BooleanFromBit,
      inactive: Schema.BooleanFromBit,
    }),
    execute: (userId) => sql`
      SELECT users.is_owner AS "isOwner", m.space_id AS "spaceId", m.role AS role,
        (users.disabled_at IS NOT NULL OR users.removed_at IS NOT NULL) AS "inactive",
        (EXISTS (SELECT 1 FROM user_passkeys WHERE user_id = users.user_id)
        OR EXISTS (SELECT 1 FROM user_totp WHERE user_id = users.user_id)) AS "strongSignIn"
      FROM users LEFT JOIN space_memberships AS m ON m.user_id = users.user_id
      WHERE users.user_id = ${userId}
    `,
  });
  const findPermissions = SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({ permission: InstallationPermission }),
    execute: (userId) => sql`
      SELECT permission FROM installation_permissions WHERE user_id = ${userId}
    `,
  });
  const UserRow = Schema.Struct({
    id: UserId,
    displayName: Schema.String,
    loginName: Schema.NullOr(Schema.String),
    isOwner: Schema.BooleanFromBit,
    status: InstallationUserStatus,
    permissions: Schema.NullOr(Schema.String),
  });
  const USER_COLUMNS = `users.user_id AS "id", users.display_name AS "displayName",
    users.login_name AS "loginName", users.is_owner AS "isOwner",
    CASE WHEN users.removed_at IS NOT NULL THEN 'removed'
      WHEN users.disabled_at IS NOT NULL THEN 'disabled' ELSE 'active' END AS "status",
    (SELECT group_concat(permission, ' ') FROM installation_permissions p
      WHERE p.user_id = users.user_id) AS "permissions"`;
  const listUserRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UserRow,
    execute: () => sql`
      SELECT ${sql.literal(USER_COLUMNS)} FROM users
      ORDER BY is_owner DESC, removed_at IS NOT NULL, display_name COLLATE NOCASE ASC, user_id ASC
    `,
  });
  const findUserRow = SqlSchema.findOneOption({
    Request: UserId,
    Result: UserRow,
    execute: (userId) => sql`
      SELECT ${sql.literal(USER_COLUMNS)} FROM users WHERE user_id = ${userId}
    `,
  });
  // Other Users' Personal spaces, which only the Owner lists.
  const listOthersPersonalSpaces = SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({
      spaceId: SpaceId,
      displayName: Schema.String,
      frozen: Schema.BooleanFromBit,
    }),
    execute: (userId) => sql`
      SELECT s.space_id AS "spaceId", u.display_name AS "displayName",
        s.frozen_at IS NOT NULL AS "frozen"
      FROM spaces s JOIN users u ON u.user_id = s.personal_owner_user_id
      WHERE s.kind = 'personal' AND s.personal_owner_user_id <> ${userId}
      ORDER BY u.display_name COLLATE NOCASE ASC, s.space_id ASC
    `,
  });
  const isPermission = Schema.is(InstallationPermission);
  const toInstallationUser = (row: typeof UserRow.Type): InstallationUser => ({
    id: row.id,
    displayName: row.displayName,
    loginName: row.loginName,
    isOwner: row.isOwner,
    status: row.status,
    installationPermissions: row.isOwner
      ? []
      : (row.permissions ?? "").split(" ").filter(isPermission).toSorted(),
  });
  const findOwnerId = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: UserId }),
    execute: () => sql`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`,
  });
  const findProjectSpace = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ spaceId: Schema.NullOr(SpaceId) }),
    execute: (projectId) => sql`
      SELECT space_id AS "spaceId" FROM projection_projects WHERE project_id = ${projectId}
    `,
  });

  /**
   * The principal, and the Organizations where they were made Admin but act as a Member until
   * they have a passkey or an authenticator app: a stolen password alone makes no Admin.
   */
  const membershipsOf = Effect.fn("SpaceDirectory.membershipsOf")(function* (userId: UserId) {
    const [rows, permissions] = yield* Effect.all(
      [findPrincipalRows(userId), findPermissions(userId)],
      { concurrency: "unbounded" },
    );
    const roles = new Map<SpaceId, SpaceRole>();
    const storedRoles = new Map<SpaceId, SpaceRole>();
    const pendingAdmin = new Set<SpaceId>();
    for (const row of rows) {
      if (row.spaceId === null || row.role === null) continue;
      storedRoles.set(row.spaceId, row.role);
      const pending = row.role === "admin" && !row.strongSignIn;
      if (pending) pendingAdmin.add(row.spaceId);
      roles.set(row.spaceId, pending ? "member" : row.role);
    }
    const principal = {
      userId,
      isOwner: rows[0]?.isOwner ?? false,
      installationPermissions: new Set(permissions.map((row) => row.permission)),
      roles,
      inactive: rows[0]?.inactive ?? false,
    } satisfies AccessPolicy.Principal;
    return { principal, storedRoles, pendingAdmin };
  }, Effect.mapError(storageError));

  const principalOf = (userId: UserId) =>
    Effect.map(membershipsOf(userId), (found) => found.principal);

  const allows = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) => AccessPolicy.isAllowed(AccessPolicy.decide(principal, action, resource));

  const movesOf = (principal: AccessPolicy.Principal, space: AccessPolicy.SpaceResource) => ({
    canMoveProjectsOut: AccessPolicy.isAllowed(AccessPolicy.mayMoveOut(principal, space)),
    canMoveProjectsIn: AccessPolicy.isAllowed(AccessPolicy.mayMoveIn(principal, space)),
  });

  const view = Effect.fn("SpaceDirectory.view")(function* (userId: UserId) {
    const personalSpaceId = personalSpaceIdOf(userId);
    const [{ principal, pendingAdmin }, organizations] = yield* Effect.all(
      [membershipsOf(userId), listOrganizations().pipe(Effect.mapError(storageError))],
      { concurrency: "unbounded" },
    );
    const othersPersonal = principal.isOwner
      ? yield* listOthersPersonalSpaces(userId).pipe(Effect.mapError(storageError))
      : [];
    const personal: AccessPolicy.SpaceResource = {
      id: personalSpaceId,
      kind: "personal",
      personalOwnerUserId: userId,
      archived: false,
      frozen: false,
    };
    const spaces: Array<SpaceSummary> = [
      // Every User has theirs; only an inactive User is refused it.
      ...(allows(principal, "space.view", personal)
        ? [
            {
              id: personalSpaceId,
              kind: "personal" as const,
              name: "Personal",
              role: null,
              isOwn: true,
              canCreateThreads: allows(principal, "thread.create", personal),
              canInvite: false,
              ...movesOf(principal, personal),
            },
          ]
        : []),
      ...organizations
        .filter((row) => allows(principal, "space.view", toResource(row)))
        .map((row) => ({
          id: row.spaceId,
          kind: row.kind,
          name: row.name,
          role: principal.roles.get(row.spaceId) ?? null,
          isOwn: false,
          canCreateThreads: allows(principal, "thread.create", toResource(row)),
          canInvite: allows(principal, "invitation.create", toResource(row)),
          ...(pendingAdmin.has(row.spaceId) ? { pendingAdmin: true } : {}),
          ...(row.archived ? { archived: true } : {}),
          ...movesOf(principal, toResource(row)),
        })),
      // The Owner reads every other User's Personal space and adds nothing to it.
      ...othersPersonal.map((row) => {
        const name = row.displayName.trim() || "Personal";
        return {
          id: row.spaceId,
          kind: "personal" as const,
          name: row.frozen ? `${name} (removed)` : name,
          role: null,
          isOwn: false,
          canCreateThreads: false,
          canInvite: false,
          ...(row.frozen ? { frozen: true } : {}),
          ...movesOf(principal, {
            id: row.spaceId,
            kind: "personal",
            personalOwnerUserId: null,
            archived: false,
            frozen: row.frozen,
          }),
        };
      }),
    ];
    return {
      userId,
      spaces,
      personalSpaceId,
      canCreateOrganization: allows(principal, "organization.create", AccessPolicy.installation),
      isOwner: principal.isOwner,
    } satisfies SpaceDirectoryView;
  });

  const viewableSpaces = Effect.fn("SpaceDirectory.viewableSpaces")(function* (userId: UserId) {
    const principal = yield* principalOf(userId);
    if (principal.isOwner) return "all" as const;
    const spaces = yield* listSpaces().pipe(Effect.mapError(storageError));
    return spaces
      .filter((row) => allows(principal, "space.view", toResource(row)))
      .map((row) => row.spaceId);
  });

  // Every action the policy decides passes here, so an agent bound to one Space's machine
  // (`CommandActor.spaceLimit`) acts in no other Space and on nothing Installation-wide.
  const requireAllowed = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) =>
    Effect.flatMap(CommandActor.spaceLimit, (limit) => {
      if (limit !== undefined && !spacesOf(resource).every((spaceId) => spaceId === limit)) {
        return Effect.fail(new SpaceAccessDeniedError({ action, reason: "space-limited" }));
      }
      const decision = AccessPolicy.decide(principal, action, resource);
      return decision._tag === "Allow"
        ? Effect.void
        : Effect.fail(new SpaceAccessDeniedError({ action, reason: decision.reason }));
    });

  const listUsers = Effect.fn("SpaceDirectory.listUsers")(function* (actorUserId: UserId) {
    const principal = yield* principalOf(actorUserId);
    yield* requireAllowed(principal, "installationPermission.manage", AccessPolicy.installation);
    const rows = yield* listUserRows().pipe(Effect.mapError(storageError));
    return rows.map(toInstallationUser);
  });

  const setInstallationPermission = Effect.fn("SpaceDirectory.setInstallationPermission")(
    function* (input: {
      readonly actorUserId: UserId;
      readonly userId: UserId;
      readonly permission: InstallationPermission;
      readonly granted: boolean;
    }) {
      const principal = yield* principalOf(input.actorUserId);
      yield* requireAllowed(principal, "installationPermission.manage", AccessPolicy.installation);
      const target = yield* findUserRow(input.userId).pipe(Effect.mapError(storageError));
      if (Option.isNone(target) || target.value.status === "removed") {
        return yield* new InstallationUserNotFoundError({ userId: input.userId });
      }
      // The Owner holds every permission; there is nothing to grant or revoke.
      if (target.value.isOwner) return toInstallationUser(target.value);
      const now = DateTime.formatIso(yield* DateTime.now);
      const written = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* input.granted
              ? sql<{ readonly userId: string }>`
                  INSERT INTO installation_permissions (user_id, permission, granted_by, granted_at)
                  VALUES (${input.userId}, ${input.permission}, ${input.actorUserId}, ${now})
                  ON CONFLICT (user_id, permission) DO NOTHING
                  RETURNING user_id AS "userId"
                `
              : sql<{ readonly userId: string }>`
                  DELETE FROM installation_permissions
                  WHERE user_id = ${input.userId} AND permission = ${input.permission}
                  RETURNING user_id AS "userId"
                `;
            if (rows.length > 0) {
              yield* audit.record({
                actor: AuditLog.userActor(input.actorUserId),
                action: input.granted
                  ? "installationPermission.grant"
                  : "installationPermission.revoke",
                target: { kind: "user", id: input.userId },
                detail: { permission: input.permission },
              });
            }
            return rows;
          }),
        )
        .pipe(Effect.mapError(storageError));
      // Only a row that changed moves caches and wakes the User's connections.
      if (written.length > 0) yield* Effect.andThen(changed, accessChanged(input.userId));
      const updated = yield* findUserRow(input.userId).pipe(Effect.mapError(storageError));
      return toInstallationUser(Option.getOrElse(updated, () => target.value));
    },
  );

  const installationUser = Effect.fn("SpaceDirectory.installationUser")(function* (userId: UserId) {
    const row = yield* findUserRow(userId).pipe(Effect.mapError(storageError));
    return Option.map(row, toInstallationUser);
  });

  const authorizeUserChange = Effect.fn("SpaceDirectory.authorizeUserChange")(function* (input: {
    readonly actorUserId: UserId;
    readonly action: "user.disable" | "user.remove";
    readonly userId: UserId;
  }) {
    const principal = yield* principalOf(input.actorUserId);
    // Only the Owner learns whether the User exists.
    if (!principal.isOwner || principal.inactive === true) {
      return yield* new SpaceAccessDeniedError({ action: input.action, reason: "owner-only" });
    }
    const target = yield* findUserRow(input.userId).pipe(Effect.mapError(storageError));
    if (Option.isNone(target)) {
      return yield* new InstallationUserNotFoundError({ userId: input.userId });
    }
    yield* requireAllowed(principal, input.action, {
      kind: "user",
      userId: target.value.id,
      isOwner: target.value.isOwner,
    });
    return toInstallationUser(target.value);
  });

  const endAccessOf = Effect.fn("SpaceDirectory.endAccessOf")(function* (input: {
    readonly userId: UserId;
    readonly removed: boolean;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
        UPDATE space_invitations SET revoked_at = ${now}
        WHERE created_by = ${input.userId} AND accepted_at IS NULL AND revoked_at IS NULL
      `;
    if (!input.removed) return;
    // What they created stays in each Organization.
    yield* sql`DELETE FROM space_memberships WHERE user_id = ${input.userId}`;
    yield* sql`
        UPDATE users
        SET access_narrowed_through = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)
        WHERE user_id = ${input.userId}
      `;
    yield* sql`
        UPDATE spaces SET frozen_at = ${now}
        WHERE personal_owner_user_id = ${input.userId} AND frozen_at IS NULL
      `;
  }, Effect.mapError(storageError));

  /**
   * A Space the User may not see answers exactly like one that does not exist, so naming
   * `personal:<id>` or an Organization id says nothing about what is there. Their own hidden
   * Personal space still says why.
   */
  const requireAllowedInSpace = Effect.fnUntraced(function* (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    spaceId: SpaceId,
    space: Option.Option<SpaceRow>,
  ): Effect.fn.Return<SpaceRow, SpaceAccessDeniedError | SpaceNotFoundError> {
    if (Option.isNone(space)) return yield* new SpaceNotFoundError({ spaceId });
    const resource = toResource(space.value);
    if (
      resource.personalOwnerUserId !== principal.userId &&
      !allows(principal, "space.view", resource)
    ) {
      return yield* new SpaceNotFoundError({ spaceId });
    }
    yield* requireAllowed(principal, action, resource);
    return space.value;
  });

  const createOrganization = Effect.fn("SpaceDirectory.createOrganization")(function* (
    userId: UserId,
    name: string,
  ) {
    const principal = yield* principalOf(userId);
    yield* requireAllowed(principal, "organization.create", AccessPolicy.installation);
    const spaceId = SpaceId.make(yield* random.uuidV4().pipe(Effect.mapError(storageError)));
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES (${spaceId}, 'organization', ${name}, ${now})
    `.pipe(Effect.mapError(storageError), Effect.ensuring(changed));
    return {
      id: spaceId,
      kind: "organization",
      name,
      role: null,
      isOwn: false,
      canCreateThreads: true,
      canInvite: true,
    } satisfies SpaceSummary;
  });

  const ownerId = findOwnerId().pipe(
    Effect.map(Option.map((row) => row.userId)),
    Effect.mapError(storageError),
  );

  const claimCreation = Effect.fn("SpaceDirectory.claimCreation")(function* (claim: CreationClaim) {
    if (claim.projectId !== undefined && moving.has(claim.projectId)) {
      return yield* new SpaceAccessDeniedError({ action: claim.action, reason: "project-moving" });
    }
    const actor = claim.actorUserId ?? Option.getOrUndefined(yield* ownerId);
    if (actor === undefined) return undefined;
    const project =
      claim.projectId === undefined
        ? Option.none()
        : yield* findProjectSpace(claim.projectId).pipe(Effect.mapError(storageError));
    let spaceId: SpaceId | undefined;
    if (Option.isSome(project)) {
      // A Project from before Spaces belongs to the Owner's Personal space.
      const legacyOwner =
        project.value.spaceId === null ? Option.getOrUndefined(yield* ownerId) : undefined;
      spaceId =
        project.value.spaceId ??
        (legacyOwner === undefined ? undefined : personalSpaceIdOf(legacyOwner));
    }
    spaceId ??= claim.spaceId ?? personalSpaceIdOf(actor);
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), principalOf(actor)],
      { concurrency: "unbounded" },
    );
    yield* requireAllowedInSpace(principal, claim.action, spaceId, space);
    return { spaceId, ownerUserId: actor } satisfies CreationStamp;
  });

  const authorize = Effect.fn("SpaceDirectory.authorize")(function* (
    userId: UserId,
    action: AccessPolicy.Action,
    spaceId: SpaceId,
  ) {
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), principalOf(userId)],
      { concurrency: "unbounded" },
    );
    const row = yield* requireAllowedInSpace(principal, action, spaceId, space);
    return { id: row.spaceId, name: row.name };
  });

  // One read per check: the item, its Space (its own, its Project's, else the Owner's Personal
  // space) and its owner (its own, its root's for a child the server made, else the Owner).
  const ItemRow = Schema.Struct({
    ownerUserId: Schema.NullOr(UserId),
    projectId: Schema.NullOr(Schema.String),
    /** The Space the item names, even when that Space is gone. */
    itemSpaceId: Schema.NullOr(Schema.String),
    archived: Schema.BooleanFromBit,
    spaceId: Schema.NullOr(SpaceId),
    kind: Schema.NullOr(SpaceKind),
    personalOwnerUserId: Schema.NullOr(UserId),
    spaceArchived: Schema.BooleanFromBit,
    frozen: Schema.BooleanFromBit,
  });
  const OWNER_ID = "(SELECT user_id FROM users WHERE is_owner = 1)";
  const SPACE_OF_ITEM = `s.space_id AS "spaceId", s.kind AS "kind",
    s.personal_owner_user_id AS "personalOwnerUserId",
    COALESCE(s.archived_at IS NOT NULL, 0) AS "spaceArchived",
    COALESCE(s.frozen_at IS NOT NULL, 0) AS "frozen"`;
  const findThreadItem = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ItemRow,
    execute: (threadId) => sql`
      SELECT item.owner_user_id AS "ownerUserId", item.project_id AS "projectId",
        item.space_id AS "itemSpaceId", item.archived AS "archived", ${sql.literal(SPACE_OF_ITEM)}
      FROM (
        SELECT COALESCE(t.owner_user_id, root.owner_user_id, ${sql.literal(OWNER_ID)}) AS owner_user_id,
          t.project_id AS project_id,
          t.archived_at IS NOT NULL AS archived,
          COALESCE(t.space_id, p.space_id, 'personal:' || ${sql.literal(OWNER_ID)}) AS space_id
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN orchestration_v2_projection_threads root
          ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
        WHERE t.thread_id = ${threadId}
      ) item LEFT JOIN spaces s ON s.space_id = item.space_id
    `,
  });
  const findProjectItem = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ItemRow,
    execute: (projectId) => sql`
      SELECT item.owner_user_id AS "ownerUserId", item.project_id AS "projectId",
        item.space_id AS "itemSpaceId", item.archived AS "archived", ${sql.literal(SPACE_OF_ITEM)}
      FROM (
        SELECT COALESCE(owner_user_id, ${sql.literal(OWNER_ID)}) AS owner_user_id, project_id,
          archived_at IS NOT NULL AS archived,
          ${sql.literal(projectSpaceSql("space_id"))} AS space_id
        FROM projection_projects WHERE project_id = ${projectId}
      ) item LEFT JOIN spaces s ON s.space_id = item.space_id
    `,
  });

  // Checks run on every command, so the principal is kept until a Space or Membership changes.
  const principals = new Map<
    UserId,
    { readonly revision: number; readonly principal: AccessPolicy.Principal }
  >();
  const currentPrincipal = Effect.fn("SpaceDirectory.currentPrincipal")(function* (userId: UserId) {
    const at = yield* Ref.get(revision);
    const cached = principals.get(userId);
    if (cached !== undefined && cached.revision === at) return cached.principal;
    const principal = yield* principalOf(userId);
    principals.set(userId, { revision: at, principal });
    return principal;
  });

  const actingUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    switch (actor._tag) {
      case "Server":
        return Option.none<UserId>();
      case "User":
        return Option.some(actor.userId);
      case "ThreadOwner":
        return yield* ownerId;
      case "NoUser": {
        if (Option.isNone(yield* ownerId)) return Option.none<UserId>();
        return yield* new SpaceAccessDeniedError({ action: "act", reason: "no-user" });
      }
    }
  });

  const threadOwner = Effect.fn("SpaceDirectory.threadOwner")(function* (threadId: ThreadId) {
    const row = yield* findThreadItem(threadId).pipe(Effect.mapError(storageError));
    return Option.flatMap(row, (found) => Option.fromNullishOr(found.ownerUserId));
  });

  // A hidden item and a missing one fail alike, so no answer says what exists elsewhere.
  const hiddenOrMissing = () =>
    new SpaceResourceNotFoundError({ message: "That Project or Thread does not exist." });

  const authorizeItem = Effect.fn("SpaceDirectory.authorizeItem")(function* (
    userId: UserId,
    action: AccessPolicy.Action,
    item: ItemRef,
  ) {
    const principal = yield* currentPrincipal(userId);
    // Said before looking the item up, so it tells nothing about what exists.
    if (principal.inactive === true) {
      return yield* new SpaceAccessDeniedError({ action, reason: "user-inactive" });
    }
    const row = yield* (item.kind === "thread" ? findThreadItem : findProjectItem)(item.id).pipe(
      Effect.mapError(storageError),
    );
    if (Option.isNone(row) || row.value.spaceId === null || row.value.kind === null) {
      return yield* hiddenOrMissing();
    }
    // An agent bound to one Space's machine reaches nothing in another, writes included.
    const limit = yield* CommandActor.spaceLimit;
    if (limit !== undefined && row.value.spaceId !== limit) return yield* hiddenOrMissing();
    const resource: AccessPolicy.SpaceResource = {
      id: row.value.spaceId,
      kind: row.value.kind,
      personalOwnerUserId: row.value.personalOwnerUserId,
      archived: row.value.spaceArchived,
      frozen: row.value.frozen,
    };
    if (!allows(principal, "space.view", resource)) return yield* hiddenOrMissing();
    // A Space-wide action (viewing, a guest link) is decided on the item's Space.
    if (!AccessPolicy.isItemAction(action)) {
      return yield* requireAllowed(principal, action, resource);
    }
    if (row.value.ownerUserId === null) return yield* hiddenOrMissing();
    yield* requireAllowed(principal, action, {
      kind: item.kind,
      space: resource,
      ownerUserId: row.value.ownerUserId,
      archived: row.value.archived,
    });
  });

  const addMembership = Effect.fn("SpaceDirectory.addMembership")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
    readonly role: SpaceRole;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql<{ readonly userId: string }>`
      INSERT INTO space_memberships (space_id, user_id, role, created_at)
      VALUES (${input.spaceId}, ${input.userId}, ${input.role}, ${now})
      ON CONFLICT (space_id, user_id) DO NOTHING
      RETURNING user_id AS "userId"
    `.pipe(Effect.mapError(storageError));
    return inserted.length > 0;
  });

  const listMemberRows = SqlSchema.findAll({
    Request: SpaceId,
    Result: Schema.Struct({
      userId: UserId,
      displayName: Schema.String,
      role: SpaceRole,
      strongSignIn: Schema.BooleanFromBit,
    }),
    execute: (spaceId) => sql`
      SELECT m.user_id AS "userId", u.display_name AS "displayName", m.role AS role,
        (EXISTS (SELECT 1 FROM user_passkeys WHERE user_id = m.user_id)
        OR EXISTS (SELECT 1 FROM user_totp WHERE user_id = m.user_id)) AS "strongSignIn"
      FROM space_memberships AS m JOIN users AS u ON u.user_id = m.user_id
      WHERE m.space_id = ${spaceId} AND u.removed_at IS NULL
      ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
        u.display_name COLLATE NOCASE, m.user_id
    `,
  });

  /** The Organization, when the User may see it; a hidden one is reported as missing. */
  const visibleOrganization = Effect.fn("SpaceDirectory.visibleOrganization")(function* (
    userId: UserId,
    spaceId: SpaceId,
  ) {
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), currentPrincipal(userId)],
      { concurrency: "unbounded" },
    );
    if (
      Option.isNone(space) ||
      space.value.kind !== "organization" ||
      !allows(principal, "space.view", toResource(space.value))
    ) {
      return yield* new SpaceNotFoundError({ spaceId });
    }
    return { principal, space: toResource(space.value) };
  });

  const ASSIGNABLE_ROLES: ReadonlyArray<SpaceRole> = ["admin", "member", "guest"];

  const members = Effect.fn("SpaceDirectory.members")(function* (viewer: UserId, spaceId: SpaceId) {
    const { principal, space } = yield* visibleOrganization(viewer, spaceId);
    const rows = yield* listMemberRows(spaceId).pipe(Effect.mapError(storageError));
    const may = (
      action: AccessPolicy.Action,
      userId: UserId,
      role: SpaceRole,
      nextRole?: SpaceRole,
    ) =>
      allows(principal, action, {
        kind: "membership",
        space,
        userId,
        role,
        ...(nextRole === undefined ? {} : { nextRole }),
      });
    return {
      members: rows.map((row): MemberSummary => ({
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        pendingAdmin: row.role === "admin" && !row.strongSignIn,
        isYou: row.userId === viewer,
        canChangeRole:
          row.userId !== viewer &&
          ASSIGNABLE_ROLES.some(
            (role) => role !== row.role && may("membership.changeRole", row.userId, row.role, role),
          ),
        canRemove: row.userId !== viewer && may("membership.remove", row.userId, row.role),
        canIssueResetLink:
          row.userId !== viewer && may("membership.resetLink", row.userId, row.role),
      })),
      // The Roles an Admin may give a Member, which are the ones they may invite as.
      assignableRoles: ASSIGNABLE_ROLES.filter((role) =>
        allows(principal, "membership.changeRole", {
          kind: "membership",
          space,
          userId: viewer,
          role: "guest",
          nextRole: role,
        }),
      ),
      canLeave: may("membership.leave", viewer, principal.roles.get(spaceId) ?? "guest"),
    } satisfies MemberList;
  });

  const authorizeMembership = Effect.fn("SpaceDirectory.authorizeMembership")(function* (input: {
    readonly actor: UserId;
    readonly action: AccessPolicy.Action;
    readonly spaceId: SpaceId;
    readonly target: UserId;
    readonly nextRole?: SpaceRole;
  }) {
    const { principal, space } = yield* visibleOrganization(input.actor, input.spaceId);
    // Decided on the Role they were given: a pending Admin is the Owner's to change too.
    const role = (yield* membershipsOf(input.target)).storedRoles.get(input.spaceId);
    if (role === undefined) {
      return yield* new SpaceAccessDeniedError({ action: input.action, reason: "no-such-member" });
    }
    yield* requireAllowed(principal, input.action, {
      kind: "membership",
      space,
      userId: input.target,
      role,
      ...(input.nextRole === undefined ? {} : { nextRole: input.nextRole }),
    });
    return role;
  });

  const setRole = Effect.fn("SpaceDirectory.setRole")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
    readonly role: SpaceRole;
  }) {
    const updated = yield* sql<{ readonly userId: string }>`
      UPDATE space_memberships SET role = ${input.role}
      WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
      RETURNING user_id AS "userId"
    `;
    // Only Admins invite, so a former Admin's pending Invitations end with their Role.
    if (updated.length > 0 && input.role !== "admin") {
      yield* revokeInvitationsBy(input.spaceId, input.userId);
    }
    return updated.length > 0;
  }, Effect.mapError(storageError));

  const revokeInvitationsBy = Effect.fn("SpaceDirectory.revokeInvitationsBy")(function* (
    spaceId: SpaceId,
    userId: UserId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE space_invitations SET revoked_at = ${now}
      WHERE space_id = ${spaceId} AND created_by = ${userId}
        AND accepted_at IS NULL AND revoked_at IS NULL
    `;
  });

  const removeMembership = Effect.fn("SpaceDirectory.removeMembership")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
  }) {
    const removed = yield* sql<{ readonly userId: string }>`
      DELETE FROM space_memberships
      WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
      RETURNING user_id AS "userId"
    `;
    if (removed.length === 0) return false;
    yield* revokeInvitationsBy(input.spaceId, input.userId);
    yield* sql`
      UPDATE users
      SET access_narrowed_through = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)
      WHERE user_id = ${input.userId}
    `;
    return true;
  }, Effect.mapError(storageError));

  const membershipChanges = yield* PubSub.unbounded<UserId>();
  const userStatusChanges = yield* PubSub.unbounded<UserStatusChange>();
  const isActive = (userId: UserId) =>
    Effect.map(principalOf(userId), (principal) => principal.inactive !== true);
  const membershipsChanged = (userIds: ReadonlyArray<UserId>) =>
    changed.pipe(
      // Open streams hear it as any access change does, then the sockets close.
      Effect.andThen(Effect.forEach(userIds, accessChanged, { discard: true })),
      Effect.andThen(PubSub.publishAll(membershipChanges, userIds)),
      Effect.asVoid,
    );

  const nextMembershipChange = Effect.fn("SpaceDirectory.nextMembershipChange")(function* (
    userId: UserId,
  ) {
    const subscription = yield* PubSub.subscribe(membershipChanges);
    const next: Effect.Effect<void> = PubSub.take(subscription).pipe(
      Effect.flatMap((changedUserId) => (changedUserId === userId ? Effect.void : next)),
    );
    return next;
  });

  const findAccessNarrowed = SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ through: Schema.NullOr(Schema.Number) }),
    execute: (userId) => sql`
      SELECT access_narrowed_through AS "through" FROM users WHERE user_id = ${userId}
    `,
  });
  const accessNarrowedThrough = Effect.fn("SpaceDirectory.accessNarrowedThrough")(function* (
    userId: UserId,
  ) {
    const row = yield* findAccessNarrowed(userId).pipe(Effect.mapError(storageError));
    return Option.match(row, { onNone: () => 0, onSome: (found) => found.through ?? 0 });
  });

  // Who sees a Space's content besides the Owner, who sees everything.
  const listViewers = SqlSchema.findAll({
    Request: Schema.Array(SpaceId),
    Result: Schema.Struct({ userId: UserId }),
    execute: (spaceIds) => sql`
      SELECT user_id AS "userId" FROM space_memberships
      WHERE space_id IN (SELECT value FROM json_each(${JSON.stringify(spaceIds)}))
      UNION
      SELECT personal_owner_user_id AS "userId" FROM spaces
      WHERE personal_owner_user_id IS NOT NULL
        AND space_id IN (SELECT value FROM json_each(${JSON.stringify(spaceIds)}))
    `,
  });
  const viewersOf = (spaceIds: ReadonlyArray<SpaceId>) =>
    listViewers(spaceIds).pipe(
      Effect.map((rows) => rows.map((row) => row.userId)),
      Effect.mapError(storageError),
    );
  // A client resuming from before this event holds rows it may no longer see.
  const markAccessNarrowed = (userIds: ReadonlyArray<UserId>) =>
    userIds.length === 0
      ? Effect.void
      : sql`
          UPDATE users
          SET access_narrowed_through = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)
          WHERE user_id IN (SELECT value FROM json_each(${JSON.stringify(userIds)}))
        `.pipe(Effect.asVoid, Effect.mapError(storageError));

  const isDeleting = (spaceId: SpaceId) =>
    sql<{ readonly deleting: number }>`
      SELECT deleting_at IS NOT NULL AS deleting FROM spaces WHERE space_id = ${spaceId}
    `.pipe(
      Effect.map((rows) => rows[0]?.deleting === 1),
      Effect.mapError(storageError),
    );

  const setOrganizationArchived = Effect.fn("SpaceDirectory.setOrganizationArchived")(
    function* (input: {
      readonly actor: UserId;
      readonly spaceId: SpaceId;
      readonly archived: boolean;
    }) {
      const action = input.archived ? "organization.archive" : "organization.restore";
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { principal, space } = yield* visibleOrganization(input.actor, input.spaceId);
            yield* requireAllowed(principal, action, space);
            const now = DateTime.formatIso(yield* DateTime.now);
            const written = yield* (
              input.archived
                ? sql<{ readonly spaceId: string }>`
                    UPDATE spaces SET archived_at = ${now}
                    WHERE space_id = ${input.spaceId} AND archived_at IS NULL
                    RETURNING space_id AS "spaceId"
                  `
                : // Once its deletion started it is never restored, so nothing comes back half-deleted.
                  sql<{ readonly spaceId: string }>`
                    UPDATE spaces SET archived_at = NULL
                    WHERE space_id = ${input.spaceId} AND archived_at IS NOT NULL
                      AND deleting_at IS NULL
                    RETURNING space_id AS "spaceId"
                  `
            ).pipe(Effect.mapError(storageError));
            if (!input.archived && written.length === 0 && (yield* isDeleting(input.spaceId))) {
              return yield* new SpaceAccessDeniedError({ action, reason: "space-deleting" });
            }
            const members = written.length === 0 ? [] : yield* viewersOf([input.spaceId]);
            if (input.archived) yield* markAccessNarrowed(members);
            if (written.length > 0) {
              yield* audit
                .record({
                  actor: AuditLog.userActor(input.actor),
                  action,
                  spaceId: input.spaceId,
                  target: { kind: "space", id: input.spaceId },
                })
                .pipe(Effect.mapError(storageError));
            }
            return { changed: written.length > 0, members };
          }),
        )
        .pipe(
          Effect.mapError((error) => (error._tag === "SqlError" ? storageError(error) : error)),
        );
      if (!outcome.changed) return false;
      // Archived: its Members lose it as on a removal. Restored: their streams reload with it.
      yield* input.archived
        ? membershipsChanged(outcome.members)
        : Effect.andThen(
            changed,
            Effect.forEach(outcome.members, accessChanged, { discard: true }),
          );
      return true;
    },
  );

  const beginOrganizationDeletion = Effect.fn("SpaceDirectory.beginOrganizationDeletion")(
    function* (input: { readonly actor: UserId; readonly spaceId: SpaceId }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { principal, space } = yield* visibleOrganization(input.actor, input.spaceId);
            yield* requireAllowed(principal, "organization.delete", space);
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
              UPDATE spaces SET deleting_at = COALESCE(deleting_at, ${now})
              WHERE space_id = ${input.spaceId} AND archived_at IS NOT NULL
            `.pipe(Effect.mapError(storageError));
          }),
        )
        .pipe(
          Effect.mapError((error) => (error._tag === "SqlError" ? storageError(error) : error)),
        );
    },
  );

  const removeArchivedOrganization = Effect.fn("SpaceDirectory.removeArchivedOrganization")(
    function* ({ actor, spaceId }: { readonly actor: UserId; readonly spaceId: SpaceId }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const space = yield* findSpace(spaceId);
            if (Option.isNone(space)) return;
            if (space.value.kind !== "organization" || !space.value.archived) {
              return yield* new SpaceAccessDeniedError({
                action: "organization.delete",
                reason: space.value.kind === "organization" ? "not-archived" : "wrong-resource",
              });
            }
            // Its scheduled tasks go with it, those bound to a Project as well as to a Thread.
            yield* sql`
              DELETE FROM scheduled_tasks
              WHERE project_id IN (
                SELECT project_id FROM projection_projects WHERE space_id = ${spaceId}
              ) OR thread_id IN (
                SELECT thread_id FROM orchestration_v2_projection_threads WHERE space_id = ${spaceId}
              )
            `;
            // Recorded while the row still names it.
            yield* audit.record({
              actor: AuditLog.userActor(actor),
              action: "organization.delete",
              spaceId,
              target: { kind: "space", id: spaceId },
            });
            yield* sql`DELETE FROM space_invitations WHERE space_id = ${spaceId}`;
            yield* sql`DELETE FROM space_memberships WHERE space_id = ${spaceId}`;
            yield* sql`DELETE FROM spaces WHERE space_id = ${spaceId}`;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SpaceAccessDeniedError" ? error : storageError(error),
          ),
          Effect.ensuring(changed),
        );
    },
  );

  const findItem = (item: ItemRef) =>
    (item.kind === "thread" ? findThreadItem : findProjectItem)(item.id).pipe(
      Effect.mapError(storageError),
    );

  const authorizeProjectMove = Effect.fn("SpaceDirectory.authorizeProjectMove")(function* (input: {
    readonly actor: UserId | undefined;
    readonly item: ItemRef;
    readonly spaceId: SpaceId;
  }) {
    const [row, destination] = yield* Effect.all(
      [findItem(input.item), findSpace(input.spaceId).pipe(Effect.mapError(storageError))],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(row) || row.value.spaceId === null || row.value.kind === null) {
      return yield* hiddenOrMissing();
    }
    const from: AccessPolicy.SpaceResource = {
      id: row.value.spaceId,
      kind: row.value.kind,
      personalOwnerUserId: row.value.personalOwnerUserId,
      archived: row.value.spaceArchived,
      frozen: row.value.frozen,
    };
    if (input.actor === undefined) {
      if (Option.isNone(destination)) {
        return yield* new SpaceNotFoundError({ spaceId: input.spaceId });
      }
      return { from: from.id, to: destination.value.spaceId };
    }
    const principal = yield* currentPrincipal(input.actor);
    if (!allows(principal, "space.view", from)) return yield* hiddenOrMissing();
    // A destination the User may not see answers like one that does not exist; their own
    // Personal space, when it is off, says why.
    const to = yield* requireAllowedInSpace(principal, "space.view", input.spaceId, destination);
    if (to.spaceId === from.id) return { from: from.id, to: from.id };
    yield* requireAllowed(principal, "project.move", { kind: "move", from, to: toResource(to) });
    return { from: from.id, to: to.spaceId };
  });

  const projectMoved = Effect.fn("SpaceDirectory.projectMoved")(function* (move: ProjectMove) {
    const [before, after] = yield* Effect.all([viewersOf([move.from]), viewersOf([move.to])], {
      concurrency: "unbounded",
    });
    const kept = new Set(after);
    yield* markAccessNarrowed(before.filter((userId) => !kept.has(userId)));
    yield* changed;
    yield* Effect.forEach(new Set([...before, ...after]), accessChanged, { discard: true });
  });

  // Projects being moved, so nothing starts in them until every Thread has followed.
  const moving = new Map<string, number>();
  // What machines are doing in each Project now (a git request): a move ends it at once.
  const accessHolds = new Map<string, Set<Deferred.Deferred<void>>>();
  // Moves that went ahead per Project, so an access checked before one is never held after it.
  const moveStarts = new Map<string, number>();
  // Who waits for a machine to hold access to a Project (`projectAccessHeld`).
  const heldWaiters = new Map<string, Array<Deferred.Deferred<void>>>();
  const whileProjectMoves = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => void moving.set(projectId, (moving.get(projectId) ?? 0) + 1)),
      () => effect,
      () =>
        Effect.sync(() => {
          const left = (moving.get(projectId) ?? 1) - 1;
          if (left === 0) moving.delete(projectId);
          else moving.set(projectId, left);
        }),
    );

  const projectMoveEpoch = (projectId: ProjectId) =>
    Effect.sync(() => moveStarts.get(projectId) ?? 0);

  const projectAccessEnds = Effect.fn("SpaceDirectory.projectAccessEnds")(function* (
    projectId: ProjectId,
  ) {
    // In one step with the holds it ends: a hold checked before can no longer register after.
    const ended = yield* Effect.sync(() => {
      moveStarts.set(projectId, (moveStarts.get(projectId) ?? 0) + 1);
      return [...(accessHolds.get(projectId) ?? [])];
    });
    yield* Effect.forEach(ended, (moved) => Deferred.succeed(moved, undefined), { discard: true });
  });

  const holdProjectAccess = Effect.fn("SpaceDirectory.holdProjectAccess")(function* (
    projectId: ProjectId,
    epoch: number,
  ) {
    const moved = yield* Deferred.make<void>();
    // Checked and registered in one synchronous step, so no move can start in between.
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (moving.has(projectId) || (moveStarts.get(projectId) ?? 0) !== epoch) {
          return { held: false, waiters: [] as Array<Deferred.Deferred<void>> };
        }
        const holds = accessHolds.get(projectId) ?? new Set();
        holds.add(moved);
        accessHolds.set(projectId, holds);
        const waiters = heldWaiters.get(projectId) ?? [];
        heldWaiters.delete(projectId);
        return { held: true, waiters };
      }),
      ({ held }) =>
        Effect.sync(() => {
          if (!held) return;
          const holds = accessHolds.get(projectId);
          holds?.delete(moved);
          if (holds?.size === 0) accessHolds.delete(projectId);
        }),
    );
    yield* Effect.forEach(held.waiters, (waiter) => Deferred.succeed(waiter, undefined), {
      discard: true,
    });
    return held.held ? Option.some(Deferred.await(moved)) : Option.none<Effect.Effect<void>>();
  });

  const projectAccessHeld = Effect.fn("SpaceDirectory.projectAccessHeld")(function* (
    projectId: ProjectId,
  ) {
    const waiter = yield* Deferred.make<void>();
    const already = yield* Effect.sync(() => {
      if ((accessHolds.get(projectId)?.size ?? 0) > 0) return true;
      heldWaiters.set(projectId, [...(heldWaiters.get(projectId) ?? []), waiter]);
      return false;
    });
    if (!already) yield* Deferred.await(waiter);
  });

  const spaceState = Effect.fn("SpaceDirectory.spaceState")(function* (item: ItemRef) {
    const row = yield* findItem(item);
    if (Option.isNone(row)) return "missing" as const;
    // No Owner yet: a row from before Spaces is the Installation's, and open.
    if (row.value.itemSpaceId === null) return "open" as const;
    if (row.value.kind === null) return "missing" as const;
    if (row.value.spaceArchived) return "archived" as const;
    return row.value.frozen ? ("frozen" as const) : ("open" as const);
  });

  const spaceOfRow = (row: Option.Option<typeof ItemRow.Type>) => {
    if (Option.isNone(row) || row.value.spaceId === null || row.value.kind === null) {
      return Option.none<AccessPolicy.SpaceResource>();
    }
    return Option.some<AccessPolicy.SpaceResource>({
      id: row.value.spaceId,
      kind: row.value.kind,
      personalOwnerUserId: row.value.personalOwnerUserId,
      archived: row.value.spaceArchived,
      frozen: row.value.frozen,
    });
  };

  const spaceOf = Effect.fn("SpaceDirectory.spaceOf")(function* (item: ItemRef) {
    return spaceOfRow(yield* findItem(item));
  });

  const placementOf = Effect.fn("SpaceDirectory.placementOf")(function* (threadId: ThreadId) {
    const row = yield* findItem({ kind: "thread", id: threadId });
    return Option.map(spaceOfRow(row), (space) => ({
      space,
      projectId: Option.isSome(row) ? (row.value.projectId as ProjectId | null) : null,
    }));
  });

  const spaceById = Effect.fn("SpaceDirectory.spaceById")(function* (spaceId: SpaceId) {
    const row = yield* findSpace(spaceId).pipe(Effect.mapError(storageError));
    return Option.map(row, (found) => ({ resource: toResource(found), name: found.name }));
  });

  const findSpaces = SqlSchema.findAll({
    Request: Schema.Array(SpaceId),
    Result: SpaceRow,
    execute: (spaceIds) =>
      sql`SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces WHERE ${sql.in("space_id", spaceIds)}`,
  });

  const spacesById = Effect.fn("SpaceDirectory.spacesById")(function* (
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    if (spaceIds.length === 0) {
      return new Map<
        SpaceId,
        { readonly resource: AccessPolicy.SpaceResource; readonly name: string }
      >();
    }
    const rows = yield* findSpaces([...new Set(spaceIds)]).pipe(Effect.mapError(storageError));
    return new Map(
      rows.map((row) => [row.spaceId, { resource: toResource(row), name: row.name }] as const),
    );
  });

  const workBlocked = Effect.fn("SpaceDirectory.workBlocked")(function* (threadId: ThreadId) {
    const row = yield* findThreadItem(threadId).pipe(Effect.mapError(storageError));
    if (Option.isNone(row)) return undefined;
    if (row.value.spaceArchived) return "space-archived" as const;
    if (row.value.frozen) return "space-frozen" as const;
    if (row.value.projectId !== null && moving.has(row.value.projectId)) {
      return "project-moving" as const;
    }
    return undefined;
  });

  return SpaceDirectory.of({
    setOrganizationArchived,
    beginOrganizationDeletion,
    removeArchivedOrganization,
    authorizeProjectMove,
    projectMoved,
    whileProjectMoves,
    holdProjectAccess,
    projectMoveEpoch,
    projectAccessEnds,
    projectAccessHeld,
    spaceOf,
    placementOf,
    spaceById,
    spacesById,
    spaceState,
    workBlocked,
    members,
    authorizeMembership,
    setRole,
    removeMembership,
    membershipsChanged,
    nextMembershipChange,
    accessNarrowedThrough,
    principalOf,
    view,
    listUsers,
    setInstallationPermission,
    authorizeUserChange,
    endAccessOf,
    installationUser,
    userStatusChanged: Effect.fn("SpaceDirectory.userStatusChanged")(function* (
      change: UserStatusChange,
    ) {
      yield* PubSub.publish(userStatusChanges, change);
    }),
    subscribeUserStatusChanges: PubSub.subscribe(userStatusChanges).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    subscribeMembershipChanges: PubSub.subscribe(membershipChanges).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    isActive,
    subscribeAccessChanges,
    createOrganization,
    claimCreation,
    authorize,
    authorizer: Effect.fn("SpaceDirectory.authorizer")(function* (userId: UserId) {
      const principal = yield* currentPrincipal(userId);
      const limit = yield* CommandActor.spaceLimit;
      return (action: AccessPolicy.Action, resource: AccessPolicy.Resource) =>
        (limit === undefined || spacesOf(resource).every((spaceId) => spaceId === limit)) &&
        allows(principal, action, resource);
    }),
    authorizeItem,
    actingUser,
    threadOwner,
    addMembership,
    viewableSpaces,
    revision: Ref.get(revision),
    changed,
  });
});

export const layer = Layer.effect(
  AccessChanges.AccessChanges,
  Effect.gen(function* () {
    const spaces = yield* SpaceDirectory;
    return AccessChanges.AccessChanges.of({
      changed: spaces.membershipsChanged,
      widened: spaces.changed,
    });
  }),
).pipe(Layer.provideMerge(Layer.effect(SpaceDirectory, make)), Layer.provide(AuditLog.layer));
