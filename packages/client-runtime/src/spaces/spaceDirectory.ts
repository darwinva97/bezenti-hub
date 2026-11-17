// HTTP beside the User's account, not a guarded WS command: creating an Organization depends on
// who the User is (the Owner), not on a session scope, so a permission atom has nothing to read.
// Clients show controls from the server's AccessPolicy answers (`canCreateOrganization`,
// `canCreateThreads`) instead.
import type {
  AuditAction,
  AuditLogQuery,
  CommandId,
  InstallationPermission,
  InstallationUserStatus,
  ProjectId,
  SpaceDirectoryView,
  SpaceId,
  SpaceSummary,
  UserId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const fetchSpaceDirectory = (client: EnvironmentHttpClient) =>
  client.spaces.list({ headers: {} });

export const createOrganization = (client: EnvironmentHttpClient, name: string) =>
  client.spaces.createOrganization({ headers: {}, payload: { name } });

/** The Owner archives, restores and (once archived) deletes an Organization. */
export const archiveOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.archiveOrganization({ headers: {}, params: { spaceId } });
export const restoreOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.restoreOrganization({ headers: {}, params: { spaceId } });
export const deleteOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.deleteOrganization({ headers: {}, params: { spaceId } });

/**
 * Moves a Project with all its Threads to another Space, answering the Threads it released. A
 * running Thread refuses it (409) unless `stopThreads`, confirmed after `projectMovePlan`.
 */
export const moveProject = (
  client: EnvironmentHttpClient,
  input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly spaceId: SpaceId;
    readonly stopThreads?: boolean;
  },
) => client.projects.move({ headers: {}, payload: input });

/** What moving the Project to `spaceId` would do: Threads it stops, and those left without a machine. */
export const projectMovePlan = (
  client: EnvironmentHttpClient,
  input: { readonly projectId: ProjectId; readonly spaceId: SpaceId },
) => client.projects.movePlan({ headers: {}, payload: input });

/** The destination Space's Sandbox in the Hub's Environments list, when it offers one. */
export function destinationSandbox<
  E extends { readonly id: string; readonly kind: string; readonly spaceId?: string | null },
>(environments: ReadonlyArray<E>, spaceId: SpaceId): E | undefined {
  return environments.find(
    (environment) => environment.kind === "sandbox" && environment.spaceId === spaceId,
  );
}

/**
 * The Spaces a Project in `from` may move to, from the server's answers per Space. A Project
 * from before Spaces (no Space) is in the Owner's Personal space. Empty when it may not leave.
 */
export function projectMoveDestinations(
  view: SpaceDirectoryView,
  from: SpaceId | null | undefined,
): ReadonlyArray<SpaceSummary> {
  const origin = from ?? (view.isOwner === true ? view.personalSpaceId : null);
  const source = view.spaces.find((space) => space.id === origin);
  if (source === undefined || source.canMoveProjectsOut !== true) return [];
  return view.spaces.filter((space) => space.id !== origin && space.canMoveProjectsIn === true);
}

/** The Owner's Users admin view. */
export const fetchInstallationUsers = (client: EnvironmentHttpClient) =>
  client.installationUsers.list({ headers: {} });

export const setInstallationPermission = (
  client: EnvironmentHttpClient,
  userId: UserId,
  permission: InstallationPermission,
  granted: boolean,
) =>
  client.installationUsers.setPermission({
    headers: {},
    params: { userId },
    payload: { permission, granted },
  });

/** Disables, re-enables or removes a User; removing cannot be undone. */
export const setInstallationUserStatus = (
  client: EnvironmentHttpClient,
  userId: UserId,
  status: InstallationUserStatus,
) => client.installationUsers.setStatus({ headers: {}, params: { userId }, payload: { status } });

/** The Owner's audit log, newest first; pass the last page's `nextCursor` as `before`. */
export const fetchAuditLog = (client: EnvironmentHttpClient, query: AuditLogQuery = {}) =>
  client.audit.list({ headers: {}, query });

/** How the audit view names each action. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "owner.bootstrap": "Claimed the Hub as Owner",
  "owner.resetLink": "Issued an Owner reset link",
  "resetLink.redeem": "Used a reset link",
  "invitation.create": "Created an Invitation",
  "invitation.accept": "Accepted an Invitation",
  "invitation.revoke": "Revoked an Invitation",
  "membership.changeRole": "Changed a Role",
  "membership.remove": "Removed a Member",
  "membership.leave": "Left the Organization",
  "membership.resetLink": "Issued a reset link",
  "installationPermission.grant": "Granted an Installation permission",
  "installationPermission.revoke": "Revoked an Installation permission",
  "user.disable": "Disabled a User",
  "user.enable": "Turned a User back on",
  "user.remove": "Removed a User",
  "organization.archive": "Archived an Organization",
  "organization.restore": "Restored an Organization",
  "organization.delete": "Deleted an Organization",
  "project.move": "Moved a Project",
  "project.delete": "Deleted a Project",
  "thread.delete": "Deleted a Thread",
  "guestLink.create": "Created a guest link",
  "appSignIn.approve": "Approved an app sign-in",
  "mcpClient.approve": "Approved an MCP client",
  "cliSession.issue": "Issued a CLI token",
  "secret.reveal": "Revealed a secret",
  "secret.edit": "Edited a secret",
  "vault.create": "Created a Vault",
  "vault.update": "Changed a Vault",
  "vault.delete": "Deleted a Vault",
  "vault.allow": "Allowed a Vault",
  "vault.choose": "Chose a Vault",
  "secret.master_key.export": "Backed up the master key",
  "secret.master_key.rotate": "Rotated the master key",
  "environment.register": "Registered an Environment",
  "environment.rename": "Renamed an Environment",
  "environment.remove": "Removed an Environment",
  "environment.mode.change": "Changed who uses an Environment",
  "thread.move": "Moved a Thread to another Environment",
  "sandbox.create": "Created a Sandbox",
  "sandbox.start": "Started a Sandbox",
  "sandbox.stop": "Stopped a Sandbox",
  "sandbox.delete": "Deleted a Sandbox",
  "sandbox.limits.change": "Changed Sandbox limits",
  "sandbox.image.update": "Updated the Sandbox image",
  "ai_gateway.update": "Updated the AI gateway",
  "ai_gateway.rollback": "Rolled back the AI gateway",
  "ai_gateway.enable": "Turned the AI gateway on or off",
  "ai_account.create": "Added an AI account",
  "ai_account.update": "Changed an AI account",
  "ai_account.delete": "Deleted an AI account",
  "ai_account.allow": "Changed who may use an AI account",
  "ai_account.login": "Signed in to a subscription AI account",
  "ai_gateway_key.create": "Created an AI gateway key",
  "ai_gateway_key.revoke": "Revoked an AI gateway key",
  "secret_provider.create": "Connected a secret provider",
  "secret_provider.update": "Changed a secret provider",
  "secret_provider.delete": "Removed a secret provider",
  "secret_provider.test": "Tested a secret provider",
  "provider_scope.create": "Created a provider scope",
  "provider_scope.update": "Changed a provider scope",
  "provider_scope.delete": "Deleted a provider scope",
  "provider_scope.allow": "Changed which Vaults use a provider scope",
  "identity.issue": "Signed a workload identity token",
  "grant.give": "Lent a resource",
  "grant.accept": "Accepted a loan",
  "grant.reject": "Rejected a loan",
  "grant.cancel": "Cancelled a loan offer",
  "grant.end": "Ended a loan",
  "grant.limits.change": "Changed a loan's limits",
};

export const INSTALLATION_PERMISSION_LABELS: Record<InstallationPermission, string> = {
  "personalSpace.create": "Use their Personal space",
  "environments.registerOwn": "Register their own Environments",
};

/** Where a client keeps its current Space, one per User so a shared browser does not mix them. */
export const currentSpaceStorageKey = (userId: UserId) => `t3code:current-space:v2:${userId}`;

/**
 * The Space to start in: the stored one while it is still listed, otherwise the first the User
 * can create in (their Personal space is listed only once they hold that permission), else the
 * first listed, else none: a hidden Personal space is never chosen.
 */
export function chooseCurrentSpace(
  view: SpaceDirectoryView,
  stored: string | null,
): SpaceSummary["id"] | null {
  const kept = view.spaces.find((space) => space.id === stored);
  if (kept !== undefined) return kept.id;
  return view.spaces.find((space) => space.canCreateThreads)?.id ?? view.spaces[0]?.id ?? null;
}
