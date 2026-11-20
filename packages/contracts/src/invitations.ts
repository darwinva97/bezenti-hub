import * as Schema from "effect/Schema";

import { AuthBrowserSessionResult } from "./auth.ts";
import { makeEntityId, SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";
import { SpaceRole } from "./spaces.ts";
import {
  AuthLoginName,
  AuthPassword,
  AuthPasskeyRegistrationResponse,
  AuthTotpCode,
} from "./userAccounts.ts";

export const InvitationId = makeEntityId("InvitationId");
export type InvitationId = typeof InvitationId.Type;

// The link's secret: 32 random bytes in base64url. Unauthenticated endpoints take it, so it is bounded.
export const InvitationToken = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const InvitationStatus = Schema.Literals(["pending", "accepted", "expired", "revoked"]);
export type InvitationStatus = typeof InvitationStatus.Type;

/** An Invitation as the people who manage an Organization's Invitations see it. */
export const InvitationSummary = Schema.Struct({
  id: InvitationId,
  spaceId: SpaceId,
  role: SpaceRole,
  status: InvitationStatus,
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  acceptedByName: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.DateTimeUtc),
  revokedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type InvitationSummary = typeof InvitationSummary.Type;

/**
 * A Platform invitation as the Owner sees it (Keycloak sign-in spec, ticket 04): an Invitation to
 * the Hub itself, without a Space or a Role. Accepting it creates a User and nothing more.
 */
export const PlatformInvitationSummary = Schema.Struct({
  id: InvitationId,
  kind: Schema.Literal("platform"),
  status: InvitationStatus,
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  acceptedByName: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.DateTimeUtc),
  revokedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type PlatformInvitationSummary = typeof PlatformInvitationSummary.Type;

export const CreatedPlatformInvitation = Schema.Struct({
  invitation: PlatformInvitationSummary,
  /** Shown once: the server keeps only its hash. The link is `<origin>/invite#token=<token>`. */
  token: TrimmedNonEmptyString,
});
export type CreatedPlatformInvitation = typeof CreatedPlatformInvitation.Type;

/** The pending Platform invitations; the audit log keeps the rest. */
export const PlatformInvitationList = Schema.Struct({
  invitations: Schema.Array(PlatformInvitationSummary),
});
export type PlatformInvitationList = typeof PlatformInvitationList.Type;

/** What revoking answers: the Invitation as its list shows it. */
export const RevokedInvitation = Schema.Union([InvitationSummary, PlatformInvitationSummary]);
export type RevokedInvitation = typeof RevokedInvitation.Type;

export const CreateInvitationRequest = Schema.Struct({ role: SpaceRole });
export type CreateInvitationRequest = typeof CreateInvitationRequest.Type;

export const CreatedInvitation = Schema.Struct({
  invitation: InvitationSummary,
  /** Shown once: the server keeps only its hash. The link is `<origin>/invite#token=<token>`. */
  token: TrimmedNonEmptyString,
});
export type CreatedInvitation = typeof CreatedInvitation.Type;

export const InvitationList = Schema.Struct({ invitations: Schema.Array(InvitationSummary) });
export type InvitationList = typeof InvitationList.Type;

export const RevokeInvitationRequest = Schema.Struct({ invitationId: InvitationId });
export type RevokeInvitationRequest = typeof RevokeInvitationRequest.Type;

export const InvitationTokenRequest = Schema.Struct({ token: InvitationToken });
export type InvitationTokenRequest = typeof InvitationTokenRequest.Type;

/**
 * What the invitee sees before accepting. Expired, revoked, used and unknown links, and links into
 * an archived Organization, all answer `invalid` alike. A Platform invitation (ticket 04) names
 * no Organization and no Role: the page names the Hub it was opened on.
 */
export const InvitationPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("valid"),
    kind: Schema.Literal("organization"),
    organizationName: Schema.String,
    role: SpaceRole,
    inviterName: Schema.String,
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({
    status: Schema.Literal("valid"),
    kind: Schema.Literal("platform"),
    inviterName: Schema.String,
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({ status: Schema.Literal("invalid") }),
]);
export type InvitationPreview = typeof InvitationPreview.Type;

const InviteeDisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const InvitationRegistrationRequest = Schema.Struct({
  token: InvitationToken,
  displayName: InviteeDisplayName,
});
export type InvitationRegistrationRequest = typeof InvitationRegistrationRequest.Type;

/** Creates a new User from the Invitation, with a passkey or a password (plus TOTP for Admins). */
export const AcceptInvitationRequest = Schema.Union([
  Schema.Struct({
    token: InvitationToken,
    method: Schema.Literal("passkey"),
    ceremonyId: BoundedId,
    response: AuthPasskeyRegistrationResponse,
  }),
  Schema.Struct({
    token: InvitationToken,
    method: Schema.Literal("password"),
    displayName: InviteeDisplayName,
    loginName: AuthLoginName,
    password: AuthPassword,
    /** Required for an Admin Invitation: a code from the enrollment started for this link. */
    totp: Schema.optionalKey(Schema.Struct({ enrollmentId: BoundedId, code: AuthTotpCode })),
  }),
]);
export type AcceptInvitationRequest = typeof AcceptInvitationRequest.Type;

export const AcceptInvitationResult = Schema.Struct({
  session: AuthBrowserSessionResult,
  userId: UserId,
  /** The Organization joined; null for a Platform invitation, which joins none. */
  spaceId: Schema.NullOr(SpaceId),
});
export type AcceptInvitationResult = typeof AcceptInvitationResult.Type;

/** A signed-in User adding the Invitation's Organization to their own User. */
export const JoinInvitationResult = Schema.Struct({ userId: UserId, spaceId: SpaceId });
export type JoinInvitationResult = typeof JoinInvitationResult.Type;
