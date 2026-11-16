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
const INVITATIONS = own("an Invitation token, or an Admin of its Organization");
const OWNER = own("the Installation's Owner only, plus the access scopes");
/** Remote code execution on another host with the Hub's grant: never anyone but the Owner. */
const SSH_INSTALL = own(
  "SshInstall: EnvironmentRegistry.authorizeDedicate (the Owner only) on every call, the progress included; no WS or MCP door",
);
/** Whoever holds the master key reads every secret from a copy of the disk. */
const MASTER_KEY = own(
  "AccessPolicy `masterKey.backup` on the Installation (the Owner only), plus the access scopes; the download also needs a strong factor in the request (UserDirectory.confirmStrongFactor) and is audited before the key leaves (MasterKeyBackup.export); a backup counts only once confirmed with the key's first characters; no WS or MCP door",
);
/** The one door that reads a Vault's value; the WS RPCs return names only. */
const VAULT_REVEAL = own(
  "Vaults.authorizeReveal (AccessPolicy `vault.reveal`: the Owner only), checked before the strong factor in the request (UserDirectory.confirmStrongFactor), then Vaults.reveal, audited `secret.reveal` before the value leaves; no WS, MCP or CLI door",
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
  "environments.approveJoin": ENVIRONMENTS,
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
  "environments.start": ENVIRONMENTS,
  "environments.sshInstallCancel": SSH_INSTALL,
  "environments.sshInstallConfirm": SSH_INSTALL,
  "environments.sshInstallStart": SSH_INSTALL,
  "environments.sshInstallStatus": SSH_INSTALL,
  "environments.startJoin": ENVIRONMENTS,
  "installationUsers.list": OWNER,
  "installationUsers.setPermission": OWNER,
  "installationUsers.setStatus": OWNER,
  "invitations.accept": INVITATIONS,
  "invitations.create": INVITATIONS,
  "invitations.join": INVITATIONS,
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
  "spaces.changeMemberRole": SPACES,
  "spaces.createOrganization": SPACES,
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
  "vaults.reveal": VAULT_REVEAL,
  "webhooks.webhookGet": WEBHOOK,
  "webhooks.webhookPatch": WEBHOOK,
  "webhooks.webhookPost": WEBHOOK,
  "webhooks.webhookPut": WEBHOOK,
};

/** Spec 4 ticket 04: a gateway key in a header only, never a cookie or another credential. */
const AI_GATEWAY = own(
  "AiGatewayKeys.authorize on every request (key live, User active, Thread in the key's Space and owned by its User; a User key whose User left its Space: 403), then AllowedAiAccounts now; planRoute pins the model to an allowed account; only fixed CLIProxyAPI paths",
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
 * Spec 4 ticket 03. Signing in to a subscription (or importing a Vertex account): WS RPCs only, in
 * INSTALLATION_RPC_METHODS. No raw route or HTTP endpoint takes a provider's callback: the Owner
 * pastes the address the browser landed on, checked against the sign-in and never fetched.
 */
export const AI_ACCOUNT_SIGN_IN_RULES: Readonly<Record<string, DoorRule>> = {
  [WS_METHODS.aiAccountsLoginStart]: OWNER,
  [WS_METHODS.aiAccountsLoginComplete]: own(
    "the Owner, from the session that started that sign-in, within 10 minutes, with its state; the pasted address must be its redirect",
  ),
  [WS_METHODS.aiAccountsImportVertex]: OWNER,
  // Ticket 15: CLIProxyAPI auth files, sealed as a sign-in; no gateway call.
  [WS_METHODS.aiAccountsImportCliproxy]: OWNER,
};
