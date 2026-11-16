import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthCreatePairingCredentialInput,
  AuthMcpApprovalDecisionRequest,
  AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpApprovalRedirect,
  AuthMcpAuthorizationRequest,
  AuthMcpAuthorizationServerMetadata,
  AuthMcpClientRegistration,
  AuthMcpProtectedResourceMetadata,
  AuthMcpRegisteredClient,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  AuthMcpTokenRequest,
  AuthMcpTokenResult,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthAppSignInApproveRequest,
  AuthAppSignInApproveResult,
  AuthAppSignInTokenRequest,
  AuthSessionState,
  AuthWebSocketTicketParams,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  AuthAccount,
  AuthCredentialRemovalRequest,
  AuthOwnerBootstrapRequest,
  AuthOwnerBootstrapResult,
  AuthOwnerBootstrapStatus,
  AuthOwnerBootstrapStatusRequest,
  AuthOwnerRegistrationRequest,
  AuthPasskeyRegistrationCeremony,
  AuthPasskeySignInCeremony,
  AuthPasskeySignInRequest,
  AuthPasswordSignInRequest,
  AuthPasswordSignInResult,
  AuthRecoveryCodeSignInRequest,
  AuthResetLinkPasswordRequest,
  AuthResetLinkRedeemRequest,
  AuthResetLinkRequest,
  AuthResetLinkStatus,
  AuthSetPasswordRequest,
  AuthSignOutResult,
  AuthTotpConfirmRequest,
  AuthTotpEnrollment,
  AuthTotpSignInRequest,
} from "./userAccounts.ts";
import {
  ChangeMemberRoleRequest,
  ChangeMemberRoleResult,
  CreateOrganizationRequest,
  InstallationUser,
  InstallationUserList,
  MemberList,
  MemberRequest,
  MemberResetLink,
  SetInstallationPermissionRequest,
  SetInstallationUserStatusRequest,
  SpaceDirectoryView,
  SpaceSummary,
} from "./spaces.ts";
import { AuditLogPage, AuditLogQuery } from "./audit.ts";
import {
  MasterKeyBackupConfirmRequest,
  MasterKeyBackupRequest,
  MasterKeyBackupResult,
  MasterKeyStatus,
  VaultRevealRequest,
  VaultRevealResult,
} from "./vaults.ts";
import {
  ChangeHubEnvironmentModeRequest,
  EnvironmentJoinApproveRequest,
  EnvironmentJoinConfirmRequest,
  EnvironmentJoinDecisionResult,
  EnvironmentJoinRequestRef,
  EnvironmentJoinRequestView,
  EnvironmentJoinStartRequest,
  EnvironmentJoinStartResult,
  EnvironmentJoinStatus,
  EnvironmentJoinStatusRequest,
  EnvironmentLeaveResult,
  EnvironmentSelfResult,
  HubEnvironmentList,
  HubEnvironmentOverview,
  HubEnvironmentSummary,
  HubSandboxActionRequest,
  HubSandboxDetail,
  HubSandboxLimitsRequest,
  HubSandboxList,
  RemoveHubEnvironmentRequest,
  StartHubEnvironmentRequest,
  RenameHubEnvironmentRequest,
} from "./hubEnvironments.ts";
import {
  AcceptInvitationRequest,
  AcceptInvitationResult,
  CreatedInvitation,
  CreateInvitationRequest,
  InvitationList,
  InvitationPreview,
  InvitationRegistrationRequest,
  InvitationSummary,
  InvitationTokenRequest,
  JoinInvitationResult,
  RevokeInvitationRequest,
} from "./invitations.ts";
import {
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "./environment.ts";
import {
  DpopFailureReason,
  AuthSessionId,
  SpaceId,
  UserId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadTranscript,
} from "./orchestrationV2.ts";
import {
  Project,
  ProjectMoveInput,
  ProjectMovePlan,
  ProjectMovePlanInput,
  ProjectMoveResult,
  ProjectMutation,
  ProjectSnapshot,
} from "./project.ts";
import {
  SandboxImageStatus,
  SandboxImageStatusQuery,
  UpdateSandboxImageRequest,
  UpdateSandboxImageResult,
} from "./sandboxImage.ts";
import {
  EnvironmentJoinGrantRequest,
  SshInstallConfirmRequest,
  SshInstallRun,
  SshInstallRunRef,
  SshInstallStartRequest,
} from "./sshInstall.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OrchestrationProtocolHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
  [ORCHESTRATION_PROTOCOL_HEADER]: Schema.Literal(ORCHESTRATION_PROTOCOL_VERSION_TEXT),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
  "invalid_history_cursor",
  "thread_transcript_too_large",
  "invalid_origin",
  // A browser session asked for over plain HTTP from off the server's machine.
  "insecure_transport",
  // An app sign-in names a redirect other than a loopback port or the mobile app's callback.
  "invalid_redirect_uri",
  // An app sign-in without a valid S256 PKCE challenge or state.
  "invalid_code_challenge",
  // An audit log filter that is not a date, a cursor or a page size.
  "invalid_audit_query",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "project_snapshot_failed",
  "project_mutation_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_thread_bounded_snapshot_failed",
  "orchestration_thread_history_failed",
  "spaces_failed",
  "invitations_failed",
  "installation_users_failed",
  "audit_log_failed",
  "environments_failed",
  "sandbox_image_failed",
  "master_key_failed",
  "vaults_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedError<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedError<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedError<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    requiredPermission: Schema.optionalKey(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredPermission ?? this.requiredScope} scope, which this client does not have.`;
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedError<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedError<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals([
  "thread_not_found",
  "user_not_found",
  "environment_not_found",
  "join_request_not_found",
  "ssh_install_run_not_found",
  "secret_not_found",
]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedError<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedError<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedError<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedError<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

/** Sandbox limits outside what a Sandbox needs or the Hub's machine has; `message` says which. */
export class EnvironmentSandboxLimitsInvalidError extends Schema.TaggedError<EnvironmentSandboxLimitsInvalidError>()(
  "EnvironmentSandboxLimitsInvalidError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentSandboxLimitsInvalidError)(this, {
      status: 400,
    });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedError<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedError<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

/**
 * A machine's mode or Space can't change while Threads have it as their Active environment:
 * these are the ones to move first (or delete).
 */
export class EnvironmentModeChangeRefusedError extends Schema.TaggedError<EnvironmentModeChangeRefusedError>()(
  "EnvironmentModeChangeRefusedError",
  {
    message: Schema.String,
    threads: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentModeChangeRefusedError)(this, { status: 409 });
  }
}

/** Too many failed sign-in attempts for this account or client; retry after the delay. */
export class EnvironmentRateLimitedError extends Schema.TaggedError<EnvironmentRateLimitedError>()(
  "EnvironmentRateLimitedError",
  {
    message: Schema.String,
    retryAfterSeconds: Schema.Number,
  },
  { httpApiStatus: 429 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRateLimitedError)(this, { status: 429 });
  }
}

const EnvironmentSessionCreationErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentUserSignInErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentOwnerBootstrapErrors = [
  ...EnvironmentUserSignInErrors,
  // The Installation already has an Owner.
  EnvironmentHttpConflictError,
] as const;
const EnvironmentPasswordSignInErrors = [
  ...EnvironmentUserSignInErrors,
  EnvironmentRateLimitedError,
  // The right password for an account that also needs TOTP and has none set up, or that the
  // Owner disabled or removed.
  EnvironmentHttpForbiddenError,
] as const;
const EnvironmentAccountErrors = [
  // The session has no User, the step-up proof failed, or the account's rules refuse the change.
  EnvironmentHttpForbiddenError,
  // Failed step-up proofs count toward the same back-off as sign-in.
  EnvironmentRateLimitedError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  // The managed policy does not allow remote clients.
  EnvironmentHttpForbiddenError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  // Another User's session or link, which only the Owner may revoke.
  EnvironmentHttpForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectMutationErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  // The current Space does not let this User create Projects.
  EnvironmentHttpForbiddenError,
  // A move refused while one of the Project's Threads runs.
  EnvironmentHttpConflictError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly userId?: UserId;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicketFor", "/api/auth/websocket-ticket/:use", {
      headers: OptionalBearerHeaders,
      params: AuthWebSocketTicketParams,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("ownerBootstrapStatus", "/api/auth/owner/status", {
      payload: AuthOwnerBootstrapStatusRequest,
      success: AuthOwnerBootstrapStatus,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("ownerRegistration", "/api/auth/owner/registration", {
      payload: AuthOwnerRegistrationRequest,
      success: AuthPasskeyRegistrationCeremony,
      error: EnvironmentOwnerBootstrapErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("ownerBootstrap", "/api/auth/owner", {
      payload: AuthOwnerBootstrapRequest,
      success: AuthOwnerBootstrapResult,
      error: EnvironmentOwnerBootstrapErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("passkeyChallenge", "/api/auth/passkey/challenge", {
      success: AuthPasskeySignInCeremony,
      error: EnvironmentUserSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("passkeySignIn", "/api/auth/passkey/sign-in", {
      payload: AuthPasskeySignInRequest,
      success: AuthBrowserSessionResult,
      // Forbidden: the passkey is right but the Owner disabled or removed the account.
      error: [...EnvironmentUserSignInErrors, EnvironmentHttpForbiddenError],
    }),
  )
  .add(
    HttpApiEndpoint.post("recoveryCodeSignIn", "/api/auth/recovery-code/sign-in", {
      payload: AuthRecoveryCodeSignInRequest,
      success: AuthBrowserSessionResult,
      // Forbidden: the code is right but the Owner disabled or removed the account.
      error: [...EnvironmentUserSignInErrors, EnvironmentHttpForbiddenError],
    }),
  )
  .add(
    HttpApiEndpoint.post("signOut", "/api/auth/sign-out", {
      // A browser signs out with its cookie; an app with its bearer or DPoP token.
      headers: OptionalBearerHeaders,
      success: AuthSignOutResult,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("passwordSignIn", "/api/auth/password/sign-in", {
      payload: AuthPasswordSignInRequest,
      success: AuthPasswordSignInResult,
      error: EnvironmentPasswordSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("totpSignIn", "/api/auth/password/totp", {
      payload: AuthTotpSignInRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentPasswordSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("account", "/api/auth/account", {
      headers: OptionalBearerHeaders,
      success: AuthAccount,
      error: EnvironmentAccountErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setPassword", "/api/auth/account/password", {
      headers: OptionalBearerHeaders,
      payload: AuthSetPasswordRequest,
      success: AuthAccount,
      // The login name belongs to another User.
      error: [...EnvironmentAccountErrors, EnvironmentHttpConflictError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removePassword", "/api/auth/account/password/remove", {
      headers: OptionalBearerHeaders,
      payload: AuthCredentialRemovalRequest,
      success: AuthAccount,
      error: EnvironmentAccountErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removeTotp", "/api/auth/account/totp/remove", {
      headers: OptionalBearerHeaders,
      payload: AuthCredentialRemovalRequest,
      success: AuthAccount,
      error: EnvironmentAccountErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("startTotpEnrollment", "/api/auth/account/totp/enrollment", {
      headers: OptionalBearerHeaders,
      success: AuthTotpEnrollment,
      error: EnvironmentAccountErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("confirmTotpEnrollment", "/api/auth/account/totp", {
      headers: OptionalBearerHeaders,
      payload: AuthTotpConfirmRequest,
      success: AuthAccount,
      error: EnvironmentAccountErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("resetLinkStatus", "/api/auth/reset/status", {
      payload: AuthResetLinkRequest,
      success: AuthResetLinkStatus,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resetLinkRegistration", "/api/auth/reset/registration", {
      payload: AuthResetLinkRequest,
      success: AuthPasskeyRegistrationCeremony,
      error: EnvironmentUserSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("redeemResetLink", "/api/auth/reset", {
      payload: AuthResetLinkRedeemRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentUserSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("redeemResetLinkWithPassword", "/api/auth/reset/password", {
      payload: AuthResetLinkPasswordRequest,
      success: AuthBrowserSessionResult,
      error: [
        ...EnvironmentUserSignInErrors,
        // The sign-in name belongs to another User.
        EnvironmentHttpConflictError,
        // The Owner's account resets with a passkey.
        EnvironmentHttpForbiddenError,
      ],
    }),
  ) {}

// Desktop and mobile apps sign in through the system browser; see `@t3tools/shared/appSignIn`.
class EnvironmentAppSignInHttpApi extends HttpApiGroup.make("appSignIn")
  .add(
    HttpApiEndpoint.post("approve", "/api/auth/app-sign-in/approve", {
      payload: AuthAppSignInApproveRequest,
      success: AuthAppSignInApproveResult,
      error: EnvironmentUserSignInErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/api/auth/app-sign-in/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthAppSignInTokenRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  ) {}

class EnvironmentMcpOAuthHttpApi extends HttpApiGroup.make("mcpOAuth")
  .add(
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("mcpProtectedResource", "/.well-known/oauth-protected-resource/mcp", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: AuthMcpAuthorizationServerMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/oauth/mcp/register", {
      payload: AuthMcpClientRegistration,
      success: AuthMcpRegisteredClient,
      error: AuthMcpRegistrationError,
    }),
  )
  .add(HttpApiEndpoint.get("authorize", "/oauth/mcp/authorize"))
  .add(
    HttpApiEndpoint.post("approval", "/oauth/mcp/approval", {
      payload: AuthMcpAuthorizationRequest,
      success: [AuthMcpApprovalDetails, AuthMcpApprovalRedirect],
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("decision", "/oauth/mcp/decision", {
      payload: AuthMcpApprovalDecisionRequest,
      success: AuthMcpApprovalRedirect,
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/mcp/token", {
      payload: AuthMcpTokenRequest,
      success: AuthMcpTokenResult,
      error: AuthMcpTokenError,
    }),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

const EnvironmentOrchestrationShellSnapshotQuery = Schema.Struct({
  omitIdleSubagents: Schema.optionalKey(Schema.String),
  omitOlderSettled: Schema.optionalKey(Schema.String),
});

const EnvironmentOrchestrationThreadBoundedSnapshotQuery = Schema.Struct({
  deferWork: Schema.optionalKey(Schema.String),
  compactTurnItems: Schema.optionalKey(Schema.String),
  dedupeBodies: Schema.optionalKey(Schema.String),
  compactIds: Schema.optionalKey(Schema.String),
});

const EnvironmentOrchestrationThreadHistoryQuery = Schema.Struct({
  cursor: TrimmedNonEmptyString,
  throughEntryId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(Schema.Literals(["conversation", "activity", "work"])),
  deferWork: Schema.optionalKey(Schema.String),
  compactIds: Schema.optionalKey(Schema.String),
});

const EnvironmentOrchestrationThreadHistoryErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;

class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OrchestrationProtocolHeaders,
      query: EnvironmentOrchestrationShellSnapshotQuery,
      success: OrchestrationV2ShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationV2ThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadTranscript", "/api/orchestration/threads/:threadId/transcript", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationV2ThreadTranscript,
      error: [EnvironmentRequestInvalidError, ...EnvironmentOrchestrationThreadSnapshotErrors],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadBoundedSnapshot", "/api/orchestration/threads/:threadId/bounded", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadBoundedSnapshotQuery,
      success: OrchestrationV2ThreadBoundedSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadHistoryPage", "/api/orchestration/threads/:threadId/history", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadHistoryQuery,
      success: OrchestrationV2ThreadHistoryPage,
      error: EnvironmentOrchestrationThreadHistoryErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentSpaceErrors = [
  // The session has no User, or the Space's rules refuse the change.
  EnvironmentHttpForbiddenError,
  EnvironmentInternalError,
] as const;

const SpaceParams = Schema.Struct({ spaceId: SpaceId });

class EnvironmentSpacesHttpApi extends HttpApiGroup.make("spaces")
  .add(
    HttpApiEndpoint.get("list", "/api/spaces", {
      headers: OptionalBearerHeaders,
      success: SpaceDirectoryView,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createOrganization", "/api/spaces/organizations", {
      headers: OptionalBearerHeaders,
      payload: CreateOrganizationRequest,
      success: SpaceSummary,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // An Organization the viewer cannot see answers exactly like one that does not exist.
  .add(
    HttpApiEndpoint.get("members", "/api/spaces/:spaceId/members", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      success: MemberList,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("changeMemberRole", "/api/spaces/:spaceId/members/role", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      payload: ChangeMemberRoleRequest,
      success: ChangeMemberRoleResult,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removeMember", "/api/spaces/:spaceId/members/remove", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      payload: MemberRequest,
      success: MemberList,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("issueMemberResetLink", "/api/spaces/:spaceId/members/reset-link", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      payload: MemberRequest,
      success: MemberResetLink,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("leave", "/api/spaces/:spaceId/leave", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      success: SpaceDirectoryView,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // The Owner's: archive hides the Organization from its Members and stops what runs in it;
  // restore brings it back; delete, only once archived, removes it with everything in it.
  .add(
    HttpApiEndpoint.post("archiveOrganization", "/api/spaces/:spaceId/archive", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      success: SpaceDirectoryView,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("restoreOrganization", "/api/spaces/:spaceId/restore", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      success: SpaceDirectoryView,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("deleteOrganization", "/api/spaces/:spaceId/delete", {
      headers: OptionalBearerHeaders,
      params: SpaceParams,
      success: SpaceDirectoryView,
      error: EnvironmentSpaceErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const InstallationUserParams = Schema.Struct({ userId: UserId });
// The session must be the Owner's and carry the access scope.
const EnvironmentInstallationUserErrors = [
  ...EnvironmentSpaceErrors,
  EnvironmentScopeRequiredError,
] as const;

// The Owner's Users admin view: list Users, grant or revoke their Installation permissions, and
// disable, re-enable or remove them.
class EnvironmentInstallationUsersHttpApi extends HttpApiGroup.make("installationUsers")
  .add(
    HttpApiEndpoint.get("list", "/api/installation/users", {
      headers: OptionalBearerHeaders,
      success: InstallationUserList,
      error: EnvironmentInstallationUserErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setPermission", "/api/installation/users/:userId/permissions", {
      headers: OptionalBearerHeaders,
      params: InstallationUserParams,
      payload: SetInstallationPermissionRequest,
      success: InstallationUser,
      error: [...EnvironmentInstallationUserErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setStatus", "/api/installation/users/:userId/status", {
      headers: OptionalBearerHeaders,
      params: InstallationUserParams,
      payload: SetInstallationUserStatusRequest,
      success: InstallationUser,
      error: [...EnvironmentInstallationUserErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

// The Owner's audit log; a session of the Owner's also needs the access scope.
class EnvironmentAuditHttpApi extends HttpApiGroup.make("audit").add(
  HttpApiEndpoint.get("list", "/api/installation/audit", {
    headers: OptionalBearerHeaders,
    query: AuditLogQuery,
    success: AuditLogPage,
    error: [...EnvironmentInstallationUserErrors, EnvironmentRequestInvalidError],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

const EnvironmentHubEnvironmentErrors = [
  // The session has no User, or the policy refuses the change.
  EnvironmentHttpForbiddenError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

const EnvironmentSshInstallErrors = [
  ...EnvironmentHubEnvironmentErrors,
  // A host, user or Hub address it refuses, or a key it cannot read; `message` says which.
  EnvironmentHttpBadRequestError,
  // A run to that host is under way, or the run is past the step asked for.
  EnvironmentHttpConflictError,
  EnvironmentResourceNotFoundError,
] as const;

// The machines registered with this Hub. Each joins with `t3 join`: the Owner approves its request
// on «Register this machine» with a strong factor. The credential, made on the machine and known
// to the Hub only as a hash, opens nothing but `/api/environment/connect` and `leave`.
class EnvironmentHubEnvironmentsHttpApi extends HttpApiGroup.make("environments")
  .add(
    HttpApiEndpoint.get("list", "/api/environments", {
      headers: OptionalBearerHeaders,
      success: HubEnvironmentList,
      error: EnvironmentHubEnvironmentErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    // Every machine with its mode, Space or owner and status, for the Owner only (mobile's list).
    HttpApiEndpoint.get("overview", "/api/environments/overview", {
      headers: OptionalBearerHeaders,
      success: HubEnvironmentOverview,
      error: EnvironmentHubEnvironmentErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("rename", "/api/environments/rename", {
      headers: OptionalBearerHeaders,
      payload: RenameHubEnvironmentRequest,
      success: HubEnvironmentSummary,
      error: [...EnvironmentHubEnvironmentErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("remove", "/api/environments/remove", {
      headers: OptionalBearerHeaders,
      payload: RemoveHubEnvironmentRequest,
      success: HubEnvironmentList,
      // Conflict: removed, but its kept SSH key or host record could not be deleted (it says so).
      error: [
        ...EnvironmentHubEnvironmentErrors,
        EnvironmentResourceNotFoundError,
        EnvironmentHttpConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // The Owner makes a machine personal or dedicates it to an Organization (environment.mode.change).
  .add(
    HttpApiEndpoint.post("changeMode", "/api/environments/mode", {
      headers: OptionalBearerHeaders,
      payload: ChangeHubEnvironmentModeRequest,
      success: HubEnvironmentSummary,
      error: [
        ...EnvironmentHubEnvironmentErrors,
        EnvironmentResourceNotFoundError,
        EnvironmentModeChangeRefusedError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // «Try again» on a Sandbox whose start failed: answers at once, as it starts.
  .add(
    HttpApiEndpoint.post("start", "/api/environments/start", {
      headers: OptionalBearerHeaders,
      payload: StartHubEnvironmentRequest,
      success: HubEnvironmentSummary,
      error: [...EnvironmentHubEnvironmentErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // Settings → Environments «Sandboxes»: the Owner sees every one and manages them; an Admin sees
  // their Space's.
  .add(
    HttpApiEndpoint.get("sandboxes", "/api/environments/sandboxes", {
      headers: OptionalBearerHeaders,
      success: HubSandboxList,
      error: EnvironmentHubEnvironmentErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sandboxAction", "/api/environments/sandboxes/action", {
      headers: OptionalBearerHeaders,
      payload: HubSandboxActionRequest,
      success: HubSandboxDetail,
      error: [...EnvironmentHubEnvironmentErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sandboxLimits", "/api/environments/sandboxes/limits", {
      headers: OptionalBearerHeaders,
      payload: HubSandboxLimitsRequest,
      success: HubSandboxList,
      error: [
        ...EnvironmentHubEnvironmentErrors,
        EnvironmentResourceNotFoundError,
        EnvironmentSandboxLimitsInvalidError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // `t3 join` on the machine: start a request, then ask until the Owner decides.
  .add(
    HttpApiEndpoint.post("startJoin", "/api/environments/join/start", {
      payload: EnvironmentJoinStartRequest,
      success: EnvironmentJoinStartResult,
      error: [EnvironmentRequestInvalidError, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("joinStatus", "/api/environments/join/status", {
      payload: EnvironmentJoinStatusRequest,
      success: EnvironmentJoinStatus,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  // Told who approved it, `t3 join` accepts them (registering the machine as theirs) or refuses.
  .add(
    HttpApiEndpoint.post("confirmJoin", "/api/environments/join/confirm", {
      payload: EnvironmentJoinConfirmRequest,
      success: EnvironmentJoinStatus,
      error: [
        EnvironmentRequestInvalidError,
        EnvironmentAuthInvalidError,
        EnvironmentResourceNotFoundError,
        EnvironmentHttpForbiddenError,
        EnvironmentInternalError,
      ],
    }),
  )
  // The «Register this machine» page; deciding takes only the browser's own cookie.
  .add(
    HttpApiEndpoint.post("joinRequest", "/api/environments/join/request", {
      payload: EnvironmentJoinRequestRef,
      success: EnvironmentJoinRequestView,
      error: [EnvironmentResourceNotFoundError, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("approveJoin", "/api/environments/join/approve", {
      payload: EnvironmentJoinApproveRequest,
      success: EnvironmentJoinDecisionResult,
      error: [
        EnvironmentRequestInvalidError,
        EnvironmentAuthInvalidError,
        EnvironmentRateLimitedError,
        EnvironmentResourceNotFoundError,
        ...EnvironmentHubEnvironmentErrors,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("denyJoin", "/api/environments/join/deny", {
      payload: EnvironmentJoinRequestRef,
      success: EnvironmentJoinDecisionResult,
      error: [
        EnvironmentAuthInvalidError,
        EnvironmentResourceNotFoundError,
        EnvironmentHttpForbiddenError,
        EnvironmentInternalError,
      ],
    }),
  )
  // A machine asks how the Hub uses it now, with its own credential.
  .add(
    HttpApiEndpoint.post("self", "/api/environments/self", {
      headers: OptionalBearerHeaders,
      success: EnvironmentSelfResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  // `t3 leave`: the machine unregisters itself with its own credential.
  .add(
    HttpApiEndpoint.post("leave", "/api/environments/leave", {
      headers: OptionalBearerHeaders,
      success: EnvironmentLeaveResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  // `t3 join --grant-on-stdin`, which the Hub runs over SSH: its run's one-use grant registers it.
  .add(
    HttpApiEndpoint.post("grantJoin", "/api/environments/join/grant", {
      payload: EnvironmentJoinGrantRequest,
      success: EnvironmentJoinStatus,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  // «Add a machine over SSH»: the Owner only. A run reads the host key first and goes on once the
  // Owner confirms it; its steps run on the Hub, followed by asking for the run.
  .add(
    HttpApiEndpoint.post("sshInstallStart", "/api/environments/ssh/start", {
      headers: OptionalBearerHeaders,
      payload: SshInstallStartRequest,
      success: SshInstallRun,
      error: EnvironmentSshInstallErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sshInstallConfirm", "/api/environments/ssh/confirm", {
      headers: OptionalBearerHeaders,
      payload: SshInstallConfirmRequest,
      success: SshInstallRun,
      error: EnvironmentSshInstallErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sshInstallCancel", "/api/environments/ssh/cancel", {
      headers: OptionalBearerHeaders,
      payload: SshInstallRunRef,
      success: SshInstallRun,
      error: EnvironmentSshInstallErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sshInstallStatus", "/api/environments/ssh/status", {
      headers: OptionalBearerHeaders,
      payload: SshInstallRunRef,
      success: SshInstallRun,
      error: EnvironmentSshInstallErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentInvitationManageErrors = [
  // The session has no User, or the policy refuses the change.
  EnvironmentHttpForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentInvitationRedeemErrors = [
  // The link is unknown, expired, revoked, used or into an archived Organization.
  EnvironmentHttpForbiddenError,
  // The sign-in name belongs to another User, or the User is already a Member.
  EnvironmentHttpConflictError,
  // Too many failed attempts from this client.
  EnvironmentRateLimitedError,
  EnvironmentRequestInvalidError,
  EnvironmentInternalError,
] as const;
const InvitationSpaceParams = Schema.Struct({ spaceId: SpaceId });

class EnvironmentInvitationsHttpApi extends HttpApiGroup.make("invitations")
  .add(
    HttpApiEndpoint.get("list", "/api/spaces/:spaceId/invitations", {
      headers: OptionalBearerHeaders,
      params: InvitationSpaceParams,
      success: InvitationList,
      error: EnvironmentInvitationManageErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("create", "/api/spaces/:spaceId/invitations", {
      headers: OptionalBearerHeaders,
      params: InvitationSpaceParams,
      payload: CreateInvitationRequest,
      success: CreatedInvitation,
      error: EnvironmentInvitationManageErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revoke", "/api/invitations/revoke", {
      headers: OptionalBearerHeaders,
      payload: RevokeInvitationRequest,
      success: InvitationSummary,
      error: EnvironmentInvitationManageErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // The rest are for the invitee, who usually has no session yet.
  .add(
    HttpApiEndpoint.post("preview", "/api/invitations/preview", {
      payload: InvitationTokenRequest,
      success: InvitationPreview,
      error: [EnvironmentRateLimitedError, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("registration", "/api/invitations/registration", {
      payload: InvitationRegistrationRequest,
      success: AuthPasskeyRegistrationCeremony,
      error: EnvironmentInvitationRedeemErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("totpEnrollment", "/api/invitations/totp-enrollment", {
      payload: InvitationTokenRequest,
      success: AuthTotpEnrollment,
      error: EnvironmentInvitationRedeemErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("accept", "/api/invitations/accept", {
      payload: AcceptInvitationRequest,
      success: AcceptInvitationResult,
      error: EnvironmentInvitationRedeemErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("join", "/api/invitations/join", {
      headers: OptionalBearerHeaders,
      payload: InvitationTokenRequest,
      success: JoinInvitationResult,
      error: EnvironmentInvitationRedeemErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentProjectsHttpApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/projects", {
      headers: OptionalBearerHeaders,
      success: ProjectSnapshot,
      error: EnvironmentProjectSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/api/projects/mutate", {
      headers: OptionalBearerHeaders,
      payload: ProjectMutation,
      success: Project,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    // The move itself, answering which Threads it released (`projects.mutate` answers the Project).
    HttpApiEndpoint.post("move", "/api/projects/move", {
      headers: OptionalBearerHeaders,
      payload: ProjectMoveInput,
      success: ProjectMoveResult,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    // What a move would do to the Project's Threads, asked before confirming it.
    HttpApiEndpoint.post("movePlan", "/api/projects/move-plan", {
      headers: OptionalBearerHeaders,
      payload: ProjectMovePlanInput,
      success: ProjectMovePlan,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

// Path tokens and optional body signatures authenticate webhooks; read raw bytes to verify signatures.
const WebhookParams = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
const WebhookAccepted = Schema.Struct({ deliveryId: TrimmedNonEmptyString }).pipe(
  HttpApiSchema.status(202),
);
const webhookEndpoint = {
  params: WebhookParams,
  success: WebhookAccepted,
} as const;
const WEBHOOK_PATH = "/api/hooks/:hookId/:token";

class EnvironmentWebhooksHttpApi extends HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("webhookPost", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.put("webhookPut", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.patch("webhookPatch", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.get("webhookGet", WEBHOOK_PATH, webhookEndpoint)) {}

// The Sandbox base image: the Owner (or the Hub's own shell, `t3 sandbox image build`) builds it,
// follows the build and moves a running Sandbox to it. A build answers at once; it runs on the Hub.
const EnvironmentSandboxImageErrors = [
  EnvironmentHttpForbiddenError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

class EnvironmentSandboxImageHttpApi extends HttpApiGroup.make("sandboxImage")
  .add(
    HttpApiEndpoint.get("status", "/api/sandboxes/image", {
      headers: OptionalBearerHeaders,
      query: SandboxImageStatusQuery,
      success: SandboxImageStatus,
      error: EnvironmentSandboxImageErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("build", "/api/sandboxes/image/build", {
      headers: OptionalBearerHeaders,
      success: SandboxImageStatus,
      error: [...EnvironmentSandboxImageErrors, EnvironmentHttpConflictError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("update", "/api/sandboxes/image/update", {
      headers: OptionalBearerHeaders,
      payload: UpdateSandboxImageRequest,
      success: UpdateSandboxImageResult,
      error: [
        ...EnvironmentSandboxImageErrors,
        EnvironmentHttpConflictError,
        EnvironmentResourceNotFoundError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

// The master key that encrypts the Hub's secrets: the Owner only, the backup with a strong factor
// in the request. HTTP rather than WS, so the key never passes through subscriptions or caches.
const EnvironmentVaultsErrors = [
  EnvironmentHttpForbiddenError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

class EnvironmentVaultsHttpApi extends HttpApiGroup.make("vaults")
  .add(
    HttpApiEndpoint.get("masterKeyStatus", "/api/vaults/master-key", {
      headers: OptionalBearerHeaders,
      success: MasterKeyStatus,
      error: EnvironmentVaultsErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("masterKeyBackup", "/api/vaults/master-key/backup", {
      headers: OptionalBearerHeaders,
      payload: MasterKeyBackupRequest,
      success: MasterKeyBackupResult,
      error: [...EnvironmentVaultsErrors, EnvironmentRateLimitedError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("masterKeyBackupConfirm", "/api/vaults/master-key/backup/confirm", {
      headers: OptionalBearerHeaders,
      payload: MasterKeyBackupConfirmRequest,
      success: MasterKeyStatus,
      error: [...EnvironmentVaultsErrors, EnvironmentHttpConflictError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  // A secret's value: the Owner only, with a strong factor in the request; the only door that
  // reads one. HTTP rather than WS, for the same reason as the key.
  .add(
    HttpApiEndpoint.post("reveal", "/api/vaults/reveal", {
      headers: OptionalBearerHeaders,
      payload: VaultRevealRequest,
      success: VaultRevealResult,
      // Conflict: a sealed Secret, refused before the factor and before its value is read.
      error: [
        ...EnvironmentVaultsErrors,
        EnvironmentRateLimitedError,
        EnvironmentResourceNotFoundError,
        EnvironmentHttpConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentAppSignInHttpApi)
  .add(EnvironmentMcpOAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentProjectsHttpApi)
  .add(EnvironmentSpacesHttpApi)
  .add(EnvironmentInvitationsHttpApi)
  .add(EnvironmentInstallationUsersHttpApi)
  .add(EnvironmentAuditHttpApi)
  .add(EnvironmentHubEnvironmentsHttpApi)
  .add(EnvironmentSandboxImageHttpApi)
  .add(EnvironmentVaultsHttpApi)
  .add(EnvironmentWebhooksHttpApi) {}
