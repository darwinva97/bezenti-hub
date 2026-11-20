/**
 * The Platform's sign-in settings (Keycloak sign-in spec, ticket 01): the Registration mode, local
 * sign-in for everyone but the Owner, and the Keycloak client. The Owner's alone. The client secret
 * enters only in an update (Redacted) and never leaves the Hub: a read says whether one is saved.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, SpaceId } from "./baseSchemas.ts";
import { SpaceRole } from "./spaces.ts";
import { AuthReauth } from "./userAccounts.ts";

/**
 * Who may get a new User: anyone who signs in (`open`), someone with an Invitation or a mapped
 * Keycloak group (`invitation-only`, today's behaviour), or only a Platform invitation (`closed`).
 */
export const RegistrationMode = Schema.Literals(["open", "invitation-only", "closed"]);
export type RegistrationMode = typeof RegistrationMode.Type;

/** The realm's address, as Keycloak names it in `iss`: `https://auth.example.com/realms/acme`. */
const MAX_ISSUER_LENGTH = 2048;
const MAX_CLIENT_ID_LENGTH = 255;
const MAX_CLIENT_SECRET_LENGTH = 1024;
/** The longest claim name or strong-factor value; a longer `acr` or `amr` can never match. */
export const MAX_CLAIM_LENGTH = 100;
/** The most values in each strong-factor list. */
export const MAX_STRONG_VALUES = 20;

const StrongValues = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CLAIM_LENGTH)),
).check(Schema.isMaxLength(MAX_STRONG_VALUES));

export const KeycloakSettings = Schema.Struct({
  /** Whether «Sign in with Keycloak» is offered; turning it off keeps the rest. */
  enabled: Schema.Boolean,
  issuer: Schema.NullOr(Schema.String),
  clientId: Schema.NullOr(Schema.String),
  /** Whether the Hub holds a client secret; the secret itself is never read back. */
  clientSecretSet: Schema.Boolean,
  /** When the secret was last saved, for «Saved · replaced on …». */
  clientSecretUpdatedAt: Schema.NullOr(IsoDateTime),
  /** The ID token claim with the person's groups (ticket 05). */
  groupsClaim: Schema.String,
  /**
   * `acr` and `amr` values that count as a strong factor (ticket 06): a Keycloak sign-in is strong
   * when its `acr` is one of the first or any of its `amr` one of the second, exactly. Empty, no
   * Keycloak sign-in is strong. E.g. `critica`, a realm's level of authentication for MFA.
   */
  strongAcr: Schema.Array(Schema.String),
  strongAmr: Schema.Array(Schema.String),
});
export type KeycloakSettings = typeof KeycloakSettings.Type;

/** The longest Keycloak group name a mapping names (a full path such as `/acme/dev` included). */
export const MAX_GROUP_LENGTH = 255;
/** The most group mappings the Owner keeps. */
const MAX_GROUP_MAPPINGS = 200;

/**
 * A Keycloak group mapped to an Organization and a Role (ticket 05): who signs in with the group
 * is in the Organization with that Role, managed by Keycloak. `group` is kept without a leading
 * `/`, and matches the token's group with or without one.
 */
export const KeycloakGroupMappingInput = Schema.Struct({
  group: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_GROUP_LENGTH + 1)),
  spaceId: SpaceId,
  role: SpaceRole,
});
export type KeycloakGroupMappingInput = typeof KeycloakGroupMappingInput.Type;

export const KeycloakGroupMapping = Schema.Struct({
  group: Schema.String,
  spaceId: SpaceId,
  organizationName: Schema.String,
  role: SpaceRole,
  /**
   * Whether the sign-in applies it: only while the Owner is the Steward of the
   * Organization, so a group never puts the Owner into someone else's Organization (ADR 0008).
   * A disabled one is shown with a warning and applies nothing.
   */
  enabled: Schema.Boolean,
  /** Archived Organizations are left as they are until restored. */
  archived: Schema.Boolean,
});
export type KeycloakGroupMapping = typeof KeycloakGroupMapping.Type;

/** An Organization a new mapping may name: not archived, and the Owner its Steward. */
export const MappableOrganization = Schema.Struct({
  spaceId: SpaceId,
  name: Schema.String,
});
export type MappableOrganization = typeof MappableOrganization.Type;

/**
 * Keycloak's re-checks for the Owner's warnings (ticket 07): the first failure since the last good
 * one and why (`unreachable`: no answer or a 5xx; `rejected`: the Hub's client refused, such as a
 * wrong secret), and whether the newest sign-in got `offline_access` (null before any).
 */
export const KeycloakStatus = Schema.Struct({
  unreachableSince: Schema.NullOr(IsoDateTime),
  problem: Schema.NullOr(Schema.Literals(["unreachable", "rejected"])),
  lastLoginOffline: Schema.NullOr(Schema.Boolean),
});
export type KeycloakStatus = typeof KeycloakStatus.Type;

export const SignInSettings = Schema.Struct({
  registrationMode: RegistrationMode,
  /** Whether a User other than the Owner may sign in with a passkey or password (ticket 08). */
  localSignInForMembers: Schema.Boolean,
  keycloak: KeycloakSettings,
  /** Keycloak groups mapped to Organizations and Roles (ticket 05). */
  groupMappings: Schema.Array(KeycloakGroupMapping),
  mappableOrganizations: Schema.Array(MappableOrganization),
  /** `T3CODE_PUBLIC_URL`'s origin: the base of the URLs to give Keycloak; else the page's own. */
  publicOrigin: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
  /** Ticket 07: Keycloak's re-checks and the newest sign-in's `offline_access`. */
  keycloakStatus: Schema.optionalKey(KeycloakStatus),
});
export type SignInSettings = typeof SignInSettings.Type;

/**
 * A change to the settings: what is left out stays. `clientSecret` is write-only and Redacted, so
 * no log, span or error shows it; leaving it out keeps the saved one. There is no way to clear it,
 * only to replace it.
 */
export const UpdateSignInSettingsRequest = Schema.Struct({
  registrationMode: Schema.optionalKey(RegistrationMode),
  localSignInForMembers: Schema.optionalKey(Schema.Boolean),
  keycloakEnabled: Schema.optionalKey(Schema.Boolean),
  issuer: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_ISSUER_LENGTH))),
  clientId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_CLIENT_ID_LENGTH))),
  clientSecret: Schema.optionalKey(
    Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(MAX_CLIENT_SECRET_LENGTH))),
  ),
  groupsClaim: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_CLAIM_LENGTH))),
  strongAcr: Schema.optionalKey(StrongValues),
  strongAmr: Schema.optionalKey(StrongValues),
  /** The whole list of group mappings (ticket 05); left out keeps the saved one. */
  groupMappings: Schema.optionalKey(
    Schema.Array(KeycloakGroupMappingInput).check(Schema.isMaxLength(MAX_GROUP_MAPPINGS)),
  ),
  /**
   * A change to the strong-factor lists ends the Keycloak sign-ins of the Owner and Admins that
   * stop being strong (ticket 06). Without this, a change that would end any is refused (409) with
   * how many, so the Owner confirms first.
   */
  endLoginsConfirmed: Schema.optionalKey(Schema.Boolean),
});
export type UpdateSignInSettingsRequest = typeof UpdateSignInSettingsRequest.Type;

/** Which part of «Check» failed: the address itself, the discovery document, or the key set. */
export const KeycloakCheckStep = Schema.Literals(["issuer", "discovery", "keys"]);
export type KeycloakCheckStep = typeof KeycloakCheckStep.Type;

export const KeycloakCheckFailureReason = Schema.Literals([
  /** Nothing to check yet: no issuer saved. */
  "not-configured",
  /** Not an https address (http only on this machine's loopback), or with a query or user. */
  "invalid-issuer",
  /** No connection: DNS, refused, TLS. */
  "unreachable",
  "timeout",
  /** Keycloak answered with a redirect; the Hub never follows one. */
  "redirect",
  /** Any status but 200. */
  "http-status",
  "too-large",
  /** Not JSON, or not an OpenID Connect discovery document or key set. */
  "invalid-document",
  /** The discovery document names another issuer. */
  "issuer-mismatch",
  /** The key set or token endpoint is on another host than the issuer. */
  "endpoint-off-issuer",
  /** The key set holds no key the Hub verifies with (RS256, PS256, ES256, EdDSA). */
  "no-usable-keys",
]);
export type KeycloakCheckFailureReason = typeof KeycloakCheckFailureReason.Type;

/** «Check»: whether the realm's discovery document and key set answer, and what they offer. */
export const KeycloakCheckResult = Schema.Union([
  Schema.TaggedStruct("ok", {
    issuer: Schema.String,
    /** Keys the Hub can verify ID tokens with. */
    signingKeys: Schema.Number,
    backchannelLogoutSupported: Schema.Boolean,
    /** Whether `offline_access` is among the realm's scopes (a 30-day refresh, ticket 07). */
    offlineAccessOffered: Schema.Boolean,
    /** The realm's `acr` values, for the strong-factor list (ticket 06). */
    acrValuesSupported: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("failed", {
    step: KeycloakCheckStep,
    reason: KeycloakCheckFailureReason,
    /** In plain words, for the Owner. */
    message: Schema.String,
  }),
]);
export type KeycloakCheckResult = typeof KeycloakCheckResult.Type;

/** Where Keycloak sends the browser back after sign-in (the client's «Valid redirect URIs»). */
export const KEYCLOAK_CALLBACK_PATH = "/oauth/keycloak/callback";
/** Where Keycloak posts a logout token (the client's «Backchannel logout URL»). */
export const KEYCLOAK_BACKCHANNEL_LOGOUT_PATH = "/oauth/keycloak/backchannel-logout";
/** Where Keycloak sends the browser after signing out (the client's «Valid post logout redirect URIs»). */
export const KEYCLOAK_POST_LOGOUT_PATH = "/sign-in";

/** The three URLs the Owner pastes into the Keycloak client, from the Hub's base address. */
export const keycloakClientUrls = (base: string) => {
  const origin = new URL(base).origin;
  return {
    redirect: `${origin}${KEYCLOAK_CALLBACK_PATH}`,
    backchannelLogout: `${origin}${KEYCLOAK_BACKCHANNEL_LOGOUT_PATH}`,
    postLogout: `${origin}${KEYCLOAK_POST_LOGOUT_PATH}`,
  };
};

/**
 * Why a Keycloak flow starts (spec, «Intenciones del flujo»): `sign-in` and `invitation` (with its
 * token) without a session; `link` and `step-up` with the browser's own. `step-up` signs nobody
 * in: it comes back with a single-use proof in the fragment (`KEYCLOAK_PROOF_FRAGMENT_PARAM`).
 */
export const KeycloakFlowIntent = Schema.Literals(["sign-in", "link", "invitation", "step-up"]);
export type KeycloakFlowIntent = typeof KeycloakFlowIntent.Type;

/** The longest path the browser may come back to. */
const MAX_RETURN_TO_LENGTH = 2048;

/**
 * Starts a flow. `returnTo` is where the browser lands after the callback: a path on this Hub
 * (one leading `/`, no `//`, no `\`), or the start is refused. `reauth` is the `link` proof.
 * `invitationToken` comes with `invitation` and only with it: the Hub checks it before the flow
 * leaves for Keycloak and keeps it on its side, never in the address it answers.
 */
export const KeycloakStartRequest = Schema.Struct({
  intent: KeycloakFlowIntent,
  returnTo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_RETURN_TO_LENGTH))),
  reauth: Schema.optionalKey(AuthReauth),
  invitationToken: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
  /**
   * Ask Keycloak for a strong factor (ticket 06): the realm is sent `acr_values` (the Owner's
   * strong `acr` list) and `prompt=login`. «Retry with second factor», and a `step-up` for an
   * action that needs a strong one. It only shapes the request: whether the sign-in was strong is
   * read from the verified ID token, never from this.
   */
  strongFactor: Schema.optionalKey(Schema.Boolean),
});
export type KeycloakStartRequest = typeof KeycloakStartRequest.Type;

/** Where the browser goes next: the realm's sign-in page. */
export const KeycloakStartResult = Schema.Struct({ authorizationUrl: Schema.String });
export type KeycloakStartResult = typeof KeycloakStartResult.Type;

/**
 * «Salir también de Keycloak» (ticket 07): the handle the sign-out answered. Spending it ends that
 * Keycloak sign-in, with the apps, MCP clients and pairing links approved from it.
 */
export const KeycloakSignOutRequest = Schema.Struct({
  handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type KeycloakSignOutRequest = typeof KeycloakSignOutRequest.Type;

/** Where the browser goes to leave Keycloak too; null when the realm offers no such address. */
export const KeycloakSignOutResult = Schema.Struct({ endSessionUrl: Schema.NullOr(Schema.String) });
export type KeycloakSignOutResult = typeof KeycloakSignOutResult.Type;

/** The fragment parameter of `/sign-in` that carries the sign-out's handle to the page. */
export const KEYCLOAK_SIGN_OUT_FRAGMENT_PARAM = "keycloak-sign-out";

/** The query parameter the callback adds to the page it sends a refused browser to. */
export const KEYCLOAK_RESULT_PARAM = "keycloak";

/**
 * Why a callback did not sign in (`?keycloak=<code>`): admission (ticket 03: invitation only,
 * closed, a dead Invitation, or what `/api/invitations/join` refuses), a disabled, removed or
 * taken account, a cancel, a back-off, Keycloak unreachable, or a failed check (never which one).
 * None says whether some other account exists.
 */
export const KeycloakSignInFailure = Schema.Literals([
  "unknown",
  "invitation-only",
  "registration-closed",
  "invitation-invalid",
  "already-member",
  "owner",
  // Ticket 04: a Platform invitation opened by who already has a User; it stays unspent.
  "has-account",
  "strong-factor-required",
  "disabled",
  "removed",
  "taken",
  // Ticket 06: a `step-up` signed in at Keycloak as someone else than the session's User.
  "identity-mismatch",
  "cancelled",
  "throttled",
  "unavailable",
  "failed",
]);
export type KeycloakSignInFailure = typeof KeycloakSignInFailure.Type;
