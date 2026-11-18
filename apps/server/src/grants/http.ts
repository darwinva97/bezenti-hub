/**
 * Giving, accepting and applying a lending link over HTTP. Grants decides who may; when the loan
 * of a machine would become active (accepting it, or applying its link), or a Vault group is
 * given, the request must also carry a strong factor (passkey or authenticator code), checked only
 * after Grants allowed it, so nobody else's proof is ever checked.
 */
import {
  AuthAccessWriteScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  type EnvironmentInternalError,
  type EnvironmentResourceNotFoundError,
  type GrantError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  annotateEnvironmentRequest,
  failAccountChange,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import * as Grants from "./Grants.ts";

/** A Grant's refusal over HTTP; its message names the resource and Space, nothing secret. */
const failGrant = (
  error: GrantError,
): Effect.Effect<
  never,
  | EnvironmentHttpForbiddenError
  | EnvironmentHttpConflictError
  | EnvironmentInternalError
  | EnvironmentResourceNotFoundError
> => {
  switch (error.reason) {
    case "not-found":
      return failEnvironmentNotFound("grant_not_found");
    case "storage":
      return failEnvironmentInternal("grants_failed");
    case "not-allowed":
    case "strong-factor-required":
      return Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
    default:
      return Effect.fail(new EnvironmentHttpConflictError({ message: error.message }));
  }
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "grants",
  Effect.fnUntraced(function* (handlers) {
    const users = yield* UserDirectory.UserDirectory;
    const grants = yield* Grants.Grants;

    /** The signed-in User, and their proof checked when `needed`. */
    const proofOf = Effect.fn("environment.grants.proofOf")(function* (
      principal: Effect.Success<ReturnType<typeof requireEnvironmentScope>>,
      needed: boolean,
      reauth: Parameters<UserDirectory.UserDirectory["Service"]["confirmStrongFactor"]>[1],
    ) {
      if (!needed) return { strongFactor: false };
      if (principal.userId === undefined) {
        return yield* new EnvironmentHttpForbiddenError({ message: "Sign in to lend or borrow." });
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* failAccountChange(
        users.confirmStrongFactor(
          {
            userId: principal.userId,
            sessionId: principal.sessionId,
            origin: request.headers.origin ?? "",
          },
          reauth,
        ),
      );
      return { strongFactor: true };
    });

    return handlers
      .handle(
        "give",
        Effect.fn("environment.grants.give")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          const asSession = CommandActor.actAsSession(principal);
          const { reauth, ...input } = args.payload;
          const plan = yield* grants.prepareGive(input).pipe(asSession, Effect.catch(failGrant));
          const proof = yield* proofOf(principal, plan.needsStrongFactor, reauth);
          return yield* grants.give(input, proof).pipe(asSession, Effect.catch(failGrant));
        }),
      )
      .handle(
        "accept",
        Effect.fn("environment.grants.accept")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          const asSession = CommandActor.actAsSession(principal);
          const input = { grantId: args.payload.grantId };
          const plan = yield* grants.prepareAccept(input).pipe(asSession, Effect.catch(failGrant));
          const choice = { useAsDefault: args.payload.useAsDefault };
          const proof = yield* proofOf(principal, plan.needsStrongFactor, args.payload.reauth);
          return yield* grants
            .accept({ ...input, ...choice }, proof)
            .pipe(asSession, Effect.catch(failGrant));
        }),
      )
      .handle(
        "claimOffer",
        Effect.fn("environment.grants.claimOffer")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          const asSession = CommandActor.actAsSession(principal);
          const { reauth, ...input } = args.payload;
          // As accepting: the same checks first, then the proof, then the change, which checks
          // them all again in its transaction.
          const plan = yield* grants.prepareClaim(input).pipe(asSession, Effect.catch(failGrant));
          const proof = yield* proofOf(principal, plan.needsStrongFactor, reauth);
          return yield* grants.claimOffer(input, proof).pipe(asSession, Effect.catch(failGrant));
        }),
      );
  }),
);
