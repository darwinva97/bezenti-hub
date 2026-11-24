/**
 * Every Hub door besides the WS RPCs and its rule (DoorRules.test.ts fails on one without). `rpc`:
 * decided by that RPC's own check (`authorizeSessionAsRpc`, `authorizeAsRpc`, or the service the
 * RPC calls). `own`: the rule it keeps instead, and why.
 */
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

export type DoorRule = { readonly rpc: string } | { readonly own: string };

const own = (rule: string): DoorRule => ({ own: rule });
const rpc = (method: string): DoorRule => ({ rpc: method });

const SIGN_IN = own("public: signs a person in or out; no Space data");
const ACCOUNT = own("the session's own User and sessions only");
const OAUTH = own("public OAuth metadata or flow; approval spends the approver's own session");
const ENVIRONMENTS = own(
  "EnvironmentRegistry with the session's principal: environment.view/use/manage in AccessPolicy",
);
const SPACES = own("SpaceDirectory/AccessPolicy for the session's User (Owner, Admin, Member)");
const INVITATIONS = own(
  "an Invitation token, or an Admin of its Organization; a Platform invitation (no Space, ticket 04) only the Owner (AccessPolicy `platformInvitation.manage`), revoking it also needs access:write, and every Organization read leaves it out",
);
/** Ticket 04: an Invitation that makes a User whatever the Registration mode says. */
const PLATFORM_INVITATIONS = own(
  "AccessPolicy `platformInvitation.manage` on the Installation (the Owner only; everyone else the same 403, before any scope is looked at), then access:read to list and access:write to create; the token is answered once at creation and only its hash is kept; a Platform invitation gives a User and never a Role or a membership; no WS or MCP door",
);
const OWNER = own("the Installation's Owner only, plus the access scopes");
/** Remote code execution on another host with the Hub's grant: never anyone but the Owner. */
const SSH_INSTALL = own(
  "SshInstall: start asks EnvironmentRegistry.authorizeDedicate on its Organization (the Owner or its Admins); confirm, status and cancel answer only the User who started the run (anyone else's is not found); no WS or MCP door",
);
/** Whoever holds the master key reads every secret from a copy of the disk. */
const MASTER_KEY = own(
  "AccessPolicy `masterKey.backup` on the Installation (the Owner only), plus the access scopes; the download also needs a strong factor in the request (UserDirectory.confirmStrongFactor) and is audited before the key leaves (MasterKeyBackup.export); a backup counts only once confirmed with the key's first characters; no WS or MCP door",
);
/** A loan that becomes active opens a machine to another Space: a strong factor, never WS. */
const GRANT_MAKES_ACTIVE = own(
  "Grants.prepareGive/prepareAccept/prepareClaim (AccessPolicy `grant.give`/`grant.decide`; a link's, also live and unthrottled) before the strong factor in the request (UserDirectory.confirmStrongFactor) when a machine's loan becomes active, then Grants.give/accept/claimOffer, which check it all again in their transaction and audit `grant.*`; access:write; no MCP door",
);
/** Who may sign in at all, and the Keycloak client's write-only secret. */
const SIGN_IN_SETTINGS = own(
  "AccessPolicy `signInSettings.manage` on the Installation (the Owner only; everyone else the same 403, before any scope is looked at), then access:read to read and access:write to change or «Check»; the client secret is write-only (never in an answer, log, span or audit entry); «Check» fetches only the saved issuer's discovery and key set (5 s, 128 KiB, no redirects, endpoints on the issuer's host); a change to the strong-factor lists (ticket 06) re-marks every live Keycloak sign-in in its transaction and ends (with their sessions and sockets) the Owner's and Admins' no longer strong, only once the request confirms it (else 409 with how many), audited with `loginsEnded`; turning local sign-in off for everyone but the Owner (ticket 08: only while Keycloak is on) ends in its transaction every session and unspent pairing link of anyone but the Owner born of no Keycloak sign-in and not of the Hub's shell (UserDirectory.endLocalSignIns, sockets after commit), turning Keycloak off ends every Keycloak sign-in and a new issuer the old realm's (UserDirectory.endKeycloakLogins, one `keycloak.login.end` each), each only once the request confirms it (else 409 saying how many, and how many Users still need Keycloak or a reset link); no WS or MCP door",
);
/** Keycloak sign-in spec, ticket 02: a flow to the realm and back. */
const KEYCLOAK_START = own(
  "public for `sign-in` and `invitation` (ticket 03: its token required, and only with it, checked by InvitationService.inspect before any flow: spends nothing, says no more than the preview, a dead link counts against it; kept only in the server-side flow, never in the authorization URL, a log, a span or an audit entry); `link` needs the browser's own session (never an app's token) and UserDirectory.confirmLinkStepUp (a fresh passkey or password proof; refused once linked); `step-up` (ticket 06) needs the browser's own session of a User with a Keycloak identity (else 401/403); `reset` (ticket 08) is public with a live reset link's token, and only with it, of a User other than the Owner (UserDirectory.inspectResetLink: spends nothing; a dead link counts against the client's back-off; only its hash is kept in the server-side flow, never the token). `acr_values` (the Owner's strong `acr` list) goes to the realm for `strongFactor` or a User whose Role needs it, and only shapes the request. Only an `Origin` that is the request's own (forwarded only by a trusted proxy) or a trusted one; a few starts a minute per client (an IPv4 address or an IPv6 /64), at most 5 pending flows per client (its 6th drops its own oldest), 10 000 on the Hub and then 503, never another client's flow dropped; `returnTo` only a path on this Hub, no dot segments",
);
const KEYCLOAK_CALLBACK = own(
  "the flow its `state` names (single-use, 10 minutes) from the browser that started it (the `__Host-` cookie over HTTPS, the bare name only on loopback HTTP), `iss` = the issuer (RFC 9207), the code exchanged with its PKCE verifier and `client_secret_basic`, the ID token verified (keys, `iss`, `aud`/`azp`, `exp`/`iat`, `nonce`); failures count toward the sign-in back-off; `sign-in` and `invitation`: KeycloakAdmission.decide over the Registration mode, the identity (issuer + subject, never an email), and the Invitation read again now; a new User (no sign-in name, its identity, login and session, and `user.register`) in one transaction, with an Organization Invitation inside InvitationService.redeemForNewUser (the conditional spend, the Role of the spent row, the membership and `invitation.accept`: a refusal leaves it unspent); an existing User joins through InvitationService.join with its refusals; whether the sign-in is strong is read from the verified token alone (`acr`/`amr` against the Owner's lists, exactly), and the Owner, an Admin, or who an Admin Invitation makes one is refused without it (ticket 06; the Owner's local sign-in is untouched); `link`: the very session that started it, never another User's identity, and a strong sign-in for the Owner or an Admin; `reset` (ticket 08): the link spent by its hash in the transaction that binds the identity (a newer link or a second callback finds nothing), never another User's identity, a strong sign-in for an Admin, then the old identity and its sign-ins, the User's passkeys, password, TOTP, sessions and pairing links end and a session born of this sign-in starts, audited `resetLink.redeem` and `user.identity.link` (a refusal leaves the link unspent); `step-up`: the very session that started it, the same issuer and subject as its User's identity, an `auth_time` after the flow started (30 s skew), and it signs nobody in: a single-use proof (5 minutes, that session and User only, spent by UserDirectory.requireStepUp/confirmStrongFactor, which needs it strong) in the redirect's fragment, never its query",
);
/** Ticket 07: «also sign out of Keycloak», after the browser signed out. */
const KEYCLOAK_SIGN_OUT = own(
  "public: only the single-use handle the browser's own sign-out answered (random, kept hashed, 10 minutes, at most 10 000 and then none is handed out, never logged), from an `Origin` the Hub takes as its own; ends that Keycloak sign-in with the sessions, apps, MCP clients and pairing links born of it (UserDirectory.endKeycloakLogins, audited `keycloak.login.end`) and answers the realm's end-session address with `client_id` and `post_logout_redirect_uri` on the Hub's own origin, never an `id_token_hint` (ticket 11: no door hands out an ID token, and the Hub keeps none)",
);
/** Ticket 07: the realm's back-channel logout. */
const KEYCLOAK_BACKCHANNEL = own(
  "public, for the realm: a urlencoded body of at most 16 KiB with exactly one `logout_token` (8 KiB), verified like an ID token (the realm's keys and algorithms, `iss`, `aud`/`azp`, `exp` when present) plus `iat` at most 2 minutes old (60 s skew), a `jti`, the back-channel logout event and no `nonce`, then a `jti` never seen (10 000 remembered for 4 minutes, only after the signature passes; full refuses, never forgets one); ends the live sign-ins of its `sid` (and `sub`), or without `sid` all of its `sub`, with all born of them (UserDirectory.endKeycloakLogins, audited); 200 or 400, never echoing the token; untraced",
);
const WEBHOOK = own("the task's secret token in the path; runs as the task's creator");
const THREAD_READ = own(
  "SpaceVisibility.visibleThreadIds like getThreadProjection: hidden answers thread_not_found",
);
const GUEST = own("a guest link's own token, for its one Thread; never a session");

export const HTTP_ENDPOINT_RULES: Readonly<Record<string, DoorRule>> = {
  "appSignIn.approve": ACCOUNT,
  "appSignIn.token": SIGN_IN,
  "audit.list": own("requireEnvironmentScope(access:read): the Owner's audit log"),
  "auth.account": ACCOUNT,
  "auth.browserSession": SIGN_IN,
  "auth.confirmTotpEnrollment": ACCOUNT,
  "auth.ownerBootstrap": own("public only until an Owner exists"),
  "auth.ownerBootstrapStatus": own("public only until an Owner exists"),
  "auth.ownerRegistration": own("public only until an Owner exists"),
  "auth.pairingCredential": own("a link for the session's own User, with no more than it holds"),
  "auth.passkeyChallenge": SIGN_IN,
  "auth.passkeySignIn": SIGN_IN,
  "auth.passwordSignIn": SIGN_IN,
  "auth.recoveryCodeSignIn": SIGN_IN,
  "auth.redeemResetLink": SIGN_IN,
  "auth.redeemResetLinkWithPassword": SIGN_IN,
  "auth.removePassword": ACCOUNT,
  "auth.removeTotp": ACCOUNT,
  "auth.resetLinkRegistration": SIGN_IN,
  "auth.resetLinkStatus": SIGN_IN,
  "auth.revokeClient": ACCOUNT,
  "auth.revokeOtherClients": ACCOUNT,
  "auth.revokePairingLink": ACCOUNT,
  "auth.session": ACCOUNT,
  "auth.setPassword": ACCOUNT,
  "auth.signOut": ACCOUNT,
  "auth.startTotpEnrollment": ACCOUNT,
  "auth.token": SIGN_IN,
  "auth.totpSignIn": SIGN_IN,
  "auth.webSocketTicket": own("a ticket for the session's own socket, with its own scopes"),
  "auth.webSocketTicketFor": own("a ticket for the session's own media routes, its own scopes"),
  "environments.approveJoin": own(
    "EnvironmentRegistry.authorizeRegister for the browser session's User, then a strong factor in the request (UserDirectory.confirmStrongFactor: a passkey, a password with a code, or a strong Keycloak `step-up` proof issued to this very session, ticket 06); only the approver confirms it",
  ),
  "environments.changeMode": ENVIRONMENTS,
  "environments.confirmJoin": own("the joining machine's own request code"),
  "environments.denyJoin": ENVIRONMENTS,
  "environments.joinRequest": own("public: a machine asks to join; nothing is granted"),
  "environments.joinStatus": own("the joining machine's own request code"),
  "environments.grantJoin": own(
    "a one-use grant the Hub issued to its own SSH install run (SshInstall): only while that run registers, for that run's Space and name; HTTPS or loopback only",
  ),
  "environments.leave": own("the Environment credential of the machine that leaves"),
  "environments.list": ENVIRONMENTS,
  "environments.overview": OWNER,
  "environments.remove": ENVIRONMENTS,
  "environments.rename": ENVIRONMENTS,
  "environments.sandboxAction": ENVIRONMENTS,
  "environments.sandboxLimits": ENVIRONMENTS,
  "environments.sandboxes": ENVIRONMENTS,
  "environments.self": own("the Environment credential of the machine that asks"),
  "environments.selfReport": own(
    "the Environment credential of the machine that asks (never a Sandbox's): its own report, and new credentials only for Sandboxes of active Grants of that machine",
  ),
  "environments.start": ENVIRONMENTS,
  "environments.sshInstallCancel": SSH_INSTALL,
  "environments.sshInstallConfirm": SSH_INSTALL,
  "environments.sshInstallStart": SSH_INSTALL,
  "environments.sshInstallStatus": SSH_INSTALL,
  "environments.startJoin": ENVIRONMENTS,
  "keycloakSignIn.signOut": KEYCLOAK_SIGN_OUT,
  "keycloakSignIn.start": KEYCLOAK_START,
  "installationUsers.list": OWNER,
  "installationUsers.setStatus": own(
    "the Installation's Owner only, plus the access scopes; disabling or removing a User ends, in the same transaction, their sessions, pairing links and live Keycloak sign-ins with their sealed refresh tokens (Keycloak ticket 11, audited `keycloak.login.end`)",
  ),
  "signInSettings.check": SIGN_IN_SETTINGS,
  "signInSettings.get": SIGN_IN_SETTINGS,
  "signInSettings.update": SIGN_IN_SETTINGS,
  "platformInvitations.create": PLATFORM_INVITATIONS,
  "platformInvitations.list": PLATFORM_INVITATIONS,
  "invitations.accept": INVITATIONS,
  "invitations.create": INVITATIONS,
  "invitations.join": own(
    "an Invitation token for the session's own User; an Admin Role needs a passkey, TOTP or Keycloak identity, and for a Keycloak User a session born of a live strong Keycloak sign-in (ticket 06), and ends their weak Keycloak access (sign-ins, app and MCP sessions, pairing links)",
  ),
  "invitations.list": INVITATIONS,
  "invitations.preview": INVITATIONS,
  "invitations.registration": INVITATIONS,
  "invitations.revoke": INVITATIONS,
  "invitations.totpEnrollment": INVITATIONS,
  "mcpOAuth.approval": OAUTH,
  "mcpOAuth.authorizationServer": OAUTH,
  "mcpOAuth.authorize": OAUTH,
  "mcpOAuth.decision": OAUTH,
  "mcpOAuth.mcpProtectedResource": OAUTH,
  "mcpOAuth.protectedResource": OAUTH,
  "mcpOAuth.register": OAUTH,
  "mcpOAuth.token": OAUTH,
  "metadata.descriptor": own("public: the environment's descriptor, no Space data"),
  "orchestration.shellSnapshot": own("SpaceVisibility.spaceFilter, like subscribeShell"),
  "orchestration.threadBoundedSnapshot": THREAD_READ,
  "orchestration.threadHistoryPage": THREAD_READ,
  "orchestration.threadSnapshot": THREAD_READ,
  "orchestration.threadTranscript": THREAD_READ,
  "projects.move": rpc(WS_METHODS.projectsMutate),
  "projects.movePlan": rpc(WS_METHODS.projectsMutate),
  "projects.mutate": rpc(WS_METHODS.projectsMutate),
  "projects.snapshot": own("ProjectService.snapshotFor(visibility): only visible Projects"),
  "pullRequests.diff": rpc(WS_METHODS.pullRequestsDiffFileContents),
  "sandboxImage.build": OWNER,
  "sandboxImage.status": OWNER,
  "sandboxImage.update": OWNER,
  "spaces.archiveOrganization": SPACES,
  "spaces.changeMemberRole": own(
    "SpaceDirectory/AccessPolicy for the session's User; making a Keycloak User an Admin ends their weak Keycloak access (sign-ins, app and MCP sessions, pairing links) in the same transaction (ticket 06)",
  ),
  "spaces.createOrganization": own(
    "AccessPolicy `organization.create` for the session's User; its creator becomes its Admin, so a Keycloak User creates one only from a session born of a live strong Keycloak sign-in, and their weak Keycloak access ends in the same transaction (ticket 06)",
  ),
  "spaces.deleteOrganization": SPACES,
  "spaces.issueMemberResetLink": SPACES,
  "spaces.leave": SPACES,
  "spaces.list": SPACES,
  "spaces.members": SPACES,
  "spaces.removeMember": SPACES,
  "spaces.restoreOrganization": SPACES,
  "vaults.masterKeyBackup": MASTER_KEY,
  "vaults.masterKeyBackupConfirm": MASTER_KEY,
  "vaults.masterKeyStatus": MASTER_KEY,
  "grants.give": GRANT_MAKES_ACTIVE,
  "grants.accept": GRANT_MAKES_ACTIVE,
  "grants.claimOffer": GRANT_MAKES_ACTIVE,
  "webhooks.webhookGet": WEBHOOK,
  "webhooks.webhookPatch": WEBHOOK,
  "webhooks.webhookPost": WEBHOOK,
  "webhooks.webhookPut": WEBHOOK,
};

/** Spec 4 ticket 04: a gateway key in a header only, never a cookie or another credential. */
const AI_GATEWAY = own(
  "AiGatewayKeys.authorize on every request (key live, User active, Thread in the key's Space and owned by its User; a User key whose User left its Space: 403; an access key: live, not expired (403 with its date), its Space open (403), its Space's own AI accounts only), then AllowedAiAccounts now; planRoute pins the model to an allowed account; only fixed CLIProxyAPI paths",
);

export const RAW_ROUTE_RULES: Readonly<Record<string, DoorRule>> = {
  "ai/AiGatewayRoute.ts: * `${AI_GATEWAY_ROUTE_PREFIX}/*`": AI_GATEWAY,
  "device/DeviceHubProxy.ts: * `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`": own(
    "DeviceAccess.mayUseDevice, as deviceOpen: the device the path or `device` names, open in a Thread the User sees (works, to drive it); only known parameters pass",
  ),
  'environments/JoinedHub.ts: GET "/health"': own("public liveness of a joined machine"),
  "environments/connectRoute.ts: GET ENVIRONMENT_CONNECT_PATH": own(
    "the Environment credential; what it may run is the executor's per-machine rules",
  ),
  "environments/gitRoute.ts: GET path": own(
    "the Environment credential; refs of Threads it runs; reads (never writes) the Hub's copy of its Project's checkout, refs/t3/project/; protocol v0 only",
  ),
  "environments/gitRoute.ts: POST path": own(
    "the Environment credential; refs of Threads it runs; reads (never writes) the Hub's copy of its Project's checkout, refs/t3/project/; protocol v0 only",
  ),
  "guest/http.ts: GET GUEST_ATTACHMENT_ROUTE": GUEST,
  "guest/http.ts: GET GUEST_COMMAND_OUTPUT_ROUTE": GUEST,
  "guest/http.ts: GET GUEST_HISTORY_ROUTE": GUEST,
  "guest/http.ts: GET GUEST_ITEM_ROUTE": GUEST,
  "guest/http.ts: GET GUEST_MEDIA_ROUTE": GUEST,
  "guest/http.ts: GET GUEST_RENDER_ROUTE": GUEST,
  "guest/http.ts: GET `${GUEST_ROUTE_PREFIX}/session`": GUEST,
  "guest/http.ts: GET `${GUEST_ROUTE_PREFIX}/stream`": GUEST,
  "guest/http.ts: POST `${GUEST_ROUTE_PREFIX}/messages`": GUEST,
  "guest/http.ts: POST `${GUEST_ROUTE_PREFIX}/redeem`": GUEST,
  'http.ts: GET "*"': own("public: the web app's static files"),
  // Vaults ticket 07: public on purpose (verifiers fetch them unsigned in): public keys only.
  "http.ts: GET IDENTITY_DISCOVERY_PATH": own(
    "public: the issuer's discovery document; the static handler's answer while identity is unused",
  ),
  "http.ts: GET IDENTITY_JWKS_PATH": own(
    "public: the issuer's public keys, by an allow-list of members; the static handler's answer while identity is unused",
  ),
  "http.ts: GET `${ASSET_ROUTE_PREFIX}/*`": rpc(WS_METHODS.assetsCreateUrl),
  "http.ts: POST OTLP_TRACES_PROXY_PATH": own(
    "diagnostics:read, which only the Owner's sessions hold (heldByUser), as getTraceDiagnostics",
  ),
  "http.ts: POST `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`": rpc(WS_METHODS.attachmentsCreateUploadUrl),
  'mcp/McpHttpServer.ts: * "/mcp"': own("an MCP credential; each tool by MCP_TOOL_RULES"),
  // The server browser's tabs, whatever the door, use one profile decided once per tab in the
  // Thread's Space (PreviewProfiles.ownerFor): its opener's, an agent's tab the Thread owner's.
  "preview/ServerBrowserStream.ts: GET `${PREVIEW_STREAM_ROUTE_PREFIX}/*`": rpc(
    WS_METHODS.previewOpen,
  ),
  "preview/ServerBrowserStream.ts: POST `${PREVIEW_STREAM_ROUTE_PREFIX}/upload`": rpc(
    WS_METHODS.previewOpen,
  ),
  "preview/hubPreviewRoute.ts: * `${HUB_PREVIEW_ROUTE_PREFIX}/*`": rpc(WS_METHODS.previewProxyUrl),
  "preview/hubPreviewRoute.ts: middleware": rpc(WS_METHODS.previewProxyUrl),
  "auth/clientAdmission.ts: middleware": own(
    "every request: public clients wait for an Owner; answers nothing else itself",
  ),
  "auth/keycloakSignInHttp.ts: GET KEYCLOAK_CALLBACK_PATH": KEYCLOAK_CALLBACK,
  "auth/keycloakSignInHttp.ts: POST KEYCLOAK_BACKCHANNEL_LOGOUT_PATH": KEYCLOAK_BACKCHANNEL,
  "http.ts: middleware": own("compression; answers nothing itself"),
  "server.ts: middleware": own("waits for startup; answers nothing itself"),
  'ws.ts: GET "/ws"': own("a session; every RPC by RPC_SPACE_ACCESS"),
};

const OWN_THREAD = own(
  "the calling agent's own Thread (requireThreadScope / scope.thread), which it works",
);
const VISIBLE_THREAD = own("visibleShells: a Thread the caller cannot see is missing");
const PREVIEW = own(
  "the calling agent's own Thread's tabs (requireThreadMcpCapability(preview)), as previewOpen; their browser profile is the Thread owner's in its Space (PreviewProfiles.ownerFor), a person's tab the opener's",
);
const DEVICE = own(
  "the calling agent's own Thread's devices (requireThreadMcpCapability(device)), as deviceOpen",
);
const PULL_REQUEST_LINK = own(
  "visibleShells on the Thread, then the orchestrator's Role rules on its command",
);
const TASK = rpc(WS_METHODS.scheduledTasksUpsert);

export const MCP_TOOL_RULES: Readonly<Record<string, DoorRule>> = {
  create_threads: OWN_THREAD,
  delegate_task: OWN_THREAD,
  delete_scheduled_task: rpc(WS_METHODS.scheduledTasksDelete),
  device_close: DEVICE,
  device_list: DEVICE,
  device_open: DEVICE,
  device_screenshot: DEVICE,
  html_preview: own("images only from folders SpaceVisibility.mayReadDirectory allows the caller"),
  html_render: own("the agent's own Thread; images as html_preview"),
  link_pull_request: PULL_REQUEST_LINK,
  link_pull_requests: PULL_REQUEST_LINK,
  list_scheduled_tasks: own("visibleScheduledTasks, as scheduledTasksSubscribe"),
  list_thread_pull_requests: VISIBLE_THREAD,
  orchestrator_capabilities: own("the caller's own limits and the Hub's providers; no Space data"),
  preview_act: PREVIEW,
  preview_dialog: PREVIEW,
  preview_evaluate: PREVIEW,
  preview_navigate: PREVIEW,
  preview_open: PREVIEW,
  preview_recording_start: PREVIEW,
  preview_recording_stop: PREVIEW,
  preview_resize: PREVIEW,
  preview_set_appearance: PREVIEW,
  preview_snapshot: PREVIEW,
  preview_status: PREVIEW,
  preview_wait_for: PREVIEW,
  read_pull_request_guide: rpc(WS_METHODS.pullRequestsReviewGuide),
  list_secret_names: OWN_THREAD,
  request_secret: OWN_THREAD,
  run_scheduled_task_now: rpc(WS_METHODS.scheduledTasksRunNow),
  schedule_task: TASK,
  t3_attachment_discard: rpc(WS_METHODS.attachmentsDelete),
  t3_attachment_prepare_upload: rpc(WS_METHODS.attachmentsCreateUploadUrl),
  t3_background_wait: OWN_THREAD,
  t3_environment_preferences_update: rpc(WS_METHODS.serverUpdateSettings),
  t3_environment_read: own("the redacted settings every client reads (serverGetConfig)"),
  t3_theme_propose: own(
    "the calling agent's own Thread (actsAsCaller); writes nothing: each viewer applies the colors in their own browser",
  ),
  t3_theme_read: own("built-in theme names and the colors-only guide; no Space data"),
  t3_pending_request: VISIBLE_THREAD,
  t3_preview_close: PREVIEW,
  t3_preview_list: PREVIEW,
  t3_project_clone: rpc(WS_METHODS.projectCloneStart),
  t3_project_create: rpc(WS_METHODS.projectsMutate),
  t3_project_delete: own("seesProjectId, then ProjectService's Role rules, as projectsMutate"),
  t3_project_list: own("ProjectService.listPage(visibility)"),
  t3_project_read: own("SpaceVisibility.seesProject"),
  t3_project_update: rpc(WS_METHODS.projectsMutate),
  t3_queue: VISIBLE_THREAD,
  t3_thread_configure: VISIBLE_THREAD,
  t3_thread_interrupt: VISIBLE_THREAD,
  t3_thread_launch: own("seesProjectId, then the launch's Space claim, as launchThread"),
  t3_thread_list: VISIBLE_THREAD,
  t3_thread_organize: VISIBLE_THREAD,
  t3_thread_read: VISIBLE_THREAD,
  t3_thread_search: own("SpaceVisibility.spaceFilter, as searchThreads"),
  t3_thread_send: VISIBLE_THREAD,
  t3_thread_send_attachments: VISIBLE_THREAD,
  t3_thread_transfer: VISIBLE_THREAD,
  t3_thread_update: own("the orchestrator's Role rules on thread.metadata.update"),
  t3_thread_wait: VISIBLE_THREAD,
  t3_workflow_stop: rpc(ORCHESTRATION_V2_WS_METHODS.stopWorkflow),
  t3_worktree_handoff: OWN_THREAD,
  t3_worktree_list: VISIBLE_THREAD,
  t3_worktree_status: OWN_THREAD,
  task_cancel: OWN_THREAD,
  task_status: OWN_THREAD,
  thread_history: OWN_THREAD,
  unlink_pull_request: PULL_REQUEST_LINK,
  unlink_pull_requests: PULL_REQUEST_LINK,
  unwatch_pull_request: PULL_REQUEST_LINK,
  watch_pull_request: PULL_REQUEST_LINK,
  write_pull_request_guides: rpc(WS_METHODS.pullRequestsGenerateReviewGuide),
};

/**
 * How each door keeps a page on a preview's own origin (ticket 15) from the Hub's ambient cookies:
 * `refused` doors drop a cookie for a request `crossesFromPreviewOrigin`; `none` doors take no
 * ambient cookie. DoorRules.test.ts lists every raw route and the HTTP API here.
 */
export type AmbientCookieRule = { readonly refused: string } | { readonly none: string };

const refused = (how: string): AmbientCookieRule => ({ refused: how });
const none = (why: string): AmbientCookieRule => ({ none: why });

const BY_ENVIRONMENT_AUTH = refused(
  "EnvironmentAuth.authenticateRequest: a cookie counts only past isBrowserOriginAllowed",
);
const GUEST_COOKIE = refused(
  "guestSessionCookie (readHubCookie): `__Host-`, none from a preview page, no planted bare one",
);
const ENVIRONMENT_CREDENTIAL = none("the Environment credential in Authorization; no cookie");

export const AMBIENT_COOKIE_RULES: Readonly<Record<string, AmbientCookieRule>> = {
  "ai/AiGatewayRoute.ts: * `${AI_GATEWAY_ROUTE_PREFIX}/*`": refused(
    "reads no cookie at all: a gateway key in a header (gatewayKeyOf), never a session",
  ),
  HttpApi: refused(
    "EnvironmentAuth reads a session cookie past isBrowserOriginAllowed; auth/http.ts sets or clears one only off a preview origin",
  ),
  "auth/clientAdmission.ts: middleware": none("reads no credential"),
  "auth/keycloakSignInHttp.ts: POST KEYCLOAK_BACKCHANNEL_LOGOUT_PATH": none(
    "reads no cookie at all: the realm's signed logout token in the body",
  ),
  "auth/keycloakSignInHttp.ts: GET KEYCLOAK_CALLBACK_PATH": refused(
    "the flow cookie through readHubCookie with `hostOnly` (`__Host-` only over HTTPS, bare only on loopback HTTP; none from a preview page); the session cookie through EnvironmentAuth, and no session issued for a request from a preview origin",
  ),
  "device/DeviceHubProxy.ts: * `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`": BY_ENVIRONMENT_AUTH,
  'environments/JoinedHub.ts: GET "/health"': none("public, on a joined machine"),
  "environments/connectRoute.ts: GET ENVIRONMENT_CONNECT_PATH": ENVIRONMENT_CREDENTIAL,
  "environments/gitRoute.ts: GET path": ENVIRONMENT_CREDENTIAL,
  "environments/gitRoute.ts: POST path": ENVIRONMENT_CREDENTIAL,
  "guest/http.ts: GET GUEST_ATTACHMENT_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET GUEST_COMMAND_OUTPUT_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET GUEST_HISTORY_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET GUEST_ITEM_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET GUEST_MEDIA_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET GUEST_RENDER_ROUTE": GUEST_COOKIE,
  "guest/http.ts: GET `${GUEST_ROUTE_PREFIX}/session`": GUEST_COOKIE,
  "guest/http.ts: GET `${GUEST_ROUTE_PREFIX}/stream`": GUEST_COOKIE,
  "guest/http.ts: POST `${GUEST_ROUTE_PREFIX}/messages`": GUEST_COOKIE,
  "guest/http.ts: POST `${GUEST_ROUTE_PREFIX}/redeem`": refused(
    "spends a guest link's token; sets no guest cookie for a preview origin",
  ),
  'http.ts: GET "*"': none(
    "public static files; HTML is not framed by a preview (frame-ancestors)",
  ),
  "http.ts: GET IDENTITY_DISCOVERY_PATH": refused(
    "reads no cookie and no session: public on purpose, the same for every caller",
  ),
  "http.ts: GET IDENTITY_JWKS_PATH": refused(
    "reads no cookie and no session: public on purpose, the same for every caller",
  ),
  "http.ts: GET `${ASSET_ROUTE_PREFIX}/*`": none("a signed asset URL; no cookie"),
  "http.ts: POST OTLP_TRACES_PROXY_PATH": BY_ENVIRONMENT_AUTH,
  "http.ts: POST `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`": none("a signed upload token; no cookie"),
  "http.ts: middleware": none("compression; reads no credential"),
  'mcp/McpHttpServer.ts: * "/mcp"': none("a bearer MCP credential; no cookie"),
  "preview/ServerBrowserStream.ts: GET `${PREVIEW_STREAM_ROUTE_PREFIX}/*`": BY_ENVIRONMENT_AUTH,
  "preview/ServerBrowserStream.ts: POST `${PREVIEW_STREAM_ROUTE_PREFIX}/upload`":
    BY_ENVIRONMENT_AUTH,
  "preview/hubPreviewRoute.ts: * `${HUB_PREVIEW_ROUTE_PREFIX}/*`": refused(
    "the Hub session through selectRequestCredential (readHubCookie), never from a preview page",
  ),
  "preview/hubPreviewRoute.ts: middleware": none(
    "a preview's own host: only that preview's host-only cookie, never a Hub cookie",
  ),
  "server.ts: middleware": none("waits for startup; reads no credential"),
  'ws.ts: GET "/ws"': BY_ENVIRONMENT_AUTH,
};

/**
 * Keycloak ticket 11: every door that creates, links or keeps an identity, and what it does with
 * one. DoorRules.test.ts fails on an identity group's door missing here; KeycloakDoors.test.ts
 * calls each and looks for the client secret, codes and tokens in what it answers.
 */
const LOCAL_SIGN_IN =
  "a local credential (ticket 08): refused, after it is checked, to anyone but the Owner while local sign-in is off; never answers a Keycloak token";
const LOCAL_RESET =
  "a reset link's local way back (ticket 08): refused to anyone but the Owner while local sign-in is off; Keycloak's way back is keycloakSignIn.start `reset`";
const LOCAL_CREDENTIAL =
  "the session's own User's local credential: refused to a User with a Keycloak identity but the Owner (UserDirectory.refuseLocalCredentialsForIdentity)";
const MCP_METADATA = "public OAuth metadata or client registration: no identity, no session";

export const IDENTITY_DOORS: Readonly<Record<string, string>> = {
  "appSignIn.approve":
    "the browser's own session approves an app; the app's session inherits its Keycloak sign-in and ends with it (ticket 09)",
  "appSignIn.token":
    "spends the app's code for its session, which carries the approving session's Keycloak sign-in",
  "auth.account":
    "the session's own User and linked identity (username, email, the realm's account page), never a subject or token",
  "auth.browserSession":
    "a pairing credential becomes a browser session of its User; one made from a Keycloak session carries its sign-in",
  "auth.confirmTotpEnrollment": LOCAL_CREDENTIAL,
  "auth.ownerBootstrap": "makes the Owner with a passkey, only until an Owner exists; no Keycloak",
  "auth.ownerBootstrapStatus": "whether an Owner exists; no identity",
  "auth.ownerRegistration": "the Owner's passkey ceremony, only until an Owner exists",
  "auth.pairingCredential":
    "a pairing link for the session's own User; one made from a Keycloak session carries its sign-in and ends with it (ticket 07)",
  "auth.passkeyChallenge": LOCAL_SIGN_IN,
  "auth.passkeySignIn": LOCAL_SIGN_IN,
  "auth.passwordSignIn": LOCAL_SIGN_IN,
  "auth.recoveryCodeSignIn":
    "the Owner's break-glass, whatever Keycloak's state (only the Owner has recovery codes)",
  "auth.redeemResetLink": LOCAL_RESET,
  "auth.redeemResetLinkWithPassword": LOCAL_RESET,
  "auth.removePassword": "the session's own User's password",
  "auth.removeTotp": "the session's own User's TOTP",
  "auth.resetLinkRegistration": LOCAL_RESET,
  "auth.resetLinkStatus": "what a live reset link offers (Keycloak, local), spending nothing",
  "auth.revokeClient": "ends one of the session's own User's sessions",
  "auth.revokeOtherClients": "ends the session's own User's other sessions",
  "auth.revokePairingLink": "ends one of the session's own User's pairing links",
  "auth.session":
    "the session's own User, and what the sign-in page offers (`keycloak`, `localForMembers`)",
  "auth.setPassword": LOCAL_CREDENTIAL,
  "auth.signOut":
    "ends the Hub session only; for one born of a Keycloak sign-in, answers a single-use handle for keycloakSignIn.signOut, never a token",
  "auth.startTotpEnrollment": LOCAL_CREDENTIAL,
  "auth.token":
    "a pairing credential becomes a bearer session of its User; one made from a Keycloak session carries its sign-in",
  "auth.totpSignIn": LOCAL_SIGN_IN,
  "auth.webSocketTicket":
    "a 5-minute ticket for the session's own socket, checked against the session's row at use: a sign-in that ends closes the socket",
  "auth.webSocketTicketFor":
    "a 5-minute ticket for the session's own media routes, checked as auth.webSocketTicket",
  "environments.approveJoin":
    "a machine joins on a strong factor in the request, a Keycloak `step-up` proof for this very session among them (ticket 06)",
  "installationUsers.list": "the Owner's list of Users; no subject or token",
  "installationUsers.setStatus":
    "disabling or removing a User ends their sessions, pairing links and Keycloak sign-ins in one transaction (ticket 11)",
  "invitations.accept":
    "a new User from an Invitation with new local credentials: refused while local sign-in is off (ticket 08); through Keycloak it is keycloakSignIn.start `invitation`",
  "invitations.create":
    "an Admin's Organization Invitation: someone else's way in, single-use, 7 days",
  "invitations.join":
    "an Invitation for the session's own User; an Admin Role needs a session of a live strong Keycloak sign-in (ticket 06)",
  "invitations.list": "an Organization's Invitations, never a token",
  "invitations.preview":
    "what an Invitation token is (`kind: platform` for a Platform invitation), spending nothing",
  "invitations.registration":
    "the passkey ceremony of a new local User from an Invitation (ticket 08: refused while local sign-in is off)",
  "invitations.revoke": "ends an Invitation (a Platform invitation the Owner's only)",
  "invitations.totpEnrollment":
    "a new local User's TOTP from an Invitation (ticket 08: refused while local sign-in is off)",
  "keycloakSignIn.signOut":
    "spends the sign-out handle and ends that Keycloak sign-in with all born of it; the realm's address carries no token (ticket 11)",
  "keycloakSignIn.start":
    "a flow to the realm (sign-in, invitation, link, reset, step-up): its secrets stay server-side, the browser gets only the authorization address and the flow cookie",
  "mcpOAuth.approval": "the approver's own browser session reads what an MCP client asks for",
  "mcpOAuth.authorizationServer": MCP_METADATA,
  "mcpOAuth.authorize":
    "sends the browser to the approval page with the client's request; no session issued",
  "mcpOAuth.decision":
    "the approver's own browser session approves an MCP client; its session inherits the Keycloak sign-in and ends with it (ticket 09)",
  "mcpOAuth.mcpProtectedResource": MCP_METADATA,
  "mcpOAuth.protectedResource": MCP_METADATA,
  "mcpOAuth.register": MCP_METADATA,
  "mcpOAuth.token":
    "spends the MCP client's code for its session, which carries the approving session's Keycloak sign-in",
  "platformInvitations.create":
    "the Owner's Platform invitation: a User, never a Role; its token answered once",
  "platformInvitations.list": "the Owner's Platform invitations, never a token",
  "signInSettings.check":
    "fetches the saved realm's discovery and keys; answers what is wrong, never the secret",
  "signInSettings.get": "the Owner's settings: `clientSecretSet`, never the client secret",
  "signInSettings.update":
    "the Owner's settings; the client secret write-only into the encrypted store; ends sign-ins and sessions a change no longer allows",
  "spaces.changeMemberRole":
    "making a Keycloak User an Admin ends their weak Keycloak access (ticket 06)",
  "spaces.createOrganization":
    "its creator becomes its Admin: a Keycloak User only from a strong sign-in, their weak access ends (ticket 06)",
  "spaces.issueMemberResetLink":
    "a reset link for another User; with Keycloak on it binds a Keycloak identity in place of the old one (ticket 08)",
  "auth/keycloakSignInHttp.ts: GET KEYCLOAK_CALLBACK_PATH":
    "the flow's end: admission, link, reset or step-up proof; answers only a redirect and the session cookie",
  "auth/keycloakSignInHttp.ts: POST KEYCLOAK_BACKCHANNEL_LOGOUT_PATH":
    "the realm's logout token ends the sign-ins it names with all born of them; answers 200 or 400, never the token",
  'ws.ts: GET "/ws"':
    "a session's socket: closes when its session ends, a Keycloak sign-in's ending among the causes",
};

/**
 * Ticket 11: every credential a person's session can lead to, and whether it ends with the Keycloak
 * sign-in it was born of. `where` names what DoorRules.test.ts finds in the sources (a table's
 * credential column, or a module that signs or holds credentials); a new one fails until listed.
 */
export type LoginCredentialRule = { readonly where: ReadonlyArray<string> } & (
  | { readonly endsWithLogin: string }
  | { readonly outlivesLogin: string }
  | { readonly notFromSession: string }
);

export const KEYCLOAK_SESSION_CREDENTIALS: Readonly<Record<string, LoginCredentialRule>> = {
  "the Keycloak sign-in itself": {
    where: ["identity_logins.refresh_token_sealed", "identity_logins.id_token_sealed"],
    endsWithLogin:
      "its sealed refresh token is dropped as it ends; no ID token is kept at all (ticket 11, migration 158)",
  },
  "browser, app and MCP client sessions": {
    where: [
      "auth_sessions.identity_login_id",
      "auth/SessionStore.ts",
      "auth/AppSignIn.ts",
      "auth/McpOAuth.ts",
    ],
    endsWithLogin:
      "the callback's session carries the sign-in; an app's or MCP client's code and session copy the approving session's (AppSignIn.approve, McpOAuth.decision); UserDirectory.endKeycloakLogins revokes them all and closes their sockets",
  },
  "pairing links and the sessions they open": {
    where: ["auth_pairing_links.identity_login_id"],
    endsWithLogin:
      "a link made from a Keycloak session carries its sign-in; unspent, it is revoked with it; spent, its session carries it",
  },
  "WebSocket and media tickets": {
    where: ["auth/SessionStore.ts"],
    endsWithLogin:
      "5 minutes, and checked against the session's row at use: none outlives its session",
  },
  "the step-up proof": {
    where: ["auth/KeycloakStepUpProofs.ts"],
    endsWithLogin:
      "single-use, 5 minutes, spent only by the very session that started it, so it dies with that session",
  },
  "the «also sign out of Keycloak» handle": {
    where: ["auth/KeycloakLogins.ts"],
    endsWithLogin: "single-use, 10 minutes, and its one use ends the sign-in",
  },
  "a pending Keycloak flow": {
    where: ["auth/KeycloakSignIn.ts"],
    notFromSession:
      "before any sign-in: its state, nonce and PKCE verifier stay server-side, single-use, 10 minutes",
  },
  "Environment credentials": {
    where: ["environments.credential_hash", "environments/EnvironmentJoin.ts"],
    outlivesLogin:
      "a machine's, for its Space: approving a join takes a fresh strong factor of the approver, and the machine then belongs to the Space (an Admin removes it), as with a local approver",
  },
  "Invitations, Platform invitations and reset links": {
    where: ["space_invitations.token_hash", "user_reset_links.token_hash"],
    outlivesLogin:
      "someone else's way in, single-use, 7 days at most, revocable; a disabled or removed User's reset links expire with them",
  },
  "Grant offer links": {
    where: ["grants.offer_token_hash"],
    outlivesLogin:
      "an offer for another Space's Admins, revocable; claiming takes their own session, and a machine's also their strong factor",
  },
  "guest links": {
    where: ["guest/GuestShareService.ts"],
    outlivesLogin:
      "a Thread's link for a guest, revocable; it stops when its creator is disabled or removed",
  },
  "asset and upload URLs": {
    where: [
      "assets/AssetSigner.ts",
      "assets/AssetAccess.ts",
      "assets/AttachmentUpload.ts",
      "mcp/toolkits/attachment/handlers.ts",
    ],
    outlivesLogin:
      "signed and short: one file the User may read for an hour, one upload for 10 minutes (an agent's too)",
  },
  "preview address passes": {
    where: [],
    outlivesLogin:
      "the cookie of the User's own preview address, for its idle life; the address refuses anyone else",
  },
  "scheduled task webhook secrets": {
    where: ["scheduled_tasks.webhook_secret"],
    outlivesLogin:
      "a task's, run as its creator: a Keycloak ending does not disable the User (spec «Bajas»); the Owner does, which pauses their tasks",
  },
  "AI gateway CLI keys": {
    where: ["ai_gateway_keys.key_hash"],
    outlivesLogin:
      "the User's own key, revocable, gone when the User is disabled or removed: a Keycloak ending does not disable the User (spec «Bajas»); binding keys to the sign-in is a follow-up",
  },
  "AI gateway access keys": {
    where: ["ai_access_keys.key_hash"],
    outlivesLogin:
      "a Space's key, not a session's or a User's (access-keys spec): it lives until it expires (at most 366 days) or whoever manages the Space, or the Owner, revokes it; its issuer leaving or signing out changes nothing",
  },
  "the master key backup": {
    where: [],
    outlivesLogin: "data, not a way in: it leaves once, audited, after a strong factor",
  },
  "Sandbox and dedicated machine credentials": {
    where: [
      "dedicated_sandbox_credentials.credential_hash",
      "dedicated_sandbox_credentials.previous_credential_hash",
    ],
    notFromSession:
      "the Hub's own, for the Sandboxes it runs, and one per active loan of a lent machine (Grants): for its borrowing Space only, reading only the repositories of the Threads it runs, dead once the loan ended and its turns' time to stop passed",
  },
  "local passwords, TOTP secrets and recovery codes": {
    where: [
      "user_passwords.password_hash",
      "user_totp.secret_ciphertext",
      "user_recovery_codes.code_hash",
    ],
    notFromSession:
      "a local User's own; refused to a Keycloak User but the Owner, and deleted when a User links (the Owner keeps theirs)",
  },
};

/**
 * Spec 4 ticket 03. Signing in to a subscription (or importing a Vertex account): WS RPCs only, in
 * INSTALLATION_RPC_METHODS. No raw route or HTTP endpoint takes a provider's callback: the Owner
 * pastes the address the browser landed on, checked against the sign-in and never fetched.
 */
export const AI_ACCOUNT_SIGN_IN_RULES: Readonly<Record<string, DoorRule>> = {
  // Owned-resources 08: for an account its caller may manage (their own, or an Organization they
  // run); one open sign-in on the Hub at a time, never replaced by another User's.
  [WS_METHODS.aiAccountsLoginStart]: own(
    "AccessPolicy `aiAccount.manage` on the new account's owner (the caller's own, or an Organization they run) or on the account signed in again",
  ),
  [WS_METHODS.aiAccountsLoginComplete]: own(
    "the User who started that sign-in, from the same session, within 10 minutes, with its state; the pasted address must be its redirect",
  ),
  [WS_METHODS.aiAccountsImportVertex]: own(
    "AccessPolicy `aiAccount.manage` on the new account's owner (the caller's own, or an Organization they run)",
  ),
  // Ticket 15: CLIProxyAPI auth files, sealed as a sign-in; no gateway call.
  [WS_METHODS.aiAccountsImportCliproxy]: OWNER,
};
