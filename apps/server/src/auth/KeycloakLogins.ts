/**
 * Keycloak sign-ins after the callback (ticket 07): the background re-check, back-channel logout and
 * «also sign out of Keycloak», each ending through `UserDirectory.endKeycloakLogins`. A Keycloak
 * that does not answer signs nobody out. One Hub process only: see `inFlight`.
 */
import {
  KEYCLOAK_POST_LOGOUT_PATH,
  type AuditAction,
  type KeycloakStatus,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerConfig from "../config.ts";
import * as UserIdentities from "../persistence/UserIdentities.ts";
import * as Users from "../persistence/Users.ts";
import * as KeycloakAdmission from "./KeycloakAdmission.ts";
import * as KeycloakClient from "./KeycloakClient.ts";
import * as KeycloakGroups from "./KeycloakGroups.ts";
import { makeHubOrigin } from "./keycloakOrigins.ts";
import * as KeycloakRealm from "./KeycloakRealm.ts";
import * as KeycloakTokens from "./keycloakTokens.ts";
import { makeGrantStore } from "./pkceGrants.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as SignInSettings from "./SignInSettings.ts";
import * as UserDirectory from "./UserDirectory.ts";
import { base64UrlEncode } from "./utils.ts";

/** Re-checks running at once, all sign-ins together; the others wait their turn. */
const MAX_CONCURRENT_RECHECKS = 8;
/** After Keycloak fails to answer, no re-check for this long, doubling up to the cap. */
const FIRST_BACKOFF = Duration.minutes(1);
const MAX_BACKOFF = Duration.minutes(10);
/** The longest logout token the Hub reads. */
const MAX_LOGOUT_TOKEN_LENGTH = 8 * 1024;
/**
 * Logout tokens' `jti`s remembered at once. Only tokens the realm signed get in, and a full cache
 * refuses (400) instead of forgetting one that could then be replayed.
 */
const MAX_REMEMBERED_JTIS = 10_000;
/** A `jti` is remembered past the logout token's own life (2 minutes, a minute's skew each way). */
const JTI_TTL = Duration.minutes(4);
/** «Also sign out of Keycloak»'s handle: single-use, this long, at most this many at once. */
const SIGN_OUT_HANDLE_TTL = Duration.minutes(10);
const MAX_SIGN_OUT_HANDLES = 10_000;

/** Why a sign-in ended, as its audit entry says it. */
export type LoginEndReason =
  | "refresh-refused"
  | "backchannel"
  | "sign-out"
  | "no-refresh-token"
  | "keycloak-off"
  | "issuer-changed"
  // The sign-in's own tokens are unusable: its refresh token won't open, the refreshed ID token
  // fails verification or names someone else, or the new tokens can't be sealed.
  | "token-unusable"
  // Ticket 11: the Owner disabled or removed the User in the Hub.
  | "user-disabled"
  | "user-removed";

/** How one re-check ended, for whoever waits on it (tests, never a clock). */
export interface RecheckOutcome {
  readonly loginId: string;
  readonly outcome: "refreshed" | "ended" | "kept" | "skipped";
}

/** «Also sign out of Keycloak» could not end the sign-in; the handle is given back for a retry. */
export class KeycloakSignOutFailedError extends Schema.TaggedError<KeycloakSignOutFailedError>()(
  "KeycloakSignOutFailedError",
  {},
) {
  override get message(): string {
    return "The Keycloak sign-in could not be ended. Try again.";
  }
}

/** «Also sign out of Keycloak» refused: an unknown, spent or expired handle, or a foreign page. */
export class KeycloakSignOutRefusedError extends Schema.TaggedError<KeycloakSignOutRefusedError>()(
  "KeycloakSignOutRefusedError",
  { reason: Schema.Literals(["invalid-handle", "invalid-origin"]) },
) {
  override get message(): string {
    return this.reason === "invalid-handle"
      ? "This sign-out has expired. Sign out of Keycloak from its own page."
      : "This sign-out cannot run from here.";
  }
}

export class KeycloakLogins extends Context.Service<
  KeycloakLogins,
  {
    /**
     * A back-channel logout token from the realm: verified (see KeycloakClient.verifyLogoutToken),
     * its `jti` never seen before, then the sign-ins it names end. `invalid` answers 400;
     * `failed` (they could not be ended) answers 500 and forgets the `jti`, so a retry is taken.
     */
    readonly backchannelLogout: (logoutToken: string) => Effect.Effect<"ok" | "invalid" | "failed">;
    /** After signing out a browser session born of `loginId`: a handle to end it too, if live. */
    readonly signOutHandle: (loginId: string) => Effect.Effect<string | undefined>;
    /**
     * «Also sign out of Keycloak»: spends the handle, ends that sign-in with all born of it, and
     * answers where the browser leaves Keycloak (`client_id` and `post_logout_redirect_uri`, never
     * an ID token: ticket 11), if the realm says.
     */
    readonly signOut: (
      request: HttpServerRequest.HttpServerRequest,
      handle: string,
    ) => Effect.Effect<
      { readonly endSessionUrl: string | null },
      KeycloakSignOutRefusedError | KeycloakSignOutFailedError
    >;
    /** The Owner's warnings: Keycloak not answering since when and why; the newest sign-in. */
    readonly status: Effect.Effect<KeycloakStatus>;
    /** Each re-check's end, from the moment this runs. */
    readonly recheckOutcomes: Effect.Effect<Stream.Stream<RecheckOutcome>, never, Scope.Scope>;
  }
>()("t3/auth/KeycloakLogins") {}

interface SignOutHandle {
  readonly loginId: string;
  readonly userId: UserId;
  readonly expiresAtMs: number;
}

/** The realm or the way to it failed (network, timeout, 5xx, another 4xx, discovery, keys). */
class RecheckProblem extends Schema.TaggedError<RecheckProblem>()("RecheckProblem", {
  kind: Schema.Literals(["unreachable", "rejected"]),
  /** Which step, for the log: never a value. */
  detail: Schema.String,
}) {}

/** This sign-in's own tokens are unusable: it ends, and Keycloak is not blamed. */
class LoginUnusable extends Schema.TaggedError<LoginUnusable>()("LoginUnusable", {
  detail: Schema.String,
}) {}

/** The Hub's own storage failed: nothing changes, nobody is blamed, the next use tries again. */
class RecheckStorageFailed extends Schema.TaggedError<RecheckStorageFailed>()(
  "RecheckStorageFailed",
  { detail: Schema.String },
) {}

/** Ending sign-ins failed in the Hub's storage: never reported as done. */
class LoginEndFailed extends Schema.TaggedError<LoginEndFailed>()("LoginEndFailed", {}) {}

export interface LoginsBounds {
  /** Logout tokens' `jti`s remembered at once (MAX_REMEMBERED_JTIS). */
  readonly maxRememberedJtis?: number;
}

const makeWith = Effect.fnUntraced(function* (options: LoginsBounds = {}) {
  const maxRememberedJtis = options.maxRememberedJtis ?? MAX_REMEMBERED_JTIS;
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const identities = yield* UserIdentities.UserIdentities;
  const users = yield* Users.UserRepository;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const settings = yield* SignInSettings.SignInSettings;
  const keycloak = yield* KeycloakClient.KeycloakClient;
  const keycloakRealm = yield* KeycloakRealm.KeycloakRealm;
  const keycloakGroups = yield* KeycloakGroups.KeycloakGroups;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const audit = yield* AuditLog.AuditLog;
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const cryptoContext = yield* Effect.context<Aead.Aead | SecureRandom.SecureRandom>();
  const hubOrigin = makeHubOrigin(config);
  const outcomes = yield* PubSub.unbounded<RecheckOutcome>();

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  /**
   * Ends these sign-ins, one audit entry each, in one transaction; their sockets close once it
   * commits. A failure leaves them as they were and fails (`LoginEndFailed`), never reports 0.
   */
  const endLogins = (
    loginIds: ReadonlyArray<string>,
    reason: LoginEndReason,
    actor: AuditLog.AuditActor,
  ) =>
    loginIds.length === 0
      ? Effect.succeed(0)
      : sql
          .withTransaction(
            Effect.gen(function* () {
              const closes: Array<Effect.Effect<void>> = [];
              let ended = 0;
              for (const loginId of loginIds) {
                const done = yield* userDirectory.endKeycloakLogins([loginId]);
                closes.push(done.afterCommit);
                for (const login of done.ended) {
                  ended += 1;
                  yield* audit.record({
                    actor,
                    action: "keycloak.login.end" satisfies AuditAction,
                    target: { kind: "user", id: login.userId },
                    detail: { reason, sessions: done.sessions, pairingLinks: done.pairingLinks },
                  });
                }
              }
              return { ended, close: Effect.all(closes, { discard: true }) };
            }),
          )
          .pipe(
            Effect.flatMap(({ ended, close }) => Effect.as(close, ended)),
            Effect.catch(() =>
              Effect.logWarning("Could not end a Keycloak sign-in.", { reason }).pipe(
                Effect.andThen(Effect.fail(new LoginEndFailed())),
              ),
            ),
          );

  // Keycloak's health as the re-checks see it, for the Owner. In memory (ticket 07, A3).
  let problem: { readonly since: DateTime.Utc; readonly kind: RecheckProblem["kind"] } | undefined;
  let backoffUntilMs = 0;
  let backoffMs = Duration.toMillis(FIRST_BACKOFF);

  const noteProblem = Effect.fn("KeycloakLogins.noteProblem")(function* (failure: RecheckProblem) {
    const now = yield* DateTime.now;
    if (problem === undefined || problem.kind !== failure.kind) {
      // Once per change, never per re-check, and never a value from Keycloak's answer.
      yield* Effect.logWarning("Keycloak re-check failed; nobody is signed out.", {
        problem: failure.kind,
        step: failure.detail,
      });
      problem = { since: problem?.since ?? DateTime.toUtc(now), kind: failure.kind };
    }
    backoffUntilMs = now.epochMilliseconds + backoffMs;
    backoffMs = Math.min(backoffMs * 2, Duration.toMillis(MAX_BACKOFF));
  });

  const noteHealthy = Effect.sync(() => {
    problem = undefined;
    backoffUntilMs = 0;
    backoffMs = Duration.toMillis(FIRST_BACKOFF);
  });

  const unreachable = (detail: string) => () => new RecheckProblem({ kind: "unreachable", detail });
  const unusable = (detail: string) => () => new LoginUnusable({ detail });
  const storageFailed = (detail: string) => () => new RecheckStorageFailed({ detail });
  const system = { source: "system" } as const;
  /** Ends one sign-in from a re-check; a storage failure keeps it for the next use to retry. */
  const endFromRecheck = (loginId: string, reason: LoginEndReason) =>
    endLogins([loginId], reason, system).pipe(
      Effect.as("ended" as const),
      Effect.mapError(storageFailed(`end ${reason}`)),
    );

  /** Ticket 07: one sign-in's re-check, under its turn. */
  const recheck = (loginId: string) =>
    recheckTokens(loginId).pipe(
      Effect.catchTags({
        // Its own tokens are unusable: nothing can re-check it, so it ends, as without one (A1).
        LoginUnusable: (failure) =>
          Effect.logWarning("A Keycloak sign-in's tokens are unusable; it ends.", {
            step: failure.detail,
          }).pipe(Effect.andThen(endFromRecheck(loginId, "token-unusable"))),
      }),
    );

  const recheckTokens = Effect.fn("KeycloakLogins.recheck")(function* (
    loginId: string,
  ): Effect.fn.Return<
    RecheckOutcome["outcome"],
    RecheckProblem | LoginUnusable | RecheckStorageFailed
  > {
    const found = yield* identities
      .loginForRefresh(loginId)
      .pipe(Effect.mapError(storageFailed("read login")));
    if (Option.isNone(found) || found.value.ended) return "skipped";
    const login = found.value;
    const nowMs = yield* Clock.currentTimeMillis;
    const checkedAtMs = Date.parse(login.checkedAt);
    // Another turn re-checked it meanwhile.
    if (checkedAtMs + Duration.toMillis(SessionStore.RECHECK_INTERVAL) > nowMs) return "skipped";
    const enabled = yield* settings.keycloakConfig.pipe(Effect.mapError(storageFailed("settings")));
    // Without the realm it came from nothing can re-check it, so it ends (spec «Desactivar»).
    if (Option.isNone(enabled)) return yield* endFromRecheck(loginId, "keycloak-off");
    if (enabled.value.issuer !== login.issuer) {
      return yield* endFromRecheck(loginId, "issuer-changed");
    }
    if (nowMs < backoffUntilMs) return "skipped";
    if (login.refreshTokenSealed === null) {
      return yield* endFromRecheck(loginId, "no-refresh-token");
    }
    const refreshToken = yield* KeycloakTokens.open(
      secretStore,
      "refresh",
      loginId,
      login.refreshTokenSealed,
    ).pipe(Effect.provide(cryptoContext), Effect.mapError(unusable("open refresh token")));
    const realm = yield* keycloakRealm
      .realmFor(login.issuer)
      .pipe(Effect.mapError(unreachable("realm")));
    const tokens = yield* keycloak
      .refresh(realm.discovery, {
        clientId: enabled.value.clientId,
        clientSecret: enabled.value.clientSecret,
        refreshToken,
      })
      .pipe(
        Effect.map((tokens) => ({ tokens, refused: false as const })),
        Effect.catchTags({
          KeycloakFlowError: (error) =>
            error.reason === "invalid-grant"
              ? Effect.succeed({ tokens: undefined, refused: true as const })
              : Effect.fail(
                  new RecheckProblem({
                    kind: error.reason === "rejected" ? "rejected" : "unreachable",
                    detail: error.detail,
                  }),
                ),
        }),
      );
    if (tokens.refused) {
      // A disabled or deleted account, an ended or expired session: the sign-in is over.
      yield* noteHealthy;
      return yield* endFromRecheck(loginId, "refresh-refused");
    }
    // Keycloak answered: whatever is wrong from here on is this sign-in's, never the realm's.
    yield* noteHealthy;
    const claims = yield* keycloak
      .verifyIdToken(realm.keys, tokens.tokens.idToken, {
        issuer: login.issuer,
        clientId: enabled.value.clientId,
        nonce: undefined,
      })
      .pipe(Effect.mapError((error) => new LoginUnusable({ detail: error.detail })));
    if (claims.sub !== login.subject) {
      return yield* new LoginUnusable({ detail: "id token: sub" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const sealedRefresh =
      tokens.tokens.refreshToken === undefined
        ? null
        : yield* KeycloakTokens.seal(
            secretStore,
            "refresh",
            loginId,
            tokens.tokens.refreshToken,
          ).pipe(Effect.provide(cryptoContext), Effect.mapError(unusable("seal refresh token")));
    // Saved on its own, before anything else and before the turn is released: Keycloak may have
    // rotated the refresh token, and the next re-check must use the new one.
    const saved = yield* identities
      .saveRefresh({ loginId, refreshTokenSealed: sealedRefresh, now })
      .pipe(Effect.mapError(storageFailed("save refresh")));
    if (!saved) return "skipped";
    // The groups, as at a sign-in (KeycloakGroups): the labels and Memberships in one
    // transaction; an Admin group on a weak sign-in ends it there (onPromotedToAdmin).
    const user = yield* users
      .getById(login.userId)
      .pipe(Effect.mapError(storageFailed("read user")));
    if (Option.isNone(user)) return "refreshed";
    const applied = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* identities.updateLabels({
            userId: login.userId,
            username: KeycloakAdmission.identityLabel(claims.preferred_username),
            email: KeycloakAdmission.identityLabel(claims.email),
            now,
          });
          const plan = yield* keycloakGroups.plan(
            { id: login.userId, isOwner: user.value.isOwner },
            claims,
            enabled.value.groupsClaim,
          );
          return yield* keycloakGroups.apply(login.userId, plan);
        }),
      )
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not apply Keycloak groups after a re-check.").pipe(
            Effect.as({ afterCommit: Effect.void }),
          ),
        ),
      );
    yield* applied.afterCommit;
    return "refreshed";
  });

  // One turn per sign-in, in memory: this assumes one Hub process, as production runs today. Two
  // replicas refreshing one rotating refresh token would get a false `invalid_grant` for the loser
  // and end a sign-in that is fine.
  const inFlight = new Set<string>();
  const slots = yield* Semaphore.make(MAX_CONCURRENT_RECHECKS);
  const layerScope = yield* Effect.scope;

  const runRecheck = (loginId: string) =>
    recheck(loginId).pipe(
      Effect.catchTags({
        // Only the realm or the way to it backs off and shows the Owner a Keycloak problem.
        RecheckProblem: (failure) => noteProblem(failure).pipe(Effect.as("kept" as const)),
        RecheckStorageFailed: (failure) =>
          Effect.logWarning("A Keycloak re-check could not read or write the Hub's storage.", {
            step: failure.detail,
          }).pipe(Effect.as("kept" as const)),
      }),
      Effect.catchCause(() =>
        Effect.logWarning("A Keycloak re-check failed unexpectedly.").pipe(
          Effect.as("kept" as const),
        ),
      ),
      Effect.flatMap((outcome) => PubSub.publish(outcomes, { loginId, outcome })),
      slots.withPermits(1),
      Effect.ensuring(Effect.sync(() => inFlight.delete(loginId))),
    );

  const onDue = (loginId: string) =>
    Effect.suspend(() => {
      if (inFlight.has(loginId)) return Effect.void;
      inFlight.add(loginId);
      return Effect.asVoid(Effect.forkIn(runRecheck(loginId), layerScope));
    });

  // Out of every trace: nothing of a re-check (a refresh token above all) reaches a span.
  yield* Effect.forkIn(
    Effect.forever(Effect.flatMap(sessions.takeDueLogin, onDue)).pipe(
      Effect.withTracerEnabled(false),
    ),
    layerScope,
  );

  // Back-channel logout: `jti`s seen, oldest first (one TTL for all, so also first to expire).
  const seenJtis = new Map<string, number>();

  // Untraced: the logout token is its argument.
  const backchannelLogout: KeycloakLogins["Service"]["backchannelLogout"] = Effect.fnUntraced(
    function* (logoutToken) {
      const invalid = (check: string) =>
        // Which check, never a value from the token.
        Effect.logDebug("Back-channel logout refused", { check }).pipe(
          Effect.as("invalid" as const),
        );
      if (logoutToken.length === 0 || logoutToken.length > MAX_LOGOUT_TOKEN_LENGTH) {
        return yield* invalid("size");
      }
      const enabled = yield* settings.keycloakConfig.pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(enabled)) return yield* invalid("keycloak off");
      const realm = yield* keycloakRealm.realmFor(enabled.value.issuer).pipe(Effect.option);
      if (Option.isNone(realm)) return yield* invalid("realm");
      const verified = yield* keycloak
        .verifyLogoutToken(realm.value.keys, Redacted.make(logoutToken), {
          issuer: enabled.value.issuer,
          clientId: enabled.value.clientId,
        })
        .pipe(Effect.result);
      if (verified._tag === "Failure") return yield* invalid(verified.failure.detail);
      const token = verified.success;
      const nowMs = yield* Clock.currentTimeMillis;
      for (const [jti, expiresAtMs] of seenJtis) {
        if (expiresAtMs > nowMs) break;
        seenJtis.delete(jti);
      }
      if (seenJtis.has(token.jti)) return yield* invalid("jti replayed");
      if (seenJtis.size >= maxRememberedJtis) {
        yield* Effect.logWarning("Back-channel logout refused: too many recent logout tokens.");
        return "invalid" as const;
      }
      seenJtis.set(token.jti, nowMs + Duration.toMillis(JTI_TTL));
      // Ending failed: the `jti` is forgotten, so Keycloak's retry is taken, and the answer is an
      // error, never a 200 Keycloak would take as delivered. Nothing matching stays a 200.
      return yield* identities
        .liveLoginsFor({ issuer: enabled.value.issuer, sid: token.sid, subject: token.sub })
        .pipe(
          Effect.flatMap((loginIds) => endLogins(loginIds, "backchannel", system)),
          Effect.as("ok" as const),
          Effect.catch(() =>
            Effect.sync(() => seenJtis.delete(token.jti)).pipe(
              Effect.andThen(Effect.logWarning("Back-channel logout could not end the sign-ins.")),
              Effect.as("failed" as const),
            ),
          ),
        );
    },
    Effect.withTracerEnabled(false),
  );

  const handles = yield* makeGrantStore<SignOutHandle>(MAX_SIGN_OUT_HANDLES + 1);

  const signOutHandle: KeycloakLogins["Service"]["signOutHandle"] = Effect.fn(
    "KeycloakLogins.signOutHandle",
  )(
    function* (loginId) {
      const login = yield* identities.loginForRefresh(loginId);
      if (Option.isNone(login) || login.value.ended) return undefined;
      const handle = base64UrlEncode(yield* random.randomBytes(32));
      const nowMs = yield* Clock.currentTimeMillis;
      const stored = yield* handles.putIfRoom(
        yield* sha256(handle),
        {
          loginId,
          userId: login.value.userId,
          expiresAtMs: nowMs + Duration.toMillis(SIGN_OUT_HANDLE_TTL),
        },
        nowMs,
        MAX_SIGN_OUT_HANDLES,
      );
      // Full: the page simply offers no «also sign out of Keycloak».
      return stored ? handle : undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const signOut: KeycloakLogins["Service"]["signOut"] = Effect.fn("KeycloakLogins.signOut")(
    function* (request, handle) {
      const origin = hubOrigin(request);
      if (origin === undefined) {
        return yield* new KeycloakSignOutRefusedError({ reason: "invalid-origin" });
      }
      // Spent the first time it is presented; given back only if the ending fails.
      const handleKey = yield* sha256(handle);
      const entry = yield* handles.take(handleKey);
      const nowMs = yield* Clock.currentTimeMillis;
      if (entry === undefined || entry.expiresAtMs <= nowMs) {
        return yield* new KeycloakSignOutRefusedError({ reason: "invalid-handle" });
      }
      const ended = yield* endLogins(
        [entry.loginId],
        "sign-out",
        AuditLog.userActor(entry.userId),
      ).pipe(Effect.result);
      if (ended._tag === "Failure") {
        // Never sent to Keycloak while the Hub's sign-in and its apps live on: an error, and the
        // handle back for a retry until it expires.
        yield* handles.putIfRoom(handleKey, entry, nowMs, MAX_SIGN_OUT_HANDLES);
        return yield* new KeycloakSignOutFailedError();
      }
      const enabled = yield* settings.keycloakConfig.pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(enabled)) return { endSessionUrl: null };
      const realm = yield* keycloakRealm.realmFor(enabled.value.issuer).pipe(Effect.option);
      const endpoint = Option.isSome(realm) ? realm.value.discovery.endSessionEndpoint : undefined;
      if (endpoint === undefined) return { endSessionUrl: null };
      const url = new URL(endpoint);
      url.searchParams.set("client_id", enabled.value.clientId);
      url.searchParams.set("post_logout_redirect_uri", `${origin}${KEYCLOAK_POST_LOGOUT_PATH}`);
      // Ticket 11: no `id_token_hint`, so no ID token ever reaches the browser (its history, the
      // realm's access log); Keycloak asks the person to confirm instead.
      return { endSessionUrl: url.href };
    },
  );

  const status: KeycloakLogins["Service"]["status"] = Effect.gen(function* () {
    const offline = yield* identities
      .newestLoginOffline()
      .pipe(Effect.orElseSucceed(() => Option.none<boolean>()));
    return {
      unreachableSince: problem === undefined ? null : DateTime.formatIso(problem.since),
      problem: problem?.kind ?? null,
      lastLoginOffline: Option.getOrNull(offline),
    } satisfies KeycloakStatus;
  });

  return KeycloakLogins.of({
    backchannelLogout,
    signOutHandle,
    signOut,
    status,
    recheckOutcomes: PubSub.subscribe(outcomes).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layerWith = (options: LoginsBounds = {}) =>
  Layer.effect(KeycloakLogins, makeWith(options));
