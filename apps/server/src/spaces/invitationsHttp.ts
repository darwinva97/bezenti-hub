import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentRateLimitedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  appendSessionCookie,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import type * as UserDirectory from "../auth/UserDirectory.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as InvitationService from "./InvitationService.ts";

const requireUser = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({ message: "Sign in with an account first." });
  }
  return principal.userId;
});

const forbidden = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
const conflict = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpConflictError({ message: error.message }));
const throttled = (error: UserDirectory.SignInThrottledError) =>
  Effect.fail(
    new EnvironmentRateLimitedError({
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    }),
  );
const internal = (error: unknown) => failEnvironmentInternal("invitations_failed", error);

const manageFailures = {
  InvitationRefusedError: forbidden,
  SpaceDirectoryStorageError: internal,
  InvitationStorageError: internal,
};

const redeemFailures = {
  InvitationInvalidError: forbidden,
  InvitationRefusedError: forbidden,
  InvitationConflictError: conflict,
  SignInThrottledError: throttled,
  InvitationStorageError: internal,
};

const passkeyFailures = {
  ...redeemFailures,
  ServerAuthInvalidOriginError: () => failEnvironmentInvalidRequest("invalid_origin"),
};

const clientIp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return deriveAuthClientMetadata({ request }).ipAddress;
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "invitations",
  Effect.fnUntraced(function* (handlers) {
    const invitations = yield* InvitationService.InvitationService;
    const sessions = yield* SessionStore.SessionStore;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.invitations.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* invitations
            .list(yield* requireUser, args.params.spaceId)
            .pipe(Effect.catchTags(manageFailures));
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.invitations.create")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          return yield* invitations
            .create(yield* requireUser, args.params.spaceId, args.payload.role)
            .pipe(Effect.catchTags(manageFailures));
        }),
      )
      .handle(
        "revoke",
        Effect.fn("environment.invitations.revoke")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* invitations
            .revoke(yield* requireUser, args.payload.invitationId)
            .pipe(Effect.catchTags(manageFailures));
        }),
      )
      .handle(
        "preview",
        Effect.fn("environment.invitations.preview")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* invitations.preview(args.payload.token, yield* clientIp).pipe(
            Effect.catchTags({
              SignInThrottledError: throttled,
              InvitationStorageError: internal,
            }),
          );
        }),
      )
      .handle(
        "registration",
        Effect.fn("environment.invitations.registration")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* invitations
            .startRegistration(request, args.payload, yield* clientIp)
            .pipe(Effect.catchTags(passkeyFailures));
        }),
      )
      .handle(
        "totpEnrollment",
        Effect.fn("environment.invitations.totpEnrollment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          return yield* invitations
            .startTotpEnrollment(args.payload.token, yield* clientIp)
            .pipe(Effect.catchTags(redeemFailures));
        }),
      )
      .handle(
        "accept",
        Effect.fn("environment.invitations.accept")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { result, sessionToken } = yield* invitations
            .accept(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(
              Effect.catchTags({
                ...passkeyFailures,
                ServerAuthInvalidCredentialError: forbidden,
                ServerAuthInsecureTransportError: () =>
                  failEnvironmentInvalidRequest("insecure_transport"),
              }),
              Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                failEnvironmentInternal("browser_session_issuance_failed", error),
              ),
            );
          yield* appendSessionCookie(sessions.cookieName, sessionToken, result.session.expiresAt);
          yield* appendCredentialResponseHeaders;
          return result;
        }),
      )
      .handle(
        "join",
        Effect.fn("environment.invitations.join")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { sessionId } = yield* EnvironmentAuthenticatedPrincipal;
          return yield* invitations
            .join(yield* requireUser, args.payload.token, yield* clientIp, sessionId)
            .pipe(Effect.catchTags(redeemFailures));
        }),
      );
  }),
);
