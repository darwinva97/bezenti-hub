import {
  type AcceptInvitationResult,
  type AuthAccount,
  type AuthOwnerBootstrapResult,
  type AuthOwnerBootstrapStatus,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeySignInCeremony,
  type AuthReauth,
  type AuthResetLinkStatus,
  type AuthTotpEnrollment,
  type InvitationPreview,
  type JoinInvitationResult,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
  EnvironmentModeChangeRefusedError,
  EnvironmentHttpForbiddenError,
  EnvironmentRateLimitedError,
} from "@t3tools/contracts";
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runPrimaryHttp } from "../../lib/runtime";
import { dropThemeCss } from "../../themeProposalApply";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

export class UserSignInError extends Schema.TaggedError<UserSignInError>()("UserSignInError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const isUserSignInError = Schema.is(UserSignInError);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentHttpConflictError = Schema.is(EnvironmentHttpConflictError);
// A machine that keeps Threads names them in its message.
const isEnvironmentModeChangeRefusedError = Schema.is(EnvironmentModeChangeRefusedError);
const isEnvironmentHttpForbiddenError = Schema.is(EnvironmentHttpForbiddenError);
const isEnvironmentRateLimitedError = Schema.is(EnvironmentRateLimitedError);

function toUserSignInError(cause: unknown, rejectedMessage: string): UserSignInError {
  if (isUserSignInError(cause)) return cause;
  if (
    isEnvironmentHttpConflictError(cause) ||
    isEnvironmentModeChangeRefusedError(cause) ||
    isEnvironmentHttpForbiddenError(cause) ||
    isEnvironmentRateLimitedError(cause)
  ) {
    return new UserSignInError({ message: cause.message, cause });
  }
  if (isEnvironmentHttpCommonError(cause)) {
    if (cause._tag === "EnvironmentAuthInvalidError") {
      return new UserSignInError({ message: rejectedMessage, cause });
    }
    if (cause._tag === "EnvironmentRequestInvalidError" && cause.reason === "invalid_origin") {
      return new UserSignInError({
        message: "Open this page from the Installation's own address to use a passkey.",
        cause,
      });
    }
    if (cause._tag === "EnvironmentRequestInvalidError" && cause.reason === "insecure_transport") {
      return new UserSignInError({
        message: "Open this Installation over HTTPS to sign in from this device.",
        cause,
      });
    }
  }
  if (
    cause instanceof WebAuthnError ||
    (cause instanceof Error && cause.name === "NotAllowedError")
  ) {
    return new UserSignInError({ message: "The passkey request was cancelled.", cause });
  }
  return new UserSignInError({ message: "Could not reach this Installation. Try again.", cause });
}

export async function request<A, E>(
  run: (client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>) => Effect.Effect<A, E>,
  rejectedMessage = "That sign-in was not accepted.",
): Promise<A> {
  try {
    return await runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(run)));
  } catch (cause) {
    throw toUserSignInError(cause, rejectedMessage);
  }
}

export function fetchOwnerBootstrapStatus(
  credential: string,
): Promise<AuthOwnerBootstrapStatus["status"]> {
  return request((client) => client.auth.ownerBootstrapStatus({ payload: { credential } })).then(
    (result) => result.status,
  );
}

/** Registers the Owner's passkey and signs this browser in; the codes are shown once. */
export async function createOwnerAccount(input: {
  readonly credential: string;
  readonly displayName: string;
}): Promise<AuthOwnerBootstrapResult> {
  const ceremony = await request((client) => client.auth.ownerRegistration({ payload: input }));
  const response = await registerPasskey(ceremony);
  return request(
    (client) =>
      client.auth.ownerBootstrap({
        payload: { credential: input.credential, ceremonyId: ceremony.ceremonyId, response },
      }),
    "This setup link expired or the passkey was not accepted. Restart the server for a new link.",
  );
}

async function registerPasskey(ceremony: AuthPasskeyRegistrationCeremony) {
  const registration = await startRegistration({
    optionsJSON: {
      ...ceremony.options,
      pubKeyCredParams: [...ceremony.options.pubKeyCredParams],
    },
  }).catch((cause: unknown) => {
    throw toUserSignInError(cause, "");
  });
  return {
    id: registration.id,
    rawId: registration.rawId,
    type: "public-key" as const,
    response: {
      clientDataJSON: registration.response.clientDataJSON,
      attestationObject: registration.response.attestationObject,
      ...(registration.response.transports ? { transports: registration.response.transports } : {}),
    },
  };
}

export async function fetchResetLinkStatus(token: string): Promise<AuthResetLinkStatus> {
  return request((client) => client.auth.resetLinkStatus({ payload: { token } }));
}

/** Registers a new passkey from a reset link, which is then spent, and signs this browser in. */
export async function resetPasskey(token: string): Promise<void> {
  const rejected = "This reset link expired or was already used. Issue a new one from the Hub.";
  const ceremony = await request(
    (client) => client.auth.resetLinkRegistration({ payload: { token } }),
    rejected,
  );
  const response = await registerPasskey(ceremony);
  await request(
    (client) =>
      client.auth.redeemResetLink({
        payload: { token, ceremonyId: ceremony.ceremonyId, response },
      }),
    rejected,
  );
}

/** Sets a new password from a reset link, which is then spent, and signs this browser in. */
export async function resetPassword(input: {
  readonly token: string;
  readonly loginName: string;
  readonly password: string;
}): Promise<void> {
  await request(
    (client) => client.auth.redeemResetLinkWithPassword({ payload: input }),
    "This reset link expired or was already used. Ask the Owner for a new one.",
  );
}

/** Signed in, or the TOTP challenge to answer with `signInWithTotp`. */
export async function signInWithPassword(input: {
  readonly loginName: string;
  readonly password: string;
}): Promise<{ readonly totpChallengeId: string } | "signed-in"> {
  const result = await request(
    (client) => client.auth.passwordSignIn({ payload: input }),
    "That sign-in name or password is not right.",
  );
  return result.authenticated ? "signed-in" : { totpChallengeId: result.challengeId };
}

export async function signInWithTotp(input: {
  readonly challengeId: string;
  readonly code: string;
}): Promise<void> {
  await request(
    (client) => client.auth.totpSignIn({ payload: input }),
    "That password or code is not right, or the code was already used. Start again.",
  );
}

export function fetchAccount(): Promise<AuthAccount> {
  return request((client) => client.auth.account({ headers: {} }));
}

/** Proof for a credential change: the current password (and code), or a passkey tap. */
export type StepUp =
  | { readonly method: "password"; readonly password: string; readonly totpCode?: string }
  | { readonly method: "passkey" }
  | { readonly method: "none" };

const STEP_UP_REJECTED = "Confirming it's you failed: check your password, code or passkey.";

export async function toReauth(stepUp: StepUp): Promise<AuthReauth | undefined> {
  if (stepUp.method === "none") return undefined;
  if (stepUp.method === "password") return stepUp;
  const ceremony = await request((client) => client.auth.passkeyChallenge({}));
  return { method: "passkey", ceremonyId: ceremony.ceremonyId, response: await assert(ceremony) };
}

export async function setAccountPassword(input: {
  readonly loginName: string;
  readonly password: string;
  readonly stepUp: StepUp;
}): Promise<AuthAccount> {
  const reauth = await toReauth(input.stepUp);
  return request(
    (client) =>
      client.auth.setPassword({
        headers: {},
        payload: {
          loginName: input.loginName,
          password: input.password,
          ...(reauth ? { reauth } : {}),
        },
      }),
    STEP_UP_REJECTED,
  );
}

export function startTotpEnrollment(): Promise<AuthTotpEnrollment> {
  return request((client) => client.auth.startTotpEnrollment({ headers: {} }));
}

export async function confirmTotpEnrollment(input: {
  readonly enrollmentId: string;
  readonly code: string;
  readonly stepUp: StepUp;
}): Promise<AuthAccount> {
  const reauth = await toReauth(input.stepUp);
  return request(
    (client) =>
      client.auth.confirmTotpEnrollment({
        headers: {},
        payload: {
          enrollmentId: input.enrollmentId,
          code: input.code,
          ...(reauth ? { reauth } : {}),
        },
      }),
    STEP_UP_REJECTED,
  );
}

export async function removeCredential(
  credential: "password" | "totp",
  stepUp: StepUp,
): Promise<AuthAccount> {
  const reauth = await toReauth(stepUp);
  if (reauth === undefined) throw new UserSignInError({ message: STEP_UP_REJECTED });
  return request(
    (client) =>
      credential === "password"
        ? client.auth.removePassword({ headers: {}, payload: { reauth } })
        : client.auth.removeTotp({ headers: {}, payload: { reauth } }),
    STEP_UP_REJECTED,
  );
}

async function assert(ceremony: AuthPasskeySignInCeremony) {
  const assertion = await startAuthentication({ optionsJSON: ceremony.options }).catch(
    (cause: unknown) => {
      throw toUserSignInError(cause, "");
    },
  );
  return {
    id: assertion.id,
    rawId: assertion.rawId,
    type: "public-key" as const,
    response: {
      clientDataJSON: assertion.response.clientDataJSON,
      authenticatorData: assertion.response.authenticatorData,
      signature: assertion.response.signature,
      ...(assertion.response.userHandle !== undefined
        ? { userHandle: assertion.response.userHandle }
        : {}),
    },
  };
}

export async function signInWithPasskey(): Promise<void> {
  const ceremony = await request((client) => client.auth.passkeyChallenge({}));
  const response = await assert(ceremony);
  await request(
    (client) =>
      client.auth.passkeySignIn({ payload: { ceremonyId: ceremony.ceremonyId, response } }),
    "That passkey is not registered on this Installation.",
  );
}

export async function signInWithRecoveryCode(code: string): Promise<void> {
  await request(
    (client) => client.auth.recoveryCodeSignIn({ payload: { code } }),
    "That recovery code is unknown or was already used.",
  );
}

export async function signOut(): Promise<void> {
  try {
    await request((client) => client.auth.signOut({ headers: {} }));
  } finally {
    // Custom theme CSS never outlives a session: whoever signs in next is not restyled by it.
    dropThemeCss();
  }
}

export function fetchInvitationPreview(token: string): Promise<InvitationPreview> {
  return request((client) => client.invitations.preview({ payload: { token } }));
}

/** An authenticator app for an invitee who picks a password; Admins need one. */
export function startInvitationTotpEnrollment(token: string): Promise<AuthTotpEnrollment> {
  return request((client) => client.invitations.totpEnrollment({ payload: { token } }));
}

/** Creates the User with a password (and TOTP code), spends the Invitation and signs in. */
export function acceptInvitationWithPassword(input: {
  readonly token: string;
  readonly displayName: string;
  readonly loginName: string;
  readonly password: string;
  readonly totp?: { readonly enrollmentId: string; readonly code: string };
}): Promise<AcceptInvitationResult> {
  return request((client) =>
    client.invitations.accept({ payload: { method: "password", ...input } }),
  );
}

/** Creates the User with a new passkey, spends the Invitation and signs in. */
export async function acceptInvitationWithPasskey(input: {
  readonly token: string;
  readonly displayName: string;
}): Promise<AcceptInvitationResult> {
  const ceremony = await request((client) => client.invitations.registration({ payload: input }));
  const response = await registerPasskey(ceremony);
  return request((client) =>
    client.invitations.accept({
      payload: { token: input.token, method: "passkey", ceremonyId: ceremony.ceremonyId, response },
    }),
  );
}

/** Adds the Invitation's Organization to the signed-in User. */
export function joinInvitation(token: string): Promise<JoinInvitationResult> {
  return request((client) => client.invitations.join({ headers: {}, payload: { token } }));
}
