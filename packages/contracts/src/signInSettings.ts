/**
 * The Platform's sign-in settings (Keycloak sign-in spec, ticket 01): the Registration mode, local
 * sign-in for everyone but the Owner, and the Keycloak client. The Owner's alone. The client secret
 * enters only in an update (Redacted) and never leaves the Hub: a read says whether one is saved.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

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
const MAX_CLAIM_LENGTH = 100;
const MAX_STRONG_VALUES = 20;

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
  /** `acr` and `amr` values that count as a strong factor (ticket 06). */
  strongAcr: Schema.Array(Schema.String),
  strongAmr: Schema.Array(Schema.String),
});
export type KeycloakSettings = typeof KeycloakSettings.Type;

export const SignInSettings = Schema.Struct({
  registrationMode: RegistrationMode,
  /** Whether a User other than the Owner may sign in with a passkey or password (ticket 08). */
  localSignInForMembers: Schema.Boolean,
  keycloak: KeycloakSettings,
  /** `T3CODE_PUBLIC_URL`'s origin: the base of the URLs to give Keycloak; else the page's own. */
  publicOrigin: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
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
const KEYCLOAK_CALLBACK_PATH = "/oauth/keycloak/callback";
/** Where Keycloak posts a logout token (the client's «Backchannel logout URL»). */
const KEYCLOAK_BACKCHANNEL_LOGOUT_PATH = "/oauth/keycloak/backchannel-logout";
/** Where Keycloak sends the browser after signing out (the client's «Valid post logout redirect URIs»). */
const KEYCLOAK_POST_LOGOUT_PATH = "/sign-in";

/** The three URLs the Owner pastes into the Keycloak client, from the Hub's base address. */
export const keycloakClientUrls = (base: string) => {
  const origin = new URL(base).origin;
  return {
    redirect: `${origin}${KEYCLOAK_CALLBACK_PATH}`,
    backchannelLogout: `${origin}${KEYCLOAK_BACKCHANNEL_LOGOUT_PATH}`,
    postLogout: `${origin}${KEYCLOAK_POST_LOGOUT_PATH}`,
  };
};
