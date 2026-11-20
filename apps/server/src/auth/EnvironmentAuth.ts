import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  withoutInstallationScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthAccessSnapshot,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  type AuthOwnerBootstrapRequest,
  type AuthOwnerBootstrapResult,
  type AuthOwnerBootstrapStatus,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeySignInCeremony,
  type AuthPasskeySignInRequest,
  type AuthPasswordSignInRequest,
  type AuthResetLinkRedeemRequest,
  type AuthResetLinkPasswordRequest,
  type AuthSecondFactorRequired,
  type AuthTotpSignInRequest,
  type AuthUser,
  DpopFailureReason,
  type UserId,
  type DpopFailureReason as DpopFailureReasonType,
  mcpClientScopes,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as UserDirectory from "./UserDirectory.ts";
import { REUSABLE_DEV_SESSION_EXPIRES_AT, resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { OwnerPresence } from "./OwnerPresence.ts";
import { type AuthRequestMetadata, type SessionCookieNames } from "./utils.ts";
import {
  crossesFromPreviewOrigin,
  type PreviewOriginPattern,
  readHubCookie,
} from "../preview/PreviewOrigin.ts";
import { headerList, isLoopbackClientAddress, isPrivateClientAddress } from "./clientConnection.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { requestUrl } from "../requestUrl.ts";

const DEFAULT_SESSION_SUBJECT = "cli-issued-session";
/** Browser sessions a User signed in to with an account credential rather than a pairing link. */
export const USER_SIGN_IN_SUBJECT = "user-sign-in";
/** Bearer and DPoP sessions a desktop or mobile app got by signing in in the system browser. */
const APP_SIGN_IN_SUBJECT = "app-sign-in";
export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

// MCP client tokens are restricted to /mcp; HTTP API and WebSocket RPC would bypass their access cap.
const MCP_CLIENT_SUBJECT = "mcp-client";

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /** The User who approved the client; it acts as them. None only before an Owner exists. */
  readonly userId?: UserId;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly userId?: UserId;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
};

export class ServerAuthBootstrapCredentialValidationError extends Schema.TaggedError<ServerAuthBootstrapCredentialValidationError>()(
  "ServerAuthBootstrapCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate bootstrap credential.";
  }
}

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  "ServerAuthSessionCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate session credential.";
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  "ServerAuthAuthenticatedSessionIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated session.";
  }
}

export class ServerAuthAuthenticatedAccessTokenIssueError extends Schema.TaggedError<ServerAuthAuthenticatedAccessTokenIssueError>()(
  "ServerAuthAuthenticatedAccessTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated access token.";
  }
}

export class ServerAuthPairingLinkCreationError extends Schema.TaggedError<ServerAuthPairingLinkCreationError>()(
  "ServerAuthPairingLinkCreationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to create pairing link.";
  }
}

export class ServerAuthPairingLinksListError extends Schema.TaggedError<ServerAuthPairingLinksListError>()(
  "ServerAuthPairingLinksListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list pairing links.";
  }
}

export class ServerAuthPairingLinkRevocationError extends Schema.TaggedError<ServerAuthPairingLinkRevocationError>()(
  "ServerAuthPairingLinkRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke pairing link.";
  }
}

export class ServerAuthSessionTokenIssueError extends Schema.TaggedError<ServerAuthSessionTokenIssueError>()(
  "ServerAuthSessionTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session token.";
  }
}

export class ServerAuthSessionsListError extends Schema.TaggedError<ServerAuthSessionsListError>()(
  "ServerAuthSessionsListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list sessions.";
  }
}

export class ServerAuthSessionRevocationError extends Schema.TaggedError<ServerAuthSessionRevocationError>()(
  "ServerAuthSessionRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class ServerAuthOtherSessionsRevocationError extends Schema.TaggedError<ServerAuthOtherSessionsRevocationError>()(
  "ServerAuthOtherSessionsRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class ServerAuthDpopReplayStateRecordError extends Schema.TaggedError<ServerAuthDpopReplayStateRecordError>()(
  "ServerAuthDpopReplayStateRecordError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to record DPoP proof replay state.";
  }
}

export class ServerAuthDpopReplayKeyCalculationError extends Schema.TaggedError<ServerAuthDpopReplayKeyCalculationError>()(
  "ServerAuthDpopReplayKeyCalculationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to calculate DPoP replay key.";
  }
}

export class ServerAuthUserDirectoryError extends Schema.TaggedError<ServerAuthUserDirectoryError>()(
  "ServerAuthUserDirectoryError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to read or write user accounts.";
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthUserDirectoryError,
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthDpopReplayKeyCalculationError,
]);
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {
    diagnostic: Schema.optional(Schema.String),
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);
export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" =>
  error._tag === "ServerAuthMissingCredentialError" ? "missing_credential" : "invalid_credential";

export const serverAuthDpopFailureReason = (
  error: ServerAuthCredentialError,
): DpopFailureReasonType | undefined =>
  error._tag === "ServerAuthInvalidCredentialError" ? error.dpopFailureReason : undefined;

export class ServerAuthInvalidScopeError extends Schema.TaggedError<ServerAuthInvalidScopeError>()(
  "ServerAuthInvalidScopeError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope is invalid.";
  }
}

export class ServerAuthScopeNotGrantedError extends Schema.TaggedError<ServerAuthScopeNotGrantedError>()(
  "ServerAuthScopeNotGrantedError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope was not granted.";
  }
}

export const ServerAuthInvalidRequestError = Schema.Union([
  ServerAuthInvalidScopeError,
  ServerAuthScopeNotGrantedError,
]);
export type ServerAuthInvalidRequestError = typeof ServerAuthInvalidRequestError.Type;
export const isServerAuthInvalidRequestError = Schema.is(ServerAuthInvalidRequestError);
export const serverAuthInvalidRequestReason = (
  error: ServerAuthInvalidRequestError,
): "invalid_scope" | "scope_not_granted" =>
  error._tag === "ServerAuthInvalidScopeError" ? "invalid_scope" : "scope_not_granted";

export class ServerAuthMcpApprovalCodeError extends Schema.TaggedError<ServerAuthMcpApprovalCodeError>()(
  "ServerAuthMcpApprovalCodeError",
  {
    reason: Schema.Literals([
      "unknown_or_used",
      "not_a_pairing_code",
      "insufficient_scope",
      "other_user",
      "inactive_user",
    ]),
  },
) {
  override get message(): string {
    if (this.reason === "other_user")
      return "That pairing code belongs to another account, and this browser is signed in as you. Approve as yourself, or use a code you created. It has not been used.";
    if (this.reason === "inactive_user")
      return "The person who created that pairing code can no longer sign in. It has not been used.";
    return this.reason === "insufficient_scope"
      ? "That pairing code cannot grant this access. It has not been used, so choose an access level it grants, or create a code with the standard scopes."
      : this.reason === "not_a_pairing_code"
        ? "That is not a one-time pairing code."
        : "That pairing code is unknown, expired, or already used.";
  }
}

export class ServerAuthOwnerAlreadyClaimedError extends Schema.TaggedError<ServerAuthOwnerAlreadyClaimedError>()(
  "ServerAuthOwnerAlreadyClaimedError",
  {},
) {
  override get message(): string {
    return "This Installation already has an Owner.";
  }
}

export class ServerAuthInvalidOriginError extends Schema.TaggedError<ServerAuthInvalidOriginError>()(
  "ServerAuthInvalidOriginError",
  {},
) {
  override get message(): string {
    return "Passkeys need a request from the app's own origin.";
  }
}

export class ServerAuthInsecureTransportError extends Schema.TaggedError<ServerAuthInsecureTransportError>()(
  "ServerAuthInsecureTransportError",
  {},
) {
  override get message(): string {
    return "Sign in over HTTPS. Browser sessions travel over plain HTTP only on this machine.";
  }
}

export class ServerAuthForbiddenOperationError extends Schema.TaggedError<ServerAuthForbiddenOperationError>()(
  "ServerAuthForbiddenOperationError",
  {},
) {
  override get message(): string {
    return "The current authentication session cannot revoke itself.";
  }
}

export class ServerAuthNotYourSessionError extends Schema.TaggedError<ServerAuthNotYourSessionError>()(
  "ServerAuthNotYourSessionError",
  {},
) {
  override get message(): string {
    return "Only the Owner can revoke another User's sessions and links.";
  }
}

/** Whose sessions and links a request may see and revoke. */
export type AccessViewer = Pick<AuthenticatedSession, "sessionId" | "userId">;

export type AccessChange =
  | PairingGrantStore.BootstrapCredentialChange
  | SessionStore.SessionCredentialChange;

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      requestMetadata: AuthRequestMetadata,
      previousSessionToken?: string,
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      },
      ServerAuthInvalidCredentialError | ServerAuthInsecureTransportError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
      requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
      requestMetadata: AuthRequestMetadata,
      input?: {
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<
      AuthAccessTokenResult,
      | ServerAuthInvalidCredentialError
      | ServerAuthInvalidRequestError
      | ServerAuthInsecureTransportError
      | ServerAuthInternalError
    >;
    readonly createPairingLink: (input?: {
      readonly ttl?: Duration.Duration;
      readonly label?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly proofKeyThumbprint?: string;
      /** A device that pairs with the link signs in as this User; without one, as the Owner. */
      readonly userId?: UserId;
      readonly purpose?: "startup";
    }) => Effect.Effect<
      IssuedPairingLink,
      ServerAuthInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput,
      creator?: UserId,
    ) => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly issueStartupPairingCredential: () => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError
    >;
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
    /** Without a viewer, any link: the Hub's shell manages them all. */
    readonly revokePairingLink: (
      id: string,
      viewer?: AccessViewer,
    ) => Effect.Effect<boolean, ServerAuthNotYourSessionError | ServerAuthInternalError>;
    /** For the Hub's shell (`t3 auth session issue`); the token acts as `userId`, else the Owner. */
    readonly issueSession: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
      readonly userId?: UserId;
      /** A durable token the shell hands out (`t3 auth session issue`), recorded in the audit log. */
      readonly audited?: boolean;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    /** The viewer's own sessions; the Owner sees every User's. */
    readonly listClientSessions: (
      viewer: AccessViewer,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    /** The viewer's sessions and links now, then the changes to them and to nothing else. */
    readonly streamAccess: (viewer: AccessViewer) => Effect.Effect<
      {
        readonly snapshot: AuthAccessSnapshot;
        readonly changes: Stream.Stream<AccessChange, ServerAuthInternalError>;
      },
      ServerAuthInternalError,
      Scope.Scope
    >;
    readonly revokeClientSession: (
      viewer: AccessViewer,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<
      boolean,
      ServerAuthForbiddenOperationError | ServerAuthNotYourSessionError | ServerAuthInternalError
    >;
    /** The Owner revokes every other session; any other User, their own other sessions. */
    readonly revokeOtherClientSessions: (
      viewer: AccessViewer,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
      use: AuthWebSocketTicketUse,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId" | "proofKeyThumbprint">,
      input?: { readonly use?: AuthWebSocketTicketUse },
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
    readonly authenticateMcpClient: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpClientSession, ServerAuthCredentialError | ServerAuthInternalError>;
    /** The client acts as `userId` (the User who approved it); the Hub's shell may leave it out for the Owner. */
    readonly issueMcpClientSession: (input: {
      readonly label: string;
      readonly userId?: UserId;
      readonly access: AuthMcpClientAccess;
      readonly client: AuthRequestMetadata;
    }) => Effect.Effect<
      {
        readonly sessionId: AuthSessionId;
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      ServerAuthInsecureTransportError | ServerAuthCredentialError | ServerAuthInternalError
    >;
    /** Spends a code covering all granted scopes. Rejects desktop grants and leaves refused proof-bound codes unspent. */
    /**
     * Answers the User the code was issued to (its creator, or the Owner), whom the client acts
     * as. A code whose User cannot sign in, or is not `asUser` (the browser's signed-in User),
     * is refused before it is spent.
     */
    readonly consumeMcpApprovalCode: (
      code: string,
      access: AuthMcpClientAccess,
      options?: { readonly asUser?: UserId | undefined },
    ) => Effect.Effect<
      { readonly userId?: UserId },
      ServerAuthMcpApprovalCodeError | ServerAuthInternalError
    >;
    readonly authenticateBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly getOwnerBootstrapStatus: (
      credential: string,
    ) => Effect.Effect<AuthOwnerBootstrapStatus, ServerAuthInternalError>;
    readonly beginOwnerBootstrap: (
      request: HttpServerRequest.HttpServerRequest,
      input: { readonly credential: string; readonly displayName: string },
    ) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      | ServerAuthOwnerAlreadyClaimedError
      | ServerAuthInvalidOriginError
      | ServerAuthInvalidCredentialError
      | ServerAuthInternalError
    >;
    /** Creates the Owner, spends the administrative bootstrap link and signs this browser in. */
    readonly completeOwnerBootstrap: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthOwnerBootstrapRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      { readonly result: AuthOwnerBootstrapResult; readonly sessionToken: string },
      | ServerAuthOwnerAlreadyClaimedError
      | ServerAuthInvalidOriginError
      | ServerAuthInvalidCredentialError
      | ServerAuthInsecureTransportError
      | ServerAuthInternalError
    >;
    readonly beginPasskeySignIn: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthPasskeySignInCeremony, ServerAuthInvalidOriginError>;
    readonly completePasskeySignIn: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthPasskeySignInRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession,
      | ServerAuthInvalidOriginError
      | ServerAuthInvalidCredentialError
      | UserDirectory.AccountInactiveError
      | ServerAuthInsecureTransportError
      | ServerAuthInternalError
    >;
    readonly signInWithRecoveryCode: (
      request: HttpServerRequest.HttpServerRequest,
      code: string,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession,
      | ServerAuthInvalidCredentialError
      | UserDirectory.AccountInactiveError
      | ServerAuthInsecureTransportError
      | ServerAuthInternalError
    >;
    /** Signs in, or answers that the account also needs a TOTP code with the password. */
    readonly signInWithPassword: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthPasswordSignInRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession | { readonly response: AuthSecondFactorRequired },
      | ServerAuthInvalidCredentialError
      | UserDirectory.AccountInactiveError
      | ServerAuthInsecureTransportError
      | UserDirectory.SecondFactorMissingError
      | UserDirectory.SignInThrottledError
      | ServerAuthInternalError
    >;
    /** The code step of a password sign-in that answered `secondFactor: "totp"`. */
    readonly signInWithTotp: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthTotpSignInRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession,
      | ServerAuthInvalidCredentialError
      | UserDirectory.AccountInactiveError
      | ServerAuthInsecureTransportError
      | UserDirectory.SignInThrottledError
      | ServerAuthInternalError
    >;
    readonly beginResetLinkRegistration: (
      request: HttpServerRequest.HttpServerRequest,
      token: string,
    ) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      ServerAuthInvalidOriginError | ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    /** Registers the new passkey, spends the reset link and signs this browser in. */
    readonly redeemResetLink: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthResetLinkRedeemRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession,
      | ServerAuthInvalidOriginError
      | ServerAuthInvalidCredentialError
      | ServerAuthInsecureTransportError
      | ServerAuthInternalError
    >;
    /** Spends a reset link on a new password; every old credential and session ends. */
    readonly redeemResetLinkWithPassword: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthResetLinkPasswordRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      UserBrowserSession,
      | ServerAuthInvalidCredentialError
      | ServerAuthInsecureTransportError
      | UserDirectory.AccountChangeRefusedError
      | UserDirectory.LoginNameTakenError
      | ServerAuthInternalError
    >;
    /** The page origin a passkey ceremony from this request is bound to. */
    readonly passkeyOrigin: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<string, ServerAuthInvalidOriginError>;
    /**
     * Signs this browser in as a User whose identity the caller already proved (an Invitation
     * that just created them, a Keycloak sign-in with `identityLoginId`); runs inside the
     * caller's transaction.
     */
    readonly startUserBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
      user: AuthUser,
      requestMetadata: AuthRequestMetadata,
      options?: { readonly identityLoginId?: string },
    ) => Effect.Effect<
      UserBrowserSession,
      ServerAuthInvalidCredentialError | ServerAuthInsecureTransportError | ServerAuthInternalError
    >;
    /** For the Hub's shell (`t3 auth owner-reset`), when the Owner has lost every passkey. */
    readonly issueOwnerResetLink: UserDirectory.UserDirectory["Service"]["issueOwnerResetLink"];
    /**
     * A bearer or DPoP session for a User an app sign-in approved in the browser (AppSignIn).
     * Refused when the User can no longer sign in.
     */
    readonly issueAppSession: (input: {
      readonly userId: UserId;
      /** The approving browser session's scopes: the app gets the standard ones it held. */
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly client: AuthRequestMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInsecureTransportError | ServerAuthInternalError
    >;
    /**
     * Revokes the request's own session: a browser's cookie, or an app's bearer or DPoP token, so
     * signing out of a Hub on desktop or mobile ends that session on the Hub too. False when it
     * carried none it may end.
     */
    readonly signOut: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
  }
>()("t3/auth/EnvironmentAuth") {}

export interface UserBrowserSession {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
}

type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
  readonly cookieName?: string;
  readonly expireNormalCookie?: boolean;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WebSocketUpgradeQuery = Schema.Struct({
  wsTicket: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  dpop: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});
const decodeWebSocketUpgradeQuery = Schema.decodeEffect(WebSocketUpgradeQuery);

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (PairingGrantStore.isBootstrapCredentialInternalError(cause)) {
    return new ServerAuthBootstrapCredentialValidationError({ cause });
  }

  return new ServerAuthInvalidCredentialError({
    cause,
  });
}

const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

export function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^Bearer /i.test(header)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseDpopToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  // The scheme is case-insensitive (RFC 9110).
  if (typeof header !== "string" || !/^DPoP /i.test(header)) {
    return null;
  }
  const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * The credential a request carries: the browser session cookie (`__Host-` first, see
 * `sessionCookieNameFor`), else a bearer or DPoP token, else the legacy cookie. Cookies are read
 * by `readHubCookie`: none from a page on a preview's own origin, and no bare-named one a preview
 * could have set for the Hub's domain.
 */
export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  names: SessionCookieNames,
) {
  const cookieToken = readHubCookie(request, names.cookieName, names.previewOrigin);
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);
  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const dpopToken = parseDpopToken(request);
  if (dpopToken !== null) {
    return { token: dpopToken, source: "dpop" } as const;
  }

  const legacyToken = names.legacyCookieName
    ? readHubCookie(request, names.legacyCookieName, names.previewOrigin)
    : undefined;
  if (legacyToken !== undefined) {
    return { token: legacyToken, source: "legacy-cookie" } as const;
  }

  return undefined;
}

type RequestCredentialSource = NonNullable<ReturnType<typeof selectRequestCredential>>["source"];

export const isBrowserCookieCredential = (source: RequestCredentialSource | "dev-cookie") =>
  source === "cookie" || source === "legacy-cookie" || source === "dev-cookie";

// Never from a preview's own origin (crossesFromPreviewOrigin). Then a missing Origin allows
// same-origin reads and non-browser clients; otherwise require same-origin Sec-Fetch-Site, this
// server's host, or a trusted app origin. A trusted proxy's X-Forwarded-Host has already
// replaced Host (clientConnection); from anyone else it is ignored.
function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
  previewOrigin: PreviewOriginPattern | undefined,
): boolean {
  if (crossesFromPreviewOrigin(previewOrigin, request.headers)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  if (trustedOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  return originHost === headerList(request.headers.host)[0]?.toLowerCase();
}

/** @public */
export const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const sql = yield* SqlClient.SqlClient;
  const audit = yield* AuditLog.AuditLog;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const digest = yield* Digest.Digest;
  const descriptor = yield* policy.getDescriptor();
  const config = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const devAuth = resolveReusableDevAuth(config);
  const ownerPresence = yield* OwnerPresence;
  const publicOrigin = config.publicUrl?.origin;

  /**
   * Session cookies and tokens are bearer credentials, so they cross plain HTTP only to this
   * machine and, unless the Hub is published on a public URL, to the LAN and tailnet that
   * `t3 up --lan` serves. A public or unknown client needs HTTPS. Behind a trusted proxy the
   * client and scheme are the ones it forwarded.
   */
  const requireSecureTransport = (requestMetadata: AuthRequestMetadata) =>
    requestMetadata.secureTransport === true ||
    isLoopbackClientAddress(requestMetadata.ipAddress) ||
    (publicOrigin === undefined && isPrivateClientAddress(requestMetadata.ipAddress))
      ? Effect.void
      : Effect.fail(new ServerAuthInsecureTransportError({}));

  // A session with no User of its own (the Hub's shell, the startup link, the desktop, MCP
  // clients until they pick a User) belongs to the Owner. Before an Owner exists it has none.
  // The auth_sessions trigger refuses a session without a User once an Owner exists.
  const sessionUser = Effect.fn("EnvironmentAuth.sessionUser")(function* (
    userId: UserId | undefined,
  ) {
    if (userId === undefined) {
      const owner = yield* userDirectory
        .ownerId()
        .pipe(Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })));
      return Option.isSome(owner) ? { userId: owner.value } : {};
    }
    const user = yield* userDirectory
      .findActiveUser(userId)
      .pipe(Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })));
    if (Option.isNone(user)) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "The User who created this link can no longer sign in.",
      });
    }
    return { userId };
  });

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.flatMap(rejectMcpClientAudience),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        ...(session.userId ? { userId: session.userId } : {}),
        method: session.method,
        scopes: session.scopes,
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.flatMap(heldByUser),
    );

  /**
   * The Installation's own scopes (its settings, providers, processes, logs and usage) are the
   * Owner's: any other User's session is read without them, however it was issued (sign-in, a
   * pairing link, the shell) and whenever. The RPCs check the Owner again (`installation` in
   * RpcSpaceAccess); this keeps the scopes a client is told about to what it can use.
   */
  const heldByUser = <
    S extends { readonly userId?: UserId; readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  >(
    session: S,
  ): Effect.Effect<S> => {
    const userId = session.userId;
    if (userId === undefined) return Effect.succeed(session);
    return knownOwnerId.pipe(
      // On a failed read nobody is the Owner, so the narrower answer wins.
      Effect.orElseSucceed(() => undefined),
      Effect.map((ownerId) =>
        ownerId === userId
          ? session
          : { ...session, scopes: withoutInstallationScopes(session.scopes) },
      ),
    );
  };

  const resolveRequestCredential = (request: HttpServerRequest.HttpServerRequest) => {
    const selectedCredential = selectRequestCredential(request, sessions);
    const hasAuthorization = request.headers.authorization !== undefined;
    const devCookieToken = devAuth
      ? readHubCookie(request, devAuth.cookieName, config.previewOrigin)
      : undefined;
    return (
      selectedCredential ??
      (!hasAuthorization && devCookieToken !== undefined
        ? { token: devCookieToken, source: "dev-cookie" as const }
        : undefined)
    );
  };

  // Cookies span ports; reject cookie-authenticated requests and sockets from other same-site origins.
  const trustedBrowserOrigins = new Set<string>([
    ...(publicOrigin ? [publicOrigin] : []),
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...DESKTOP_RENDERER_ORIGINS,
    ...config.devAllowedOrigins,
  ]);

  const authenticateRequest = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> => {
    const dpopToken = parseDpopToken(request);
    const credential = resolveRequestCredential(request);
    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    if (
      isBrowserCookieCredential(credential.source) &&
      !isBrowserOriginAllowed(request, trustedBrowserOrigins, config.previewOrigin)
    ) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sessions are only accepted from the app's own origin.",
        }),
      );
    }
    return authenticateToken(credential.token).pipe(
      Effect.flatMap((session) => {
        if (session.proofKeyThumbprint) {
          if (!dpopToken || dpopToken !== credential.token) {
            return Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound access token requires DPoP authorization.",
                dpopFailureReason: "invalid_proof",
              }),
            );
          }
          return verifyRequestDpopProof({
            request,
            expectedThumbprint: session.proofKeyThumbprint,
            expectedAccessToken: dpopToken,
          }).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
            Effect.provideService(Digest.Digest, digest),
            Effect.as(session),
          );
        }
        if (dpopToken) {
          return Effect.fail(
            new ServerAuthInvalidCredentialError({
              diagnostic: "DPoP authorization requires a proof-bound access token.",
              dpopFailureReason: "invalid_proof",
            }),
          );
        }
        return Effect.succeed(session);
      }),
    );
  };

  // The Owner is never replaced, so once read their id is kept for every session check.
  let cachedOwnerId: UserId | undefined;
  const knownOwnerId = Effect.suspend(() =>
    cachedOwnerId !== undefined
      ? Effect.succeed(cachedOwnerId)
      : userDirectory.ownerId().pipe(
          Effect.map((owner) => {
            if (Option.isSome(owner)) cachedOwnerId = owner.value;
            return Option.getOrUndefined(owner);
          }),
        ),
  );

  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = Effect.fn(
    "EnvironmentAuth.getSessionState",
  )(function* (request) {
    // A session has a User exactly when an Owner exists, so only a signed-out check asks.
    const ownerExists = userDirectory.hasOwner().pipe(
      Effect.map((exists) => ({ ownerExists: exists })),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read whether the Installation has an Owner.", { cause }).pipe(
          Effect.as({}),
        ),
      ),
    );
    // Only the Owner sets the Installation up; clients skip that welcome for everyone else. On a
    // failed read nobody is the Owner, so an invited User never sees the Owner's setup.
    const isOwnerOf = (userId: UserId) =>
      knownOwnerId.pipe(
        Effect.map((ownerId) => ({ isOwner: ownerId === userId })),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read who the Owner is.", { cause }).pipe(
            Effect.as({ isOwner: false }),
          ),
        ),
      );
    return yield* authenticateRequest(request).pipe(
      Effect.flatMap((session) =>
        (session.userId === undefined ? Effect.succeed({}) : isOwnerOf(session.userId)).pipe(
          Effect.map((owner): AuthSessionState => ({
            authenticated: true,
            auth: descriptor,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
            ...(session.userId ? { userId: session.userId } : {}),
            ownerExists: session.userId !== undefined,
            ...owner,
          })),
        ),
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        ownerExists.pipe(
          Effect.map((owner): AuthSessionState => ({
            authenticated: false,
            auth: descriptor,
            ...owner,
          })),
        ),
      ),
    );
  });

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = Effect.fn(
    "EnvironmentAuth.createBrowserSession",
  )(function* (credential, requestMetadata, previousSessionToken) {
    if (devAuth?.matches(credential)) {
      return yield* sessions.verify(credential).pipe(
        mapSessionVerificationErrors,
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  response: {
                    authenticated: true,
                    ...authScopeResponse(session.scopes),
                    sessionMethod: session.method,
                    expiresAt: DateTime.toUtc(DateTime.add(now, { days: 30 })),
                  } satisfies AuthBrowserSessionResult,
                  sessionToken: credential,
                  cookieName: devAuth.cookieName,
                  expireNormalCookie: true,
                }) satisfies BootstrapExchangeResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.createBrowserSession"),
      );
    }
    yield* requireSecureTransport(requestMetadata);
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const grant = yield* bootstrapCredentials
      .consume(credential)
      .pipe(Effect.mapError(toBootstrapExchangeError));
    const owner = yield* sessionUser(grant.userId);
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: grant.subject,
        ...owner,
        scopes: grant.scopes,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        client: {
          ...requestMetadata,
          ...(grant.label ? { label: grant.label } : {}),
        },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    } satisfies BootstrapExchangeResult;
  });

  type ResolvedBootstrapGrant = Pick<
    PairingGrantStore.BootstrapGrant,
    "scopes" | "subject" | "label" | "userId"
  > & {
    readonly method: PairingGrantStore.BootstrapGrant["method"] | "reusable-dev-token";
  };
  const resolveBootstrapGrant = (
    credential: string,
    input?: {
      readonly proofKeyThumbprint?: string;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly requiredScopes?: ReadonlyArray<AuthEnvironmentScope>;
    },
  ): Effect.Effect<
    ResolvedBootstrapGrant,
    ServerAuthInvalidCredentialError | ServerAuthInternalError | ServerAuthScopeNotGrantedError
  > => {
    if (!devAuth?.matches(credential)) {
      return bootstrapCredentials
        .consume(credential, input)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "BootstrapCredentialScopeNotGrantedError"
              ? new ServerAuthScopeNotGrantedError({})
              : toBootstrapExchangeError(cause),
          ),
        );
    }
    return sessions.verify(credential).pipe(
      mapSessionVerificationErrors,
      Effect.filterOrFail(
        (session) =>
          input?.requiredScopes === undefined ||
          input.requiredScopes.every((scope) => session.scopes.includes(scope)),
        () => new ServerAuthScopeNotGrantedError({}),
      ),
      Effect.map(
        (session) =>
          ({
            method: "reusable-dev-token",
            scopes: session.scopes,
            subject: "reusable-dev-token-child",
            ...(session.userId ? { userId: session.userId } : {}),
          }) satisfies ResolvedBootstrapGrant,
      ),
    );
  };

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuth["Service"]["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata, input) => {
      return requireSecureTransport(requestMetadata).pipe(
        Effect.andThen(
          resolveBootstrapGrant(credential, {
            ...input,
            ...(requestedScopes !== undefined ? { requestedScopes } : {}),
          }),
        ),
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            const grantedScopes =
              requestedScopes === undefined
                ? grant.scopes
                : [...new Set(requestedScopes)].filter((scope) => grant.scopes.includes(scope));
            if (grantedScopes.length === 0) {
              return yield* new ServerAuthScopeNotGrantedError({});
            }
            const owner = yield* sessionUser(grant.userId);
            return yield* sessions
              .issue({
                method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
                subject: grant.subject,
                ...owner,
                scopes: grantedScopes,
                ...(input?.proofKeyThumbprint
                  ? {
                      proofKeyThumbprint: input.proofKeyThumbprint,
                      ttl: Duration.hours(1),
                    }
                  : {}),
                replaceActiveForSubjectAndMethod: grant.method === "desktop-bootstrap",
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
                ),
              );
          }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  access_token: session.token,
                  issued_token_type: AuthAccessTokenType,
                  token_type: input?.proofKeyThumbprint ? "DPoP" : "Bearer",
                  expires_in: Math.max(
                    0,
                    Math.floor(
                      (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000,
                    ),
                  ),
                  scope: encodeOAuthScope(session.scopes),
                }) satisfies AuthAccessTokenResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.exchangeBootstrapCredentialForAccessToken"),
      );
    };

  const toPairingCredential = (issued: IssuedPairingLink): AuthPairingCredentialResult => ({
    id: issued.id,
    credential: issued.credential,
    ...(issued.label ? { label: issued.label } : {}),
    expiresAt: issued.expiresAt,
  });

  const issuePairingLink = Effect.fn("EnvironmentAuth.issuePairingLink")(
    function* (input: Parameters<EnvironmentAuth["Service"]["createPairingLink"]>[0]) {
      const createdAt = yield* DateTime.now;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        ...(input?.userId ? { userId: input.userId } : {}),
        ...(input?.purpose ? { purpose: input.purpose } : {}),
      });
      return {
        id: issued.id,
        credential: issued.credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies IssuedPairingLink;
    },
    Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause })),
  );

  const createPairingLink: EnvironmentAuth["Service"]["createPairingLink"] = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(function* (input) {
    // The startup link is for a browser on this machine; every other link lets a device pair.
    if (input?.purpose !== "startup" && !ManagedLimits.allowsRemoteClients(managedPolicy)) {
      return yield* ManagedLimits.refuseRemoteClients(
        managedPolicy,
        "so this server cannot create pairing links",
      );
    }
    return yield* issuePairingLink(input);
  });

  const listPairingLinks: EnvironmentAuth["Service"]["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];
        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .map((link) => ({ ...link, ...authScopeResponse(link.scopes) }))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError((cause) => new ServerAuthPairingLinksListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuth["Service"]["revokePairingLink"] = Effect.fn(
    "EnvironmentAuth.revokePairingLink",
  )(function* (id, viewer) {
    if (viewer !== undefined) {
      const scope = yield* accessScopeFor(viewer);
      if (!scope.seesEveryone) {
        const creator = yield* bootstrapCredentials
          .creatorOf(id)
          .pipe(Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })));
        if (Option.isNone(creator)) return false;
        if (!scope.sees(creator.value ?? undefined)) {
          return yield* new ServerAuthNotYourSessionError({});
        }
      }
    }
    return yield* bootstrapCredentials
      .revoke(id)
      .pipe(Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })));
  });

  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) => {
    const issue = sessionUser(input?.userId).pipe(
      Effect.flatMap((owner) =>
        sessions
          .issue({
            subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
            ...owner,
            method: "bearer-access-token",
            scopes: input?.scopes ?? AuthStandardClientScopes,
            client: {
              ...(input?.label ? { label: input.label } : {}),
              deviceType: "bot",
            },
            ...(input?.ttl ? { ttl: input.ttl } : {}),
          })
          .pipe(
            Effect.tap((issued) =>
              input?.audited !== true
                ? Effect.void
                : audit.record({
                    actor: AuditLog.cliActor,
                    action: "cliSession.issue",
                    // Before an Owner exists the token names no User; the session is the target.
                    target:
                      "userId" in owner && owner.userId !== undefined
                        ? { kind: "user", id: owner.userId }
                        : { kind: "session", id: issued.sessionId },
                    detail: {
                      sessionId: issued.sessionId,
                      label: input.label ?? null,
                      scopes: issued.scopes.join(" "),
                    },
                  }),
            ),
          ),
      ),
    );
    return (input?.audited === true ? sql.withTransaction(issue) : issue).pipe(
      Effect.map(
        (issued) =>
          ({
            sessionId: issued.sessionId,
            token: issued.token,
            method: "bearer-access-token",
            scopes: issued.scopes,
            subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
            client: issued.client,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies IssuedBearerSession,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ServerAuthUserDirectoryError" ||
        cause._tag === "ServerAuthInvalidCredentialError"
          ? cause
          : new ServerAuthSessionTokenIssueError({ cause }),
      ),
      Effect.withSpan("EnvironmentAuth.issueSession"),
    );
  };

  // The Owner, or anyone before an Owner exists (only the operator can pair then), sees every
  // User's sessions and links; any other User sees their own.
  const accessScopeFor = (viewer: AccessViewer) =>
    userDirectory.ownerId().pipe(
      Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })),
      Effect.map((owner) => {
        const seesEveryone = Option.isNone(owner) || owner.value === viewer.userId;
        return {
          seesEveryone,
          sees: (userId: UserId | undefined) => seesEveryone || userId === viewer.userId,
        };
      }),
    );

  /** Names other Users' sessions for the viewer; `names` caches lookups across calls. */
  const withUserNames = Effect.fn("EnvironmentAuth.withUserNames")(function* (
    viewer: AccessViewer,
    clientSessions: ReadonlyArray<AuthClientSession>,
    names: Map<UserId, string | undefined> = new Map(),
  ) {
    const missing = [
      ...new Set(
        clientSessions.flatMap((session) =>
          session.userId === undefined ||
          session.userId === viewer.userId ||
          names.has(session.userId)
            ? []
            : [session.userId],
        ),
      ),
    ];
    if (missing.length > 0) {
      const found = yield* userDirectory
        .displayNames(missing)
        .pipe(Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })));
      for (const userId of missing) names.set(userId, found.get(userId));
    }
    return clientSessions.map((clientSession): AuthClientSession => {
      const name = clientSession.userId ? names.get(clientSession.userId) : undefined;
      return {
        ...clientSession,
        ...authScopeResponse(clientSession.scopes),
        current: clientSession.sessionId === viewer.sessionId,
        ...(name ? { userDisplayName: name } : {}),
      };
    });
  });

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept = (sessionId: AuthSessionId) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const issuePairingCredential: EnvironmentAuth["Service"]["issuePairingCredential"] = (
    input,
    creator,
  ) =>
    createPairingLink({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      ...(creator ? { userId: creator } : {}),
      ...(input?.label ? { label: input.label } : {}),
    }).pipe(
      Effect.map(toPairingCredential),
      Effect.withSpan("EnvironmentAuth.issuePairingCredential"),
    );

  const issueStartupPairingCredential: EnvironmentAuth["Service"]["issueStartupPairingCredential"] =
    () => {
      // Unguarded: startup already refused auth policies the managed policy leaves out.
      const fallback = issuePairingLink({
        scopes: AuthStandardClientScopes,
        subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        purpose: "startup",
      }).pipe(Effect.map(toPairingCredential));
      if (!devAuth) {
        return fallback.pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));
      }
      return sessions.verify(devAuth.credential).pipe(
        Effect.map(
          (session) =>
            ({
              id: session.sessionId,
              credential: devAuth.credential,
              label: "Reusable dev token",
              expiresAt: DateTime.toUtc(session.expiresAt ?? REUSABLE_DEV_SESSION_EXPIRES_AT),
            }) satisfies AuthPairingCredentialResult,
        ),
        Effect.catch((cause) =>
          SessionStore.isSessionCredentialInvalidError(cause)
            ? fallback
            : Effect.fail(new ServerAuthPairingLinkCreationError({ cause })),
        ),
        Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"),
      );
    };

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = Effect.fn(
    "EnvironmentAuth.listClientSessions",
  )(function* (viewer) {
    const scope = yield* accessScopeFor(viewer);
    const visible = (yield* listSessions()).filter((session) => scope.sees(session.userId));
    return yield* withUserNames(viewer, visible);
  });

  const streamAccess: EnvironmentAuth["Service"]["streamAccess"] = Effect.fn(
    "EnvironmentAuth.streamAccess",
  )(function* (viewer) {
    // Resolved once per stream: an Owner created mid-stream adopts this viewer's session anyway.
    const scope = yield* accessScopeFor(viewer);
    // Subscribed before the snapshot is read, so no change falls between the two.
    const liveChanges = Stream.merge(
      yield* bootstrapCredentials.subscribeChanges,
      yield* sessions.subscribeChanges,
    );
    const names = new Map<UserId, string | undefined>();
    const pairingLinks = (yield* listPairingLinks()).filter((link) => scope.sees(link.userId));
    const clientSessions = yield* withUserNames(
      viewer,
      (yield* listSessions()).filter((session) => scope.sees(session.userId)),
      names,
    );
    // Removals carry only an id, so they pass only for ids this viewer was shown.
    const shownLinks = new Set(pairingLinks.map((link) => link.id));
    const shownSessions = new Set(clientSessions.map((session) => session.sessionId));
    const view = Effect.fn("EnvironmentAuth.viewAccessChange")(function* (change: AccessChange) {
      switch (change.type) {
        case "pairingLinkUpserted":
          if (!scope.sees(change.pairingLink.userId)) return Option.none<AccessChange>();
          shownLinks.add(change.pairingLink.id);
          return Option.some<AccessChange>(change);
        case "pairingLinkRemoved":
          return shownLinks.delete(change.id)
            ? Option.some<AccessChange>(change)
            : Option.none<AccessChange>();
        case "clientRemoved":
          return shownSessions.delete(change.sessionId)
            ? Option.some<AccessChange>(change)
            : Option.none<AccessChange>();
        case "clientUpserted": {
          if (!scope.sees(change.clientSession.userId)) return Option.none<AccessChange>();
          shownSessions.add(change.clientSession.sessionId);
          const [clientSession] = yield* withUserNames(viewer, [change.clientSession], names);
          return clientSession === undefined
            ? Option.none<AccessChange>()
            : Option.some<AccessChange>({ ...change, clientSession });
        }
      }
    });
    const changes = liveChanges.pipe(
      Stream.mapEffect(view),
      Stream.filter(Option.isSome),
      Stream.map((change) => change.value),
    );
    return { snapshot: { pairingLinks, clientSessions }, changes };
  });

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (viewer, targetSessionId) {
    if (viewer.sessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }
    const scope = yield* accessScopeFor(viewer);
    if (!scope.seesEveryone) {
      const target = yield* sessions
        .getActive(targetSessionId)
        .pipe(Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })));
      if (Option.isNone(target)) return false;
      if (!scope.sees(target.value.userId)) return yield* new ServerAuthNotYourSessionError({});
    }
    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] =
    Effect.fn("EnvironmentAuth.revokeOtherClientSessions")(function* (viewer) {
      const scope = yield* accessScopeFor(viewer);
      if (scope.seesEveryone || viewer.userId === undefined) {
        return yield* revokeOtherSessionsExcept(viewer.sessionId);
      }
      return yield* sessions
        .revokeAllForUser(viewer.userId, { except: viewer.sessionId })
        .pipe(Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })));
    });

  const issueStartupPairingUrl: EnvironmentAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
    issueStartupPairingCredential().pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
      Effect.withSpan("EnvironmentAuth.issueStartupPairingUrl"),
    );

  // Only the RPC socket's ticket is bound to the client's proof key. The media
  // routes reuse one ticket across <img>, EventSource and several sockets, and
  // each of those would need its own single-use proof.
  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (
    session,
    input,
  ) =>
    sessions
      .issueWebSocketToken(session.sessionId, {
        ...(input?.use ? { audience: input.use } : {}),
        ...(input?.use === "rpc" && session.proofKeyThumbprint
          ? { proofKeyThumbprint: session.proofKeyThumbprint }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
        Effect.map(
          (issued) =>
            ({
              ticket: Redacted.make(issued.token),
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies AuthWebSocketTicketResult,
        ),
        Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
      );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request, use) {
      const url = requestUrl(request);
      if (Option.isSome(url)) {
        const query = yield* decodeWebSocketUpgradeQuery(
          Object.fromEntries(url.value.searchParams),
        ).pipe(Effect.orDie);
        const websocketTicket = query.wsTicket && Redacted.value(query.wsTicket);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          const session = yield* sessions
            .verifyWebSocketToken(websocketTicket)
            .pipe(mapSessionVerificationErrors, Effect.flatMap(rejectMcpClientAudience));
          if (session.audience !== undefined && session.audience !== use) {
            return yield* new ServerAuthInvalidCredentialError({
              diagnostic: `WebSocket ticket was issued for the ${session.audience} route.`,
            });
          }
          if (session.proofKeyThumbprint) {
            // WebSocket clients cannot set headers, so the proof travels in the query.
            // The proof hashes the ticket; consuming its jti prevents replay after first use.
            // Only encrypted transport prevents an active interceptor from racing that use.
            const proof = request.headers.dpop ?? (query.dpop && Redacted.value(query.dpop));
            if (!proof) {
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound WebSocket ticket requires a DPoP proof.",
                dpopFailureReason: "invalid_proof",
              });
            }
            yield* verifyRequestDpopProof({
              request,
              proof,
              expectedThumbprint: session.proofKeyThumbprint,
              expectedAccessToken: websocketTicket,
            }).pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
              Effect.provideService(Digest.Digest, digest),
            );
          }
          return yield* heldByUser({
            sessionId: session.sessionId,
            subject: session.subject,
            ...(session.userId ? { userId: session.userId } : {}),
            method: session.method,
            scopes: session.scopes,
            ...(session.proofKeyThumbprint
              ? { proofKeyThumbprint: session.proofKeyThumbprint }
              : {}),
            ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
          });
        }
      }

      return yield* authenticateRequest(request);
    });

  const authenticateMcpClient: EnvironmentAuth["Service"]["authenticateMcpClient"] = (request) => {
    const token = parseBearerToken(request);
    if (token === null) return Effect.fail(new ServerAuthMissingCredentialError({}));
    return sessions.verify(token).pipe(
      mapSessionVerificationErrors,
      Effect.flatMap((session) =>
        session.subject === MCP_CLIENT_SUBJECT && session.method === "bearer-access-token"
          ? Effect.succeed({
              sessionId: session.sessionId,
              label: session.client.label ?? "MCP client",
              access: session.scopes.includes(AuthOrchestrationOperateScope)
                ? (session.runtimeModeCeiling ?? "approval-required")
                : "read-only",
              ...(session.userId ? { userId: session.userId } : {}),
            } satisfies McpClientSession)
          : Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "Only MCP client sessions are accepted here.",
              }),
            ),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };

  // Acts as the User who approved it. Only the Hub's shell (`t3 thread`) leaves the User out,
  // and then it is the Owner, as every userless issuance is.
  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    requireSecureTransport(input.client).pipe(
      Effect.andThen(sessionUser(input.userId)),
      Effect.flatMap((owner) =>
        sessions.issue({
          subject: MCP_CLIENT_SUBJECT,
          method: "bearer-access-token",
          ...owner,
          scopes: mcpClientScopes(input.access),
          ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
          client: { ...input.client, label: input.label, deviceType: "bot" },
        }),
      ),
      Effect.map((issued) => ({
        sessionId: issued.sessionId,
        token: issued.token,
        expiresAt: issued.expiresAt,
      })),
      Effect.mapError((cause) =>
        cause._tag === "ServerAuthInvalidCredentialError"
          ? cause
          : new ServerAuthSessionTokenIssueError({ cause }),
      ),
      Effect.withSpan("EnvironmentAuth.issueMcpClientSession"),
    );

  const authenticateBrowserSession: EnvironmentAuth["Service"]["authenticateBrowserSession"] = (
    request,
  ) => {
    const credential = resolveRequestCredential(request);
    if (!credential || !isBrowserCookieCredential(credential.source)) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    return authenticateRequest(request).pipe(
      Effect.filterOrFail(
        (session) => session.method === "browser-session-cookie",
        () => new ServerAuthInvalidCredentialError({ diagnostic: "Not a browser session." }),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };

  const consumeMcpApprovalCode: EnvironmentAuth["Service"]["consumeMcpApprovalCode"] = Effect.fn(
    "EnvironmentAuth.consumeMcpApprovalCode",
  )(function* (code, access, options) {
    const credential = code.trim();
    const approverOf = (userId: UserId | undefined) =>
      sessionUser(userId).pipe(
        Effect.catchTags({
          ServerAuthInvalidCredentialError: () =>
            Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "inactive_user" })),
        }),
        Effect.filterOrFail(
          (approver) => options?.asUser === undefined || approver.userId === options.asUser,
          () => new ServerAuthMcpApprovalCodeError({ reason: "other_user" }),
        ),
      );
    // Check whom a stored code acts as before spending it, so a refusal leaves it usable.
    const link = yield* inspectLink(credential);
    if (Option.isSome(link) && link.value.spendable) yield* approverOf(link.value.userId);
    const grant = yield* resolveBootstrapGrant(credential, {
      // No MCP tool needs the Installation's own scopes, which a Member's code lacks.
      requiredScopes: withoutInstallationScopes(mcpClientScopes(access)),
    }).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "unknown_or_used" })),
        ServerAuthScopeNotGrantedError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "insufficient_scope" })),
      }),
    );
    if (grant.method !== "one-time-token" && grant.method !== "reusable-dev-token") {
      return yield* new ServerAuthMcpApprovalCodeError({ reason: "not_a_pairing_code" });
    }
    return yield* approverOf(grant.userId);
  });

  const userDirectoryFailure = (cause: UserDirectory.UserDirectoryStorageError) =>
    new ServerAuthUserDirectoryError({ cause });

  // A passkey is bound to the page's origin, so only an origin the cookie rules accept may use one.
  const resolvePasskeyOrigin = (request: HttpServerRequest.HttpServerRequest) => {
    const origin = request.headers.origin;
    if (
      origin === undefined ||
      !isBrowserOriginAllowed(request, trustedBrowserOrigins, config.previewOrigin)
    ) {
      return Effect.fail(new ServerAuthInvalidOriginError({}));
    }
    try {
      const url = new URL(origin);
      // A published Hub binds every passkey to its public origin, so none is stranded on
      // another name for the same server, such as a LAN address or localhost.
      if (publicOrigin !== undefined) {
        return url.origin === publicOrigin
          ? Effect.succeed(url.origin)
          : Effect.fail(new ServerAuthInvalidOriginError({}));
      }
      return url.protocol === "https:" || url.protocol === "http:"
        ? Effect.succeed(url.origin)
        : Effect.fail(new ServerAuthInvalidOriginError({}));
    } catch {
      return Effect.fail(new ServerAuthInvalidOriginError({}));
    }
  };

  const issueUserBrowserSession = Effect.fn("EnvironmentAuth.issueUserBrowserSession")(function* (
    request: HttpServerRequest.HttpServerRequest,
    user: AuthUser,
    requestMetadata: AuthRequestMetadata,
    options?: { readonly identityLoginId?: string },
  ) {
    // A page on a preview's own origin signs nobody in, and replaces no session (login CSRF).
    if (crossesFromPreviewOrigin(config.previewOrigin, request.headers)) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "No one signs in from a preview's own origin.",
      });
    }
    yield* requireSecureTransport(requestMetadata);
    if (
      !ManagedLimits.allowsRemoteClients(managedPolicy) &&
      !isLoopbackClientAddress(requestMetadata.ipAddress)
    ) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "The managed policy allows account sign-in only on this machine.",
      });
    }
    const previousCredential = selectRequestCredential(request, sessions);
    const previousSession =
      previousCredential === undefined || !isBrowserCookieCredential(previousCredential.source)
        ? undefined
        : yield* sessions.verify(previousCredential.token).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: USER_SIGN_IN_SUBJECT,
        userId: user.id,
        // Only the Owner's session holds the Installation's own scopes (see `heldByUser`).
        scopes: user.isOwner
          ? AuthStandardClientScopes
          : withoutInstallationScopes(AuthStandardClientScopes),
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        ...(options?.identityLoginId === undefined
          ? {}
          : { identityLoginId: options.identityLoginId }),
        client: requestMetadata,
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      },
      sessionToken: session.token,
    } satisfies UserBrowserSession;
  });

  const inspectLink = (credential: string) =>
    bootstrapCredentials
      .inspect(credential)
      .pipe(
        Effect.mapError((cause) => new ServerAuthBootstrapCredentialValidationError({ cause })),
      );

  const isAdministrativeBootstrapLink = (credential: string) =>
    inspectLink(credential).pipe(
      Effect.map((link) =>
        Option.exists(
          link,
          ({ subject, spendable }) =>
            spendable && subject === INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ),
      ),
    );

  const requireAdministrativeBootstrapLink = (credential: string) =>
    isAdministrativeBootstrapLink(credential).pipe(
      Effect.filterOrFail(
        (matches) => matches,
        () =>
          new ServerAuthInvalidCredentialError({
            diagnostic: "Only the administrative bootstrap link can create the Owner.",
          }),
      ),
    );

  const getOwnerBootstrapStatus: EnvironmentAuth["Service"]["getOwnerBootstrapStatus"] = Effect.fn(
    "EnvironmentAuth.getOwnerBootstrapStatus",
  )(function* (credential) {
    const link = yield* inspectLink(credential);
    // Only the setup link describes itself, so this never confirms another credential existed.
    if (Option.isNone(link) || link.value.subject !== INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT) {
      return { status: "not-applicable" } as const;
    }
    if (!link.value.spendable) return { status: "spent" } as const;
    const hasOwner = yield* userDirectory.hasOwner().pipe(Effect.mapError(userDirectoryFailure));
    return { status: hasOwner ? "claimed" : "available" } as const;
  });

  const ownerCreationFailures = <A, R>(
    effect: Effect.Effect<
      A,
      UserDirectory.OwnerAlreadyClaimedError | UserDirectory.UserDirectoryStorageError,
      R
    >,
  ) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause._tag === "OwnerAlreadyClaimedError"
          ? new ServerAuthOwnerAlreadyClaimedError({})
          : userDirectoryFailure(cause),
      ),
    );

  const beginOwnerBootstrap: EnvironmentAuth["Service"]["beginOwnerBootstrap"] = Effect.fn(
    "EnvironmentAuth.beginOwnerBootstrap",
  )(function* (request, input) {
    const origin = yield* resolvePasskeyOrigin(request);
    yield* requireAdministrativeBootstrapLink(input.credential);
    return yield* userDirectory
      .startOwnerRegistration({ displayName: input.displayName, origin })
      .pipe(ownerCreationFailures);
  });

  const passkeyRejected = (cause: UserDirectory.PasskeyRejectedError) =>
    new ServerAuthInvalidCredentialError({ diagnostic: cause.message, cause });

  const completeOwnerBootstrap: EnvironmentAuth["Service"]["completeOwnerBootstrap"] = Effect.fn(
    "EnvironmentAuth.completeOwnerBootstrap",
  )(function* (request, input, requestMetadata) {
    const origin = yield* resolvePasskeyOrigin(request);
    if (yield* userDirectory.hasOwner().pipe(Effect.mapError(userDirectoryFailure))) {
      return yield* new ServerAuthOwnerAlreadyClaimedError({});
    }
    yield* requireAdministrativeBootstrapLink(input.credential);
    const pending = yield* userDirectory
      .verifyOwnerRegistration({
        ceremonyId: input.ceremonyId,
        origin,
        response: input.response,
      })
      .pipe(Effect.mapError(passkeyRejected));
    // One transaction: a failure after spending the link would lose it, and the recovery codes
    // are only ever returned here.
    const { created, session } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* bootstrapCredentials
            .consume(input.credential)
            .pipe(Effect.mapError(toBootstrapExchangeError));
          const created = yield* userDirectory.createOwner(pending).pipe(ownerCreationFailures);
          const session = yield* issueUserBrowserSession(request, created.user, requestMetadata);
          yield* audit
            .record({
              actor: AuditLog.userActor(created.user.id),
              action: "owner.bootstrap",
              target: { kind: "user", id: created.user.id },
            })
            .pipe(Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })));
          return { created, session };
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new ServerAuthUserDirectoryError({ cause })),
        }),
      );
    ownerPresence.markExists();
    return {
      result: {
        session: session.response,
        user: created.user,
        recoveryCodes: created.recoveryCodes,
      },
      sessionToken: session.sessionToken,
    };
  });

  const beginPasskeySignIn: EnvironmentAuth["Service"]["beginPasskeySignIn"] = Effect.fn(
    "EnvironmentAuth.beginPasskeySignIn",
  )(function* (request) {
    const origin = yield* resolvePasskeyOrigin(request);
    return yield* userDirectory.startPasskeySignIn({ origin });
  });

  const completePasskeySignIn: EnvironmentAuth["Service"]["completePasskeySignIn"] = Effect.fn(
    "EnvironmentAuth.completePasskeySignIn",
  )(function* (request, input, requestMetadata) {
    const origin = yield* resolvePasskeyOrigin(request);
    const user = yield* userDirectory
      .finishPasskeySignIn({ ceremonyId: input.ceremonyId, origin, response: input.response })
      .pipe(
        Effect.catchTags({
          PasskeyRejectedError: (cause) => Effect.fail(passkeyRejected(cause)),
          UserDirectoryStorageError: (cause) => Effect.fail(userDirectoryFailure(cause)),
        }),
      );
    return yield* issueSignInSession(request, user, requestMetadata);
  });

  // The Owner may disable the User between the credential check and the session write, which the
  // database then refuses (migration 092): answer that as the disabled account it is.
  const issueSignInSession = (
    request: HttpServerRequest.HttpServerRequest,
    user: AuthUser,
    requestMetadata: AuthRequestMetadata,
  ) =>
    issueUserBrowserSession(request, user, requestMetadata).pipe(
      Effect.catchTags({
        ServerAuthAuthenticatedSessionIssueError: (error) =>
          userDirectory.inactiveReason(user.id).pipe(
            Effect.mapError(userDirectoryFailure),
            Effect.flatMap((inactive) => Effect.fail(inactive ?? error)),
          ),
      }),
    );

  const signInWithRecoveryCode: EnvironmentAuth["Service"]["signInWithRecoveryCode"] = Effect.fn(
    "EnvironmentAuth.signInWithRecoveryCode",
  )(function* (request, code, requestMetadata) {
    const user = yield* userDirectory.redeemRecoveryCode(code).pipe(
      Effect.catchTags({
        RecoveryCodeRejectedError: (cause) =>
          Effect.fail(new ServerAuthInvalidCredentialError({ diagnostic: cause.message })),
        UserDirectoryStorageError: (cause) => Effect.fail(userDirectoryFailure(cause)),
      }),
    );
    return yield* issueSignInSession(request, user, requestMetadata);
  });

  const passwordFailures = {
    PasswordRejectedError: (cause: UserDirectory.PasswordRejectedError) =>
      Effect.fail(new ServerAuthInvalidCredentialError({ diagnostic: cause.message })),
    UserDirectoryStorageError: (cause: UserDirectory.UserDirectoryStorageError) =>
      Effect.fail(userDirectoryFailure(cause)),
  };

  const signInWithPassword: EnvironmentAuth["Service"]["signInWithPassword"] = Effect.fn(
    "EnvironmentAuth.signInWithPassword",
  )(function* (request, input, requestMetadata) {
    const checked = yield* userDirectory
      .checkPassword(input, requestMetadata.ipAddress)
      .pipe(Effect.catchTags(passwordFailures));
    if (checked._tag === "totp-required") {
      return {
        response: { authenticated: false, secondFactor: "totp", challengeId: checked.challengeId },
      } as const;
    }
    return yield* issueSignInSession(request, checked.user, requestMetadata);
  });

  const signInWithTotp: EnvironmentAuth["Service"]["signInWithTotp"] = Effect.fn(
    "EnvironmentAuth.signInWithTotp",
  )(function* (request, input, requestMetadata) {
    const user = yield* userDirectory
      .checkTotp(input, requestMetadata.ipAddress)
      .pipe(Effect.catchTags(passwordFailures));
    return yield* issueSignInSession(request, user, requestMetadata);
  });

  const resetLinkFailures = {
    ResetLinkRejectedError: (cause: UserDirectory.ResetLinkRejectedError) =>
      Effect.fail(new ServerAuthInvalidCredentialError({ diagnostic: cause.message })),
    UserDirectoryStorageError: (cause: UserDirectory.UserDirectoryStorageError) =>
      Effect.fail(userDirectoryFailure(cause)),
  };

  const recordResetRedeemed = (userId: UserId, method: "passkey" | "password") =>
    audit
      .record({
        actor: AuditLog.userActor(userId),
        action: "resetLink.redeem",
        target: { kind: "user", id: userId },
        detail: { method },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthUserDirectoryError({ cause })));

  // The link and its entry commit together; the shell, not a signed-in User, issued it.
  const issueOwnerResetLink: EnvironmentAuth["Service"]["issueOwnerResetLink"] = () =>
    sql
      .withTransaction(
        userDirectory.issueOwnerResetLink().pipe(
          Effect.tap((issued) =>
            audit.record({
              actor: AuditLog.cliActor,
              action: "owner.resetLink",
              target: { kind: "user", id: issued.user.id },
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "NoOwnerError" || cause._tag === "UserDirectoryStorageError"
            ? cause
            : new UserDirectory.UserDirectoryStorageError({ cause }),
        ),
        Effect.withSpan("EnvironmentAuth.issueOwnerResetLink"),
      );

  const beginResetLinkRegistration: EnvironmentAuth["Service"]["beginResetLinkRegistration"] =
    Effect.fn("EnvironmentAuth.beginResetLinkRegistration")(function* (request, token) {
      const origin = yield* resolvePasskeyOrigin(request);
      return yield* userDirectory
        .startResetRegistration({ token, origin })
        .pipe(Effect.catchTags(resetLinkFailures));
    });

  const redeemResetLink: EnvironmentAuth["Service"]["redeemResetLink"] = Effect.fn(
    "EnvironmentAuth.redeemResetLink",
  )(function* (request, input, requestMetadata) {
    const origin = yield* resolvePasskeyOrigin(request);
    const pending = yield* userDirectory
      .verifyResetRegistration({ ceremonyId: input.ceremonyId, origin, response: input.response })
      .pipe(Effect.mapError(passkeyRejected));
    // Spending the link, storing the passkey and issuing the session succeed or fail together.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const user = yield* userDirectory
            .redeemResetLink({ token: input.token, pending })
            .pipe(Effect.catchTags(resetLinkFailures));
          yield* recordResetRedeemed(user.id, "passkey");
          return { user, session: yield* issueUserBrowserSession(request, user, requestMetadata) };
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new ServerAuthUserDirectoryError({ cause })),
        }),
        // After the commit: their Admin rights may have changed with their credentials.
        Effect.tap(({ user }) => userDirectory.credentialsChanged(user.id)),
        Effect.map(({ session }) => session),
      );
  });

  const redeemResetLinkWithPassword: EnvironmentAuth["Service"]["redeemResetLinkWithPassword"] =
    Effect.fn("EnvironmentAuth.redeemResetLinkWithPassword")(
      function* (request, input, requestMetadata) {
        // Spending the link, replacing the credentials and issuing the session succeed or fail together.
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const user = yield* userDirectory.redeemResetLinkWithPassword(input).pipe(
                Effect.catchTags({
                  ResetLinkRejectedError: resetLinkFailures.ResetLinkRejectedError,
                  UserDirectoryStorageError: resetLinkFailures.UserDirectoryStorageError,
                }),
              );
              yield* recordResetRedeemed(user.id, "password");
              return {
                user,
                session: yield* issueUserBrowserSession(request, user, requestMetadata),
              };
            }),
          )
          .pipe(
            Effect.catchTags({
              SqlError: (cause) => Effect.fail(new ServerAuthUserDirectoryError({ cause })),
            }),
            Effect.tap(({ user }) => userDirectory.credentialsChanged(user.id)),
            Effect.map(({ session }) => session),
          );
      },
    );

  const issueAppSession: EnvironmentAuth["Service"]["issueAppSession"] = Effect.fn(
    "EnvironmentAuth.issueAppSession",
  )(function* (input) {
    yield* requireSecureTransport(input.client);
    if (
      !ManagedLimits.allowsRemoteClients(managedPolicy) &&
      !isLoopbackClientAddress(input.client.ipAddress)
    ) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "The managed policy allows account sign-in only on this machine.",
      });
    }
    // Refuses a User who was disabled or removed between the approval and the exchange.
    const owner = yield* sessionUser(input.userId);
    // An approval hands out only what the approving session held.
    const scopes = AuthStandardClientScopes.filter((scope) => input.scopes.includes(scope));
    if (scopes.length === 0) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "The approving session holds no scope an app could use.",
      });
    }
    const session = yield* sessions
      .issue({
        method: input.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
        subject: APP_SIGN_IN_SUBJECT,
        ...owner,
        scopes,
        ...(input.proofKeyThumbprint
          ? { proofKeyThumbprint: input.proofKeyThumbprint, ttl: Duration.hours(1) }
          : {}),
        client: input.client,
      })
      .pipe(
        Effect.mapError((cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause })),
      );
    const now = yield* DateTime.now;
    return {
      access_token: session.token,
      issued_token_type: AuthAccessTokenType,
      token_type: input.proofKeyThumbprint ? "DPoP" : "Bearer",
      expires_in: Math.max(
        0,
        Math.floor((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
      ),
      scope: encodeOAuthScope(session.scopes),
    } satisfies AuthAccessTokenResult;
  });

  // A cookie names a browser session; anything else is an app's bearer or DPoP token, checked
  // (proof included) like any request it makes.
  const requestSession = (request: HttpServerRequest.HttpServerRequest) => {
    const credential = resolveRequestCredential(request);
    return credential !== undefined && isBrowserCookieCredential(credential.source)
      ? authenticateBrowserSession(request)
      : authenticateRequest(request);
  };

  const signOut: EnvironmentAuth["Service"]["signOut"] = (request) =>
    requestSession(request).pipe(
      Effect.flatMap((session) =>
        // The reusable dev session is shared across worktrees and is not this browser's to end.
        session.subject === "reusable-dev-token"
          ? Effect.succeed(false)
          : sessions
              .revoke(session.sessionId)
              .pipe(Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause }))),
      ),
      Effect.catchIf(isServerAuthCredentialError, () => Effect.succeed(false)),
      Effect.withSpan("EnvironmentAuth.signOut"),
    );

  const ownerAtStartup = yield* userDirectory
    .hasOwner()
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not read whether the Installation has an Owner; public clients are re-checked on arrival.",
          { cause },
        ).pipe(Effect.as(false)),
      ),
    );
  if (ownerAtStartup) ownerPresence.markExists();

  yield* revokePairedClientsThePolicyDisallows(managedPolicy, {
    sessions,
    pairingLinks: bootstrapCredentials,
  });

  return EnvironmentAuth.of({
    getDescriptor: Effect.fn("EnvironmentAuth.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
    getSessionState,
    createBrowserSession,
    exchangeBootstrapCredentialForAccessToken,
    createPairingLink,
    issuePairingCredential,
    issueStartupPairingCredential,
    listPairingLinks,
    revokePairingLink,
    issueSession,
    listSessions,
    revokeSession,
    listClientSessions,
    streamAccess,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    issueStartupPairingUrl,
    authenticateMcpClient,
    issueMcpClientSession,
    consumeMcpApprovalCode,
    authenticateBrowserSession,
    getOwnerBootstrapStatus,
    beginOwnerBootstrap,
    completeOwnerBootstrap,
    beginPasskeySignIn,
    completePasskeySignIn,
    signInWithRecoveryCode,
    signInWithPassword,
    signInWithTotp,
    beginResetLinkRegistration,
    redeemResetLink,
    redeemResetLinkWithPassword,
    passkeyOrigin: resolvePasskeyOrigin,
    startUserBrowserSession: issueUserBrowserSession,
    issueOwnerResetLink,
    issueAppSession,
    signOut,
  });
});

const isRemoteClient = (ipAddress: string | undefined) =>
  ipAddress !== undefined && !isLocalLoopbackHost(ipAddress);

/** Subject of the sessions and links a pairing link created. */
const LINK_PAIRED_SUBJECT = "one-time-token";

/**
 * Revokes sessions and unused links from pairing the policy no longer allows, so a policy rolled
 * out to a machine that already had phones paired takes effect on the next start.
 */
const revokePairedClientsThePolicyDisallows = Effect.fn(
  "EnvironmentAuth.revokePairedClientsThePolicyDisallows",
)(function* (
  policy: ManagedPolicy.ManagedPolicy["Service"],
  stores: {
    readonly sessions: SessionStore.SessionStore["Service"];
    readonly pairingLinks: PairingGrantStore.PairingGrantStore["Service"];
  },
) {
  if (ManagedLimits.allowsRemoteClients(policy)) return;
  const sessions = (yield* stores.sessions.listActive()).filter(
    (session) =>
      session.subject === LINK_PAIRED_SUBJECT ||
      // The startup link and account sign-in also serve browsers on this machine; only a
      // device elsewhere goes.
      ((session.subject === INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT ||
        session.subject === USER_SIGN_IN_SUBJECT ||
        session.subject === APP_SIGN_IN_SUBJECT) &&
        isRemoteClient(session.client.ipAddress)),
  );
  const links = (yield* stores.pairingLinks.listActive()).filter(
    (link) => link.subject === LINK_PAIRED_SUBJECT,
  );
  yield* Effect.forEach(sessions, (session) => stores.sessions.revoke(session.sessionId), {
    discard: true,
  });
  yield* Effect.forEach(links, (link) => stores.pairingLinks.revoke(link.id), { discard: true });
  if (sessions.length > 0 || links.length > 0) {
    yield* Effect.logInfo("Revoked clients the managed policy does not allow.", {
      sessions: sessions.length,
      pairingLinks: links.length,
    });
  }
});

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provide(AuditLog.layer),
  Layer.provideMerge(UserDirectory.layer),
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

// Commands beside the Hub (`t3 ...`): the store opens read-only while a Hub runs.
const layerStorage = Layer.mergeAll(ServerSecretStore.layerClient, SqlitePersistence.layerConfig);

export const layerRuntime = layer.pipe(
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
