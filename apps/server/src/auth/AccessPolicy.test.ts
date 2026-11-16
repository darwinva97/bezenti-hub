import { type InstallationPermission, SpaceId, type SpaceRole, UserId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as AccessPolicy from "./AccessPolicy.ts";

const ORG = SpaceId.make("org-acme");
const OTHER_ORG = SpaceId.make("org-other");

const organization: AccessPolicy.SpaceResource = {
  id: ORG,
  kind: "organization",
  personalOwnerUserId: null,
  archived: false,
  frozen: false,
};
const archivedOrganization = { ...organization, archived: true };
const personalOf = (userId: string): AccessPolicy.SpaceResource => ({
  id: SpaceId.make(`personal-${userId}`),
  kind: "personal",
  personalOwnerUserId: UserId.make(userId),
  archived: false,
  frozen: false,
});

const principal = (
  userId: string,
  options: {
    readonly isOwner?: boolean;
    readonly roles?: ReadonlyArray<readonly [SpaceId, SpaceRole]>;
    readonly permissions?: ReadonlyArray<InstallationPermission>;
  } = {},
): AccessPolicy.Principal => ({
  userId: UserId.make(userId),
  isOwner: options.isOwner ?? false,
  installationPermissions: new Set(options.permissions ?? []),
  roles: new Map(options.roles ?? []),
});

const owner = principal("owner", { isOwner: true });
const admin = principal("ada", { roles: [[ORG, "admin"]] });
const member = principal("grace", { roles: [[ORG, "member"]] });
const guest = principal("linus", { roles: [[ORG, "guest"]] });
const outsider = principal("eve", { roles: [[OTHER_ORG, "admin"]] });
const personalCreator = principal("grace", { permissions: ["personalSpace.create"] });

const owned = (
  kind: "thread" | "project",
  ownerUserId: string,
  options: { readonly archived?: boolean; readonly space?: AccessPolicy.SpaceResource } = {},
): AccessPolicy.OwnedResource => ({
  kind,
  space: options.space ?? organization,
  ownerUserId: UserId.make(ownerUserId),
  archived: options.archived ?? false,
});
// Ada is the Admin, Grace the Member, Linus the Guest.
const adasThread = owned("thread", "ada");
const gracesThread = owned("thread", "grace");
const linusThread = owned("thread", "linus");
const gracesProject = owned("project", "grace");
const adasProject = owned("project", "ada");
const archivedGracesThread = owned("thread", "grace", { archived: true });
const archivedGracesProject = owned("project", "grace", { archived: true });

const membership = (
  userId: string,
  role: SpaceRole,
  options: { readonly nextRole?: SpaceRole; readonly space?: AccessPolicy.SpaceResource } = {},
): AccessPolicy.MembershipResource => ({
  kind: "membership",
  space: options.space ?? organization,
  userId: UserId.make(userId),
  role,
  ...(options.nextRole === undefined ? {} : { nextRole: options.nextRole }),
});
// Grace the Member, Linus the Guest and Hedy, a second Admin, as targets.
const grace = (nextRole?: SpaceRole | { readonly space: AccessPolicy.SpaceResource }) =>
  typeof nextRole === "object"
    ? membership("grace", "member", nextRole)
    : membership("grace", "member", nextRole === undefined ? {} : { nextRole });
const linusAs = (nextRole?: SpaceRole) =>
  membership("linus", "guest", nextRole === undefined ? {} : { nextRole });
const otherAdmin = (nextRole?: SpaceRole) =>
  membership("hedy", "admin", nextRole === undefined ? {} : { nextRole });

const userTarget = (userId: string, isOwner = false): AccessPolicy.UserResource => ({
  kind: "user",
  userId: UserId.make(userId),
  isOwner,
});
const disabledMember: AccessPolicy.Principal = { ...member, inactive: true };
const frozenPersonal: AccessPolicy.SpaceResource = { ...personalOf("grace"), frozen: true };
const otherOrganization: AccessPolicy.SpaceResource = { ...organization, id: OTHER_ORG };
const move = (
  from: AccessPolicy.SpaceResource,
  to: AccessPolicy.SpaceResource,
): AccessPolicy.MoveResource => ({ kind: "move", from, to });
const adminOfBoth = principal("ada", {
  roles: [
    [ORG, "admin"],
    [OTHER_ORG, "admin"],
  ],
});
const adminHereMemberThere = principal("ada", {
  roles: [
    [ORG, "admin"],
    [OTHER_ORG, "member"],
  ],
});
const personalAdmin = principal("grace", {
  roles: [[ORG, "admin"]],
  permissions: ["personalSpace.create"],
});

const hubMachine: AccessPolicy.EnvironmentResource = {
  kind: "environment",
  environmentKind: "hub",
  ownerUserId: null,
};
const ownersLaptop: AccessPolicy.EnvironmentResource = {
  kind: "environment",
  environmentKind: "external",
  ownerUserId: UserId.make("owner"),
};

const gracesLaptop: AccessPolicy.EnvironmentResource = {
  kind: "environment",
  environmentKind: "external",
  ownerUserId: UserId.make("grace"),
};

/** Acme's Sandbox, asked to run a Thread of `workSpaceId`. */
const acmeSandbox = (workSpaceId: SpaceId | undefined): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: "sandbox",
  ownerUserId: null,
  space: organization,
  ...(workSpaceId === undefined ? {} : { workSpaceId }),
});
const personalSandbox = (userId: string): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: "sandbox",
  ownerUserId: null,
  space: personalOf(userId),
  workSpaceId: personalOf(userId).id,
});

/** A machine the Owner dedicated to Acme, asked to run a Thread of `workSpaceId`. */
const acmeVps = (workSpaceId: SpaceId | undefined): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: "external",
  mode: "dedicated",
  ownerUserId: null,
  space: organization,
  ...(workSpaceId === undefined ? {} : { workSpaceId }),
});

/** A dedicated machine whose Organization was deleted under it. */
const spacelessVps: AccessPolicy.EnvironmentResource = {
  kind: "environment",
  environmentKind: "external",
  mode: "dedicated",
  ownerUserId: null,
  workSpaceId: ORG,
};

const vault = (
  space: AccessPolicy.SpaceResource | null,
  options: {
    readonly isMain?: boolean;
    readonly allowedSpaces?: ReadonlyArray<AccessPolicy.SpaceResource>;
    readonly allowedUsers?: ReadonlyArray<string>;
  } = {},
): AccessPolicy.VaultResource => ({
  kind: "vault",
  isMain: options.isMain ?? false,
  space,
  allowedSpaces: options.allowedSpaces ?? [],
  allowedUsers: (options.allowedUsers ?? []).map((id) => UserId.make(id)),
});
const mainVault = vault(null, { isMain: true });
const ownersVault = vault(null);
const orgVault = vault(organization);
const archivedOrgVault = vault(archivedOrganization);
// Spec 5 ticket 03: the Owner's own Vaults, allowed to Spaces and Users.
const allowedToAcme = vault(null, { allowedSpaces: [organization] });
const allowedToAcmeAndOther = vault(null, { allowedSpaces: [organization, otherOrganization] });
const allowedToAcmeAndGrace = vault(null, {
  allowedSpaces: [organization],
  allowedUsers: ["grace"],
});
const allowedToGrace = vault(null, { allowedUsers: ["grace"] });
const allowedToGracesPersonal = vault(null, { allowedSpaces: [personalOf("grace")] });
const allowedToArchivedAcme = vault(null, { allowedSpaces: [archivedOrganization] });

const allow = AccessPolicy.allow;
const deny = AccessPolicy.deny;

type Row = readonly [
  string,
  AccessPolicy.Principal,
  AccessPolicy.Action,
  AccessPolicy.Resource,
  AccessPolicy.Decision,
];

// One row per rule. Later tickets add rows (and actions), never a new suite.
const rows: ReadonlyArray<Row> = [
  // The Owner holds every permission.
  ["Owner views an Organization", owner, "space.view", organization, allow],
  ["Owner views another User's Personal space", owner, "space.view", personalOf("grace"), allow],
  ["Owner creates a Thread anywhere", owner, "thread.create", organization, allow],
  ["Owner creates a Project in an Organization", owner, "project.create", organization, allow],
  [
    "Owner creates in their own Personal space",
    owner,
    "project.create",
    personalOf("owner"),
    allow,
  ],
  ["Owner creates an Organization", owner, "organization.create", AccessPolicy.installation, allow],

  // Organizations, by Role.
  ["Admin views", admin, "space.view", organization, allow],
  ["Member views", member, "space.view", organization, allow],
  ["Guest views", guest, "space.view", organization, allow],
  ["non-Member cannot view", outsider, "space.view", organization, deny("not-a-member")],
  ["Admin creates Threads", admin, "thread.create", organization, allow],
  ["Member creates Threads", member, "thread.create", organization, allow],
  ["Guest creates Threads", guest, "thread.create", organization, allow],
  [
    "non-Member cannot create Threads",
    outsider,
    "thread.create",
    organization,
    deny("not-a-member"),
  ],
  ["Admin creates Projects", admin, "project.create", organization, allow],
  ["Member creates Projects", member, "project.create", organization, allow],
  ["Guest cannot create Projects", guest, "project.create", organization, deny("role-not-allowed")],
  [
    "non-Member cannot create Projects",
    outsider,
    "project.create",
    organization,
    deny("not-a-member"),
  ],

  // Only the Owner creates Organizations.
  [
    "Admin cannot create Organizations",
    admin,
    "organization.create",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "Member cannot create Organizations",
    member,
    "organization.create",
    AccessPolicy.installation,
    deny("owner-only"),
  ],

  // Personal spaces: private to their User; using one at all is an Installation permission.
  [
    "with the permission a User views their own Personal space",
    personalCreator,
    "space.view",
    personalOf("grace"),
    allow,
  ],
  [
    "without the permission a User's Personal space is hidden",
    member,
    "space.view",
    personalOf("grace"),
    deny("missing-installation-permission"),
  ],
  [
    "a User's permission does not reach someone else's Personal space",
    principal("ada", { permissions: ["personalSpace.create"] }),
    "space.view",
    personalOf("grace"),
    deny("not-your-personal-space"),
  ],
  [
    "the Owner reads another User's Personal space but starts no Thread there",
    owner,
    "thread.create",
    personalOf("grace"),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner creates no Project in another User's Personal space",
    owner,
    "project.create",
    personalOf("grace"),
    deny("personal-space-read-only"),
  ],
  [
    "a User cannot view someone else's Personal space",
    admin,
    "space.view",
    personalOf("grace"),
    deny("not-your-personal-space"),
  ],
  [
    "creating in a Personal space needs the permission",
    member,
    "thread.create",
    personalOf("grace"),
    deny("missing-installation-permission"),
  ],
  [
    "with the permission a User creates Threads there",
    personalCreator,
    "thread.create",
    personalOf("grace"),
    allow,
  ],
  [
    "with the permission a User creates Projects there",
    personalCreator,
    "project.create",
    personalOf("grace"),
    allow,
  ],
  [
    "the permission does not reach another Personal space",
    personalCreator,
    "thread.create",
    personalOf("ada"),
    deny("not-your-personal-space"),
  ],

  // Archived Organizations and frozen Personal spaces take nothing new, not even from the Owner.
  [
    "Members no longer see an archived Organization",
    member,
    "space.view",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "the Owner still sees an archived Organization",
    owner,
    "space.view",
    archivedOrganization,
    allow,
  ],
  [
    "nobody creates Threads in an archived Organization",
    owner,
    "thread.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "nobody creates Projects in an archived Organization",
    admin,
    "project.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "nobody creates in a frozen Personal space",
    owner,
    "thread.create",
    { ...personalOf("grace"), frozen: true },
    deny("space-frozen"),
  ],

  // Invitations: Admins invite Members and Guests; only the Owner invites Admins.
  ["Owner invites to an Organization", owner, "invitation.create", organization, allow],
  ["Admin invites Members and Guests", admin, "invitation.create", organization, allow],
  ["Member cannot invite", member, "invitation.create", organization, deny("role-not-allowed")],
  ["Guest cannot invite", guest, "invitation.create", organization, deny("role-not-allowed")],
  ["non-Member cannot invite", outsider, "invitation.create", organization, deny("not-a-member")],
  ["Owner names Admins", owner, "admin.manage", organization, allow],
  ["Admin cannot name Admins", admin, "admin.manage", organization, deny("owner-only")],
  [
    "nobody invites into a Personal space, not even the Owner",
    owner,
    "invitation.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "nobody invites into an archived Organization",
    owner,
    "invitation.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "the Owner lists and revokes Invitations, even of an archived Organization",
    owner,
    "invitation.manage",
    archivedOrganization,
    allow,
  ],
  ["Admin lists and revokes Invitations", admin, "invitation.manage", organization, allow],
  [
    "Member cannot list or revoke Invitations",
    member,
    "invitation.manage",
    organization,
    deny("role-not-allowed"),
  ],

  // Memberships: Admins manage Members and Guests, never Admins; only the Owner names Admins.
  ["Admin makes a Member a Guest", admin, "membership.changeRole", grace("guest"), allow],
  ["Admin makes a Guest a Member", admin, "membership.changeRole", linusAs("member"), allow],
  [
    "Admin cannot make anyone an Admin",
    admin,
    "membership.changeRole",
    grace("admin"),
    deny("owner-only"),
  ],
  [
    "Admin cannot demote another Admin",
    admin,
    "membership.changeRole",
    otherAdmin("member"),
    deny("owner-only"),
  ],
  ["Owner names an Admin", owner, "membership.changeRole", grace("admin"), allow],
  ["Owner demotes an Admin", owner, "membership.changeRole", otherAdmin("member"), allow],
  [
    "Member cannot change Roles",
    member,
    "membership.changeRole",
    linusAs("member"),
    deny("role-not-allowed"),
  ],
  ["Admin removes a Member", admin, "membership.remove", grace(), allow],
  [
    "Admin cannot remove another Admin",
    admin,
    "membership.remove",
    otherAdmin(),
    deny("owner-only"),
  ],
  ["Owner removes an Admin", owner, "membership.remove", otherAdmin(), allow],
  ["Guest cannot remove anyone", guest, "membership.remove", grace(), deny("role-not-allowed")],
  ["non-Member cannot remove anyone", outsider, "membership.remove", grace(), deny("not-a-member")],
  [
    "nobody changes Roles in an archived Organization but the Owner",
    admin,
    "membership.remove",
    grace({ space: archivedOrganization }),
    deny("space-archived"),
  ],
  ["a Member leaves", member, "membership.leave", grace(), allow],
  ["an Admin leaves", admin, "membership.leave", membership("ada", "admin"), allow],
  [
    "a Member leaves even an archived Organization",
    member,
    "membership.leave",
    grace({ space: archivedOrganization }),
    allow,
  ],
  ["nobody leaves for someone else", admin, "membership.leave", grace(), deny("not-yours")],
  // A reset link takes the account over, so only the Owner issues one.
  [
    "Admin cannot issue a Member's reset link",
    admin,
    "membership.resetLink",
    grace(),
    deny("owner-only"),
  ],
  [
    "Admin cannot issue a Guest's reset link",
    admin,
    "membership.resetLink",
    linusAs(),
    deny("owner-only"),
  ],
  [
    "Admin cannot issue another Admin's reset link",
    admin,
    "membership.resetLink",
    otherAdmin(),
    deny("owner-only"),
  ],
  ["Owner issues anyone's reset link", owner, "membership.resetLink", otherAdmin(), allow],
  [
    "Member cannot issue reset links",
    member,
    "membership.resetLink",
    linusAs(),
    deny("role-not-allowed"),
  ],
  [
    "Memberships exist only in Organizations",
    owner,
    "membership.remove",
    grace({ space: personalOf("grace") }),
    deny("wrong-resource"),
  ],

  // Role table, Threads: only the creator continues one, not even an Admin.
  ["Admin continues their own Thread", admin, "thread.continue", adasThread, allow],
  ["Member continues their own Thread", member, "thread.continue", gracesThread, allow],
  ["Guest continues their own Thread", guest, "thread.continue", linusThread, allow],
  [
    "Admin cannot continue another's Thread",
    admin,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "Member cannot continue another's Thread",
    member,
    "thread.continue",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot continue another's Thread",
    guest,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "not even the Owner continues another's Thread",
    owner,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "the Owner continues their own Thread",
    owner,
    "thread.continue",
    owned("thread", "owner"),
    allow,
  ],
  ["the Owner archives anyone's Thread", owner, "thread.archive", gracesThread, allow],
  // Pins, settling, snoozes and tags are shared Thread state: the creator's or an Admin's.
  ["Member organizes their own Thread", member, "thread.organize", gracesThread, allow],
  ["Admin organizes another's Thread", admin, "thread.organize", gracesThread, allow],
  [
    "Member cannot organize another's Thread",
    member,
    "thread.organize",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot organize another's Thread",
    guest,
    "thread.organize",
    gracesThread,
    deny("not-yours"),
  ],
  ["non-Member cannot continue", outsider, "thread.continue", gracesThread, deny("not-a-member")],
  [
    "nobody continues a Thread in an archived Organization",
    owner,
    "thread.continue",
    owned("thread", "grace", { space: archivedOrganization }),
    deny("space-archived"),
  ],

  // Archiving (and restoring): one's own; Admins also others'. Guests own no Projects.
  ["Admin archives their own Thread", admin, "thread.archive", adasThread, allow],
  ["Member archives their own Thread", member, "thread.archive", gracesThread, allow],
  ["Guest archives their own Thread", guest, "thread.archive", linusThread, allow],
  ["Admin archives another's Thread", admin, "thread.archive", gracesThread, allow],
  [
    "Member cannot archive another's Thread",
    member,
    "thread.archive",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot archive another's Thread",
    guest,
    "thread.archive",
    gracesThread,
    deny("not-yours"),
  ],
  ["Admin archives their own Project", admin, "project.archive", adasProject, allow],
  ["Member archives their own Project", member, "project.archive", gracesProject, allow],
  [
    "Guest cannot archive a Project, even one they created",
    guest,
    "project.archive",
    owned("project", "linus"),
    deny("role-not-allowed"),
  ],
  ["Admin archives another's Project", admin, "project.archive", gracesProject, allow],
  [
    "Member cannot archive another's Project",
    member,
    "project.archive",
    adasProject,
    deny("not-yours"),
  ],
  [
    "Guest cannot archive another's Project",
    guest,
    "project.archive",
    gracesProject,
    deny("not-yours"),
  ],
  ["Member changes their own Project", member, "project.manage", gracesProject, allow],
  [
    "Member cannot change another's Project",
    member,
    "project.manage",
    adasProject,
    deny("not-yours"),
  ],
  ["Admin changes another's Project", admin, "project.manage", gracesProject, allow],
  ["the Owner archives anything", owner, "project.archive", gracesProject, allow],

  // Stopping a running Thread: one's own; Admins also others'.
  ["Member stops their own Thread", member, "thread.stop", gracesThread, allow],
  ["Guest stops their own Thread", guest, "thread.stop", linusThread, allow],
  ["Admin stops another's Thread", admin, "thread.stop", gracesThread, allow],
  ["Member cannot stop another's Thread", member, "thread.stop", adasThread, deny("not-yours")],
  ["Guest cannot stop another's Thread", guest, "thread.stop", gracesThread, deny("not-yours")],

  // Permanent deletion: Admins, and only what is archived.
  ["Admin deletes an archived Thread", admin, "thread.delete", archivedGracesThread, allow],
  ["Admin deletes an archived Project", admin, "project.delete", archivedGracesProject, allow],
  [
    "Admin cannot delete a Thread that is not archived",
    admin,
    "thread.delete",
    gracesThread,
    deny("not-archived"),
  ],
  [
    "Member cannot delete, even their own archived Thread",
    member,
    "thread.delete",
    archivedGracesThread,
    deny("role-not-allowed"),
  ],
  [
    "Guest cannot delete",
    guest,
    "thread.delete",
    owned("thread", "linus", { archived: true }),
    deny("role-not-allowed"),
  ],
  [
    "Member cannot delete their own archived Project",
    member,
    "project.delete",
    archivedGracesProject,
    deny("role-not-allowed"),
  ],
  ["the Owner deletes anything", owner, "thread.delete", gracesThread, allow],

  // A Personal space's User runs it; others (but the Owner) do not reach it.
  [
    "a User continues their Thread in their Personal space",
    personalCreator,
    "thread.continue",
    owned("thread", "grace", { space: personalOf("grace") }),
    allow,
  ],
  [
    "a User archives in their Personal space",
    personalCreator,
    "project.archive",
    owned("project", "grace", { space: personalOf("grace") }),
    allow,
  ],
  [
    "a User deletes what is archived in their Personal space",
    personalCreator,
    "thread.delete",
    owned("thread", "grace", { space: personalOf("grace"), archived: true }),
    allow,
  ],
  [
    "nobody else acts in a Personal space",
    admin,
    "thread.stop",
    owned("thread", "grace", { space: personalOf("grace") }),
    deny("not-your-personal-space"),
  ],
  [
    "once the permission is revoked, what is in the Personal space is out of reach",
    member,
    "thread.continue",
    owned("thread", "grace", { space: personalOf("grace") }),
    deny("missing-installation-permission"),
  ],
  // The Owner only reads another User's Personal space: nothing there is theirs to change.
  ...(
    [
      ["thread.continue", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.archive", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.organize", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.stop", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.delete", owned("thread", "grace", { space: personalOf("grace"), archived: true })],
      ["project.archive", owned("project", "grace", { space: personalOf("grace") })],
      ["project.manage", owned("project", "grace", { space: personalOf("grace") })],
      ["project.delete", owned("project", "grace", { space: personalOf("grace"), archived: true })],
    ] as const
  ).map(
    ([action, item]) =>
      [
        `the Owner cannot ${action} in another User's Personal space`,
        owner,
        action,
        item,
        deny("personal-space-read-only"),
      ] as const,
  ),
  [
    "the Owner archives in their own Personal space",
    owner,
    "thread.archive",
    owned("thread", "grace", { space: personalOf("owner") }),
    allow,
  ],
  [
    "the Owner deletes in their own Personal space",
    owner,
    "project.delete",
    owned("project", "owner", { space: personalOf("owner") }),
    allow,
  ],
  ["Thread rules need a Thread", member, "thread.continue", organization, deny("wrong-resource")],

  // Guest links: Admins, only in Organizations; never from a Personal space.
  ["Admin creates a guest link", admin, "guestLink.create", organization, allow],
  [
    "Member cannot create a guest link",
    member,
    "guestLink.create",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "Guest cannot create a guest link",
    guest,
    "guestLink.create",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "the Owner creates a guest link in an Organization",
    owner,
    "guestLink.create",
    organization,
    allow,
  ],
  [
    "no guest link from a Personal space, not even the Owner's",
    owner,
    "guestLink.create",
    personalOf("owner"),
    deny("wrong-resource"),
  ],
  [
    "no guest link from a Personal space by its own User",
    personalCreator,
    "guestLink.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no Invitation into a Personal space by its own User",
    personalCreator,
    "invitation.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no Invitations to manage in a Personal space, not even the Owner's",
    owner,
    "invitation.manage",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no guest link from an archived Organization",
    admin,
    "guestLink.create",
    archivedOrganization,
    deny("space-archived"),
  ],

  // Installation permissions: only the Owner lists Users and grants or revokes them.
  [
    "the Owner grants and revokes Installation permissions",
    owner,
    "installationPermission.manage",
    AccessPolicy.installation,
    allow,
  ],
  [
    "an Admin cannot grant Installation permissions",
    admin,
    "installationPermission.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a User holding a permission cannot grant it",
    personalCreator,
    "installationPermission.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],

  // Disabling and removing Users: only the Owner, never the Owner themselves.
  ["the Owner disables a User", owner, "user.disable", userTarget("grace"), allow],
  ["the Owner removes a User", owner, "user.remove", userTarget("grace"), allow],
  [
    "nobody disables the Owner",
    owner,
    "user.disable",
    userTarget("owner", true),
    deny("owner-protected"),
  ],
  [
    "nobody removes the Owner",
    owner,
    "user.remove",
    userTarget("owner", true),
    deny("owner-protected"),
  ],
  [
    "an Admin cannot disable a User",
    admin,
    "user.disable",
    userTarget("grace"),
    deny("owner-only"),
  ],
  ["a Member cannot remove a User", member, "user.remove", userTarget("ada"), deny("owner-only")],
  ["User rules need a User", owner, "user.remove", organization, deny("wrong-resource")],

  // A disabled or removed User may do nothing, though their Memberships remain.
  [
    "a disabled Member no longer views",
    disabledMember,
    "space.view",
    organization,
    deny("user-inactive"),
  ],
  [
    "a disabled Member continues not even their own Thread",
    disabledMember,
    "thread.continue",
    gracesThread,
    deny("user-inactive"),
  ],
  [
    "a disabled Admin's guest link stops",
    { ...admin, inactive: true },
    "guestLink.create",
    organization,
    deny("user-inactive"),
  ],

  // A removed User's Personal space: frozen, read by the Owner, who may only delete from it.
  ["the Owner reads a frozen Personal space", owner, "space.view", frozenPersonal, allow],
  [
    "the Owner deletes a Thread from a frozen Personal space without archiving it",
    owner,
    "thread.delete",
    owned("thread", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner deletes a Project from a frozen Personal space",
    owner,
    "project.delete",
    owned("project", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner stops a running Thread in a frozen Personal space",
    owner,
    "thread.stop",
    owned("thread", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner archives nothing in a frozen Personal space",
    owner,
    "project.archive",
    owned("project", "grace", { space: frozenPersonal }),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner continues nothing in a frozen Personal space",
    owner,
    "thread.continue",
    owned("thread", "grace", { space: frozenPersonal }),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner starts no Thread in a frozen Personal space",
    owner,
    "thread.create",
    frozenPersonal,
    deny("space-frozen"),
  ],
  // An Organization's lifecycle is the Owner's: archive, restore, and delete once archived.
  ["the Owner archives an Organization", owner, "organization.archive", organization, allow],
  [
    "the Owner restores an archived Organization",
    owner,
    "organization.restore",
    archivedOrganization,
    allow,
  ],
  [
    "the Owner deletes an archived Organization",
    owner,
    "organization.delete",
    archivedOrganization,
    allow,
  ],
  [
    "not even the Owner deletes an Organization that is not archived",
    owner,
    "organization.delete",
    organization,
    deny("not-archived"),
  ],
  ["an Admin cannot archive", admin, "organization.archive", organization, deny("owner-only")],
  [
    "an Admin cannot restore",
    admin,
    "organization.restore",
    archivedOrganization,
    deny("owner-only"),
  ],
  [
    "an Admin cannot delete",
    admin,
    "organization.delete",
    archivedOrganization,
    deny("owner-only"),
  ],
  [
    "a Personal space is not archived like an Organization",
    owner,
    "organization.archive",
    personalOf("grace"),
    deny("wrong-resource"),
  ],

  // Moving a Project: Admin (or its Personal space's User) in the origin and in the destination.
  [
    "an Admin of both moves between them",
    adminOfBoth,
    "project.move",
    move(organization, otherOrganization),
    allow,
  ],
  [
    "an Admin of the origin who is a Member of the destination cannot",
    adminHereMemberThere,
    "project.move",
    move(organization, otherOrganization),
    deny("role-not-allowed"),
  ],
  [
    "a Member of the origin cannot, even as Admin of the destination",
    adminHereMemberThere,
    "project.move",
    move(otherOrganization, organization),
    deny("role-not-allowed"),
  ],
  [
    "nobody moves into an Organization they are not in",
    admin,
    "project.move",
    move(organization, otherOrganization),
    deny("not-a-member"),
  ],
  [
    "a User moves their Project from their Personal space into an Organization they run",
    personalAdmin,
    "project.move",
    move(personalOf("grace"), organization),
    allow,
  ],
  ["and back", personalAdmin, "project.move", move(organization, personalOf("grace")), allow],
  [
    "not from a Personal space they may not use",
    principal("grace", { roles: [[ORG, "admin"]] }),
    "project.move",
    move(personalOf("grace"), organization),
    deny("missing-installation-permission"),
  ],
  [
    "not out of someone else's Personal space",
    admin,
    "project.move",
    move(personalOf("grace"), organization),
    deny("not-your-personal-space"),
  ],
  [
    "the Owner moves between Organizations",
    owner,
    "project.move",
    move(organization, otherOrganization),
    allow,
  ],
  [
    "the Owner moves out of their own Personal space",
    owner,
    "project.move",
    move(personalOf("owner"), organization),
    allow,
  ],
  [
    "not even the Owner moves into another User's Personal space",
    owner,
    "project.move",
    move(organization, personalOf("grace")),
    deny("personal-space-read-only"),
  ],
  [
    "not even the Owner moves out of another User's Personal space",
    owner,
    "project.move",
    move(personalOf("grace"), organization),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner moves out of a removed User's frozen Personal space, which was handed to them",
    owner,
    "project.move",
    move({ ...personalOf("grace"), frozen: true }, organization),
    allow,
  ],
  [
    "nobody moves into a frozen Personal space",
    owner,
    "project.move",
    move(organization, { ...personalOf("owner"), frozen: true }),
    deny("space-frozen"),
  ],
  [
    "nobody moves into an archived Organization",
    owner,
    "project.move",
    move(otherOrganization, archivedOrganization),
    deny("space-archived"),
  ],
  [
    "the Owner rescues a Project from an archived Organization",
    owner,
    "project.move",
    move(archivedOrganization, otherOrganization),
    allow,
  ],
  [
    "an Admin cannot move out of an archived Organization",
    adminOfBoth,
    "project.move",
    move(archivedOrganization, otherOrganization),
    deny("space-archived"),
  ],
  [
    "a move to the same Space is no move",
    owner,
    "project.move",
    move(organization, organization),
    deny("wrong-resource"),
  ],
  [
    "a move is decided on its origin and destination",
    owner,
    "project.move",
    organization,
    deny("wrong-resource"),
  ],
  // Environments: the Owner and Users with `environments.registerOwn` join their own machines, and
  // a personal one is its owner's alone.
  ["Owner registers a machine", owner, "environment.register", AccessPolicy.installation, allow],
  [
    "an Admin without the permission does not register a machine",
    admin,
    "environment.register",
    AccessPolicy.installation,
    deny("missing-installation-permission"),
  ],
  [
    "a User with `environments.registerOwn` registers their own machine",
    principal("grace", { roles: [[ORG, "member"]], permissions: ["environments.registerOwn"] }),
    "environment.register",
    AccessPolicy.installation,
    allow,
  ],
  [
    "a disabled User with the permission registers nothing",
    {
      ...principal("grace", { permissions: ["environments.registerOwn"] }),
      inactive: true,
    },
    "environment.register",
    AccessPolicy.installation,
    deny("user-inactive"),
  ],
  [
    "registering is decided on the Installation",
    principal("grace", { permissions: ["environments.registerOwn"] }),
    "environment.register",
    organization,
    deny("wrong-resource"),
  ],
  ["a Member renames their own machine", member, "environment.rename", gracesLaptop, allow],
  ["a Member removes their own machine", member, "environment.remove", gracesLaptop, allow],
  [
    "a Member does not remove another User's machine",
    member,
    "environment.remove",
    ownersLaptop,
    deny("owner-only"),
  ],
  ["a Member uses the Hub machine", member, "environment.view", hubMachine, allow],
  [
    "a Member does not see the Owner's personal machine",
    member,
    "environment.view",
    ownersLaptop,
    deny("not-yours"),
  ],
  ["Owner sees their personal machine", owner, "environment.view", ownersLaptop, allow],
  ["a Member runs a Thread on the Hub machine", member, "environment.use", hubMachine, allow],
  ["Owner runs a Thread on their machine", owner, "environment.use", ownersLaptop, allow],
  [
    "a Member does not run a Thread on the Owner's machine",
    member,
    "environment.use",
    ownersLaptop,
    deny("not-yours"),
  ],
  [
    "Owner does not run a Thread on another User's machine",
    owner,
    "environment.use",
    gracesLaptop,
    deny("not-yours"),
  ],
  ["Owner sees another User's personal machine", owner, "environment.view", gracesLaptop, allow],
  ["Owner removes another User's machine", owner, "environment.remove", gracesLaptop, allow],
  [
    "a Member does not see another Member's machine",
    principal("ada", { roles: [[ORG, "member"]] }),
    "environment.view",
    gracesLaptop,
    deny("not-yours"),
  ],
  ["a Member sees their own machine", member, "environment.view", gracesLaptop, allow],
  ["Owner renames their machine", owner, "environment.rename", ownersLaptop, allow],
  ["Owner renames the Hub machine", owner, "environment.rename", hubMachine, allow],
  ["Owner removes their machine", owner, "environment.remove", ownersLaptop, allow],
  ["nobody removes the Hub machine", owner, "environment.remove", hubMachine, deny("hub-machine")],
  [
    "an Admin does not rename the Hub machine",
    admin,
    "environment.rename",
    hubMachine,
    deny("owner-only"),
  ],
  [
    "a disabled User sees no Environment",
    disabledMember,
    "environment.view",
    hubMachine,
    deny("user-inactive"),
  ],
  [
    "an Environment action needs an Environment",
    owner,
    "environment.view",
    organization,
    deny("wrong-resource"),
  ],
  ["an Admin runs a Thread in the Sandbox", admin, "environment.use", acmeSandbox(ORG), allow],
  ["a Member runs a Thread in the Sandbox", member, "environment.use", acmeSandbox(ORG), allow],
  [
    "a Guest runs nothing in the Sandbox",
    guest,
    "environment.use",
    acmeSandbox(ORG),
    deny("role-not-allowed"),
  ],
  ["a Guest sees the Sandbox", guest, "environment.view", acmeSandbox(ORG), allow],
  [
    "another Organization's Admin does not see the Sandbox",
    outsider,
    "environment.view",
    acmeSandbox(ORG),
    deny("not-a-member"),
  ],
  [
    "another Organization's Admin runs nothing there, even for their own Space",
    outsider,
    "environment.use",
    acmeSandbox(OTHER_ORG),
    deny("other-space"),
  ],
  [
    "a Sandbox runs no Thread of another Space, even its Members'",
    personalAdmin,
    "environment.use",
    acmeSandbox(personalOf("grace").id),
    deny("other-space"),
  ],
  [
    "a Sandbox runs a Thread only for a known Space",
    member,
    "environment.use",
    acmeSandbox(undefined),
    deny("other-space"),
  ],
  [
    "nothing runs in an archived Organization's Sandbox",
    owner,
    "environment.use",
    { ...acmeSandbox(ORG), space: archivedOrganization },
    deny("space-archived"),
  ],
  [
    "Owner runs a Thread in any Organization's Sandbox",
    owner,
    "environment.use",
    acmeSandbox(ORG),
    allow,
  ],
  [
    "a User runs their Personal space's Sandbox",
    personalCreator,
    "environment.use",
    personalSandbox("grace"),
    allow,
  ],
  [
    "Owner sees another User's Personal Sandbox but runs nothing there",
    owner,
    "environment.use",
    personalSandbox("grace"),
    deny("personal-space-read-only"),
  ],
  ["Owner sees every Sandbox", owner, "environment.view", personalSandbox("grace"), allow],
  [
    "a Sandbox is not renamed as a machine",
    owner,
    "environment.rename",
    acmeSandbox(ORG),
    deny("sandbox"),
  ],
  [
    "a Sandbox is not removed as a machine",
    owner,
    "environment.remove",
    acmeSandbox(ORG),
    deny("sandbox"),
  ],
  [
    "an Admin does not remove the Sandbox",
    admin,
    "environment.remove",
    acmeSandbox(ORG),
    deny("owner-only"),
  ],
  ["Owner sees every Sandbox's use and limits", owner, "sandbox.inspect", acmeSandbox(ORG), allow],
  [
    "an Admin sees their Sandbox's use and limits",
    admin,
    "sandbox.inspect",
    acmeSandbox(ORG),
    allow,
  ],
  [
    "a Member does not see the Sandbox's use and limits",
    member,
    "sandbox.inspect",
    acmeSandbox(ORG),
    deny("role-not-allowed"),
  ],
  [
    "another Organization's Admin does not see its use",
    outsider,
    "sandbox.inspect",
    acmeSandbox(ORG),
    deny("not-a-member"),
  ],
  [
    "a User sees their Personal space's Sandbox use",
    personalCreator,
    "sandbox.inspect",
    personalSandbox("grace"),
    allow,
  ],
  [
    "Owner starts, stops and limits any Sandbox",
    owner,
    "sandbox.manage",
    personalSandbox("grace"),
    allow,
  ],
  [
    "an Admin does not start, stop or limit their Sandbox",
    admin,
    "sandbox.manage",
    acmeSandbox(ORG),
    deny("owner-only"),
  ],
  ["a Sandbox action needs a Sandbox", owner, "sandbox.manage", hubMachine, deny("wrong-resource")],
  [
    "a disabled Admin sees no Sandbox use",
    disabledMember,
    "sandbox.inspect",
    acmeSandbox(ORG),
    deny("user-inactive"),
  ],
  // The master key that encrypts every secret: only the Owner backs it up (spec 5 «Vaults»).
  ["Owner backs up the master key", owner, "masterKey.backup", AccessPolicy.installation, allow],
  [
    "an Admin does not back up the master key",
    admin,
    "masterKey.backup",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a Member does not back up the master key",
    member,
    "masterKey.backup",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a Guest does not back up the master key",
    guest,
    "masterKey.backup",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a User with every Installation permission does not back up the master key",
    principal("grace", { permissions: ["environments.registerOwn", "personalSpace.create"] }),
    "masterKey.backup",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "the master key is backed up on the Installation, not a Space",
    owner,
    "masterKey.backup",
    organization,
    deny("wrong-resource"),
  ],
  // Vaults (spec 5 «Vaults»): the Owner does all; an Organization's Admins edit its Vaults without
  // reading them; its Members and Guests see names; the Main vault is the Owner's alone.
  ...(
    [
      [
        "Owner",
        owner,
        ["vault.view", "vault.edit", "vault.manage", "vault.reveal", "vault.dangerousName"],
        [],
      ],
      [
        "Admin",
        admin,
        ["vault.view", "vault.edit"],
        ["vault.manage", "vault.reveal", "vault.dangerousName"],
      ],
      [
        "Member",
        member,
        ["vault.view"],
        ["vault.edit", "vault.manage", "vault.reveal", "vault.dangerousName"],
      ],
      [
        "Guest",
        guest,
        ["vault.view"],
        ["vault.edit", "vault.manage", "vault.reveal", "vault.dangerousName"],
      ],
    ] as const
  ).flatMap(([who, actor, allowed, denied]) => [
    ...allowed.map((action): Row => [
      `${who}: ${action} on its Organization's Vault`,
      actor,
      action,
      orgVault,
      allow,
    ]),
    ...denied.map((action): Row => [
      `${who}: no ${action} on its Organization's Vault`,
      actor,
      action,
      orgVault,
      action === "vault.edit" ? deny("role-not-allowed") : deny("owner-only"),
    ]),
  ]),
  ...(
    ["vault.view", "vault.edit", "vault.manage", "vault.reveal", "vault.dangerousName"] as const
  ).flatMap((action): ReadonlyArray<Row> => [
    [`Owner: ${action} on the Main vault`, owner, action, mainVault, allow],
    ...([admin, member, guest] as const).map((actor): Row => [
      `${actor.userId}: no ${action} on the Main vault`,
      actor,
      action,
      mainVault,
      deny("owner-only"),
    ]),
    [
      `another Organization's Admin: no ${action}`,
      outsider,
      action,
      orgVault,
      action !== "vault.view" && action !== "vault.edit"
        ? deny("owner-only")
        : deny("not-a-member"),
    ],
  ]),
  [
    "Admin: no edit in an archived Organization",
    admin,
    "vault.edit",
    archivedOrgVault,
    deny("space-archived"),
  ],
  ["Owner: edits in an archived Organization", owner, "vault.edit", archivedOrgVault, allow],
  ["Owner's own Vault: not an Admin's", admin, "vault.view", ownersVault, deny("owner-only")],
  ["a Vault action on a Space", owner, "vault.view", organization, deny("wrong-resource")],
  ["a Space action on a Vault", owner, "space.view", orgVault, deny("wrong-resource")],
  // Spec 5 ticket 03: the Owner's own Vaults reach whom the Owner allowed them to. Whoever works
  // in an allowed Space, or is an allowed User, sees the names; an Admin edits the secrets only
  // while the Vault reaches nothing but Organizations they run.
  ["an Admin sees a Vault allowed to Acme", admin, "vault.view", allowedToAcme, allow],
  ["a Member sees a Vault allowed to Acme", member, "vault.view", allowedToAcme, allow],
  ["a Guest sees a Vault allowed to Acme", guest, "vault.view", allowedToAcme, allow],
  [
    "another Organization's Admin does not",
    outsider,
    "vault.view",
    allowedToAcme,
    deny("owner-only"),
  ],
  ["an Admin edits a Vault allowed to Acme alone", admin, "vault.edit", allowedToAcme, allow],
  ["a Member does not edit it", member, "vault.edit", allowedToAcme, deny("owner-only")],
  [
    "an Admin does not edit one that also reaches another Organization",
    admin,
    "vault.edit",
    allowedToAcmeAndOther,
    deny("owner-only"),
  ],
  [
    "an Admin does not edit one that also reaches a User",
    admin,
    "vault.edit",
    allowedToAcmeAndGrace,
    deny("owner-only"),
  ],
  [
    "nobody edits one allowed only to Users",
    admin,
    "vault.edit",
    allowedToGrace,
    deny("owner-only"),
  ],
  ["the allowed User sees its names", member, "vault.view", allowedToGrace, allow],
  ["another User does not", admin, "vault.view", allowedToGrace, deny("owner-only")],
  [
    "a Personal space's User sees one allowed to it",
    personalCreator,
    "vault.view",
    allowedToGracesPersonal,
    allow,
  ],
  [
    "a Personal space's User does not edit it",
    personalCreator,
    "vault.edit",
    allowedToGracesPersonal,
    deny("owner-only"),
  ],
  [
    "nothing through an archived Organization",
    admin,
    "vault.view",
    allowedToArchivedAcme,
    deny("owner-only"),
  ],
  ["only the Owner allows a Vault", admin, "vault.manage", allowedToAcme, deny("owner-only")],
  [
    "the Main vault stays the Owner's alone, whatever it holds",
    admin,
    "vault.view",
    vault(null, { isMain: true, allowedSpaces: [organization], allowedUsers: ["ada"] }),
    deny("owner-only"),
  ],
  // Spec «Variables y Secrets sellados», ticket 01 (decision 4): whoever sees a Vault reads its
  // Variables' values, Guests excepted (an invitation can leave the Organization).
  ["Owner reads Variables of the Main vault", owner, "vault.readVariables", mainVault, allow],
  ["Owner reads an Organization's Variables", owner, "vault.readVariables", orgVault, allow],
  ["an Admin reads its Organization's Variables", admin, "vault.readVariables", orgVault, allow],
  ["a Member reads its Organization's Variables", member, "vault.readVariables", orgVault, allow],
  [
    "a Guest does not read its Organization's Variables",
    guest,
    "vault.readVariables",
    orgVault,
    deny("role-not-allowed"),
  ],
  [
    "another Organization's Admin does not",
    outsider,
    "vault.readVariables",
    orgVault,
    deny("not-a-member"),
  ],
  ["nor an Admin the Main vault's", admin, "vault.readVariables", mainVault, deny("owner-only")],
  ["a Member reads a Vault allowed to Acme", member, "vault.readVariables", allowedToAcme, allow],
  [
    "a Guest does not read a Vault allowed to Acme",
    guest,
    "vault.readVariables",
    allowedToAcme,
    deny("owner-only"),
  ],
  ["the allowed User reads its Variables", member, "vault.readVariables", allowedToGrace, allow],
  [
    "a Personal space's User reads one allowed to it",
    personalCreator,
    "vault.readVariables",
    allowedToGracesPersonal,
    allow,
  ],
  // Ticket 03: a Provider entry is the Vault's editors' (an Admin's only through a scope allowed
  // to the Vault, which Vaults checks); Members and Guests never.
  ["Owner adds a Provider entry", owner, "vault.providerEntry", orgVault, allow],
  ["an Admin adds one to its Organization's Vault", admin, "vault.providerEntry", orgVault, allow],
  ...([member, guest] as const).map((actor): Row => [
    `${actor.userId}: no Provider entry`,
    actor,
    "vault.providerEntry",
    orgVault,
    deny("role-not-allowed"),
  ]),
  ["nor an Admin the Main vault", admin, "vault.providerEntry", mainVault, deny("owner-only")],
  ["an Admin on a Vault allowed to Acme alone", admin, "vault.providerEntry", allowedToAcme, allow],
  // Secret providers' scopes and «Test connection»: the Owner's, on the Installation.
  [
    "Owner manages secret providers",
    owner,
    "secretProvider.manage",
    AccessPolicy.installation,
    allow,
  ],
  ...([admin, member, guest] as const).map((actor): Row => [
    `${actor.userId}: no secret provider`,
    actor,
    "secretProvider.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ]),
  // Choosing a Space's defaults and its Projects' adds and removes.
  ["Owner chooses an Organization's Vaults", owner, "vault.choose", organization, allow],
  ["Owner chooses a Personal space's Vaults", owner, "vault.choose", personalOf("grace"), allow],
  ["an Admin chooses Acme's Vaults", admin, "vault.choose", organization, allow],
  ["a Member does not", member, "vault.choose", organization, deny("role-not-allowed")],
  ["a Guest does not", guest, "vault.choose", organization, deny("role-not-allowed")],
  [
    "another Organization's Admin does not",
    outsider,
    "vault.choose",
    organization,
    deny("not-a-member"),
  ],
  [
    "an Admin does not in an archived Organization",
    admin,
    "vault.choose",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "a Personal space's User does not choose its Vaults",
    personalCreator,
    "vault.choose",
    personalOf("grace"),
    deny("owner-only"),
  ],
  ["choosing is decided on a Space", owner, "vault.choose", orgVault, deny("wrong-resource")],
  // Dedicated machines: the Owner gives one to an Organization, whose Users who work there use it
  // for its Threads, as its Sandbox; other Spaces neither see nor use it.
  ["Owner dedicates machines", owner, "environment.dedicate", AccessPolicy.installation, allow],
  [
    "a User with `registerOwn` does not dedicate machines",
    principal("grace", { roles: [[ORG, "admin"]], permissions: ["environments.registerOwn"] }),
    "environment.dedicate",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "dedicating is decided on the Installation",
    owner,
    "environment.dedicate",
    organization,
    deny("wrong-resource"),
  ],
  [
    "a Member runs a Thread on Acme's dedicated machine",
    member,
    "environment.use",
    acmeVps(ORG),
    allow,
  ],
  [
    "an Admin runs a Thread on Acme's dedicated machine",
    admin,
    "environment.use",
    acmeVps(ORG),
    allow,
  ],
  [
    "a Guest runs nothing on the dedicated machine",
    guest,
    "environment.use",
    acmeVps(ORG),
    deny("role-not-allowed"),
  ],
  ["a Member sees Acme's dedicated machine", member, "environment.view", acmeVps(ORG), allow],
  [
    "another Organization's Admin does not see the dedicated machine",
    outsider,
    "environment.view",
    acmeVps(ORG),
    deny("not-a-member"),
  ],
  [
    "another Organization's Admin runs nothing there, even for their own Space",
    outsider,
    "environment.use",
    acmeVps(OTHER_ORG),
    deny("other-space"),
  ],
  [
    "a dedicated machine runs no Thread of another Space, even its Members'",
    personalAdmin,
    "environment.use",
    acmeVps(personalOf("grace").id),
    deny("other-space"),
  ],
  [
    "a dedicated machine is not its registrar's personal machine",
    owner,
    "environment.use",
    acmeVps(personalOf("owner").id),
    deny("other-space"),
  ],
  [
    "nothing runs on an archived Organization's dedicated machine",
    owner,
    "environment.use",
    { ...acmeVps(ORG), space: archivedOrganization },
    deny("space-archived"),
  ],
  [
    "a dedicated machine whose Space is gone runs nothing",
    member,
    "environment.use",
    spacelessVps,
    deny("wrong-resource"),
  ],
  [
    "Owner still sees a dedicated machine whose Space is gone",
    owner,
    "environment.view",
    spacelessVps,
    allow,
  ],
  ["…and renames it", owner, "environment.rename", spacelessVps, allow],
  ["…and removes it", owner, "environment.remove", spacelessVps, allow],
  ["…and runs nothing there", owner, "environment.use", spacelessVps, deny("wrong-resource")],
  [
    "nobody else sees a dedicated machine whose Space is gone",
    member,
    "environment.view",
    spacelessVps,
    deny("wrong-resource"),
  ],
  [
    "a dedicated machine has no Sandbox use or limits in Settings",
    owner,
    "sandbox.inspect",
    acmeVps(ORG),
    deny("wrong-resource"),
  ],
  ["Owner renames a dedicated machine", owner, "environment.rename", acmeVps(ORG), allow],
  ["Owner removes a dedicated machine", owner, "environment.remove", acmeVps(ORG), allow],
  [
    "an Admin does not remove the dedicated machine",
    admin,
    "environment.remove",
    acmeVps(ORG),
    deny("owner-only"),
  ],
  [
    "an Admin does not rename the dedicated machine",
    admin,
    "environment.rename",
    acmeVps(ORG),
    deny("owner-only"),
  ],
  // AI accounts (spec 4): the Owner manages them; whoever works in a Space uses what it allows.
  ["Owner manages AI accounts", owner, "aiAccount.manage", AccessPolicy.installation, allow],
  [
    "an Admin does not manage AI accounts",
    admin,
    "aiAccount.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a Member does not manage AI accounts",
    member,
    "aiAccount.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a Guest does not manage AI accounts",
    guest,
    "aiAccount.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "AI accounts are managed on the Installation, not a Space",
    owner,
    "aiAccount.manage",
    organization,
    deny("wrong-resource"),
  ],
  ["an Admin uses AI accounts in their Organization", admin, "aiAccount.use", organization, allow],
  ["a Member uses AI accounts in their Organization", member, "aiAccount.use", organization, allow],
  ["a Guest uses AI accounts in their Organization", guest, "aiAccount.use", organization, allow],
  [
    "nobody uses AI accounts in an Organization they are not in",
    outsider,
    "aiAccount.use",
    organization,
    deny("not-a-member"),
  ],
  [
    "nobody uses AI accounts in an archived Organization",
    member,
    "aiAccount.use",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "a disabled Member uses no AI account",
    disabledMember,
    "aiAccount.use",
    organization,
    deny("user-inactive"),
  ],
  [
    "the Owner uses no AI account in another User's Personal space",
    owner,
    "aiAccount.use",
    personalOf("grace"),
    deny("personal-space-read-only"),
  ],
  [
    "AI accounts are used in a Space, not on the Installation",
    member,
    "aiAccount.use",
    AccessPolicy.installation,
    deny("wrong-resource"),
  ],
  // AI usage (spec 4 ticket 05): the whole Space's usage is the Owner's and its Admins'.
  ["the Owner reads an Organization's AI usage", owner, "aiUsage.viewSpace", organization, allow],
  ["an Admin reads their Organization's AI usage", admin, "aiUsage.viewSpace", organization, allow],
  [
    "an Admin reads an archived Organization's AI usage (history)",
    admin,
    "aiUsage.viewSpace",
    archivedOrganization,
    allow,
  ],
  [
    "a Member reads no one else's AI usage in their Organization",
    member,
    "aiUsage.viewSpace",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "a Guest reads no one else's AI usage in their Organization",
    guest,
    "aiUsage.viewSpace",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "nobody reads the AI usage of an Organization they are not in",
    outsider,
    "aiUsage.viewSpace",
    organization,
    deny("not-a-member"),
  ],
  [
    "a disabled Member reads no AI usage",
    disabledMember,
    "aiUsage.viewSpace",
    organization,
    deny("user-inactive"),
  ],
  [
    "the Owner reads another User's Personal space usage",
    owner,
    "aiUsage.viewSpace",
    personalOf("grace"),
    allow,
  ],
  [
    "a User reads no whole-Space usage of a Personal space (their own rows are theirs)",
    member,
    "aiUsage.viewSpace",
    personalOf("grace"),
    deny("owner-only"),
  ],
  [
    "AI usage is read by Space, not on the Installation",
    owner,
    "aiUsage.viewSpace",
    AccessPolicy.installation,
    deny("wrong-resource"),
  ],
];

describe("AccessPolicy.decide", () => {
  it.each(rows)("%s", (_name, who, action, resource, expected) => {
    expect(AccessPolicy.decide(who, action, resource)).toEqual(expected);
  });
});
