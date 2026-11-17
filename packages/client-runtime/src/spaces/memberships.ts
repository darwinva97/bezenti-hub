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
