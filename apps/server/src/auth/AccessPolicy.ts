/**
 * Who may do what in which Space. Pure; each rule is one row in AccessPolicy.test.ts. The Owner
 * may do everything but create in archived or frozen Spaces, change another User's Personal space
 * (bar moving, stopping and deleting in a removed User's), share from one, or turn themselves off.
 */
import type { SpaceId, SpaceKind, SpaceRole, UserId } from "@t3tools/contracts";

export interface Principal {
  readonly userId: UserId;
  readonly isOwner: boolean;
  /** The User's Role in each Organization they are a Member of. */
  readonly roles: ReadonlyMap<SpaceId, SpaceRole>;
  /** Disabled or removed: every action is refused, though their Memberships may remain. */
  readonly inactive?: boolean;
}

export interface SpaceResource {
  readonly id: SpaceId;
  readonly kind: SpaceKind;
  readonly personalOwnerUserId: UserId | null;
  readonly archived: boolean;
  /** A removed User's Personal space, handed to the Owner. */
  readonly frozen: boolean;
}

/** Actions that concern the Installation as a whole rather than one Space. */
export const installation = { kind: "installation" } as const;
export type InstallationResource = typeof installation;

/** A Thread or Project, with the Space it is in and the User who created it. */
export interface OwnedResource {
  readonly kind: "thread" | "project";
  readonly space: SpaceResource;
  /** Rows from before Spaces belong to the Owner. */
  readonly ownerUserId: UserId;
  readonly archived: boolean;
}

/** One User's Membership of an Organization, as someone acts on it. */
export interface MembershipResource {
  readonly kind: "membership";
  readonly space: SpaceResource;
  readonly userId: UserId;
  readonly role: SpaceRole;
  /** For `membership.changeRole`: the Role asked for. */
  readonly nextRole?: SpaceRole;
}

/** A User of the Installation, as the Owner disables or removes them. */
export interface UserResource {
  readonly kind: "user";
  readonly userId: UserId;
  readonly isOwner: boolean;
}

/** A Project moving from one Space to another, decided on both. */
export interface MoveResource {
  readonly kind: "move";
  readonly from: SpaceResource;
  readonly to: SpaceResource;
}

/**
 * A machine registered with the Hub: the Hub machine, one joined with `t3 join`, or a Space's
 * Sandbox.
 */
export interface EnvironmentResource {
  readonly kind: "environment";
  readonly environmentKind: "hub" | "external" | "sandbox";
  /** An external machine's: `dedicated` to `space`, or (the default) `personal` to its owner. */
  /** `lent`: a Sandbox on a machine lent to `space` (Grants), decided as a Sandbox. */
  readonly mode?: "personal" | "dedicated" | "sandbox" | "lent";
  /**
   * Null for the Hub machine and dedicated machines, which belong to the Installation, and for
   * Sandboxes.
   */
  readonly ownerUserId: UserId | null;
  /** A Sandbox's or dedicated machine's Space. */
  readonly space?: SpaceResource;
  /** For `environment.use`: the Space of the Thread that would run there. */
  readonly workSpaceId?: SpaceId;
}

/**
 * An external machine changing its mode or Organization (owned-resources 07): to an Organization
 * (`to`), or back to personal (`to` null), its actor's own. Decided on where it is and where it goes.
 */
export interface EnvironmentMoveResource {
  readonly kind: "environment-move";
  readonly environment: EnvironmentResource;
  readonly to: SpaceResource | null;
}

/**
 * An AI account (owned-resources 08, 09): a User's, used in their Personal space, or an
 * Organization's (`space` null once the Organization is gone). Creating one is decided on a
 * resource naming the owner it would have.
 */
export interface AiAccountResource {
  readonly kind: "ai-account";
  readonly owner:
    | { readonly kind: "user"; readonly userId: UserId }
    | { readonly kind: "organization"; readonly space: SpaceResource | null };
}

/**
 * A group of a Vault (owned-resources 03): each owner, a User or an Organization, has one Vault of
 * groups, its `default` and named ones. An Organization's `space` is null once it is gone.
 */
export interface VaultResource {
  readonly kind: "vault";
  readonly owner:
    | { readonly kind: "user"; readonly userId: UserId; readonly isInstallationOwner: boolean }
    | { readonly kind: "organization"; readonly space: SpaceResource | null };
  /** The owner's `default`: never deleted, renamed or archived (`vault.manage`). */
  readonly isDefault: boolean;
  /**
   * Grants ticket 07: the Spaces an active Grant lends it to (a group reaches its owner's Space
   * without one). Read-only there: names, and Variables for whoever may read them.
   */
  readonly lentTo: ReadonlyArray<SpaceResource>;
}

/**
 * Who lends a resource: its owner, a User or an Organization (`space` null once it is gone).
 * Null when nobody may lend it.
 */
export type GrantLender =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "organization"; readonly space: SpaceResource | null }
  | null;

/**
 * A Grant (a loan of a resource to a Space), as its lender or its destination acts on it. The
 * lender is the resource's owner: a User (their personal machine, their AI account) or an
 * Organization (its AI account), whose Admins act for it.
 */
export interface GrantResource {
  readonly kind: "grant";
  readonly lender: GrantLender;
  readonly target: SpaceResource;
  /**
   * For `grant.give`: whether the lender may name this destination (a Space they work in, the
   * Personal space of someone they share a Space with, any Personal space for the Owner), so no
   * one learns of Spaces they do not see.
   */
  readonly targetKnown?: boolean;
}

export type Resource =
  | GrantResource
  | VaultResource
  | SpaceResource
  | InstallationResource
  | OwnedResource
  | MembershipResource
  | UserResource
  | MoveResource
  | EnvironmentResource
  | EnvironmentMoveResource
  | AiAccountResource;

export type Action =
  | "space.view"
  | "thread.create"
  | "project.create"
  | "organization.create"
  /** List the Installation's Users (the Owner's Users admin view). */
  | "installationPermission.manage"
  /** Disable a User or turn them back on: their sessions end, their Memberships stay. */
  | "user.disable"
  /** Remove a User for good: their Memberships end and their Personal space freezes. */
  | "user.remove"
  /** Create an Invitation into an Organization as a Member or Guest. */
  | "invitation.create"
  /** List and revoke an Organization's Invitations. */
  | "invitation.manage"
  /** Invite as an Admin or revoke such an Invitation; checked beside the Invitation action. */
  | "admin.manage"
  /** Give a Member another Role. */
  | "membership.changeRole"
  /** Remove someone from the Organization. */
  | "membership.remove"
  /** Leave the Organization oneself. */
  | "membership.leave"
  /** Issue a one-time link that resets the Member's sign-in. It takes the account over: Owner only. */
  | "membership.resetLink"
  /** Create or close a guest link (read one Thread for 24h). */
  | "guestLink.create"
  /** Anything that speaks in or changes a Thread: messages, turns, settings, metadata. */
  | "thread.continue"
  /** Archive or restore a Thread. */
  | "thread.archive"
  /**
   * Pin, settle, snooze or tag a Thread. That state is stored on the Thread and shared by every
   * viewer, so it is its creator's or an Admin's, as archiving is.
   */
  | "thread.organize"
  /** Stop a running Thread. */
  | "thread.stop"
  /** Permanently delete an archived Thread. */
  | "thread.delete"
  /** Archive or restore a Project. */
  | "project.archive"
  /** Change a Project's settings. */
  | "project.manage"
  /** Permanently delete an archived Project. */
  | "project.delete"
  /** Move a Project, with its Threads, to another Space (`MoveResource`). */
  | "project.move"
  /** Hide an Organization from its Members and stop everything in it. */
  | "organization.archive"
  /** Bring an archived Organization back. */
  | "organization.restore"
  /** Permanently delete an archived Organization with everything in it. */
  | "organization.delete"
  /** Approve one's own machine joining the Hub as a personal one (`t3 join`): every active User. */
  | "environment.register"
  /**
   * Dedicate a machine to an Organization, which becomes its owner (owned-resources 07): the Owner
   * or its Admins, decided on that Organization.
   */
  | "environment.dedicate"
  /**
   * Change an external machine's mode or Organization (`EnvironmentMoveResource`): power where it
   * is (its owner; a dedicated one's Admins or the Owner) and where it goes (`environment.dedicate`).
   */
  | "environment.move"
  /** See an Environment in Settings and where Threads may run. */
  | "environment.view"
  /** Run a Thread on the Environment. */
  | "environment.use"
  | "environment.rename"
  /** Remove a machine: its credential stops working at once. */
  | "environment.remove"
  /** See a Sandbox's resource use and limits: the Owner, an Admin of its Space. */
  | "sandbox.inspect"
  /** Start, stop or restart a Sandbox by hand and change its limits: the Owner. */
  | "sandbox.manage"
  /**
   * See the master key's status and download its backup: the Owner alone, decided on the
   * Installation. Whoever holds it reads every secret from a copy of the Hub's disk.
   */
  | "masterKey.backup"
  // Vaults (`VaultResource`; see `decideVault`).
  /** See a Vault and its secrets' names and descriptions, never values. */
  | "vault.view"
  /** Read its Variables' values: whoever sees it, Guests excepted (decision 4). */
  | "vault.readVariables"
  /**
   * Add or change a Provider entry: whoever edits the Vault; an Admin only through a Provider
   * scope allowed to it (Vaults decides), the Owner also «Direct».
   */
  | "vault.providerEntry"
  /**
   * Add, change or delete a workload identity entry (Vaults ticket 07, question 7): a token the
   * Hub signs for any audience is the Owner's to hand out, in any Vault.
   */
  | "vault.identityEntry"
  /** Secret providers' scopes and «Test connection», decided on the Installation: the Owner. */
  | "secretProvider.manage"
  /**
   * Read and change the sign-in settings and «Check» the Keycloak realm (Keycloak sign-in spec,
   * ticket 01), decided on the Installation: the Owner alone. They decide who gets in at all.
   */
  | "signInSettings.manage"
  /** Add, replace, rename and delete a Vault's secrets without reading them. */
  | "vault.edit"
  /**
   * Create, rename, describe, archive and delete a group, and allow it (the Owner's own): its
   * owner's managers (owned-resources 03); never on a `default` group.
   */
  | "vault.manage"
  /**
   * Set a name that changes how tools run (`secretNameRisk`), confirmed: the Owner, and a User in
   * their own Vault (owned-resources 04).
   */
  | "vault.dangerousName"
  /**
   * Choose a Space's default groups and its Projects' adds and removes, decided on the Space: a
   * Personal space's User; an Organization's Admins and the Owner (owned-resources 04).
   */
  | "vault.choose"
  /**
   * On an `AiAccountResource`: create, rename, disable, replace, order and delete it: a User's
   * own, nobody else (the Owner included); an Organization's, its Admins and the Owner. On the
   * Installation: run its AI gateway (everyone's usage, imports, subscription limits): the Owner.
   */
  | "aiAccount.manage"
  /** See an AI account's name, provider, owner and status: whoever manages it, and the Owner. */
  | "aiAccount.view"
  /**
   * Use the AI accounts allowed to a Space or to oneself in that Space (AllowedAiAccounts): whoever
   * may start a Thread there, Guests included; decided on the Space.
   */
  | "aiAccount.use"
  /**
   * Read the AI usage of everyone who works in a Space (spec 4 ticket 05, decided on the Space):
   * the Owner anywhere, an Organization's Admins in theirs, archived or not (it is history). A
   * User's own usage needs no action: it is theirs.
   */
  | "aiUsage.viewSpace"
  // Grants (`GrantResource`; see `decideGrant`).
  /** Lend one's resource to a Space; decided on the resource's owner and the destination. */
  | "grant.give"
  /**
   * Offer one's resource by a lending link (Grants ticket 06): decided on its owner only; whoever
   * applies the link decides on their own Space (`grant.decide`).
   */
  | "grant.offer"
  /** Take back a waiting Grant (or an unused link) before it is decided. */
  | "grant.cancel"
  /** Take back an active Grant. */
  | "grant.revoke"
  | "grant.setLimits"
  /** See a Grant one gave, with its state and the borrower's use (never its Threads). */
  | "grant.viewGiven"
  /** Accept or reject a Grant to a Space: its Admins, a Personal space's User. */
  | "grant.decide"
  /** Give back an active Grant to a Space: whoever decides there. */
  | "grant.return"
  /** See an active Grant one's Space received: whoever works there (not its Guests). */
  | "grant.viewReceived";

/** Actions that read or manage rather than add something to the Space. */
const NON_CREATING: ReadonlySet<Action> = new Set([
  "space.view",
  "installationPermission.manage",
  "invitation.manage",
  // Checked beside `invitation.create`, which refuses archived Organizations.
  "admin.manage",
]);

const OWNER_ONLY: ReadonlySet<Action> = new Set(["admin.manage", "installationPermission.manage"]);

/** Actions on one registered Environment, decided against an `EnvironmentResource`. */
const ENVIRONMENT_ACTIONS: ReadonlySet<Action> = new Set([
  "environment.view",
  "environment.use",
  "environment.rename",
  "environment.remove",
  "sandbox.inspect",
  "sandbox.manage",
]);

const USER_ACTIONS: ReadonlySet<Action> = new Set(["user.disable", "user.remove"]);
/** The Owner's, on an Organization in any state; it is deleted only once archived. */
const ORGANIZATION_LIFECYCLE: ReadonlySet<Action> = new Set([
  "organization.archive",
  "organization.restore",
  "organization.delete",
]);

const MEMBERSHIP_ACTIONS: ReadonlySet<Action> = new Set([
  "membership.changeRole",
  "membership.remove",
  "membership.leave",
  "membership.resetLink",
]);

/** Actions on one Thread or Project, decided against an `OwnedResource`. */
const OWNED_ACTIONS: ReadonlySet<Action> = new Set([
  "thread.continue",
  "thread.archive",
  "thread.organize",
  "thread.stop",
  "thread.delete",
  "project.archive",
  "project.manage",
  "project.delete",
]);

/** Whether `action` is decided on a Thread or Project rather than on its Space. */
export const isItemAction = (action: Action) => OWNED_ACTIONS.has(action);

export type DenyReason =
  | "owner-only"
  | "not-a-member"
  | "role-not-allowed"
  | "not-your-personal-space"
  /** The Owner reads another User's Personal space and changes nothing in it. */
  | "personal-space-read-only"
  /** An owner's `default` Vault group is never deleted, renamed or archived. */
  | "default-group"
  | "space-archived"
  | "space-frozen"
  /** The User was disabled or removed. */
  | "user-inactive"
  /** Nobody disables or removes the Owner. */
  | "owner-protected"
  /** Someone else's Thread or Project. */
  | "not-yours"
  /** Only archived items are deleted permanently. */
  | "not-archived"
  /** The Hub machine runs the Hub itself, so it is never removed. */
  | "hub-machine"
  /** A Space's Sandbox is the Hub's to run: never renamed or removed as a machine. */
  | "sandbox"
  /** A Sandbox runs only the Threads of its own Space. */
  | "other-space"
  | "wrong-resource";

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: DenyReason };

export const allow: Decision = { _tag: "Allow" };
export const deny = (reason: DenyReason): Decision => ({ _tag: "Deny", reason });

const isSpace = (resource: Resource): resource is SpaceResource =>
  resource.kind === "organization" || resource.kind === "personal";
const isOwned = (resource: Resource): resource is OwnedResource =>
  resource.kind === "thread" || resource.kind === "project";
const isMembership = (resource: Resource): resource is MembershipResource =>
  resource.kind === "membership";
const isUser = (resource: Resource): resource is UserResource => resource.kind === "user";
const isMove = (resource: Resource): resource is MoveResource => resource.kind === "move";
const isEnvironment = (resource: Resource): resource is EnvironmentResource =>
  resource.kind === "environment";

/**
 * A Sandbox, and a machine dedicated to a Space, is for the Users who work in its Space (not its
 * Guests), and only for that Space's Threads. Everyone who sees the Space sees it; the Owner sees
 * every one. The Owner and the Organization's Admins rename and remove a dedicated machine (a
 * Sandbox is the Hub's own).
 */
const decideSpaceBound = (
  principal: Principal,
  action: Action,
  environment: EnvironmentResource,
): Decision => {
  const space = environment.space;
  if (space === undefined) {
    // A dedicated machine outlives a deleted Space as the Installation's: the Owner still sees,
    // renames and removes it, and nothing runs there.
    return environment.environmentKind === "external" &&
      principal.isOwner &&
      action !== "environment.use"
      ? allow
      : deny("wrong-resource");
  }
  if (action === "environment.view") {
    return principal.isOwner ? allow : decide(principal, "space.view", space);
  }
  // Its use and limits are its Space's Admins' to see (a Personal space's User's); the Owner's
  // to change. Only a Sandbox has them.
  if (action === "sandbox.inspect" || action === "sandbox.manage") {
    if (environment.environmentKind !== "sandbox") return deny("wrong-resource");
    if (principal.isOwner) return allow;
    if (action === "sandbox.manage") return deny("owner-only");
    return space.kind === "personal"
      ? inPersonalSpace(principal, space)
      : inOrganization(principal, space, ADMIN_ONLY);
  }
  if (action !== "environment.use") {
    if (environment.environmentKind === "sandbox") {
      return principal.isOwner ? deny("sandbox") : deny("owner-only");
    }
    // A dedicated machine is its Organization's: the Owner, and its Admins while it is open.
    return runsDedicatedMachine(principal, space);
  }
  if (environment.workSpaceId !== space.id) return deny("other-space");
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  if (principal.isOwner) {
    return othersPersonalSpace(principal, space) ? deny("personal-space-read-only") : allow;
  }
  return space.kind === "personal"
    ? inPersonalSpace(principal, space)
    : inOrganization(principal, space, ROLES_THAT_CREATE_PROJECTS);
};

/** Renaming, removing or moving a machine dedicated to `space`: the Owner, or its open Admins. */
const runsDedicatedMachine = (principal: Principal, space: SpaceResource): Decision => {
  if (principal.isOwner) return allow;
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  return inOrganization(principal, space, ADMIN_ONLY);
};

/** Dedicating a machine to `space`: an open Organization's Admins, or the Owner. */
const decideDedicate = (principal: Principal, space: SpaceResource): Decision => {
  if (space.kind !== "organization") return deny("wrong-resource");
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  return principal.isOwner ? allow : inOrganization(principal, space, ADMIN_ONLY);
};

/**
 * Changing an external machine's mode or Organization, as moving a Project does: power over where
 * it is and where it goes. A personal machine is its owner's alone, the Owner's included only for
 * their own; one dedicated to an Organization is the Owner's and its Admins' (the Owner's alone
 * once its Organization is gone). Turned personal, it becomes its actor's.
 */
const decideEnvironmentMove = (
  principal: Principal,
  { environment, to }: EnvironmentMoveResource,
): Decision => {
  if (environment.environmentKind !== "external") return deny("wrong-resource");
  if (environment.mode === "dedicated") {
    const from = environment.space;
    if (from === undefined) {
      if (!principal.isOwner) return deny("owner-only");
    } else {
      const origin = runsDedicatedMachine(principal, from);
      if (origin._tag === "Deny") return origin;
    }
  } else if (environment.mode === undefined || environment.mode === "personal") {
    if (environment.ownerUserId !== principal.userId) return deny("not-yours");
  } else {
    return deny("wrong-resource");
  }
  return to === null ? allow : decideDedicate(principal, to);
};

/**
 * Everyone uses the Hub machine. A personal machine is its owner's: nobody else sees it but the
 * Owner, who sees, renames and removes every one, and never removes the Hub machine. Its owner
 * renames and removes it too.
 */
const decideEnvironment = (
  principal: Principal,
  action: Action,
  environment: EnvironmentResource,
): Decision => {
  if (environment.environmentKind === "sandbox" || environment.mode === "dedicated") {
    return decideSpaceBound(principal, action, environment);
  }
  if (action === "sandbox.inspect" || action === "sandbox.manage") return deny("wrong-resource");
  const own = environment.ownerUserId === principal.userId;
  // A personal machine runs only its owner's work: the Owner sees every one, uses only their own.
  if (action === "environment.use") {
    return environment.environmentKind === "hub" || own ? allow : deny("not-yours");
  }
  if (action === "environment.view") {
    return environment.environmentKind === "hub" || own || principal.isOwner
      ? allow
      : deny("not-yours");
  }
  if (principal.isOwner) {
    return environment.environmentKind === "hub" && action === "environment.remove"
      ? deny("hub-machine")
      : allow;
  }
  // A User renames and removes their own personal machine.
  return environment.environmentKind === "external" && own ? allow : deny("owner-only");
};

const ROLES_THAT_CREATE_PROJECTS: ReadonlySet<SpaceRole> = new Set(["admin", "member"]);
const ADMIN_ONLY: ReadonlySet<SpaceRole> = new Set(["admin"]);

// Every User always has their Personal space; nobody else but the Owner (read-only) reaches it.
const inPersonalSpace = (principal: Principal, space: SpaceResource) =>
  space.personalOwnerUserId === principal.userId ? allow : deny("not-your-personal-space");

const inOrganization = (
  principal: Principal,
  space: SpaceResource,
  allowedRoles?: ReadonlySet<SpaceRole>,
) => {
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  if (allowedRoles !== undefined && !allowedRoles.has(role)) return deny("role-not-allowed");
  return allow;
};

/**
 * Rules on one Thread or Project. Only its creator continues a Thread, not even an Admin or the
 * Owner; each archives and stops their own; Admins also archive and stop others' and delete what
 * is archived. A Personal space's User runs their own space as an Admin runs an Organization.
 */
const othersPersonalSpace = (principal: Principal, space: SpaceResource) =>
  space.kind === "personal" && space.personalOwnerUserId !== principal.userId;

const decideOwned = (principal: Principal, action: Action, item: OwnedResource): Decision => {
  const { space } = item;
  const deletes = action === "thread.delete" || action === "project.delete";
  if (principal.isOwner && othersPersonalSpace(principal, space)) {
    // A removed User's work is the Owner's to stop, keep or delete, archived or not.
    return space.frozen && (deletes || action === "thread.stop")
      ? allow
      : deny("personal-space-read-only");
  }
  if (action === "thread.continue") {
    if (space.archived) return deny("space-archived");
    if (space.frozen) return deny("space-frozen");
    // Nobody speaks in someone else's Thread: a new Thread in the same Project builds on it.
    if (principal.isOwner) return item.ownerUserId === principal.userId ? allow : deny("not-yours");
  }
  if (principal.isOwner) return allow;
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  if (space.kind === "personal") {
    const reach = inPersonalSpace(principal, space);
    if (reach._tag === "Deny") return reach;
    if (action === "thread.continue" && item.ownerUserId !== principal.userId) {
      return deny("not-yours");
    }
    return deletes && !item.archived ? deny("not-archived") : allow;
  }
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  const own = item.ownerUserId === principal.userId;
  switch (action) {
    case "thread.continue":
      return own ? allow : deny("not-yours");
    case "thread.archive":
    case "thread.organize":
    case "thread.stop":
      return own || role === "admin" ? allow : deny("not-yours");
    case "project.archive":
    case "project.manage":
      if (role === "admin") return allow;
      if (!own) return deny("not-yours");
      return ROLES_THAT_CREATE_PROJECTS.has(role) ? allow : deny("role-not-allowed");
    case "thread.delete":
    case "project.delete":
      if (role !== "admin") return deny("role-not-allowed");
      return item.archived ? allow : deny("not-archived");
    default:
      return deny("wrong-resource");
  }
};

/**
 * Rules on someone's Membership. Anyone leaves; Admins change and remove Members and Guests, but
 * never touch an Admin or make one, and issue no reset links: only the Owner does.
 */
const decideMembership = (
  principal: Principal,
  action: Action,
  target: MembershipResource,
): Decision => {
  const { space } = target;
  if (space.kind !== "organization") return deny("wrong-resource");
  if (action === "membership.leave") {
    if (target.userId !== principal.userId) return deny("not-yours");
    return principal.roles.has(space.id) ? allow : deny("not-a-member");
  }
  if (principal.isOwner) return allow;
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  if (role !== "admin") return deny("role-not-allowed");
  if (space.archived) return deny("space-archived");
  if (action === "membership.resetLink") return deny("owner-only");
  if (target.role === "admin" || target.nextRole === "admin") return deny("owner-only");
  return allow;
};

/**
 * Moving a Project takes running both Spaces (Admin of an Organization, User of a Personal space).
 * The Owner moves anything but into or out of another User's Personal space (out of a frozen one
 * is allowed). Nothing enters an archived or frozen Space; only the Owner leaves an archived one.
 */
const runsSpace = (principal: Principal, space: SpaceResource) =>
  space.kind === "personal"
    ? inPersonalSpace(principal, space)
    : inOrganization(principal, space, ADMIN_ONLY);

/** The origin half of `project.move`: whether a Project may leave `from`. */
export const mayMoveOut = (principal: Principal, from: SpaceResource): Decision => {
  if (principal.isOwner) {
    return othersPersonalSpace(principal, from) && !from.frozen
      ? deny("personal-space-read-only")
      : allow;
  }
  if (from.archived) return deny("space-archived");
  if (from.frozen) return deny("space-frozen");
  return runsSpace(principal, from);
};

/** The destination half of `project.move`: whether a Project may arrive in `to`. */
export const mayMoveIn = (principal: Principal, to: SpaceResource): Decision => {
  if (to.archived) return deny("space-archived");
  if (to.frozen) return deny("space-frozen");
  if (principal.isOwner) {
    return othersPersonalSpace(principal, to) ? deny("personal-space-read-only") : allow;
  }
  return runsSpace(principal, to);
};

const decideMove = (principal: Principal, { from, to }: MoveResource): Decision => {
  if (from.id === to.id) return deny("wrong-resource");
  const destination = mayMoveIn(principal, to);
  if (destination._tag === "Deny") return destination;
  return mayMoveOut(principal, from);
};

const VAULT_ACTIONS: ReadonlySet<Action> = new Set([
  "vault.view",
  "vault.readVariables",
  "vault.providerEntry",
  "vault.identityEntry",
  "vault.edit",
  "vault.manage",
  "vault.dangerousName",
]);

/**
 * Vault groups (owned-resources 03): nobody manages a `default`; the Owner does the rest, never
 * reading a Secret. The Owner's `default` is theirs alone; an Organization's groups its Admins'
 * to manage and edit; Members see names and Variables, Guests names. Identity: the Owner's. A
 * group lent to a Space (Grants ticket 07) is read there, never written (`decideLentVault`).
 */
const decideVault = (principal: Principal, action: Action, vault: VaultResource): Decision => {
  const own = decideOwnVault(principal, action, vault);
  if (own._tag === "Allow") return own;
  return decideLentVault(principal, action, vault) ?? own;
};

/** What a group's owner side allows: its owner, its Organization's people, the Owner. */
const decideOwnVault = (principal: Principal, action: Action, vault: VaultResource): Decision => {
  if (action === "vault.manage" && vault.isDefault) return deny("default-group");
  // Owned-resources 04: a User's own Vault is theirs alone (Provider and identity entries stay the
  // Owner's); the Owner reads its names and Variables; nobody else sees it.
  if (vault.owner.kind === "user" && !vault.owner.isInstallationOwner) {
    if (vault.owner.userId === principal.userId) {
      return action === "vault.providerEntry" || action === "vault.identityEntry"
        ? deny("owner-only")
        : allow;
    }
    if (principal.isOwner) {
      return action === "vault.view" || action === "vault.readVariables"
        ? allow
        : deny("personal-space-read-only");
    }
    return deny("not-yours");
  }
  if (principal.isOwner) return allow;
  if (action === "vault.identityEntry" || action === "vault.dangerousName") {
    return deny("owner-only");
  }
  const { owner } = vault;
  // The Owner's groups are the Owner's alone (lent ones are read where they are lent).
  if (owner.kind === "user") return deny("owner-only");
  const space = owner.space;
  if (space === null) return deny("owner-only");
  if (space.kind !== "organization") return deny("wrong-resource");
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  return inOrganization(
    principal,
    space,
    action === "vault.edit" || action === "vault.providerEntry" || action === "vault.manage"
      ? ADMIN_ONLY
      : action === "vault.readVariables"
        ? ROLES_THAT_CREATE_PROJECTS
        : undefined,
  );
};

/**
 * Grants ticket 07: a named group lent to Spaces by active Grants. Whoever works in an open one
 * sees its names; its Admins and Members (a Personal space's User) read its Variables, Guests do
 * not. Nobody there edits, manages or writes a dangerous name into it: undefined, so the owner
 * side's refusal stands.
 */
const decideLentVault = (
  principal: Principal,
  action: Action,
  vault: VaultResource,
): Decision | undefined => {
  if (vault.isDefault || (action !== "vault.view" && action !== "vault.readVariables")) {
    return undefined;
  }
  const works = (space: SpaceResource) =>
    !space.archived &&
    !space.frozen &&
    (space.kind === "personal"
      ? inPersonalSpace(principal, space)._tag === "Allow"
      : inOrganization(
          principal,
          space,
          action === "vault.readVariables" ? ROLES_THAT_CREATE_PROJECTS : undefined,
        )._tag === "Allow");
  return vault.lentTo.some(works) ? allow : undefined;
};

/**
 * Which groups a Space and its Projects receive: a Personal space's User there (the Owner only
 * reads someone else's, owned-resources 04); an Organization's Admins and the Owner while it is open.
 */
const decideVaultChoice = (principal: Principal, space: SpaceResource): Decision => {
  // Owned-resources 04: a Personal space's groups are its User's to choose; the Owner reads.
  if (space.kind === "personal") {
    if (space.frozen) return deny("space-frozen");
    if (space.personalOwnerUserId === principal.userId) return allow;
    return principal.isOwner ? deny("personal-space-read-only") : deny("not-your-personal-space");
  }
  if (principal.isOwner) return allow;
  if (space.kind !== "organization") return deny("owner-only");
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
  return inOrganization(principal, space, ADMIN_ONLY);
};

const AI_ACCOUNT_ACTIONS: ReadonlySet<Action> = new Set(["aiAccount.manage", "aiAccount.view"]);

/**
 * AI accounts by their owner (owned-resources 08). A User's are theirs alone to manage; the Owner
 * sees them (name, provider, owner, status) and changes nothing. An Organization's are its
 * Admins' and the Owner's, while it is open. Allowances are the Owner's, on the Owner's own
 * accounts only: anything else is lent with a Grant.
 */
const decideAiAccount = (
  principal: Principal,
  action: Action,
  { owner }: AiAccountResource,
): Decision => {
  const manages = (): Decision => {
    if (owner.kind === "user") {
      return owner.userId === principal.userId ? allow : deny("not-yours");
    }
    const space = owner.space;
    if (space === null || space.kind !== "organization") return deny("wrong-resource");
    if (space.archived) return deny("space-archived");
    if (space.frozen) return deny("space-frozen");
    // Owned-resources 09: an Organization's are its Admins' (and the Owner's) to manage.
    return principal.isOwner ? allow : inOrganization(principal, space, ADMIN_ONLY);
  };
  const managed = manages();
  if (action === "aiAccount.view") {
    return managed._tag === "Allow" || principal.isOwner ? allow : managed;
  }
  return managed;
};

const GRANT_ACTIONS: ReadonlySet<Action> = new Set([
  "grant.give",
  "grant.offer",
  "grant.cancel",
  "grant.revoke",
  "grant.setLimits",
  "grant.viewGiven",
  "grant.decide",
  "grant.return",
  "grant.viewReceived",
]);

/**
 * The lender's side of a Grant: only the resource's owner, the Owner included (no bypass): the
 * User, or an Organization's Admins. A gone Organization lends nothing; an archived or frozen one
 * gives nothing new, yet its Admins still take back or cancel what it lent.
 */
const decideLender = (principal: Principal, action: Action, grant: GrantResource): Decision => {
  const { lender, target } = grant;
  if (lender === null) return deny("not-yours");
  if (lender.kind === "user") {
    if (lender.userId !== principal.userId) return deny("not-yours");
    if (action !== "grant.give") return allow;
    // What a User owns already serves them in their own Personal space.
    if (target.kind === "personal" && target.personalOwnerUserId === principal.userId) {
      return deny("wrong-resource");
    }
  } else {
    const space = lender.space;
    if (space === null || space.kind !== "organization") return deny("not-yours");
    const runs = inOrganization(principal, space, ADMIN_ONLY);
    if (runs._tag === "Deny") return runs.reason === "not-a-member" ? deny("not-yours") : runs;
    if (action !== "grant.give" && action !== "grant.offer") return allow;
    if (space.archived) return deny("space-archived");
    if (space.frozen) return deny("space-frozen");
    // A link names no destination: whoever applies it decides on theirs.
    if (action === "grant.offer") return allow;
    // An Organization's own resources already serve it.
    if (target.id === space.id) return deny("wrong-resource");
  }
  if (target.archived) return deny("space-archived");
  if (target.frozen) return deny("space-frozen");
  return grant.targetKnown === true ? allow : deny("not-a-member");
};

/** The lender's side of a Grant (`decideLender`). */
const LENDER_ACTIONS: ReadonlySet<Action> = new Set([
  "grant.give",
  "grant.offer",
  "grant.cancel",
  "grant.revoke",
  "grant.setLimits",
  "grant.viewGiven",
]);

/**
 * Grants. The lender acts on what they lend and nothing else: the Owner lends only their own
 * resources and decides only where they would decide anyway. A Grant to an Organization is decided
 * and returned by its Admins; to a Personal space, by its User. Nothing new enters an archived or
 * frozen Space, but it can always be given back.
 */
const decideGrant = (principal: Principal, action: Action, grant: GrantResource): Decision => {
  const { target } = grant;
  if (LENDER_ACTIONS.has(action)) return decideLender(principal, action, grant);
  if (action === "grant.decide") {
    if (target.archived) return deny("space-archived");
    if (target.frozen) return deny("space-frozen");
  }
  // The Owner holds no Installation permissions of their own, yet runs their Personal space.
  if (
    principal.isOwner &&
    target.kind === "personal" &&
    target.personalOwnerUserId === principal.userId
  ) {
    return allow;
  }
  if (action === "grant.viewReceived") {
    return target.kind === "personal"
      ? inPersonalSpace(principal, target)
      : inOrganization(principal, target, ROLES_THAT_CREATE_PROJECTS);
  }
  return runsSpace(principal, target);
};

export function decide(principal: Principal, action: Action, resource: Resource): Decision {
  if (principal.inactive === true) return deny("user-inactive");
  if (GRANT_ACTIONS.has(action) || resource.kind === "grant") {
    return GRANT_ACTIONS.has(action) && resource.kind === "grant"
      ? decideGrant(principal, action, resource)
      : deny("wrong-resource");
  }
  if (VAULT_ACTIONS.has(action) || resource.kind === "vault") {
    return VAULT_ACTIONS.has(action) && resource.kind === "vault"
      ? decideVault(principal, action, resource)
      : deny("wrong-resource");
  }
  if (action === "vault.choose") {
    return isSpace(resource) ? decideVaultChoice(principal, resource) : deny("wrong-resource");
  }
  if (USER_ACTIONS.has(action) || isUser(resource)) {
    if (!USER_ACTIONS.has(action) || !isUser(resource)) return deny("wrong-resource");
    if (!principal.isOwner) return deny("owner-only");
    return resource.isOwner ? deny("owner-protected") : allow;
  }
  if (ENVIRONMENT_ACTIONS.has(action) || isEnvironment(resource)) {
    return ENVIRONMENT_ACTIONS.has(action) && isEnvironment(resource)
      ? decideEnvironment(principal, action, resource)
      : deny("wrong-resource");
  }
  // Owned-resources 06: every active User joins their own machines (the limit comes with plans).
  if (action === "environment.register") {
    return resource.kind === "installation" ? allow : deny("wrong-resource");
  }
  if (resource.kind === "ai-account") {
    return AI_ACCOUNT_ACTIONS.has(action)
      ? decideAiAccount(principal, action, resource)
      : deny("wrong-resource");
  }
  if (action === "aiAccount.view") return deny("wrong-resource");
  if (action === "aiAccount.manage") {
    if (resource.kind !== "installation") return deny("wrong-resource");
    return principal.isOwner ? allow : deny("owner-only");
  }
  // Ticket 18: any active User creates Organizations (and becomes their Admin); no cap yet.
  if (action === "organization.create") {
    return resource.kind === "installation" ? allow : deny("wrong-resource");
  }
  // Working in the Space: the same rule as starting a Thread there (archived, frozen, another
  // User's Personal space and an Organization one is not a Member of are refused).
  if (action === "aiAccount.use") {
    return isSpace(resource)
      ? decide(principal, "thread.create", resource)
      : deny("wrong-resource");
  }
  if (action === "aiUsage.viewSpace") {
    if (!isSpace(resource)) return deny("wrong-resource");
    if (principal.isOwner) return allow;
    return resource.kind === "organization"
      ? inOrganization(principal, resource, ADMIN_ONLY)
      : deny("owner-only");
  }
  if (action === "environment.dedicate") {
    return isSpace(resource) ? decideDedicate(principal, resource) : deny("wrong-resource");
  }
  if (action === "environment.move" || resource.kind === "environment-move") {
    return action === "environment.move" && resource.kind === "environment-move"
      ? decideEnvironmentMove(principal, resource)
      : deny("wrong-resource");
  }
  if (
    action === "masterKey.backup" ||
    action === "secretProvider.manage" ||
    action === "signInSettings.manage"
  ) {
    if (resource.kind !== "installation") return deny("wrong-resource");
    return principal.isOwner ? allow : deny("owner-only");
  }
  if (action === "project.move" || isMove(resource)) {
    return action === "project.move" && isMove(resource)
      ? decideMove(principal, resource)
      : deny("wrong-resource");
  }
  if (ORGANIZATION_LIFECYCLE.has(action)) {
    if (!isSpace(resource) || resource.kind !== "organization") return deny("wrong-resource");
    if (!principal.isOwner) return deny("owner-only");
    return action === "organization.delete" && !resource.archived ? deny("not-archived") : allow;
  }
  if (MEMBERSHIP_ACTIONS.has(action) || isMembership(resource)) {
    return MEMBERSHIP_ACTIONS.has(action) && isMembership(resource)
      ? decideMembership(principal, action, resource)
      : deny("wrong-resource");
  }
  if (OWNED_ACTIONS.has(action) || isOwned(resource)) {
    return OWNED_ACTIONS.has(action) && isOwned(resource)
      ? decideOwned(principal, action, resource)
      : deny("wrong-resource");
  }
  // Nothing is shared from a Personal space directly, so nobody is invited into one and no
  // guest link is made from one.
  if (
    (action === "invitation.create" ||
      action === "invitation.manage" ||
      action === "admin.manage" ||
      action === "guestLink.create") &&
    (!isSpace(resource) || resource.kind !== "organization")
  ) {
    return deny("wrong-resource");
  }
  const creates = !NON_CREATING.has(action);
  if (creates && isSpace(resource)) {
    if (resource.archived) return deny("space-archived");
    if (resource.frozen) return deny("space-frozen");
  }
  if (principal.isOwner) {
    // The Owner reads every Personal space but adds nothing to another User's.
    return creates && isSpace(resource) && othersPersonalSpace(principal, resource)
      ? deny("personal-space-read-only")
      : allow;
  }
  if (OWNER_ONLY.has(action)) return deny("owner-only");
  if (!isSpace(resource)) return deny("wrong-resource");
  if (resource.archived) return deny("space-archived");
  if (resource.kind === "personal") return inPersonalSpace(principal, resource);
  switch (action) {
    case "space.view":
    case "thread.create":
      return inOrganization(principal, resource);
    case "project.create":
      return inOrganization(principal, resource, ROLES_THAT_CREATE_PROJECTS);
    case "guestLink.create":
    case "invitation.create":
    case "invitation.manage":
      return inOrganization(principal, resource, ADMIN_ONLY);
    default:
      return deny("owner-only");
  }
}

export const isAllowed = (decision: Decision) => decision._tag === "Allow";
