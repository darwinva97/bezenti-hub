// Who is in an Organization, shared by web and mobile. HTTP beside the User's account, like
// Invitations: what the viewer may do to each Member comes from the server's AccessPolicy answers
// in the list (`canChangeRole`, `canRemove`, `canIssueResetLink`). Web authenticates with its
// cookie; mobile passes its Hub session as `headers`.
import type { SpaceId, SpaceRole, UserId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

/** The session a request carries when it is not the browser's cookie. */
export interface SessionHeaders {
  readonly authorization?: string;
}

export const listMembers = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  headers: SessionHeaders = {},
) => client.spaces.members({ headers, params: { spaceId } });

export const changeMemberRole = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  userId: UserId,
  role: SpaceRole,
  headers: SessionHeaders = {},
) => client.spaces.changeMemberRole({ headers, params: { spaceId }, payload: { userId, role } });

export const removeMember = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  userId: UserId,
  headers: SessionHeaders = {},
) => client.spaces.removeMember({ headers, params: { spaceId }, payload: { userId } });

export const issueMemberResetLink = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  userId: UserId,
) => client.spaces.issueMemberResetLink({ headers: {}, params: { spaceId }, payload: { userId } });

export const leaveOrganization = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  headers: SessionHeaders = {},
) => client.spaces.leave({ headers, params: { spaceId } });

/** The link to hand the Member. The token rides in the fragment, which never reaches a server log. */
export const resetLink = (origin: string, token: string) =>
  `${origin.replace(/\/+$/, "")}/reset#token=${encodeURIComponent(token)}`;

/**
 * The Roles offered when changing a Member's Role: what the viewer may assign, plus the Member's
 * current Role so the choice never hides where they are (an Admin whom a plain Admin cannot demote).
 */
export function memberRoleChoices(
  member: { readonly role: SpaceRole },
  assignableRoles: ReadonlyArray<SpaceRole>,
): ReadonlyArray<SpaceRole> {
  return assignableRoles.includes(member.role)
    ? assignableRoles
    : [member.role, ...assignableRoles];
}

/** «Managed by Keycloak (group X)»: a Membership a mapped Keycloak group gives (ticket 05). */
export const managedByKeycloakLabel = (member: { readonly keycloakGroup: string | null }) =>
  member.keycloakGroup === null
    ? "Managed by Keycloak"
    : `Managed by Keycloak (group ${member.keycloakGroup})`;

/** Why nobody changes, removes or leaves such a Membership in the Hub. */
export const MANAGED_BY_KEYCLOAK_HINT =
  "Its Role follows the Keycloak group: change the group in Keycloak, or the Owner changes its mapping.";

/** Why a Member a group put in can't leave from the Hub. */
export const LEAVE_MANAGED_HINT =
  "You are in this Organization through your Keycloak group, so you leave it by leaving the group.";

/**
 * Whether the viewer sees a managed Membership's controls held back, with why: they manage others
 * (an Admin or the Owner, who may assign Roles) and it is someone else's.
 */
export const heldByKeycloak = (
  member: { readonly managedByKeycloak: boolean; readonly isYou: boolean },
  assignableRoles: ReadonlyArray<SpaceRole>,
) => member.managedByKeycloak && !member.isYou && assignableRoles.length > 0;
