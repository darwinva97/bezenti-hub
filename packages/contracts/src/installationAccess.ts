import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

/**
 * Scopes over the Installation as a whole: its settings and keybindings, its providers, its
 * processes, logs and usage. Only the Owner's sessions keep them; a Member's session is read
 * without them, whatever it was issued with.
 */
export const AuthInstallationScopes = [
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
] as const satisfies ReadonlyArray<AuthEnvironmentScope>;

const installationScopes = new Set<AuthEnvironmentScope>(AuthInstallationScopes);

/** `scopes` without the Installation's own: what a session of a User who is not the Owner holds. */
export const withoutInstallationScopes = <S extends AuthEnvironmentScope>(
  scopes: ReadonlyArray<S>,
): ReadonlyArray<S> => scopes.filter((scope) => !installationScopes.has(scope));

/**
 * RPCs on the Installation as a whole, which only its Owner calls (the server refuses everyone
 * else, `installation` in RpcSpaceAccess): settings, keybindings, providers and their sign-ins,
 * processes, logs, traces, usage, storage, device hosts and the Hub's source-control sign-in.
 */
export const INSTALLATION_RPC_METHODS = [
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverRemoveKeybinding,
  WS_METHODS.serverRunStorageCleanup,
  WS_METHODS.serverGetStorageCleanupReport,
  WS_METHODS.serverGetDatabaseStorage,
  WS_METHODS.serverGetTraceDiagnostics,
  WS_METHODS.serverGetProcessDiagnostics,
  WS_METHODS.serverSignalProcess,
  WS_METHODS.serverGetProcessResourceHistory,
  WS_METHODS.serverGetResourceTelemetryHistory,
  WS_METHODS.serverRetryResourceTelemetry,
  WS_METHODS.subscribeResourceTelemetry,
  WS_METHODS.serverCheckOtlpEndpoint,
  WS_METHODS.serverPrepareTriage,
  WS_METHODS.serverGetUsageSummary,
  WS_METHODS.serverRefreshUsageRates,
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.providerConsumeResetCredit,
  WS_METHODS.providerAuthStart,
  WS_METHODS.providerAuthComplete,
  WS_METHODS.providerAuthRespond,
  WS_METHODS.providerAuthCancel,
  WS_METHODS.providerAuthLogout,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.chatGptReconnectProfile,
  WS_METHODS.chatGptImportProfile,
  WS_METHODS.chatGptHandoffSubscribe,
  // Every User's preview browser profiles; each User clears only their own (`previewClearProfile`).
  WS_METHODS.previewClearAllProfiles,
  WS_METHODS.providerInstallStart,
  WS_METHODS.providerInstallCancel,
  WS_METHODS.providerInstallSubscribe,
  WS_METHODS.providerInstallRemove,
  WS_METHODS.serverSearchAcpRegistry,
  WS_METHODS.serverPrepareAcpRegistryAgent,
  WS_METHODS.serverUninstallAcpRegistryManagedBinary,
  WS_METHODS.serverAcceptAcpRegistryUrlAuth,
  WS_METHODS.serverLogoutAcpRegistry,
  // An ACP agent's model provider, secrets included, on the Installation's provider instance;
  // the Project only says where the agent runs.
  WS_METHODS.serverSetAcpRegistryProvider,
  WS_METHODS.serverDisableAcpRegistryProvider,
  WS_METHODS.deviceConfigure,
  WS_METHODS.deviceTestHost,
  WS_METHODS.deviceEasAccount,
  WS_METHODS.deviceSimlockIdentity,
  WS_METHODS.deviceShutdown,
  WS_METHODS.deviceAction,
  // Signing in replaces the Hub's own credential; starring acts as its account.
  WS_METHODS.sourceControlSignInStart,
  WS_METHODS.sourceControlSignInWait,
  WS_METHODS.sourceControlSignInCancel,
  WS_METHODS.sourceControlStar,
  // The Hub's AI gateway: what it runs, and which release.
  WS_METHODS.aiGatewayStatus,
  WS_METHODS.aiGatewayCheckForUpdates,
  WS_METHODS.aiGatewayUpdate,
  WS_METHODS.aiGatewayRollback,
  WS_METHODS.aiGatewaySetEnabled,
  // The Installation's AI accounts: only the Owner registers, changes, allows and orders them
  // (`aiAccounts.list` is everyone's, filtered by AllowedAiAccounts).
  WS_METHODS.aiAccountsCreate,
  WS_METHODS.aiAccountsUpdate,
  WS_METHODS.aiAccountsDelete,
  WS_METHODS.aiAccountsAllow,
  WS_METHODS.aiAccountsReorder,
  // Subscription AI accounts (spec 4 ticket 03): signing in and importing are the Owner's alone;
  // the Hub has no callback route (the Owner pastes the address the browser landed on).
  WS_METHODS.aiAccountsLoginStart,
  WS_METHODS.aiAccountsLoginComplete,
  WS_METHODS.aiAccountsImportVertex,
  WS_METHODS.aiAccountsImportCliproxy,
  // Secret providers' scopes, «Test connection» and what deleting one breaks (Vaults ticket 03):
  // the Owner's, as the providers themselves (`server.updateSettings`).
  WS_METHODS.secretProvidersTest,
  WS_METHODS.secretProvidersImpact,
  WS_METHODS.secretProvidersScopesList,
  WS_METHODS.secretProvidersScopesPut,
  WS_METHODS.secretProvidersScopesDelete,
  WS_METHODS.secretProvidersScopesAllow,
] as const;
export type InstallationRpcMethod = (typeof INSTALLATION_RPC_METHODS)[number];

const installationRpcMethods = new Set<string>(INSTALLATION_RPC_METHODS);

export const isInstallationRpcMethod = (method: string): method is InstallationRpcMethod =>
  installationRpcMethods.has(method);

export const INSTALLATION_OWNER_ONLY_MESSAGE = "Only the Owner of this Hub can do that.";

/**
 * Whether the session may act on the Installation as a whole: its User is the Owner, or it has
 * no User (no Owner exists yet, or an environment without accounts).
 */
export const sessionActsForInstallation = (
  session: Pick<AuthSessionState, "authenticated" | "userId" | "isOwner">,
): boolean => session.authenticated && (session.userId === undefined || session.isOwner === true);
