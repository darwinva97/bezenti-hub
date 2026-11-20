// Invitations into an Organization, shared by web and mobile. Like Organizations, they are HTTP
// beside the User's account: who may invite depends on the User, and clients show the controls from
// the server's `canInvite` answer. Web authenticates with its cookie; mobile passes its Hub
// session as `headers`.
import type { InvitationId, InvitationStatus, SpaceId, SpaceRole } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import type { SessionHeaders } from "./memberships.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const listInvitations = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  headers: SessionHeaders = {},
) => client.invitations.list({ headers, params: { spaceId } });

export const createInvitation = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  role: SpaceRole,
  headers: SessionHeaders = {},
) => client.invitations.create({ headers, params: { spaceId }, payload: { role } });

export const revokeInvitation = (
  client: EnvironmentHttpClient,
  invitationId: InvitationId,
  headers: SessionHeaders = {},
) => client.invitations.revoke({ headers, payload: { invitationId } });

/**
 * The Owner's pending Platform invitations (Keycloak sign-in, ticket 04): Invitations to the Hub
 * without a Space. Revoked with `revokeInvitation`, as any Invitation.
 */
export const listPlatformInvitations = (
  client: EnvironmentHttpClient,
  headers: SessionHeaders = {},
) => client.platformInvitations.list({ headers });

export const createPlatformInvitation = (
  client: EnvironmentHttpClient,
  headers: SessionHeaders = {},
) => client.platformInvitations.create({ headers });

/** The link to hand the invitee. The token rides in the fragment, which never reaches a server log. */
export const invitationLink = (origin: string, token: string) =>
  `${origin.replace(/\/+$/, "")}/invite#token=${encodeURIComponent(token)}`;

/**
 * Whether the viewer may revoke an Invitation: only a pending one, and an Admin Invitation only
 * when the viewer may assign Admin (the Owner).
 */
export function canRevokeInvitation(
  invitation: { readonly status: InvitationStatus; readonly role: SpaceRole },
  assignableRoles: ReadonlyArray<SpaceRole>,
): boolean {
  return (
    invitation.status === "pending" &&
    (invitation.role !== "admin" || assignableRoles.includes("admin"))
  );
}

export const SPACE_ROLE_LABELS: Record<SpaceRole, string> = {
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};
