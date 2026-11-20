import * as Schema from "effect/Schema";

import { AuthBrowserSessionResult } from "./auth.ts";
import { TrimmedNonEmptyString, TrimmedString, UserId } from "./baseSchemas.ts";

export const AuthUser = Schema.Struct({
  id: UserId,
  displayName: TrimmedNonEmptyString,
  isOwner: Schema.Boolean,
});
export type AuthUser = typeof AuthUser.Type;

export const AuthOwnerBootstrapStatusRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthOwnerBootstrapStatusRequest = typeof AuthOwnerBootstrapStatusRequest.Type;

/**
 * `available`: the credential is the administrative bootstrap link and no Owner exists yet.
 * `claimed`: the credential is the administrative bootstrap link but the Owner already exists.
 * `spent`: the administrative bootstrap link, already used, revoked or expired.
 * `not-applicable`: any other credential, which pairs as before.
 */
export const AuthOwnerBootstrapStatus = Schema.Struct({
  status: Schema.Literals(["available", "claimed", "spent", "not-applicable"]),
});
export type AuthOwnerBootstrapStatus = typeof AuthOwnerBootstrapStatus.Type;

// The subset of the WebAuthn JSON options this server emits, shaped for `@simplewebauthn/browser`.
export const AuthPasskeyCreationOptions = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  rp: Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  user: Schema.Struct({
    id: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    displayName: TrimmedNonEmptyString,
  }),
  pubKeyCredParams: Schema.Array(
    Schema.Struct({ alg: Schema.Number, type: Schema.Literal("public-key") }),
  ),
  timeout: Schema.Number,
  authenticatorSelection: Schema.Struct({
    residentKey: Schema.Literal("required"),
    requireResidentKey: Schema.Literal(true),
    userVerification: Schema.Literal("preferred"),
  }),
  attestation: Schema.Literal("none"),
});
export type AuthPasskeyCreationOptions = typeof AuthPasskeyCreationOptions.Type;

export const AuthPasskeyRequestOptions = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  rpId: TrimmedNonEmptyString,
  timeout: Schema.Number,
  userVerification: Schema.Literal("preferred"),
});
export type AuthPasskeyRequestOptions = typeof AuthPasskeyRequestOptions.Type;

export const AuthPasskeyRegistrationCeremony = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  options: AuthPasskeyCreationOptions,
});
export type AuthPasskeyRegistrationCeremony = typeof AuthPasskeyRegistrationCeremony.Type;

export const AuthPasskeySignInCeremony = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  options: AuthPasskeyRequestOptions,
});
export type AuthPasskeySignInCeremony = typeof AuthPasskeySignInCeremony.Type;

export const AuthPasskeyRegistrationResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  rawId: TrimmedNonEmptyString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: TrimmedNonEmptyString,
    attestationObject: TrimmedNonEmptyString,
    transports: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});
export type AuthPasskeyRegistrationResponse = typeof AuthPasskeyRegistrationResponse.Type;

export const AuthPasskeyAuthenticationResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  rawId: TrimmedNonEmptyString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: TrimmedNonEmptyString,
    authenticatorData: TrimmedNonEmptyString,
    signature: TrimmedNonEmptyString,
    userHandle: Schema.optionalKey(Schema.String),
  }),
});
export type AuthPasskeyAuthenticationResponse = typeof AuthPasskeyAuthenticationResponse.Type;

export const AuthOwnerRegistrationRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type AuthOwnerRegistrationRequest = typeof AuthOwnerRegistrationRequest.Type;

export const AuthOwnerBootstrapRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  ceremonyId: TrimmedNonEmptyString,
  response: AuthPasskeyRegistrationResponse,
});
export type AuthOwnerBootstrapRequest = typeof AuthOwnerBootstrapRequest.Type;

export const AuthOwnerBootstrapResult = Schema.Struct({
  session: AuthBrowserSessionResult,
  user: AuthUser,
  /** Shown once; the server keeps only their hashes. */
  recoveryCodes: Schema.Array(TrimmedNonEmptyString),
});
export type AuthOwnerBootstrapResult = typeof AuthOwnerBootstrapResult.Type;

export const AuthPasskeySignInRequest = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  response: AuthPasskeyAuthenticationResponse,
});
export type AuthPasskeySignInRequest = typeof AuthPasskeySignInRequest.Type;

export const AuthRecoveryCodeSignInRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
});
export type AuthRecoveryCodeSignInRequest = typeof AuthRecoveryCodeSignInRequest.Type;

export const AuthSignOutResult = Schema.Struct({
  signedOut: Schema.Boolean,
});
export type AuthSignOutResult = typeof AuthSignOutResult.Type;

/** How a User names themselves at password sign-in; unique in the Installation, ignoring case. */
export const AuthLoginName = TrimmedString.check(Schema.isPattern(/^[A-Za-z0-9][\w.-]{1,39}$/));

export const AuthPassword = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(256));

export const AuthTotpCode = Schema.String.check(Schema.isPattern(/^\d{6}$/));

/**
 * A linked Keycloak account, as the account page shows it: its user name and email (labels, as
 * Keycloak last sent them) and the realm's own account page, where the password and MFA change.
 */
export const AuthLinkedIdentity = Schema.Struct({
  username: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  accountUrl: Schema.String,
});
export type AuthLinkedIdentity = typeof AuthLinkedIdentity.Type;

export const AuthAccount = Schema.Struct({
  user: AuthUser,
  loginName: Schema.NullOr(Schema.String),
  hasPasskey: Schema.Boolean,
  hasPassword: Schema.Boolean,
  totpEnrolled: Schema.Boolean,
  /** This account may sign in with a password only together with a TOTP code. */
  passwordRequiresTotp: Schema.Boolean,
  /** The Keycloak account this User signs in with (Keycloak sign-in spec, ticket 02). */
  identity: Schema.optionalKey(AuthLinkedIdentity),
  /**
   * Without an identity, whether «Connect Keycloak» is open to this account: `allowed`; `admins-later`
   * for an Admin other than the Owner (their strong factor from Keycloak comes with ticket 06);
   * `needs-reset` for an account with no passkey or password to confirm with.
   */
  keycloakLink: Schema.optionalKey(Schema.Literals(["allowed", "admins-later", "needs-reset"])),
});
export type AuthAccount = typeof AuthAccount.Type;

/**
 * Proof, in the same request, that the person changing credentials can sign in now: the current
 * password (and TOTP code when enrolled), or a fresh assertion from one of the account's passkeys
 * (its challenge comes from `/api/auth/passkey/challenge`).
 */
export const AuthReauth = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("password"),
    password: Schema.String.check(Schema.isMaxLength(256)),
    totpCode: Schema.optionalKey(AuthTotpCode),
  }),
  Schema.Struct({
    method: Schema.Literal("passkey"),
    ceremonyId: TrimmedNonEmptyString,
    response: AuthPasskeyAuthenticationResponse,
  }),
]);
export type AuthReauth = typeof AuthReauth.Type;

export const AuthSetPasswordRequest = Schema.Struct({
  loginName: AuthLoginName,
  password: AuthPassword,
  /** Required unless the account has no way to sign in yet. */
  reauth: Schema.optionalKey(AuthReauth),
});
export type AuthSetPasswordRequest = typeof AuthSetPasswordRequest.Type;

export const AuthTotpEnrollment = Schema.Struct({
  enrollmentId: TrimmedNonEmptyString,
  /** Base32, for authenticator apps that cannot scan the QR code. */
  secret: TrimmedNonEmptyString,
  otpauthUri: TrimmedNonEmptyString,
});
export type AuthTotpEnrollment = typeof AuthTotpEnrollment.Type;

export const AuthTotpConfirmRequest = Schema.Struct({
  enrollmentId: TrimmedNonEmptyString,
  code: AuthTotpCode,
  reauth: Schema.optionalKey(AuthReauth),
});
export type AuthTotpConfirmRequest = typeof AuthTotpConfirmRequest.Type;

export const AuthCredentialRemovalRequest = Schema.Struct({ reauth: AuthReauth });
export type AuthCredentialRemovalRequest = typeof AuthCredentialRemovalRequest.Type;

export const AuthPasswordSignInRequest = Schema.Struct({
  loginName: Schema.String.check(Schema.isMaxLength(64)),
  password: Schema.String.check(Schema.isMaxLength(256)),
});
export type AuthPasswordSignInRequest = typeof AuthPasswordSignInRequest.Type;

/**
 * The account also needs a TOTP code: send it with `challengeId` to `/api/auth/password/totp`.
 * Accounts with TOTP get this answer whether or not the password was right.
 */
export const AuthSecondFactorRequired = Schema.Struct({
  authenticated: Schema.Literal(false),
  secondFactor: Schema.Literal("totp"),
  challengeId: TrimmedNonEmptyString,
});
export type AuthSecondFactorRequired = typeof AuthSecondFactorRequired.Type;

export const AuthPasswordSignInResult = Schema.Union([
  AuthBrowserSessionResult,
  AuthSecondFactorRequired,
]);
export type AuthPasswordSignInResult = typeof AuthPasswordSignInResult.Type;

export const AuthTotpSignInRequest = Schema.Struct({
  challengeId: TrimmedNonEmptyString,
  code: AuthTotpCode,
});
export type AuthTotpSignInRequest = typeof AuthTotpSignInRequest.Type;

export const AuthResetLinkRequest = Schema.Struct({ token: TrimmedNonEmptyString });
export type AuthResetLinkRequest = typeof AuthResetLinkRequest.Type;

export const AuthResetLinkStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("valid"),
    displayName: Schema.String,
    /** The account's sign-in name, if it has one, to keep when setting a new password. */
    loginName: Schema.optional(Schema.NullOr(Schema.String)),
    /** Whether the link may set a password instead of a passkey (not for the Owner). */
    passwordAllowed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ status: Schema.Literal("invalid") }),
]);
export type AuthResetLinkStatus = typeof AuthResetLinkStatus.Type;

export const AuthResetLinkRedeemRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
  ceremonyId: TrimmedNonEmptyString,
  response: AuthPasskeyRegistrationResponse,
});
export type AuthResetLinkRedeemRequest = typeof AuthResetLinkRedeemRequest.Type;

export const AuthResetLinkPasswordRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
  loginName: AuthLoginName,
  password: AuthPassword,
});
export type AuthResetLinkPasswordRequest = typeof AuthResetLinkPasswordRequest.Type;
