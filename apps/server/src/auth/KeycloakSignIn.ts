/**
 * Sign-in, linking and `step-up` through Keycloak (spec, tickets 02 and 06): code flow with PKCE
 * S256, `state` bound to the browser by a `__Host-` cookie, `nonce` and RFC 9207 `iss`. Flows live
 * 10 minutes in memory, spent the first time the browser comes back.
 */
import {
  type AuthReauth,
  type AuthUser,
  KEYCLOAK_CALLBACK_PATH,
  KEYCLOAK_PROOF_FRAGMENT_PARAM,
  KEYCLOAK_RESULT_PARAM,
  type KeycloakFlowIntent,
  type KeycloakSignInFailure,
  type UserId,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { HttpServerRequest } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerConfig from "../config.ts";
import * as UserIdentities from "../persistence/UserIdentities.ts";
import * as Users from "../persistence/Users.ts";
import { readHubCookie } from "../preview/PreviewOrigin.ts";
import * as InvitationService from "../spaces/InvitationService.ts";
import * as GroupSync from "./GroupSync.ts";
import { clientBucketOf, isLoopbackClientAddress } from "./clientConnection.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as KeycloakAdmission from "./KeycloakAdmission.ts";
import * as KeycloakClient from "./KeycloakClient.ts";
import * as KeycloakGroups from "./KeycloakGroups.ts";
import * as KeycloakLogins from "./KeycloakLogins.ts";
import * as KeycloakRealm from "./KeycloakRealm.ts";
import * as KeycloakStepUpProofs from "./KeycloakStepUpProofs.ts";
import * as KeycloakTokens from "./keycloakTokens.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import { makeHubOrigin } from "./keycloakOrigins.ts";
import { makeGrantStore } from "./pkceGrants.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as SignInSettings from "./SignInSettings.ts";
import * as UserDirectory from "./UserDirectory.ts";
import { base64UrlEncode, deriveAuthClientMetadata, timingSafeEqualBase64Url } from "./utils.ts";

/** Long enough to sign in at Keycloak (and register there), short enough that a stray one dies. */
const FLOW_TTL = Duration.minutes(10);
/** Flows waiting for their callback, all clients together; past it `start` says «try again». */
const MAX_PENDING_FLOWS = 10_000;
/** A client's own pending flows; its next start drops its own oldest, never another client's. */
const FLOWS_PER_CLIENT = 5;
/** Starts one client may make per minute; the rest are refused until the minute passes. */
const STARTS_PER_MINUTE = 20;
const MAX_TRACKED_CLIENTS = 10_000;
/**
 * A `step-up`'s `auth_time` may be this much before the flow started: the realm's clock and the
 * Hub's differ a little. Anything older is an authentication from before this confirmation.
 */
const AUTH_TIME_SKEW = Duration.seconds(30);

/** The flow cookie: `__Host-` over HTTPS (Path=/, no Domain), the bare name on loopback HTTP. */
export const FLOW_COOKIE_NAME = "t3_keycloak_flow";
/** The key in the Hub's encrypted store that seals refresh tokens (and ID tokens, ticket 07). */
export const REFRESH_TOKEN_KEY_NAME = KeycloakTokens.REFRESH_TOKEN_KEY_NAME;
/** Where a `link` lands by default: the User's account settings. */
export const ACCOUNT_PATH = "/settings/user/account";
/** Where an `invitation` flow that did not go through lands: the page that started it. */
const INVITE_PATH = "/invite";

/** A refresh token's associated data: a row copied to another login does not open. */
export const refreshTokenContext = KeycloakTokens.refreshTokenContext;

interface PendingFlow {
  readonly intent: KeycloakFlowIntent;
  readonly returnTo: string;
  /** SHA-256 of the cookie value: the flow comes back only to the browser that started it. */
  readonly browserBinding: string;
  readonly nonce: string;
  readonly codeVerifier: Redacted.Redacted<string>;
  /** Exactly what the authorization request named, sent again at the exchange. */
  readonly redirectUri: string;
  readonly issuer: string;
  readonly clientId: string;
  /** For `link`: the User and the browser session that proved their credential at `start`. */
  readonly link: { readonly userId: UserId; readonly sessionId: AuthSessionId } | undefined;
  /** For `step-up` (ticket 06): the User and the browser session the proof will serve. */
  readonly stepUp: { readonly userId: UserId; readonly sessionId: AuthSessionId } | undefined;
  /** When `start` ran: a `step-up`'s authentication must come after it. */
  readonly startedAtMs: number;
  /** For `invitation`: the token, checked at `start` and again at the callback; never sent out. */
  readonly invitationToken: Redacted.Redacted<string> | undefined;
  readonly expiresAtMs: number;
}

/** Why `start` refused, before any flow exists. */
export class KeycloakStartRefusedError extends Schema.TaggedError<KeycloakStartRefusedError>()(
  "KeycloakStartRefusedError",
  {
    reason: Schema.Literals([
      // Keycloak is off, or has no client secret.
      "off",
      "invalid-return-to",
      // No `Origin`, or one the Hub does not take as its own; or a preview's page.
      "invalid-origin",
      // `link` or `step-up` without this browser's own session.
      "not-signed-in",
      // `step-up` by a User who does not sign in with Keycloak (ticket 06).
      "no-identity",
      // Too many starts from this client in a minute.
      "rate-limited",
      // Too many flows under way on the whole Hub.
      "busy",
      // The realm's discovery or keys could not be read.
      "unavailable",
      // `invitation` without a live Invitation's token, or a token with another intent.
      "invitation-invalid",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "off":
        return "Sign-in with Keycloak is off on this Hub.";
      case "rate-limited":
        return "Too many attempts. Wait a minute and try again.";
      case "busy":
        return "Too many sign-ins are under way. Try again in a minute.";
      case "unavailable":
        return "Keycloak is not answering. Try again in a moment.";
      case "invitation-invalid":
        // As the Invitation's preview says it: unknown, used, expired or revoked alike.
        return new InvitationService.InvitationInvalidError({}).message;
      case "no-identity":
        return "Only an account that signs in with Keycloak confirms through it.";
      default:
        return "This sign-in cannot start from here.";
    }
  }
}

export interface FlowCookie {
  readonly name: string;
  readonly value: string;
  readonly secure: boolean;
}

/** Where the callback sends the browser, and the session it signed in, if any. */
export interface CallbackOutcome {
  readonly redirectTo: string;
  readonly session: { readonly token: string; readonly expiresAt: DateTime.DateTime } | undefined;
  /** Whether the flow cookie was set `Secure` (`__Host-`): the name to expire. */
  readonly secure: boolean;
}

export class KeycloakSignIn extends Context.Service<
  KeycloakSignIn,
  {
    readonly start: (
      request: HttpServerRequest.HttpServerRequest,
      input: {
        readonly intent: KeycloakFlowIntent;
        readonly returnTo?: string | undefined;
        readonly reauth?: AuthReauth | undefined;
        readonly invitationToken?: string | undefined;
        readonly strongFactor?: boolean | undefined;
      },
    ) => Effect.Effect<
      { readonly authorizationUrl: string; readonly cookie: FlowCookie },
      | KeycloakStartRefusedError
      | UserDirectory.AccountChangeRefusedError
      | UserDirectory.SignInThrottledError
      | UserDirectory.UserDirectoryStorageError
      | SignInSettings.SignInSettingsStorageError
      | InvitationService.InvitationStorageError
    >;
    /** Never fails: every refusal is a redirect with `?keycloak=<code>`. */
    readonly callback: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<CallbackOutcome>;
  }
>()("t3/auth/KeycloakSignIn") {}

/**
 * `returnTo` as a path on this Hub, or undefined: one leading `/`, never `//` or a `\` (which
 * browsers read as another host), no control characters, and still on this origin once resolved.
 */
export const safeReturnTo = (value: string): string | undefined => {
  if (value.length === 0 || value.length > 2048) return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  if ([...value].some((char) => char < " " || char === "\u007f")) return undefined;
  // No `.` or `..` segments, even encoded: resolving them can fold the path into `//host`.
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path.split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return undefined;
  const base = "https://hub.invalid";
  const url = URL.parse(value, base);
  if (url === null || url.origin !== base || url.pathname.startsWith("//")) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
};

const withResult = (path: string, failure: KeycloakSignInFailure) => {
  const url = new URL(path, "https://hub.invalid");
  url.searchParams.set(KEYCLOAK_RESULT_PARAM, failure);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** A `step-up`'s way back: the page, with the proof's id in the fragment, never the query. */
const withProof = (path: string, proofId: string) => {
  const url = new URL(path, "https://hub.invalid");
  url.hash = new URLSearchParams({ [KEYCLOAK_PROOF_FRAGMENT_PARAM]: proofId }).toString();
  return `${url.pathname}${url.search}${url.hash}`;
};

/** Internal: a refusal and whether it counts toward the client's sign-in back-off. */
class CallbackRefusal extends Schema.TaggedError<CallbackRefusal>()("CallbackRefusal", {
  failure: Schema.String,
  counted: Schema.Boolean,
  /** For a debug log: which check. Never a value from the request or the token. */
  detail: Schema.String,
}) {}

const refuse = (failure: KeycloakSignInFailure, detail: string, counted = false) =>
  new CallbackRefusal({ failure, counted, detail });

export interface FlowBounds extends KeycloakLogins.LoginsBounds {
  readonly maxPendingFlows?: number;
  readonly startsPerMinute?: number;
  readonly flowsPerClient?: number;
}

/** A sign-in's strength (ticket 06): what its token said, and what that is under the lists. */
interface Strength {
  readonly evidence: KeycloakAdmission.LoginEvidence;
  readonly strong: boolean;
}

const makeWith = Effect.fn("KeycloakSignIn.makeWith")(function* (options: FlowBounds) {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* SignInSettings.SignInSettings;
  const keycloak = yield* KeycloakClient.KeycloakClient;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const users = yield* Users.UserRepository;
  const identities = yield* UserIdentities.UserIdentities;
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const audit = yield* AuditLog.AuditLog;
  const invitations = yield* InvitationService.InvitationService;
  const stepUpProofs = yield* KeycloakStepUpProofs.KeycloakStepUpProofs;
  const keycloakGroups = yield* KeycloakGroups.KeycloakGroups;
  const keycloakRealm = yield* KeycloakRealm.KeycloakRealm;
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const cryptoContext = yield* Effect.context<Aead.Aead | SecureRandom.SecureRandom>();

  const maxPendingFlows = options.maxPendingFlows ?? MAX_PENDING_FLOWS;
  // Never evicts: `putIfRoom` refuses at the cap, and a client drops only its own flows.
  const flows = yield* makeGrantStore<PendingFlow>(maxPendingFlows + 1);
  const startsPerMinute = options.startsPerMinute ?? STARTS_PER_MINUTE;
  const flowsPerClient = options.flowsPerClient ?? FLOWS_PER_CLIENT;
  const startWindows = new Map<string, { windowStartMs: number; count: number }>();
  /** Each client bucket's pending flow keys, oldest first. */
  const clientFlows = new Map<string, Array<string>>();

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );
  const randomToken = random.randomBytes(32).pipe(Effect.map((bytes) => base64UrlEncode(bytes)));

  /**
   * Where the realm sends the browser back: `T3CODE_PUBLIC_URL` when set, else the page's own
   * origin, taken only when it is the request's own or one the Hub trusts (`keycloakOrigins.ts`).
   */
  const hubOrigin = makeHubOrigin(config);
  const redirectUriFor = (request: HttpServerRequest.HttpServerRequest) => {
    const base = hubOrigin(request);
    return base === undefined ? undefined : `${base}${KEYCLOAK_CALLBACK_PATH}`;
  };

  /** Counts this start against its client bucket; false past the minute's allowance. */
  const allowStart = (key: string, nowMs: number) => {
    const window = startWindows.get(key);
    if (window === undefined || nowMs - window.windowStartMs >= 60_000) {
      startWindows.delete(key);
      startWindows.set(key, { windowStartMs: nowMs, count: 1 });
      for (const oldest of startWindows.keys()) {
        if (startWindows.size <= MAX_TRACKED_CLIENTS) break;
        startWindows.delete(oldest);
      }
      return true;
    }
    window.count += 1;
    return window.count <= startsPerMinute;
  };

  // The configured realm's discovery and keys, shared with the re-checks (ticket 07).
  const realmFor = keycloakRealm.realmFor;

  const enabledConfig = settings.keycloakConfig;

  /**
   * The flow cookie under exactly the name `start` set: over HTTPS only `__Host-` (a sibling host
   * can toss a bare one), the bare name only on loopback HTTP; none from a preview's page.
   */
  const flowCookieOf = (request: HttpServerRequest.HttpServerRequest, clientIp?: string) =>
    request.protocol === "https" || isLoopbackClientAddress(clientIp)
      ? readHubCookie(request, FLOW_COOKIE_NAME, config.previewOrigin, { hostOnly: true })
      : undefined;

  const start: KeycloakSignIn["Service"]["start"] = Effect.fn("KeycloakSignIn.start")(
    function* (request, input) {
      const returnTo =
        input.returnTo === undefined
          ? input.intent === "link"
            ? ACCOUNT_PATH
            : "/"
          : safeReturnTo(input.returnTo);
      if (returnTo === undefined) {
        return yield* new KeycloakStartRefusedError({ reason: "invalid-return-to" });
      }
      const redirectUri = redirectUriFor(request);
      if (redirectUri === undefined) {
        return yield* new KeycloakStartRefusedError({ reason: "invalid-origin" });
      }
      // A token comes with `invitation` and only with it.
      if ((input.intent === "invitation") !== (input.invitationToken !== undefined)) {
        return yield* new KeycloakStartRefusedError({ reason: "invitation-invalid" });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const clientIp = deriveAuthClientMetadata({ request }).ipAddress;
      // Unauthenticated: a client (an IPv4 address or an IPv6 /64) gets a few starts a minute.
      const bucket = clientBucketOf(clientIp);
      if (!allowStart(bucket, nowMs)) {
        return yield* new KeycloakStartRefusedError({ reason: "rate-limited" });
      }
      const enabled = yield* enabledConfig;
      if (Option.isNone(enabled)) {
        return yield* new KeycloakStartRefusedError({ reason: "off" });
      }
      const { issuer, clientId } = enabled.value;

      // A link no longer valid fails here, before the person leaves for Keycloak. Checking spends
      // nothing and says no more than the Invitation's preview; a dead link counts against it.
      let invitationToken: PendingFlow["invitationToken"];
      if (input.invitationToken !== undefined) {
        yield* invitations.inspect(input.invitationToken, clientIp).pipe(
          Effect.catchTags({
            InvitationInvalidError: () =>
              Effect.fail(new KeycloakStartRefusedError({ reason: "invitation-invalid" })),
          }),
        );
        invitationToken = Redacted.make(input.invitationToken);
      }

      /** The browser's own User session, for `link` and `step-up`: never a token an app holds. */
      const browserSession = environmentAuth.authenticateBrowserSession(request).pipe(
        Effect.mapError(() => new KeycloakStartRefusedError({ reason: "not-signed-in" })),
        Effect.flatMap((session) =>
          session.userId === undefined
            ? Effect.fail(new KeycloakStartRefusedError({ reason: "not-signed-in" }))
            : Effect.succeed({ userId: session.userId, sessionId: session.sessionId }),
        ),
      );

      let stepUpFor: PendingFlow["stepUp"];
      if (input.intent === "step-up") {
        stepUpFor = yield* browserSession;
        const identity = yield* identities
          .findByUser(stepUpFor.userId)
          .pipe(Effect.mapError((cause) => new UserDirectory.UserDirectoryStorageError({ cause })));
        if (Option.isNone(identity)) {
          return yield* new KeycloakStartRefusedError({ reason: "no-identity" });
        }
      }

      let link: PendingFlow["link"];
      if (input.intent === "link") {
        // The browser's own session, never a token an app holds, and a fresh proof of the
        // User's current credential: a stolen session alone cannot attach another account.
        const session = yield* browserSession;
        yield* userDirectory.confirmLinkStepUp(
          {
            userId: session.userId,
            sessionId: session.sessionId,
            origin: request.headers.origin ?? "",
          },
          input.reauth,
        );
        link = { userId: session.userId, sessionId: session.sessionId };
      }

      // Ask the realm for a strong factor (`acr_values`, the Owner's strong `acr` list) when the
      // page asks for one (a retry, or an action that needs it) or the User's Role needs it. It
      // only shapes the request: the callback reads strength from the verified token alone.
      const boundUser = link?.userId ?? stepUpFor?.userId;
      const askStrong =
        input.strongFactor === true ||
        (boundUser !== undefined && (yield* userDirectory.requiresStrongSignIn(boundUser)));
      const acrValues = askStrong ? enabled.value.strongAcr : [];

      const realmNow = yield* realmFor(issuer).pipe(
        Effect.mapError(() => new KeycloakStartRefusedError({ reason: "unavailable" })),
      );
      const [state, nonce, verifier, binding] = yield* Effect.all([
        randomToken,
        randomToken,
        randomToken,
        randomToken,
      ]);
      const flowKey = yield* sha256(state);
      // Past its own cap a client drops its own oldest flows; the others' are never touched.
      const live: Array<string> = [];
      for (const key of clientFlows.get(bucket) ?? []) {
        if ((yield* flows.get(key, nowMs)) !== undefined) live.push(key);
      }
      while (live.length >= flowsPerClient) {
        const oldest = live.shift();
        if (oldest !== undefined) yield* flows.take(oldest);
      }
      const stored = yield* flows.putIfRoom(
        flowKey,
        {
          intent: input.intent,
          returnTo,
          browserBinding: yield* sha256(binding),
          nonce,
          codeVerifier: Redacted.make(verifier),
          redirectUri,
          issuer,
          clientId,
          link,
          stepUp: stepUpFor,
          startedAtMs: nowMs,
          invitationToken,
          expiresAtMs: nowMs + Duration.toMillis(FLOW_TTL),
        },
        nowMs,
        maxPendingFlows,
      );
      if (!stored) return yield* new KeycloakStartRefusedError({ reason: "busy" });
      clientFlows.delete(bucket);
      clientFlows.set(bucket, [...live, flowKey]);
      for (const oldestBucket of clientFlows.keys()) {
        if (clientFlows.size <= MAX_TRACKED_CLIENTS) break;
        clientFlows.delete(oldestBucket);
      }
      const secure = request.protocol === "https";
      return {
        authorizationUrl: KeycloakClient.authorizationUrl(realmNow.discovery, {
          clientId,
          redirectUri,
          state,
          nonce,
          codeChallenge: yield* sha256(verifier),
          // `link` and `step-up` ask the person to authenticate again, whatever the SSO session;
          // `step-up` also asks for an authentication made now.
          ...(input.intent === "link" || input.intent === "step-up" || askStrong
            ? { prompt: "login" as const }
            : {}),
          ...(input.intent === "step-up" ? { maxAge: 0 as const } : {}),
          ...(acrValues.length > 0 ? { acrValues } : {}),
        }),
        cookie: {
          name: secure ? `__Host-${FLOW_COOKIE_NAME}` : FLOW_COOKIE_NAME,
          value: binding,
          secure,
        },
      };
    },
  );

  const storage = (detail: string) => () => refuse("failed", detail);

  const sealToken = (
    kind: KeycloakTokens.TokenKind,
    loginId: string,
    token: Redacted.Redacted<string> | undefined,
  ) =>
    token === undefined
      ? Effect.succeed(null)
      : KeycloakTokens.seal(secretStore, kind, loginId, token).pipe(
          Effect.provide(cryptoContext),
          Effect.mapError(storage(`seal ${kind} token`)),
        );

  const inactiveRefusal = (userId: UserId) =>
    userDirectory.inactiveReason(userId).pipe(
      Effect.mapError(storage("inactive reason")),
      Effect.flatMap((inactive) =>
        inactive === undefined
          ? Effect.void
          : Effect.fail(refuse(inactive.removed ? "removed" : "disabled", "user inactive")),
      ),
    );

  /** The browser session for a User the callback proved, from this login. */
  const issueSession = (
    request: HttpServerRequest.HttpServerRequest,
    user: AuthUser,
    loginId: string,
  ) =>
    environmentAuth
      .startUserBrowserSession(request, user, deriveAuthClientMetadata({ request }), {
        identityLoginId: loginId,
      })
      .pipe(
        // The Owner may disable the User between the checks and the write (migration 092).
        Effect.catch(() =>
          inactiveRefusal(user.id).pipe(
            Effect.andThen(Effect.fail(refuse("failed", "session issue"))),
          ),
        ),
      );

  const newLogin = Effect.fn("KeycloakSignIn.newLogin")(function* (
    userId: UserId,
    flow: PendingFlow,
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    now: string,
    strength: Strength,
  ) {
    const loginId = yield* random.uuidV4();
    yield* identities
      .insertLogin({
        loginId,
        userId,
        issuer: flow.issuer,
        subject: claims.sub,
        keycloakSid: claims.sid ?? null,
        refreshTokenSealed: yield* sealToken("refresh", loginId, tokens.refreshToken),
        // Ticket 07: the latest ID token, for «also sign out of Keycloak»'s `id_token_hint`.
        idTokenSealed: yield* sealToken("id", loginId, tokens.idToken),
        offline: tokens.refreshToken !== undefined && tokens.scopes.includes("offline_access"),
        strong: strength.strong,
        acr: strength.evidence.acr,
        amr: strength.evidence.amr,
        now,
      })
      .pipe(Effect.mapError(storage("insert login")));
    return loginId;
  });

  /**
   * Ticket 05: what the token's groups change for a User (`planGroupSync`), read inside the
   * caller's transaction. `undefined` is a new identity, with no Memberships yet. The Owner
   * belongs to no Organization, so no group puts them in one.
   */
  const groupPlan = (
    user: { readonly id: UserId; readonly isOwner: boolean } | undefined,
    claims: KeycloakClient.IdTokenClaims,
    groupsClaim: string,
  ) =>
    keycloakGroups
      .plan(user, claims, groupsClaim)
      .pipe(Effect.mapError((error) => refuse("failed", error.step)));

  /** Applies a plan in the caller's transaction; `afterCommit` once it commits. */
  const applyGroups = (userId: UserId, changes: ReadonlyArray<GroupSync.GroupChange>) =>
    keycloakGroups
      .apply(userId, changes)
      .pipe(Effect.mapError((error) => refuse("failed", error.step)));

  /** An existing, active User's sign-in: fresh labels, a new login and its session. */
  const signIn = Effect.fn("KeycloakSignIn.signIn")(function* (
    request: HttpServerRequest.HttpServerRequest,
    flow: PendingFlow,
    userId: UserId,
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    strength: Strength,
  ) {
    const record = yield* users.getById(userId).pipe(Effect.mapError(storage("read user")));
    if (Option.isNone(record)) return yield* refuse("unknown", "identity without user");
    const user: AuthUser = {
      id: record.value.userId,
      displayName: record.value.displayName,
      isOwner: record.value.isOwner,
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* identities
            .updateLabels({
              userId,
              username: KeycloakAdmission.identityLabel(claims.preferred_username),
              email: KeycloakAdmission.identityLabel(claims.email),
              now,
            })
            .pipe(Effect.mapError(storage("update labels")));
          const loginId = yield* newLogin(userId, flow, claims, tokens, now, strength);
          return yield* issueSession(request, user, loginId);
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(refuse("failed", "transaction")) }));
  });

  /**
   * A User for a new identity, run inside the caller's transaction: the User (no sign-in name, a
   * cleaned display name), the identity by issuer and subject, the login and the session. Never
   * matched to anyone by email.
   */
  const newUser = Effect.fn("KeycloakSignIn.newUser")(function* (
    request: HttpServerRequest.HttpServerRequest,
    flow: PendingFlow,
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    strength: Strength,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const user = yield* userDirectory
      .createIdentityUser(KeycloakAdmission.newUserDisplayName(claims))
      .pipe(Effect.mapError(storage("create user")));
    const linked = yield* identities
      .link({
        userId: user.id,
        issuer: flow.issuer,
        subject: claims.sub,
        username: KeycloakAdmission.identityLabel(claims.preferred_username),
        email: KeycloakAdmission.identityLabel(claims.email),
        now,
      })
      .pipe(Effect.mapError(storage("link new identity")));
    // The same identity's other callback got there first; trying again signs in.
    if (!linked) return yield* refuse("failed", "identity created meanwhile");
    const loginId = yield* newLogin(user.id, flow, claims, tokens, now, strength);
    const session = yield* issueSession(request, user, loginId);
    return { user, session };
  });

  /**
   * A new User without an Invitation, audited `user.register`: by open registration, or by a
   * mapped group (ticket 05), whose Memberships come with the User in the same transaction.
   */
  const register = Effect.fn("KeycloakSignIn.register")(function* (
    request: HttpServerRequest.HttpServerRequest,
    flow: PendingFlow,
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    strength: Strength,
    groupsClaim: string,
  ) {
    const { session, afterCommit } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const { user, session } = yield* newUser(request, flow, claims, tokens, strength);
          const plan = yield* groupPlan({ id: user.id, isOwner: false }, claims, groupsClaim);
          const applied = yield* applyGroups(user.id, plan);
          yield* audit
            .record({
              actor: AuditLog.userActor(user.id),
              action: "user.register",
              target: { kind: "user", id: user.id, name: user.displayName },
              detail: { via: GroupSync.anyAdded(plan) ? "group" : "open", issuer: flow.issuer },
            })
            .pipe(Effect.mapError(storage("audit")));
          return { session, afterCommit: applied.afterCommit };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(refuse("failed", "transaction")) }));
    yield* afterCommit;
    return session;
  });

  /** The token of an `invitation` flow, re-read now: it may have expired or been revoked. */
  const invitationNow = (
    flow: PendingFlow,
    clientIp: string | undefined,
  ): Effect.Effect<KeycloakAdmission.InvitationState, CallbackRefusal> =>
    flow.invitationToken === undefined
      ? Effect.succeed({ kind: "none" })
      : invitations.inspect(Redacted.value(flow.invitationToken), clientIp).pipe(
          Effect.map((found): KeycloakAdmission.InvitationState => found),
          Effect.catchTags({
            InvitationInvalidError: () => Effect.succeed({ kind: "invalid" } as const),
            SignInThrottledError: () => Effect.fail(refuse("throttled", "invitation throttled")),
            InvitationStorageError: () => Effect.fail(refuse("failed", "read invitation")),
          }),
        );

  /** What `/api/invitations/join` refused, as a code for the page to say in its words. */
  const joinRefusal = (
    error:
      | InvitationService.InvitationInvalidError
      | InvitationService.InvitationRefusedError
      | InvitationService.InvitationConflictError
      | UserDirectory.SignInThrottledError
      | InvitationService.InvitationStorageError,
  ): KeycloakSignInFailure => {
    switch (error._tag) {
      case "InvitationInvalidError":
        return "invitation-invalid";
      case "InvitationRefusedError":
        return error.code ?? "failed";
      case "InvitationConflictError":
        return error.code ?? "failed";
      case "SignInThrottledError":
        return "throttled";
      case "InvitationStorageError":
        return "failed";
    }
  };

  /**
   * `sign-in` and `invitation`: who the identity becomes is `KeycloakAdmission.decide`'s, from
   * the Registration mode, the identity's User and the Invitation the flow carries.
   */
  const admit = Effect.fn("KeycloakSignIn.admit")(function* (
    request: HttpServerRequest.HttpServerRequest,
    flow: PendingFlow,
    mode: KeycloakAdmission.AdmissionInput["mode"],
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    clientIp: string | undefined,
    strength: Strength,
    groupsClaim: string,
  ) {
    const found = yield* identities
      .findBySubject(flow.issuer, claims.sub)
      .pipe(Effect.mapError(storage("find identity")));
    let identity: KeycloakAdmission.IdentityState = { kind: "unknown" };
    if (Option.isSome(found)) {
      const { userId } = found.value;
      const inactive = yield* userDirectory
        .inactiveReason(userId)
        .pipe(Effect.mapError(storage("inactive reason")));
      identity =
        inactive === undefined
          ? { kind: "active", userId }
          : { kind: "inactive", userId, removed: inactive.removed };
    }
    const invitation = yield* invitationNow(flow, clientIp);
    const invitationMakesAdmin = invitation.kind === "organization" && invitation.role === "admin";
    const intent = flow.intent === "invitation" ? "invitation" : "sign-in";
    const token = flow.invitationToken === undefined ? "" : Redacted.value(flow.invitationToken);

    if (identity.kind === "active") {
      const { userId } = identity;
      const record = yield* users.getById(userId).pipe(Effect.mapError(storage("read user")));
      if (Option.isNone(record)) return yield* refuse("unknown", "identity without user");
      // Ticket 05: mapping, strong-factor read, decision and session share one transaction. A
      // weak sign-in's refusal still commits the mapping (spec «Factor fuerte»), its promotion
      // having ended their weak access, and is returned after. `link` refuses before instead.
      const done = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const plan = yield* groupPlan(
              { id: userId, isOwner: record.value.isOwner },
              claims,
              groupsClaim,
            );
            const applied = yield* applyGroups(userId, plan);
            // Read after the mapping: an Owner or Admin now, or one this Invitation would make.
            const requiresStrong =
              (yield* userDirectory
                .requiresStrongSignIn(userId)
                .pipe(Effect.mapError(storage("requires strong")))) || invitationMakesAdmin;
            const outcome = KeycloakAdmission.decide({
              mode,
              intent,
              identity,
              invitation,
              mappedGroup: GroupSync.anyAdded(plan),
              requiresStrong,
              loginStrong: strength.strong,
            });
            if (
              outcome.kind !== "enter" &&
              outcome.kind !== "enter-and-join" &&
              outcome.kind !== "enter-has-account"
            ) {
              return {
                refusal: outcome.kind === "refuse" ? outcome.reason : ("failed" as const),
                afterCommit: applied.afterCommit,
              };
            }
            const session = yield* signIn(request, flow, userId, claims, tokens, strength);
            return { outcome: outcome.kind, session, afterCommit: applied.afterCommit };
          }),
        )
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(refuse("failed", "transaction")) }));
      // Once committed: their connections hear the Memberships, ended sessions lose sockets.
      yield* done.afterCommit;
      if ("refusal" in done) return yield* refuse(done.refusal, "admission");
      const session = done.session;
      if (done.outcome === "enter") return { session, redirectTo: flow.returnTo };
      // Ticket 04: signed in, told they already have an account; the Invitation stays unspent.
      // Only the code goes in the address, never the token.
      if (done.outcome === "enter-has-account") {
        return { session, redirectTo: withResult(INVITE_PATH, "has-account") };
      }
      // `enter-and-join`: signed in whatever the Invitation says, as they are this Hub's User
      // already. A link found dead just now is the refusal `join` would give, counted once.
      const joined =
        invitation.kind === "invalid"
          ? ("invitation-invalid" as const)
          : yield* invitations.join(userId, token, clientIp).pipe(
              Effect.as(undefined),
              Effect.catch((error) => Effect.succeed(joinRefusal(error))),
            );
      return {
        session,
        redirectTo: joined === undefined ? flow.returnTo : withResult(INVITE_PATH, joined),
      };
    }

    // A new identity: what its groups would give, planned on no Memberships, admits it (a mapped
    // group is a permanent Invitation) and says whether it needs a strong factor. Nothing about a
    // refused one is kept.
    const plan =
      identity.kind === "unknown" ? yield* groupPlan(undefined, claims, groupsClaim) : [];
    const outcome = KeycloakAdmission.decide({
      mode,
      intent,
      identity,
      invitation,
      mappedGroup: GroupSync.anyAdded(plan),
      requiresStrong: invitationMakesAdmin || GroupSync.grantsAdmin(plan),
      loginStrong: strength.strong,
    });
    switch (outcome.kind) {
      case "refuse":
        // Nothing about a refused new identity is kept; the Invitation is untouched.
        return yield* refuse(outcome.reason, "admission");
      case "enter":
      case "enter-and-join":
      case "enter-has-account":
        return yield* refuse("failed", "admission");
      case "create-user": {
        const session = yield* register(request, flow, claims, tokens, strength, groupsClaim);
        return { session, redirectTo: flow.returnTo };
      }
      case "create-user-and-join":
      case "create-user-and-spend": {
        // One transaction: the User, identity, login and session, then the conditional spend and
        // the membership (none for a Platform invitation, ticket 04). Losing the race for the
        // link rolls the new User back.
        const { session, afterCommit } = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const created = yield* newUser(request, flow, claims, tokens, strength);
              const redeemed = yield* invitations
                .redeemForNewUser({
                  token,
                  clientIp,
                  userId: created.user.id,
                  // The Role is the spent row's: an Admin's needs this sign-in to be strong.
                  adminAllowed: strength.strong,
                })
                .pipe(
                  Effect.catchTags({
                    InvitationInvalidError: () =>
                      Effect.fail(refuse("invitation-invalid", "invitation spent meanwhile")),
                    InvitationRefusedError: (error) =>
                      Effect.fail(refuse(joinRefusal(error), "invitation refused")),
                    InvitationConflictError: (error) =>
                      Effect.fail(refuse(joinRefusal(error), "invitation conflict")),
                    SignInThrottledError: () =>
                      Effect.fail(refuse("throttled", "invitation throttled")),
                    InvitationStorageError: () =>
                      Effect.fail(refuse("failed", "invitation storage")),
                  }),
                );
              // Ticket 05: the groups, planned on the Membership just accepted, so where a group
              // maps into the same Organization it takes the Invitation's over.
              const plan = yield* groupPlan(
                { id: created.user.id, isOwner: false },
                claims,
                groupsClaim,
              );
              const applied = yield* applyGroups(created.user.id, plan);
              return {
                session: created.session,
                afterCommit: Effect.andThen(redeemed.afterCommit, applied.afterCommit),
              };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: () => Effect.fail(refuse("failed", "transaction")) }));
        yield* afterCommit;
        return { session, redirectTo: flow.returnTo };
      }
    }
  });

  const link = Effect.fn("KeycloakSignIn.link")(function* (
    request: HttpServerRequest.HttpServerRequest,
    flow: PendingFlow,
    linkTo: NonNullable<PendingFlow["link"]>,
    claims: KeycloakClient.IdTokenClaims,
    tokens: KeycloakClient.TokenSet,
    strength: Strength,
    groupsClaim: string,
  ) {
    const { userId } = linkTo;
    // The Owner and Admins sign in with a strong factor from now on: a weak one links nothing,
    // nor does one whose groups (ticket 05) would make them an Admin. Unlike a sign-in, which
    // commits the mapping and then refuses (`admit`), a link refuses before its transaction:
    // until it commits the identity is not this User's, so its groups say nothing about them.
    if (!strength.strong) {
      const owner = yield* users.getById(userId).pipe(Effect.mapError(storage("read user")));
      const needsStrong =
        (yield* userDirectory
          .requiresStrongSignIn(userId)
          .pipe(Effect.mapError(storage("requires strong")))) ||
        GroupSync.grantsAdmin(
          yield* groupPlan(
            { id: userId, isOwner: Option.isSome(owner) && owner.value.isOwner },
            claims,
            groupsClaim,
          ),
        );
      if (needsStrong) {
        return yield* refuse("strong-factor-required", "link without strong factor");
      }
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const done = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* inactiveRefusal(userId);
          const record = yield* users.getById(userId).pipe(Effect.mapError(storage("read user")));
          if (Option.isNone(record)) return yield* refuse("failed", "user gone");
          const holder = yield* identities
            .findBySubject(flow.issuer, claims.sub)
            .pipe(Effect.mapError(storage("find identity")));
          if (Option.isSome(holder) && holder.value.userId !== userId) {
            return yield* refuse("taken", "identity of another user");
          }
          const linked = yield* identities
            .link({
              userId,
              issuer: flow.issuer,
              subject: claims.sub,
              username: KeycloakAdmission.identityLabel(claims.preferred_username),
              email: KeycloakAdmission.identityLabel(claims.email),
              now,
            })
            .pipe(Effect.mapError(storage("link")));
          if (!linked) return yield* refuse("failed", "already linked");
          const isOwner = record.value.isOwner;
          // From now on only Keycloak lets them in; the Owner keeps the break-glass.
          if (!isOwner) {
            yield* users
              .removePasskeysExcept({ userId, credentialId: "" })
              .pipe(Effect.mapError(storage("remove passkeys")));
            yield* users.removePassword(userId).pipe(Effect.mapError(storage("remove password")));
            yield* users.removeTotp(userId).pipe(Effect.mapError(storage("remove totp")));
          }
          // Every session and unspent pairing link of the User ends, the Owner's too; machines'
          // credentials, gateway and CLI keys are not sessions and stay.
          const closeLinks = yield* pairingLinks
            .revokeAllForUserDeferred(userId)
            .pipe(Effect.mapError(storage("revoke pairing links")));
          const closeSockets = yield* sessions
            .revokeAllForUserDeferred(userId)
            .pipe(Effect.mapError(storage("revoke sessions")));
          // Ticket 05: a link is a Keycloak sign-in, so its groups apply, read again here.
          const plan = yield* groupPlan({ id: userId, isOwner }, claims, groupsClaim);
          if (!strength.strong && GroupSync.grantsAdmin(plan)) {
            return yield* refuse("strong-factor-required", "link without strong factor");
          }
          const applied = yield* applyGroups(userId, plan);
          const loginId = yield* newLogin(userId, flow, claims, tokens, now, strength);
          const session = yield* issueSession(
            request,
            { id: userId, displayName: record.value.displayName, isOwner },
            loginId,
          );
          yield* audit
            .record({
              actor: AuditLog.userActor(userId),
              action: "user.identity.link",
              target: { kind: "user", id: userId, name: record.value.displayName },
              detail: { issuer: flow.issuer, credentialsRemoved: !isOwner },
            })
            .pipe(Effect.mapError(storage("audit")));
          return {
            session,
            afterCommit: Effect.all([closeSockets, closeLinks, applied.afterCommit], {
              discard: true,
            }),
          };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(refuse("failed", "transaction")) }));
    // After the commit: the old sessions' sockets close, and their Admin rights are re-read.
    yield* done.afterCommit;
    yield* userDirectory.credentialsChanged(userId);
    return { session: done.session, redirectTo: flow.returnTo };
  });

  /**
   * `step-up` (ticket 06): the person authenticated again just now, as the identity the session's
   * User signs in with. Nothing is signed in or kept but a proof for that session; whether the
   * sign-in was strong is recorded in it, for `requireStepUp` and `confirmStrongFactor` to weigh.
   */
  const stepUp = Effect.fn("KeycloakSignIn.stepUp")(function* (
    flow: PendingFlow,
    bound: NonNullable<PendingFlow["stepUp"]>,
    claims: KeycloakClient.IdTokenClaims,
    strength: Strength,
  ) {
    yield* inactiveRefusal(bound.userId);
    const identity = yield* identities
      .findByUser(bound.userId)
      .pipe(Effect.mapError(storage("find identity")));
    if (
      Option.isNone(identity) ||
      identity.value.issuer !== flow.issuer ||
      identity.value.subject !== claims.sub
    ) {
      return yield* refuse("identity-mismatch", "step-up as another identity", true);
    }
    // An authentication from before this confirmation started (the realm reused its SSO session
    // despite `max_age=0`) proves nothing about who holds the session now.
    const authTime = KeycloakAdmission.authTimeOf(claims);
    if (
      authTime === undefined ||
      authTime * 1000 < flow.startedAtMs - Duration.toMillis(AUTH_TIME_SKEW)
    ) {
      return yield* refuse("failed", "step-up auth_time", true);
    }
    const proofId = yield* stepUpProofs.issue({
      userId: bound.userId,
      sessionId: bound.sessionId,
      strong: strength.strong,
      authTime,
    });
    return withProof(flow.returnTo, proofId);
  });

  const callback: KeycloakSignIn["Service"]["callback"] = Effect.fn("KeycloakSignIn.callback")(
    function* (request) {
      const secure = request.protocol === "https";
      const clientIp = deriveAuthClientMetadata({ request }).ipAddress;
      const params = new URL(request.url, "https://hub.invalid").searchParams;
      const state = params.get("state");
      // Spent the first time it comes back, whatever happens next.
      const flow =
        state === null || state.length > 512 ? undefined : yield* flows.take(yield* sha256(state));

      const run = Effect.gen(function* () {
        yield* userDirectory
          .requireClientNotThrottled(clientIp)
          .pipe(Effect.mapError(() => refuse("throttled", "throttled")));
        if (flow === undefined) return yield* refuse("failed", "unknown state", true);
        if (flow.expiresAtMs <= (yield* Clock.currentTimeMillis)) {
          return yield* refuse("failed", "expired flow", true);
        }
        const cookie = flowCookieOf(request, clientIp);
        if (
          cookie === undefined ||
          cookie.length > 512 ||
          !timingSafeEqualBase64Url(yield* sha256(cookie), flow.browserBinding)
        ) {
          return yield* refuse("failed", "browser binding", true);
        }
        const enabled = yield* enabledConfig.pipe(Effect.mapError(storage("settings")));
        if (
          Option.isNone(enabled) ||
          enabled.value.issuer !== flow.issuer ||
          enabled.value.clientId !== flow.clientId
        ) {
          return yield* refuse("unavailable", "settings changed");
        }
        const realmNow = yield* realmFor(flow.issuer).pipe(
          Effect.mapError(() => refuse("unavailable", "realm")),
        );
        // RFC 9207: the response names its issuer; required when the realm says it always does.
        const iss = params.get("iss");
        if (iss === null ? realmNow.discovery.issParameterSupported : iss !== flow.issuer) {
          return yield* refuse("failed", "iss", true);
        }
        if (params.has("error")) return yield* refuse("cancelled", "error response");
        const bound = flow.link ?? flow.stepUp;
        if (bound !== undefined) {
          // A `link` or `step-up` comes back to the very session that started it.
          const session = yield* environmentAuth
            .authenticateBrowserSession(request)
            .pipe(Effect.mapError(() => refuse("failed", "bound flow without session", true)));
          if (session.sessionId !== bound.sessionId || session.userId !== bound.userId) {
            return yield* refuse("failed", "bound flow from another session", true);
          }
        }
        const code = params.get("code");
        if (code === null || code === "" || code.length > 4096) {
          return yield* refuse("failed", "no code", true);
        }
        const tokens = yield* keycloak
          .exchangeCode(realmNow.discovery, {
            clientId: flow.clientId,
            clientSecret: enabled.value.clientSecret,
            code: Redacted.make(code),
            codeVerifier: flow.codeVerifier,
            redirectUri: flow.redirectUri,
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "invalid-grant"
                ? refuse("failed", error.detail, true)
                : refuse("unavailable", error.detail),
            ),
          );
        const claims = yield* keycloak
          .verifyIdToken(realmNow.keys, tokens.idToken, {
            issuer: flow.issuer,
            clientId: flow.clientId,
            nonce: flow.nonce,
          })
          .pipe(Effect.mapError((error) => refuse("failed", error.detail, true)));
        // Strong only by the verified token and the Owner's lists as they are now.
        const evidence = KeycloakAdmission.loginEvidence(claims);
        const strength: Strength = {
          evidence,
          strong: KeycloakAdmission.loginIsStrong(evidence, enabled.value),
        };
        if (flow.stepUp !== undefined) {
          return {
            redirectTo: yield* stepUp(flow, flow.stepUp, claims, strength),
            session: undefined,
            secure,
          } satisfies CallbackOutcome;
        }
        const { session, redirectTo } =
          flow.link === undefined
            ? yield* admit(
                request,
                flow,
                enabled.value.registrationMode,
                claims,
                tokens,
                clientIp,
                strength,
                enabled.value.groupsClaim,
              )
            : yield* link(
                request,
                flow,
                flow.link,
                claims,
                tokens,
                strength,
                enabled.value.groupsClaim,
              );
        return {
          redirectTo,
          session: { token: session.sessionToken, expiresAt: session.response.expiresAt },
          secure,
        } satisfies CallbackOutcome;
      });

      const refused = Effect.fn("KeycloakSignIn.refused")(function* (refusal: CallbackRefusal) {
        if (refusal.counted) yield* userDirectory.recordClientSignInFailure(clientIp);
        // Which check, never a value from the request or the token (no subject, no email).
        yield* Effect.logDebug("Keycloak sign-in refused", {
          failure: refusal.failure,
          check: refusal.detail,
        });
        const landing =
          flow?.intent === "link" || flow?.intent === "step-up"
            ? flow.returnTo
            : flow?.intent === "invitation"
              ? INVITE_PATH
              : "/sign-in";
        return {
          redirectTo: withResult(landing, refusal.failure as KeycloakSignInFailure),
          session: undefined,
          secure,
        } satisfies CallbackOutcome;
      });

      return yield* run.pipe(Effect.catchTags({ CallbackRefusal: refused }));
    },
  );

  return KeycloakSignIn.of({ start, callback });
});

/**
 * The flows and the re-checks (ticket 07) over one realm cache and one group sync, so a refresh
 * applies Keycloak's groups exactly as a sign-in does.
 */
export const layerWith = (options: FlowBounds = {}) =>
  Layer.merge(
    Layer.effect(KeycloakSignIn, makeWith(options)),
    KeycloakLogins.layerWith(
      options.maxRememberedJtis === undefined
        ? {}
        : { maxRememberedJtis: options.maxRememberedJtis },
    ),
  ).pipe(Layer.provideMerge(KeycloakGroups.layer), Layer.provideMerge(KeycloakRealm.layer));

export const layer = layerWith();
