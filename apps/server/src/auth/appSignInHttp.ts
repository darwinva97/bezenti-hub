import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AppSignIn from "./AppSignIn.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "./http.ts";
import { checkRequestDpopProof } from "./dpop.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const handlers = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "appSignIn",
  Effect.fnUntraced(function* (handlers) {
    const appSignIn = yield* AppSignIn.AppSignIn;
    return handlers
      .handle(
        "approve",
        Effect.fn("environment.appSignIn.approve")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* appendCredentialResponseHeaders;
            const redirectTo = yield* appSignIn.approve(request, args.payload);
            return { redirectTo };
          },
          Effect.catchTags({
            AppSignInRequestError: (error) => failEnvironmentInvalidRequest(error.reason),
            AppSignInNotSignedInError: () => failEnvironmentAuthInvalid("missing_credential"),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.appSignIn.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            // Checked, not recorded: the code is spent the first time it is presented and the
            // session issued is bound to the proof's key, so a replayed proof gains nothing.
            // Recording it would let anyone write replay state to disk with a made-up code.
            const proofKeyThumbprint = args.headers.dpop
              ? (yield* checkRequestDpopProof({ request })).thumbprint
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* appSignIn.exchange({
              token: args.payload,
              client: deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              ...(proofKeyThumbprint === undefined ? {} : { proofKeyThumbprint }),
            });
          },
          Effect.catchTags({
            AppSignInInvalidGrantError: () => failEnvironmentAuthInvalid("invalid_credential"),
            ServerAuthInsecureTransportError: () =>
              failEnvironmentInvalidRequest("insecure_transport"),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              "invalid_credential",
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      );
  }),
);

export const layer = handlers.pipe(Layer.provide(AppSignIn.layer));
