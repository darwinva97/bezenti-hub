/**
 * `t3 join`, the Hub's half: the machine sends its credential's SHA-256 and a PKCE challenge, a
 * User who may approves it with a strong factor (dedicating it to an Organization, if the Owner),
 * and the machine accepts that approver before it is registered. The credential never leaves it.
 */
import type {
  EnvironmentId,
  HubEnvironmentDedicatedSpace,
  EnvironmentJoinApprover,
  EnvironmentJoinApproveRequest,
  EnvironmentJoinConfirmRequest,
  EnvironmentJoinRequestView,
  EnvironmentJoinStartRequest,
  EnvironmentJoinStatus,
  EnvironmentJoinStatusRequest,
  UserId,
} from "@t3tools/contracts";
import {
  appSignInCallbackUrl,
  appSignInCancelledUrl,
  appSignInRedirectKind,
  isAppSignInCodeChallenge,
  isAppSignInState,
} from "@t3tools/shared/appSignIn";
import { isEnvironmentCredentialHash } from "@t3tools/shared/environmentJoin";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeGrantStore, makePkce } from "../auth/pkceGrants.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";

/** Long enough for the Owner to reach a browser and sign in. */
const JOIN_REQUEST_TTL_MS = 600_000;
// Starting a request needs no session, so the store is bounded.
const MAX_PENDING_REQUESTS = 200;

type Decision =
  | { readonly _tag: "pending" }
  | { readonly _tag: "denied" }
  /** Approved on the page; registered once the machine accepts this approver. */
  | {
      readonly _tag: "awaiting-confirmation";
      readonly name: string;
      readonly approvedBy: EnvironmentJoinApprover;
      readonly dedicatedSpace: HubEnvironmentDedicatedSpace | undefined;
    }
  | {
      readonly _tag: "approved";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly dedicatedSpace: HubEnvironmentDedicatedSpace | undefined;
    };

interface PendingJoin {
  readonly codeChallenge: string;
  readonly credentialHash: string;
  readonly name: string;
  readonly os: string;
  readonly hostname: string;
  readonly redirectUri: string | undefined;
  readonly state: string | undefined;
  /** What `t3 join --dedicated` asked for, as typed: a suggestion for the page. */
  readonly requestedDedicatedSpace: string | undefined;
  readonly requestedAt: string;
  readonly expiresAtMs: number;
  readonly decision: Decision;
}

export class EnvironmentJoinRequestError extends Schema.TaggedError<EnvironmentJoinRequestError>()(
  "EnvironmentJoinRequestError",
  { reason: Schema.Literals(["invalid_redirect_uri", "invalid_code_challenge"]) },
) {}

export class EnvironmentJoinNotSignedInError extends Schema.TaggedError<EnvironmentJoinNotSignedInError>()(
  "EnvironmentJoinNotSignedInError",
  {},
) {
  override get message(): string {
    return "Sign in to this Hub in the browser first.";
  }
}

/** Unknown, expired or already decided otherwise: all look alike. */
export class EnvironmentJoinRequestNotFoundError extends Schema.TaggedError<EnvironmentJoinRequestNotFoundError>()(
  "EnvironmentJoinRequestNotFoundError",
  {},
) {
  override get message(): string {
    return "This registration expired or was already decided. Run `t3 join` again.";
  }
}

/** The verifier is not the one the request was started with. */
export class EnvironmentJoinInvalidGrantError extends Schema.TaggedError<EnvironmentJoinInvalidGrantError>()(
  "EnvironmentJoinInvalidGrantError",
  {},
) {}

type ApproveError =
  | EnvironmentJoinNotSignedInError
  | EnvironmentJoinRequestNotFoundError
  | EnvironmentRegistry.EnvironmentAccessDeniedError
  | UserDirectory.AccountChangeRefusedError
  | UserDirectory.SignInThrottledError
  | UserDirectory.UserDirectoryStorageError
  | EnvironmentRegistry.EnvironmentStorageError
  | EnvironmentAuth.ServerAuthInternalError;

export class EnvironmentJoin extends Context.Service<
  EnvironmentJoin,
  {
    readonly start: (
      input: EnvironmentJoinStartRequest,
    ) => Effect.Effect<{ readonly requestId: string }, EnvironmentJoinRequestError>;
    /** The request, and whether the browser's signed-in User may approve it. */
    readonly view: (
      request: HttpServerRequest.HttpServerRequest,
      requestId: string,
    ) => Effect.Effect<EnvironmentJoinRequestView, EnvironmentJoinRequestNotFoundError>;
    /**
     * Names the approver for the machine to accept; answers where the browser goes next, if
     * anywhere.
     */
    readonly approve: (
      request: HttpServerRequest.HttpServerRequest,
      input: EnvironmentJoinApproveRequest,
    ) => Effect.Effect<string | null, ApproveError>;
    /** `t3 join` accepts the approver, which registers the machine as theirs, or refuses them. */
    readonly confirm: (
      input: EnvironmentJoinConfirmRequest,
    ) => Effect.Effect<
      EnvironmentJoinStatus,
      | EnvironmentJoinRequestNotFoundError
      | EnvironmentJoinInvalidGrantError
      | EnvironmentRegistry.EnvironmentAccessDeniedError
      | EnvironmentRegistry.EnvironmentStorageError
    >;
    readonly deny: (
      request: HttpServerRequest.HttpServerRequest,
      requestId: string,
    ) => Effect.Effect<
      string | null,
      | EnvironmentJoinNotSignedInError
      | EnvironmentJoinRequestNotFoundError
      | EnvironmentRegistry.EnvironmentAccessDeniedError
      | EnvironmentRegistry.EnvironmentStorageError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    readonly status: (
      input: EnvironmentJoinStatusRequest,
    ) => Effect.Effect<EnvironmentJoinStatus, EnvironmentJoinInvalidGrantError>;
  }
>()("t3/environments/EnvironmentJoin") {}

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const pkce = yield* makePkce;
  const requests = yield* makeGrantStore<PendingJoin>(MAX_PENDING_REQUESTS);
  // One decision at a time, so two approvals of one request register it once.
  const decisions = yield* Semaphore.make(1);

  const start: EnvironmentJoin["Service"]["start"] = Effect.fn("EnvironmentJoin.start")(
    function* (input) {
      // Only `t3 join` on the machine itself is sent back to: a loopback port, never a scheme.
      if (
        input.redirectUri !== undefined &&
        (appSignInRedirectKind(input.redirectUri) !== "this-computer" ||
          input.state === undefined ||
          !isAppSignInState(input.state))
      ) {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_redirect_uri" });
      }
      if (
        !isAppSignInCodeChallenge(input.codeChallenge) ||
        !isEnvironmentCredentialHash(input.credentialHash)
      ) {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_code_challenge" });
      }
      const now = yield* Clock.currentTimeMillis;
      const requestId = base64UrlEncode(yield* random.randomBytes(24));
      yield* requests.put(
        requestId,
        {
          codeChallenge: input.codeChallenge,
          credentialHash: input.credentialHash,
          name: input.name,
          os: input.os,
          hostname: input.hostname,
          redirectUri: input.redirectUri,
          state: input.state,
          requestedDedicatedSpace: input.dedicatedSpace,
          requestedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          expiresAtMs: now + JOIN_REQUEST_TTL_MS,
          decision: { _tag: "pending" },
        },
        now,
      );
      return { requestId };
    },
  );

  const find = Effect.fn("EnvironmentJoin.find")(function* (requestId: string) {
    const found = yield* requests.get(requestId, yield* Clock.currentTimeMillis);
    if (found === undefined) return yield* new EnvironmentJoinRequestNotFoundError({});
    return found;
  });

  // The browser's own cookie, never a token an app holds.
  const browserUser = Effect.fn("EnvironmentJoin.browserUser")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const session = yield* environmentAuth
      .authenticateBrowserSession(request)
      .pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
          Effect.fail(new EnvironmentJoinNotSignedInError({})),
        ),
      );
    if (session.userId === undefined) return yield* new EnvironmentJoinNotSignedInError({});
    return { userId: session.userId as UserId, sessionId: session.sessionId };
  });

  const statusOf = (decision: Decision): EnvironmentJoinStatus => {
    switch (decision._tag) {
      case "approved":
        return {
          status: "approved",
          environmentId: decision.environmentId,
          hubEnvironmentId: registry.hubId,
          name: decision.name,
          ...(decision.dedicatedSpace === undefined
            ? {}
            : { dedicatedSpace: decision.dedicatedSpace }),
        };
      case "awaiting-confirmation":
        return {
          status: "awaiting-confirmation",
          name: decision.name,
          approvedBy: decision.approvedBy,
          ...(decision.dedicatedSpace === undefined
            ? {}
            : { dedicatedSpace: decision.dedicatedSpace }),
        };
      default:
        return { status: decision._tag };
    }
  };

  const view: EnvironmentJoin["Service"]["view"] = Effect.fn("EnvironmentJoin.view")(
    function* (request, requestId) {
      const found = yield* find(requestId);
      // A hint for the page only: approving asks again. Not knowing (signed out, or the session
      // or the User could not be read) is no answer rather than a failure.
      const user = yield* browserUser(request).pipe(Effect.option);
      const unknown = { mayApprove: undefined, denialMessage: undefined };
      const viewer: { mayApprove: boolean | undefined; denialMessage: string | undefined } =
        Option.isNone(user)
          ? unknown
          : yield* registry.authorizeRegister(user.value.userId).pipe(
              Effect.as({ mayApprove: true, denialMessage: undefined }),
              Effect.catch((error) =>
                Effect.succeed(
                  error._tag === "EnvironmentAccessDeniedError"
                    ? { mayApprove: false, denialMessage: error.message }
                    : unknown,
                ),
              ),
            );
      const status = found.decision._tag;
      // Only someone who may approve learns what machine asks.
      if (viewer.mayApprove !== true) {
        return {
          requestId,
          status,
          ...(viewer.mayApprove === undefined ? {} : { viewerMayApprove: viewer.mayApprove }),
          ...(viewer.denialMessage === undefined ? {} : { denialMessage: viewer.denialMessage }),
        };
      }
      // The Organizations this User may dedicate the machine to (the Owner's every one, an Admin's
      // own), the one `t3 join --dedicated` named first.
      const offered = Option.isNone(user)
        ? []
        : yield* registry
            .dedicatedSpaces(user.value.userId)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<HubEnvironmentDedicatedSpace> => []));
      const requested = found.requestedDedicatedSpace;
      const asked = (space: HubEnvironmentDedicatedSpace) =>
        requested !== undefined &&
        (space.id === requested || space.name.toLowerCase() === requested.toLowerCase());
      const dedicatedSpaces = [
        ...offered.filter(asked),
        ...offered.filter((space) => !asked(space)),
      ];
      return {
        requestId,
        name: found.name,
        os: found.os,
        hostname: found.hostname,
        requestedAt: found.requestedAt,
        status,
        viewerMayApprove: true,
        ...(requested === undefined ? {} : { requestedDedicatedSpace: requested }),
        ...(offered.length === 0 ? {} : { dedicatedSpaces }),
      };
    },
  );

  const returnTo = (found: PendingJoin, approved: boolean) =>
    found.redirectUri === undefined || found.state === undefined
      ? null
      : approved
        ? appSignInCallbackUrl(found.redirectUri, "approved", found.state)
        : appSignInCancelledUrl(found.redirectUri, found.state);

  // Approving only names the approver: the machine registers once `t3 join` accepts them, so a
  // User who got hold of someone else's link cannot take that machine as theirs unnoticed.
  const approve: EnvironmentJoin["Service"]["approve"] = Effect.fn("EnvironmentJoin.approve")(
    function* (request, input) {
      const user = yield* browserUser(request);
      // Who may comes before the factor, so the proof of a User without the right is never checked.
      yield* registry.authorizeRegister(user.userId);
      const dedicatedSpace =
        input.dedicatedSpaceId === undefined
          ? undefined
          : yield* registry.dedicatedSpaces(user.userId).pipe(
              Effect.flatMap((offered) => {
                const space = offered.find((entry) => entry.id === input.dedicatedSpaceId);
                return space === undefined
                  ? Effect.fail(
                      new EnvironmentRegistry.EnvironmentAccessDeniedError({
                        reason: "not-an-organization",
                      }),
                    )
                  : Effect.succeed(space);
              }),
            );
      yield* find(input.requestId);
      yield* userDirectory.confirmStrongFactor(
        { ...user, origin: request.headers.origin ?? "" },
        input.reauth,
      );
      const account = yield* userDirectory.getAccount(user.userId);
      return yield* decisions.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* find(input.requestId);
          const { decision } = found;
          // Asking again after a lost answer changes nothing; someone else decides nothing.
          if (decision._tag === "approved") return returnTo(found, true);
          if (decision._tag === "awaiting-confirmation") {
            if (decision.approvedBy.userId === user.userId) return returnTo(found, true);
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          if (decision._tag === "denied") {
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          yield* requests.update(input.requestId, yield* Clock.currentTimeMillis, (current) => ({
            ...current,
            name: input.name,
            decision: {
              _tag: "awaiting-confirmation",
              name: input.name,
              approvedBy: {
                userId: user.userId,
                displayName: account.user.displayName,
                loginName: account.loginName,
              },
              dedicatedSpace,
            },
          }));
          return returnTo(found, true);
        }),
      );
    },
  );

  const confirm: EnvironmentJoin["Service"]["confirm"] = Effect.fn("EnvironmentJoin.confirm")(
    function* (input) {
      const found = yield* find(input.requestId);
      if (!(yield* pkce.verifies(input.codeVerifier, found.codeChallenge))) {
        return yield* new EnvironmentJoinInvalidGrantError({});
      }
      return yield* decisions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* find(input.requestId);
          const { decision } = current;
          if (decision._tag === "approved" && input.accept) return statusOf(decision);
          if (decision._tag !== "awaiting-confirmation") {
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          const decide = (next: Decision) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              requests.update(input.requestId, now, (pending) => ({ ...pending, decision: next })),
            );
          if (!input.accept) {
            yield* decide({ _tag: "denied" });
            return { status: "denied" } as const;
          }
          const environmentId = yield* registry
            .register({
              approvedBy: decision.approvedBy.userId,
              name: decision.name,
              os: current.os,
              hostname: current.hostname,
              credentialHash: current.credentialHash,
              dedicatedSpaceId: decision.dedicatedSpace?.id,
            })
            .pipe(
              // The approver lost the right since: this request is over.
              Effect.tapError((error) =>
                error._tag === "EnvironmentAccessDeniedError"
                  ? decide({ _tag: "denied" })
                  : Effect.void,
              ),
            );
          const approved = {
            _tag: "approved",
            environmentId,
            name: decision.name,
            dedicatedSpace: decision.dedicatedSpace,
          } as const;
          yield* decide(approved);
          return statusOf(approved);
        }),
      );
    },
  );

  const deny: EnvironmentJoin["Service"]["deny"] = Effect.fn("EnvironmentJoin.deny")(
    function* (request, requestId) {
      const user = yield* browserUser(request);
      // As for approving: only someone who may approve turns a request down.
      yield* registry.authorizeRegister(user.userId);
      return yield* decisions.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* find(requestId);
          if (found.decision._tag !== "pending") {
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          yield* requests.update(requestId, yield* Clock.currentTimeMillis, (current) => ({
            ...current,
            decision: { _tag: "denied" },
          }));
          return returnTo(found, false);
        }),
      );
    },
  );

  const status: EnvironmentJoin["Service"]["status"] = Effect.fn("EnvironmentJoin.status")(
    function* (input) {
      const found = yield* requests.get(input.requestId, yield* Clock.currentTimeMillis);
      if (found === undefined) return { status: "expired" } as const;
      if (!(yield* pkce.verifies(input.codeVerifier, found.codeChallenge))) {
        return yield* new EnvironmentJoinInvalidGrantError({});
      }
      return statusOf(found.decision);
    },
  );

  return EnvironmentJoin.of({ start, view, approve, confirm, deny, status });
});

export const layer = Layer.effect(EnvironmentJoin, make);
