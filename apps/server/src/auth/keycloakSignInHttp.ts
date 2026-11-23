/**
 * Keycloak over HTTP: `start` sets the flow's `__Host-` cookie and answers the realm's address; the
 * callback answers only a redirect (ticket 02). Ticket 07: «also sign out of Keycloak», and the raw
 * route where the realm posts its back-channel logout tokens.
 */
import {
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentRateLimitedError,
  EnvironmentServiceBusyError,
  KEYCLOAK_BACKCHANNEL_LOGOUT_PATH,
  KEYCLOAK_CALLBACK_PATH,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { fromPreviewOrigin } from "../preview/PreviewOrigin.ts";
import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  appendSessionCookie,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "./http.ts";
import * as KeycloakLogins from "./KeycloakLogins.ts";
import * as KeycloakSignIn from "./KeycloakSignIn.ts";
import * as SessionStore from "./SessionStore.ts";

const failStart = (error: KeycloakSignIn.KeycloakStartRefusedError) => {
  switch (error.reason) {
    case "invalid-return-to":
      return failEnvironmentInvalidRequest("invalid_return_to");
    case "invalid-origin":
      return failEnvironmentInvalidRequest("invalid_origin");
    case "not-signed-in":
      return failEnvironmentAuthInvalid("missing_credential");
    case "rate-limited":
      return Effect.fail(
        new EnvironmentRateLimitedError({ message: error.message, retryAfterSeconds: 60 }),
      );
    case "busy":
      return Effect.fail(
        new EnvironmentServiceBusyError({ message: error.message, retryAfterSeconds: 60 }),
      );
    case "unavailable":
      return failEnvironmentInternal("keycloak_unavailable");
    case "off":
    case "no-identity":
      return Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
    case "invitation-invalid":
    case "reset-invalid":
      return Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }));
  }
};

const FLOW_COOKIE_MAX_AGE = "10 minutes";

const flowCookieAttributes = (secure: boolean) =>
  ({ httpOnly: true, path: "/", sameSite: "lax", secure }) as const;

export const layerApi = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "keycloakSignIn",
  Effect.fnUntraced(function* (handlers) {
    const keycloakSignIn = yield* KeycloakSignIn.KeycloakSignIn;
    const keycloakLogins = yield* KeycloakLogins.KeycloakLogins;
    return handlers
      .handle(
        "signOut",
        Effect.fn("environment.keycloakSignIn.signOut")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const done = yield* keycloakLogins.signOut(request, args.payload.handle).pipe(
            Effect.catchTags({
              KeycloakSignOutRefusedError: (error) =>
                error.reason === "invalid-origin"
                  ? failEnvironmentInvalidRequest("invalid_origin")
                  : Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
              KeycloakSignOutFailedError: (error) =>
                failEnvironmentInternal("internal_error", error),
            }),
          );
          yield* appendCredentialResponseHeaders;
          return done;
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.keycloakSignIn.start")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // A page on a preview's own origin starts no flow and gets no cookie (ticket 11: every
          // module that sets a Hub cookie asks first; KeycloakSignIn.start refuses its Origin too).
          if (yield* fromPreviewOrigin)
            return yield* failEnvironmentInvalidRequest("invalid_origin");
          const request = yield* HttpServerRequest.HttpServerRequest;
          const started = yield* keycloakSignIn.start(request, args.payload).pipe(
            Effect.catchTags({
              KeycloakStartRefusedError: failStart,
              AccountChangeRefusedError: (error) =>
                Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
              SignInThrottledError: (error) =>
                Effect.fail(
                  new EnvironmentRateLimitedError({
                    message: error.message,
                    retryAfterSeconds: error.retryAfterSeconds,
                  }),
                ),
              UserDirectoryStorageError: (error) =>
                failEnvironmentInternal("internal_error", error),
              SignInSettingsStorageError: (error) =>
                failEnvironmentInternal("sign_in_settings_failed", error),
              InvitationStorageError: (error) =>
                failEnvironmentInternal("invitations_failed", error),
            }),
          );
          const cookies = Cookies.set(Cookies.empty, started.cookie.name, started.cookie.value, {
            ...flowCookieAttributes(started.cookie.secure),
            maxAge: FLOW_COOKIE_MAX_AGE,
          });
          if (Result.isFailure(cookies)) {
            return yield* failEnvironmentInternal("browser_session_cookie_failed");
          }
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.mergeCookies(response, cookies.success)),
          );
          yield* appendCredentialResponseHeaders;
          return { authorizationUrl: started.authorizationUrl };
        }),
      );
  }),
);

/** The largest back-channel logout request body read: one form field with a logout token. */
const MAX_BACKCHANNEL_BODY_BYTES = 16 * 1024;

/**
 * Ticket 07, the realm's back-channel logout: a form with `logout_token` and nothing to do with
 * cookies. 200 once the sign-ins it names have ended (or none matched), 400 for anything else;
 * the answer never echoes the token. Untraced (`isUntracedRequest`): the token is in the body.
 */
export const layerBackchannelLogoutRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const keycloakLogins = yield* KeycloakLogins.KeycloakLogins;
    const answer = (status: 200 | 400 | 500) =>
      HttpServerResponse.empty({
        status,
        headers: { "cache-control": "no-store" },
      });
    yield* router.add("POST", KEYCLOAK_BACKCHANNEL_LOGOUT_PATH, (request) =>
      Effect.gen(function* () {
        const type = request.headers["content-type"] ?? "";
        const length = Number(request.headers["content-length"] ?? "0");
        if (
          !type.toLowerCase().startsWith("application/x-www-form-urlencoded") ||
          length > MAX_BACKCHANNEL_BODY_BYTES
        ) {
          return answer(400);
        }
        const text = yield* request.text.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            ByteSize.bytes(MAX_BACKCHANNEL_BODY_BYTES),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        if (text === undefined || text.length > MAX_BACKCHANNEL_BODY_BYTES) return answer(400);
        const tokens = new URLSearchParams(text).getAll("logout_token");
        if (tokens.length !== 1) return answer(400);
        const outcome = yield* keycloakLogins.backchannelLogout(tokens[0] ?? "");
        return answer(outcome === "ok" ? 200 : outcome === "invalid" ? 400 : 500);
      }),
    );
  }),
);

/** The callback: a redirect, the session cookie when one was issued, and the flow cookie gone. */
export const layerCallbackRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const keycloakSignIn = yield* KeycloakSignIn.KeycloakSignIn;
    const sessions = yield* SessionStore.SessionStore;
    yield* router.add("GET", KEYCLOAK_CALLBACK_PATH, (request) =>
      Effect.gen(function* () {
        const outcome = yield* keycloakSignIn.callback(request);
        // Nothing is set or cleared for a page on a preview's own origin (no session either:
        // appendSessionCookie refuses it), as for every Hub cookie.
        const preview = yield* fromPreviewOrigin;
        const expireFlow = Cookies.expireCookie(
          Cookies.empty,
          outcome.secure
            ? `__Host-${KeycloakSignIn.FLOW_COOKIE_NAME}`
            : KeycloakSignIn.FLOW_COOKIE_NAME,
          flowCookieAttributes(outcome.secure),
        );
        let redirectTo = outcome.redirectTo;
        if (outcome.session !== undefined) {
          const set = yield* appendSessionCookie(
            sessions.cookieName,
            outcome.session.token,
            outcome.session.expiresAt,
          ).pipe(Effect.result);
          if (Result.isFailure(set)) redirectTo = "/sign-in?keycloak=failed";
        }
        const response = HttpServerResponse.redirect(redirectTo, {
          status: 303,
          headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
        });
        return Result.isSuccess(expireFlow) && !preview
          ? HttpServerResponse.mergeCookies(response, expireFlow.success)
          : response;
      }),
    );
  }),
);
