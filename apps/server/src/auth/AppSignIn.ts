import type {
  AuthAccessTokenResult,
  AuthEnvironmentScope,
  AuthAppSignInApproveRequest,
  AuthAppSignInTokenRequest,
  UserId,
} from "@t3tools/contracts";
import {
  appSignInCallbackUrl,
  appSignInRedirectKind,
  isAppSignInCodeChallenge,
  isAppSignInState,
} from "@t3tools/shared/appSignIn";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeGrantStore, makePkce } from "./pkceGrants.ts";
import type { AuthRequestMetadata } from "./utils.ts";

// Desktop and mobile sign-in through the system browser (RFC 8252): a browser session approves a
// one-time code bound to the app's PKCE challenge and redirect; the app exchanges it with its
// verifier for a session of that User. See docs/internals/environment-auth.md#app-sign-in.

/** Long enough for the browser to hand the code back, short enough that a leaked one is stale. */
const APP_SIGN_IN_CODE_TTL_MS = 60_000;
const MAX_PENDING_CODES = 1_000;

interface PendingCode {
  readonly userId: UserId;
  /** The approving browser session's scopes; the app gets no more than these. */
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly clientLabel: string | undefined;
  /** The approving session's Keycloak sign-in (ticket 07): the app's session ends with it. */
  readonly identityLoginId: string | undefined;
  readonly expiresAtMs: number;
}

export class AppSignInRequestError extends Schema.TaggedError<AppSignInRequestError>()(
  "AppSignInRequestError",
  { reason: Schema.Literals(["invalid_redirect_uri", "invalid_code_challenge"]) },
) {}

/** The approving request carried no browser session of a User. */
export class AppSignInNotSignedInError extends Schema.TaggedError<AppSignInNotSignedInError>()(
  "AppSignInNotSignedInError",
  {},
) {
  override get message(): string {
    return "Sign in to this Hub in the browser first.";
  }
}

/** Unknown, used, expired, or presented with the wrong verifier or redirect: all look alike. */
export class AppSignInInvalidGrantError extends Schema.TaggedError<AppSignInInvalidGrantError>()(
  "AppSignInInvalidGrantError",
  {},
) {
  override get message(): string {
    return "The sign-in code is invalid or expired. Sign in again.";
  }
}

export class AppSignIn extends Context.Service<
  AppSignIn,
  {
    /** Approves with the request's browser session and answers the redirect back to the app. */
    readonly approve: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthAppSignInApproveRequest,
    ) => Effect.Effect<
      string,
      AppSignInRequestError | AppSignInNotSignedInError | EnvironmentAuth.ServerAuthInternalError
    >;
    readonly exchange: (input: {
      readonly token: AuthAppSignInTokenRequest;
      /** The requesting client, with the label, device type and OS the app presented. */
      readonly client: AuthRequestMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<
      AuthAccessTokenResult,
      | AppSignInInvalidGrantError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInsecureTransportError
      | EnvironmentAuth.ServerAuthInternalError
    >;
  }
>()("t3/auth/AppSignIn") {}

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const audit = yield* AuditLog.AuditLog;
  const random = yield* SecureRandom.SecureRandom;
  const { sha256, verifies: pkceVerifies } = yield* makePkce;
  // Keyed by the code's SHA-256, so the codes themselves are never held.
  const codes = yield* makeGrantStore<PendingCode>(MAX_PENDING_CODES);

  const approve: AppSignIn["Service"]["approve"] = Effect.fn("AppSignIn.approve")(
    function* (request, input) {
      if (appSignInRedirectKind(input.redirectUri) === null) {
        return yield* new AppSignInRequestError({ reason: "invalid_redirect_uri" });
      }
      if (!isAppSignInCodeChallenge(input.codeChallenge) || !isAppSignInState(input.state)) {
        return yield* new AppSignInRequestError({ reason: "invalid_code_challenge" });
      }
      // Only the browser's own cookie approves (its origin is checked with it), never a token an
      // app already holds, so every app session traces back to a sign-in in a browser.
      const session = yield* environmentAuth
        .authenticateBrowserSession(request)
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
            Effect.fail(new AppSignInNotSignedInError({})),
          ),
        );
      if (session.userId === undefined) return yield* new AppSignInNotSignedInError({});
      const now = yield* Clock.currentTimeMillis;
      const code = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      const key = yield* sha256(code);
      const pending: PendingCode = {
        userId: session.userId,
        scopes: session.scopes,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        clientLabel: input.clientLabel?.slice(0, 80),
        identityLoginId: session.identityLoginId,
        expiresAtMs: now + APP_SIGN_IN_CODE_TTL_MS,
      };
      // Recorded before the code exists: an approval the log missed never signs anyone in.
      yield* audit
        .record({
          actor: AuditLog.userActor(session.userId),
          action: "appSignIn.approve",
          target: { kind: "user", id: session.userId },
          detail: {
            client: pending.clientLabel ?? null,
            redirect: appSignInRedirectKind(input.redirectUri),
          },
        })
        .pipe(
          Effect.mapError((cause) => new EnvironmentAuth.ServerAuthUserDirectoryError({ cause })),
        );
      yield* codes.put(key, pending, now);
      return appSignInCallbackUrl(input.redirectUri, code, input.state);
    },
  );

  const exchange: AppSignIn["Service"]["exchange"] = Effect.fn("AppSignIn.exchange")(function* ({
    token,
    client,
    proofKeyThumbprint,
  }) {
    const key = yield* sha256(token.code);
    // A presented code is spent even when a later check fails (RFC 6749 §4.1.2).
    const pending = yield* codes.take(key);
    const now = yield* Clock.currentTimeMillis;
    if (
      pending === undefined ||
      pending.expiresAtMs <= now ||
      pending.redirectUri !== token.redirect_uri ||
      !(yield* pkceVerifies(token.code_verifier, pending.codeChallenge))
    ) {
      return yield* new AppSignInInvalidGrantError({});
    }
    const label = client.label ?? pending.clientLabel;
    return yield* environmentAuth.issueAppSession({
      userId: pending.userId,
      scopes: pending.scopes,
      client: label === undefined ? client : { ...client, label },
      ...(proofKeyThumbprint === undefined ? {} : { proofKeyThumbprint }),
      ...(pending.identityLoginId === undefined
        ? {}
        : { identityLoginId: pending.identityLoginId }),
    });
  });

  return AppSignIn.of({ approve, exchange });
});

export const layer = Layer.effect(AppSignIn, make).pipe(Layer.provide(AuditLog.layer));
