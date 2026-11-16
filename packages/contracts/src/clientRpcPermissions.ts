import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // An address that reaches a port on the Thread's machine, as opening a preview there does.
  [WS_METHODS.previewProxyUrl]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  // Which CLIProxyAPI release the Hub runs, as saving the Hub's settings changes what it runs.
  [WS_METHODS.aiGatewayUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.aiGatewayRollback]: AuthSettingsWriteScope,
  [WS_METHODS.aiGatewaySetEnabled]: AuthSettingsWriteScope,
  // The Owner's AI accounts, as saving the Hub's settings changes what agents may use.
  [WS_METHODS.aiAccountsCreate]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsDelete]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsAllow]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsReorder]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsLoginStart]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsLoginComplete]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsImportVertex]: AuthSettingsWriteScope,
  [WS_METHODS.aiAccountsImportCliproxy]: AuthSettingsWriteScope,
  // A User's local CLI keys (spec 4 ticket 10): a credential to the Hub, as a pairing link is.
  [WS_METHODS.aiGatewayKeysCreate]: AuthAccessWriteScope,
  // Switching a Thread's AI account changes the Thread, as any command on it does.
  [WS_METHODS.threadSetAiAccount]: AuthOrchestrationOperateScope,
  [WS_METHODS.aiGatewayKeysRevoke]: AuthAccessWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  // Vaults: who may is the Hub's (AccessPolicy `vault.*`); the session must hold access:write.
  [WS_METHODS.vaultsCreate]: AuthAccessWriteScope,
  [WS_METHODS.vaultsUpdate]: AuthAccessWriteScope,
  [WS_METHODS.vaultsDelete]: AuthAccessWriteScope,
  [WS_METHODS.vaultsEntriesPut]: AuthAccessWriteScope,
  [WS_METHODS.vaultsEntriesDelete]: AuthAccessWriteScope,
  [WS_METHODS.vaultsEntriesLink]: AuthAccessWriteScope,
  [WS_METHODS.vaultsEntriesCopy]: AuthAccessWriteScope,
  [WS_METHODS.vaultsAllow]: AuthAccessWriteScope,
  // Vaults ticket 03: Secret providers' scopes and «Test connection» are settings, the Owner's.
  [WS_METHODS.secretProvidersTest]: AuthSettingsWriteScope,
  [WS_METHODS.secretProvidersScopesPut]: AuthSettingsWriteScope,
  [WS_METHODS.secretProvidersScopesDelete]: AuthSettingsWriteScope,
  [WS_METHODS.secretProvidersScopesAllow]: AuthSettingsWriteScope,
  [WS_METHODS.vaultsSpaceDefaultsSet]: AuthAccessWriteScope,
  [WS_METHODS.vaultsProjectChoicesSet]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
