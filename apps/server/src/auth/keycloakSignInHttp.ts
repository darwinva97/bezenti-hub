/**
 * Keycloak sign-in over HTTP (Keycloak sign-in spec, ticket 02): `POST /api/auth/keycloak/start`
 * answers the realm's sign-in address and sets the flow's `__Host-` cookie; the raw route
 * `GET /oauth/keycloak/callback` is where the realm sends the browser back, and answers only a
 * redirect: to `returnTo` with a session cookie, or to a page with `?keycloak=<code>`.
 */
import {
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentRateLimitedError,
  EnvironmentServiceBusyError,
  KEYCLOAK_CALLBACK_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  appendSessionCookie,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "./http.ts";
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
      return Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
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
    return handlers.handle(
      "start",
      Effect.fn("environment.keycloakSignIn.start")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
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
            UserDirectoryStorageError: (error) => failEnvironmentInternal("internal_error", error),
            SignInSettingsStorageError: (error) =>
              failEnvironmentInternal("sign_in_settings_failed", error),
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

/** The callback: a redirect, the session cookie when one was issued, and the flow cookie gone. */
export const layerCallbackRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const keycloakSignIn = yield* KeycloakSignIn.KeycloakSignIn;
    const sessions = yield* SessionStore.SessionStore;
    yield* router.add("GET", KEYCLOAK_CALLBACK_PATH, (request) =>
      Effect.gen(function* () {
        const outcome = yield* keycloakSignIn.callback(request);
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
        return Result.isSuccess(expireFlow)
          ? HttpServerResponse.mergeCookies(response, expireFlow.success)
          : response;
      }),
    );
  }),
);
