/**
 * How each RPC that reaches Projects or Threads keeps to what the session may see. Every
 * `orchestration.*` RPC and every RPC whose payload names a Thread or Project must be listed
 * (RpcAuthorization.test.ts checks). A refusal looks exactly like a missing one. RPCs on the
 * Installation as a whole are its Owner's: scopes alone do not keep a Member or an Admin out.
 */
import {
  INSTALLATION_OWNER_ONLY_MESSAGE,
  INSTALLATION_RPC_METHODS,
  type InstallationRpcMethod,
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectId,
  SpaceActionDeniedError,
  SOURCE_CONTROL_MEDIA_ASSET,
  SpaceResourceNotFoundError,
  type ThreadId,
  type UserId,
  WS_METHODS,
  type WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import { climbsOrHome, leavesFolder } from "../spaces/directoryRoots.ts";
import { localWorkspaceTargets } from "../workspace/localWorkspaceTargets.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * `thread`/`project`: hidden ids refused. `command`: what it acts on. `named`: Projects at any
 * depth. `work`/`owned`: the User's own Thread (or held draft). `filtered`: the handler filters.
 * `readDirectory`/`workDirectory`: a Hub folder (`cwd`) the User may read or work in.
 * `installation`: the Owner's alone. `unscoped`: why not (one session's own). Missing: refused.
 */
export type RpcSpaceAccess =
  | "thread"
  | "project"
  | "command"
  | "named"
  | "work"
  | "owned"
  | "filtered"
  // A named Thread is not hidden (reads) or is the User's work (writes); else filesystem scopes.
  | "readIfThread"
  | "workIfThread"
  | "readDirectory"
  | "workDirectory"
  // A Project the User works in (not a Guest's): changes made with the Hub's credentials.
  | "workProject"
  | "installation"
  | { readonly unscoped: string };

const TASK_BY_ID = {
  unscoped: "ScheduledTaskService checks the task's rights (requireTaskRights)",
};
const SERVER_CONFIG = {
  unscoped: "what every client runs on: providers, models, keybindings and redacted settings",
};
const SOURCE_CONTROL_ACCOUNT = {
  unscoped: "the Hub's source-control tools and account, which cloning and publishing read",
};
const PREVIEW_PROFILES = {
  unscoped:
    "the caller's own preview browser profiles: ServerBrowser keys them by User (PreviewProfiles)",
};
/** Vaults name no Thread or Project: each Vault is its Organization's or the Owner's. */
const VAULTS = {
  unscoped:
    "Vaults: AccessPolicy `vault.*` for the session's User through SpaceDirectory.authorizeResource (spaceLimit too); a hidden Vault answers like a missing one; no value is returned",
};
/** AI accounts name no Thread or Project: the list is AllowedAiAccounts' for the session. */
const AI_ACCOUNTS_LIST = {
  unscoped:
    "AI accounts: AiAccounts.list answers with what AllowedAiAccounts lets the session's User use in the Spaces SpaceDirectory.authorizer lets them act in (spaceLimit too); only the Owner, unlimited, sees every account and its details; no credential is returned",
};
/** The picker names a Space: AllowedAiAccounts answers nothing where the User does not work. */
const AI_ACCOUNTS_PICKER = {
  unscoped:
    "AI-account picker: AiAccountChoice.picker answers AllowedAiAccounts for the session's User in the named Space (AccessPolicy `aiAccount.use`), nothing in a Space they do not work in or outside spaceLimit; names and model names only, no credential",
};
/** AI usage names a Thread only to narrow its answer: AiUsage.summary decides what is seen. */
const AI_USAGE_SUMMARY = {
  unscoped:
    "AI usage: AiUsage.summary answers the Owner (not limited to one Space) everything, an Organization's Admin (AccessPolicy `aiUsage.viewSpace`) their Spaces' plus their own, anyone else only their own rows, within spaceLimit; a filter (Space, User, account, Thread) only narrows that; counts only, never a prompt or a key",
};
/** Local CLI keys name no Thread or Project: each is its User's, the Owner's to see and revoke. */
const AI_GATEWAY_KEYS = {
  unscoped:
    "Local CLI keys: AiGatewayKeys answers the session's own person only (never an agent, the Hub's shell or a one-Space session); a User lists and revokes their own keys, the Owner everyone's (another's answers like a missing one); a key is made only for a Space the User works in (AccessPolicy `aiAccount.use`); only `create` returns the key, once",
};
const INSTALLATION_ACCESS = Object.fromEntries(
  INSTALLATION_RPC_METHODS.map((method) => [method, "installation"]),
) as Readonly<Record<InstallationRpcMethod, "installation">>;

export const RPC_SPACE_ACCESS = {
  // A hidden target answers like a missing one; the Role rules run on every command in the
  // orchestrator, whatever its transport.
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: "command",
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: "command",
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: "filtered",
  // The family is also read through SpaceVisibility, so a fork elsewhere stays hidden.
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: "thread",
  [WS_METHODS.guestShareCreate]: "thread",
  [WS_METHODS.secretsAnswerRequest]: "thread",
  [WS_METHODS.secretsVaultTargets]: "thread",
  [WS_METHODS.vaultsList]: VAULTS,
  [WS_METHODS.vaultsCreate]: VAULTS,
  [WS_METHODS.vaultsUpdate]: VAULTS,
  [WS_METHODS.vaultsDelete]: VAULTS,
  [WS_METHODS.vaultsEntriesList]: VAULTS,
  [WS_METHODS.vaultsEntriesPut]: VAULTS,
  [WS_METHODS.vaultsEntriesDelete]: VAULTS,
  [WS_METHODS.vaultsEntriesLink]: VAULTS,
  [WS_METHODS.vaultsEntriesCopy]: VAULTS,
  [WS_METHODS.aiAccountsList]: AI_ACCOUNTS_LIST,
  [WS_METHODS.aiAccountsPicker]: AI_ACCOUNTS_PICKER,
  // Spec 4 ticket 08: a hidden Thread answers like a missing one; the switch is a command on the
  // Thread (`thread.continue` in the orchestrator) whose account AiAccountChoice decides.
  [WS_METHODS.threadSetAiAccount]: "thread",
  [WS_METHODS.aiUsageSummary]: AI_USAGE_SUMMARY,
  [WS_METHODS.aiGatewayKeysList]: AI_GATEWAY_KEYS,
  [WS_METHODS.aiGatewayKeysCreate]: AI_GATEWAY_KEYS,
  [WS_METHODS.aiGatewayKeysRevoke]: AI_GATEWAY_KEYS,
  // Spec 5 ticket 03. Allowances and a Space's defaults: AccessPolicy `vault.manage` and
  // `vault.choose` in Vaults. A Project's choices and a Thread's names: the named Project or
  // Thread must be visible first, then the same rules (EffectiveVaults for the Thread).
  [WS_METHODS.vaultsAllow]: VAULTS,
  [WS_METHODS.vaultsSpaceDefaultsSet]: VAULTS,
  [WS_METHODS.vaultsChoices]: "project",
  [WS_METHODS.vaultsProjectChoicesSet]: "project",
  [WS_METHODS.vaultsThreadEnvironment]: "thread",
  // Vaults ticket 03: the scopes a Vault's editors may use, decided by Vaults (`vault.edit`).
  [WS_METHODS.vaultsProviderScopes]: VAULTS,
  [WS_METHODS.projectsCreateFromThread]: "thread",
  // An app acts inside its Thread's live session, so it is its creator's, like a message.
  [WS_METHODS.mcpAppsCallTool]: "owned",
  [WS_METHODS.mcpAppsToolInfo]: "thread",
  [WS_METHODS.mcpAppsReadResource]: "thread",
  [WS_METHODS.mcpAppsUpdateModelContext]: "owned",
  [WS_METHODS.providerUploadFeedback]: "thread",
  // Drafts use these before their Thread exists, so they also take a draft its User holds.
  [WS_METHODS.assetsPersistChatAttachments]: "work",
  [WS_METHODS.subscribeWorktreeSetup]: "work",
  [WS_METHODS.worktreeSetupCancel]: "work",
  [WS_METHODS.terminalOpen]: "work",
  [WS_METHODS.terminalAttach]: "work",
  [WS_METHODS.terminalObserve]: "work",
  [WS_METHODS.terminalWrite]: "work",
  [WS_METHODS.terminalResize]: "work",
  [WS_METHODS.terminalClear]: "work",
  [WS_METHODS.terminalClose]: "work",
  [WS_METHODS.previewOpen]: "work",
  [WS_METHODS.previewResize]: "work",
  [WS_METHODS.previewAdjust]: "work",
  [WS_METHODS.previewClose]: "work",
  [WS_METHODS.previewList]: "work",
  [WS_METHODS.previewReportStatus]: "work",
  // The address it gives is checked again, by the same rule, on every request it serves.
  [WS_METHODS.previewProxyUrl]: "work",
  [WS_METHODS.deviceOpen]: "work",
  // Without a Thread these work on a directory, which filesystem scopes guard; with one they run
  // on that Thread's Active environment, inside its workspace (ThreadWorkspace).
  [WS_METHODS.projectsSearchEntries]: "readIfThread",
  [WS_METHODS.projectsSearchContents]: "readIfThread",
  [WS_METHODS.projectsListEntries]: "readIfThread",
  [WS_METHODS.projectsListIgnoredFiles]: "readIfThread",
  [WS_METHODS.projectsReadFile]: "readIfThread",
  [WS_METHODS.filesystemBrowse]: "readIfThread",
  [WS_METHODS.projectsWriteFile]: "workIfThread",
  [WS_METHODS.deviceClose]: "work",
  [WS_METHODS.gitRunStackedAction]: "workDirectory",
  [WS_METHODS.gitPreparePullRequestThread]: "workDirectory",
  [WS_METHODS.projectsMutate]: "command",
  [WS_METHODS.scheduledTasksUpsert]: {
    unscoped: "ScheduledTaskService checks it as its creator: hidden like missing, then the Role",
  },
  // Creates the Project it clones into, in a folder the handler keeps to where the User may
  // work (`cloneDestinationAllowed`).
  [WS_METHODS.projectCloneStart]: "filtered",
  // A clone is its starter's (and the Owner's) to cancel or retry; others are answered no-op.
  [WS_METHODS.projectCloneCancel]: "filtered",
  [WS_METHODS.projectCloneRetry]: "filtered",
  [WS_METHODS.agentSessionsImport]: "project",
  [WS_METHODS.serverListAcpRegistrySessions]: "project",
  [WS_METHODS.serverImportAcpRegistrySession]: "project",
  [WS_METHODS.serverDeleteAcpRegistrySession]: "project",
  [WS_METHODS.serverListAcpRegistryProviders]: "project",
  // Without a Project these name, the handler narrows them to the visible ones.
  [WS_METHODS.pullRequestsList]: "project",
  [WS_METHODS.pullRequestsListStats]: "project",
  [WS_METHODS.pullRequestsInvalidate]: "project",
  [WS_METHODS.pullRequestsReportState]: "project",
  [WS_METHODS.assetsCreateUrl]: "named",
  [WS_METHODS.serverReportClientActivity]: {
    unscoped: "reports this client's own activity and returns nothing",
  },
  [WS_METHODS.pullRequestsFilterOptions]: "project",
  [WS_METHODS.pullRequestsSummary]: "project",
  [WS_METHODS.pullRequestsRouting]: "project",
  [WS_METHODS.pullRequestsStack]: "project",
  // Also filtered: a Pull Request can link Threads in several Spaces.
  [WS_METHODS.pullRequestsLinkedThreads]: "project",
  [WS_METHODS.pullRequestsDetail]: "project",
  [WS_METHODS.pullRequestsPreview]: "project",
  [WS_METHODS.pullRequestsChecks]: "project",
  [WS_METHODS.pullRequestsActivity]: "project",
  [WS_METHODS.pullRequestsReviewGuide]: "project",
  [WS_METHODS.pullRequestsGenerateReviewGuide]: "workProject",
  [WS_METHODS.pullRequestsThreadComments]: "project",
  [WS_METHODS.pullRequestsDiffFileContents]: "project",
  [WS_METHODS.pullRequestsFilesViewed]: "project",
  [WS_METHODS.pullRequestsChangeBreakdown]: "project",
  [WS_METHODS.pullRequestsSetFilesViewed]: "project",
  [WS_METHODS.pullRequestsRunAction]: "workProject",
  [WS_METHODS.pullRequestsUpdate]: "workProject",
  [WS_METHODS.pullRequestsComment]: "workProject",
  [WS_METHODS.pullRequestsUpdateComment]: "workProject",
  [WS_METHODS.pullRequestsSubmitReview]: "workProject",
  [WS_METHODS.pullRequestsReplyToThread]: "workProject",
  [WS_METHODS.pullRequestsSetThreadResolution]: "workProject",
  [WS_METHODS.pullRequestsSetReaction]: "workProject",
  [WS_METHODS.pullRequestsReviewerCandidates]: "project",
  [WS_METHODS.pullRequestsRequestReviewers]: "workProject",
  [WS_METHODS.pullRequestsLabelCandidates]: "project",
  [WS_METHODS.pullRequestsSetLabels]: "workProject",
  // Git and other work on a folder with no Thread to place it: on the Hub's own disk.
  [WS_METHODS.subscribeVcsStatus]: "readDirectory",
  [WS_METHODS.vcsPull]: "workDirectory",
  [WS_METHODS.vcsRefreshStatus]: "readDirectory",
  [WS_METHODS.gitResolvePullRequest]: "readDirectory",
  [WS_METHODS.vcsListRefs]: "readDirectory",
  [WS_METHODS.vcsCreateWorktree]: "workDirectory",
  [WS_METHODS.vcsRemoveWorktree]: "workDirectory",
  [WS_METHODS.vcsCreateRef]: "workDirectory",
  [WS_METHODS.vcsSwitchRef]: "workDirectory",
  [WS_METHODS.vcsInit]: "workDirectory",
  [WS_METHODS.reviewGetBranchCommits]: "readDirectory",
  [WS_METHODS.reviewGetDiffPreview]: "readDirectory",
  [WS_METHODS.reviewGetDiffFileContents]: "readDirectory",
  [WS_METHODS.shellOpenInEditor]: "workDirectory",
  // Each path the User may not read answers null (file chips of agent messages keep the rest).
  [WS_METHODS.filesystemGetMetadata]: "filtered",
  [WS_METHODS.sourceControlLookupRepository]: "readDirectory",
  [WS_METHODS.sourceControlPublishRepository]: "workDirectory",
  [WS_METHODS.serverRefreshProviders]: "readDirectory",
  // Into a folder the handler keeps to where the User may work, as projectCloneStart.
  [WS_METHODS.sourceControlCloneRepository]: "filtered",
  // The User's own clones and those of Projects they see; the URLs carry no credentials.
  [WS_METHODS.subscribeProjectClones]: "filtered",
  [WS_METHODS.projectsEnsureScratch]: { unscoped: "the session User's own scratch Project" },
  [WS_METHODS.projectsCreateNew]: {
    unscoped: "creates a Project in the Hub's Projects folder, as project.create does",
  },
  // Only candidates whose folder the User may read and whose Project they see.
  [WS_METHODS.agentSessionsScan]: "filtered",
  [WS_METHODS.attachmentsCreateUploadUrl]: { unscoped: "the session User's own uploads" },
  // Only the User who uploaded the pending attachment deletes it.
  [WS_METHODS.attachmentsDelete]: "filtered",
  [WS_METHODS.subscribeTerminalMetadata]: "filtered",
  [WS_METHODS.scheduledTasksSubscribe]: { unscoped: "ScheduledTaskService lists visible tasks" },
  [WS_METHODS.scheduledTasksSetEnabled]: TASK_BY_ID,
  [WS_METHODS.scheduledTasksDelete]: TASK_BY_ID,
  [WS_METHODS.scheduledTasksRunNow]: TASK_BY_ID,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: TASK_BY_ID,
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: TASK_BY_ID,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: TASK_BY_ID,
  [WS_METHODS.pullRequestsRoutingIdentity]: { unscoped: "a host's identity, no Project" },
  [WS_METHODS.pullRequestsSubscribeRefreshes]: { unscoped: "refresh signals, no Project data" },
  [WS_METHODS.sourceControlAppAccess]: SOURCE_CONTROL_ACCOUNT,
  [WS_METHODS.sourceControlStarred]: SOURCE_CONTROL_ACCOUNT,
  [WS_METHODS.serverDiscoverSourceControl]: SOURCE_CONTROL_ACCOUNT,
  [WS_METHODS.previewClearProfile]: PREVIEW_PROFILES,
  [WS_METHODS.previewReportProfiles]: PREVIEW_PROFILES,
  // The handler drops events of Threads the User may not work.
  [WS_METHODS.subscribePreviewEvents]: "filtered",
  // Of the Hub's listening servers, only the Owner sees (and stops) everyone's.
  [WS_METHODS.subscribeDiscoveredLocalServers]: "filtered",
  [WS_METHODS.previewStopLocalServer]: "filtered",
  // Sessions of Threads the User sees only (`DeviceAccess`); retrying a host or updating device
  // tools is the Owner's (`ownerOnlyCall`).
  [WS_METHODS.deviceList]: "filtered",
  [WS_METHODS.deviceDetail]: "filtered",
  [WS_METHODS.subscribeDeviceState]: "filtered",
  [WS_METHODS.serverProbe]: { unscoped: "answers whether this connection is alive" },
  [WS_METHODS.serverGetConfig]: SERVER_CONFIG,
  [WS_METHODS.subscribeServerConfig]: SERVER_CONFIG,
  [WS_METHODS.subscribeServerLifecycle]: {
    unscoped: "this connection's welcome and the server's own restarts",
  },
  [WS_METHODS.serverGetHostResources]: {
    unscoped: "the Hub's CPU and memory load, which placing a Thread reads; no paths or ids",
  },
  // Each User sees their own sessions and links; the Owner sees everyone's.
  [WS_METHODS.subscribeAuthAccess]: "filtered",
  ...INSTALLATION_ACCESS,
} as const satisfies Partial<Readonly<Record<WsRpcMethod, RpcSpaceAccess>>>;

export const spaceAccessForRpcMethod = (method: string): RpcSpaceAccess | undefined =>
  Object.hasOwn(RPC_SPACE_ACCESS, method)
    ? RPC_SPACE_ACCESS[method as keyof typeof RPC_SPACE_ACCESS]
    : undefined;

const notFound = () =>
  new SpaceResourceNotFoundError({ message: "That Project or Thread does not exist." });
const notYours = () =>
  new SpaceActionDeniedError({
    message: "Only the person who started this Thread can use its terminals, previews and files.",
  });
const ownerOnly = () => new SpaceActionDeniedError({ message: INSTALLATION_OWNER_ONLY_MESSAGE });

/** A call of an otherwise shared RPC that changes the Hub itself: retrying a device host or
 * updating device tools, unlike listing devices. */
const ownerOnlyCall = (method: string, payload: unknown) =>
  method === WS_METHODS.deviceList &&
  (stringField(payload, "retryHostId") !== undefined ||
    stringField(payload, "updateTool") !== undefined);

const THREAD_KEYS = new Set(["threadId", "threadIds", "conversationThreadId"]);
// A terminal runs in a folder the client names; it must be one the User may work in.
const DIRECTORY_FIELDS: Partial<Record<string, ReadonlyArray<string>>> = {
  [WS_METHODS.terminalOpen]: ["cwd", "worktreePath"],
  [WS_METHODS.terminalAttach]: ["cwd", "worktreePath"],
};
const PROJECT_KEYS = new Set(["projectId", "projectIds"]);
// Other paths a folder RPC opens, besides its `cwd`.
const DIRECTORY_TARGET_FIELDS: Partial<Record<string, ReadonlyArray<string>>> = {
  // Its RPC sends a null `path` (the managed folder); checked should a client ever name one.
  [WS_METHODS.vcsCreateWorktree]: ["path"],
  [WS_METHODS.vcsRemoveWorktree]: ["path"],
};

/**
 * The Hub folders an asset URL would serve from with no Thread to place it: a host file, a
 * draft's folder, a Project's favicon folder, the repository whose credential fetches host media.
 */
const assetReadTargets = (payload: unknown): ReadonlyArray<string> | "refused" => {
  const resource = Predicate.isObject(payload)
    ? (payload as { readonly resource?: unknown }).resource
    : undefined;
  const tag = stringField(resource, "_tag");
  const path = stringField(resource, "path");
  const cwd = stringField(resource, "cwd");
  if (tag === "media-file" && path !== undefined) {
    // A plain relative path is the Thread's own file, which the Thread's rule covers; one that
    // climbs out or names a home is refused, never left unchecked.
    if (!leavesFolder(path)) return [];
    // An absolute host file is checked as one; anything else that leaves is refused.
    if (climbsOrHome(path)) return "refused";
    return localWorkspaceTargets(WS_METHODS.assetsCreateUrl, { path }, ["path"]);
  }
  if (tag === "draft-workspace-file") {
    return localWorkspaceTargets(WS_METHODS.assetsCreateUrl, { cwd, relativePath: path });
  }
  if (tag === "project-favicon" || tag === SOURCE_CONTROL_MEDIA_ASSET) {
    return localWorkspaceTargets(WS_METHODS.assetsCreateUrl, { cwd });
  }
  return [];
};

/** Every string under one of `keys`, at any depth of the payload. */
const idsUnder = (value: unknown, keys: ReadonlySet<string>, into: Array<string> = []) => {
  if (Array.isArray(value)) {
    for (const item of value) idsUnder(item, keys, into);
  } else if (Predicate.isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key)) {
        for (const id of Array.isArray(child) ? child : [child]) {
          if (typeof id === "string") into.push(id);
        }
      } else {
        idsUnder(child, keys, into);
      }
    }
  }
  return into;
};

const stringField = (payload: unknown, name: string): string | undefined => {
  const value = Predicate.isObject(payload)
    ? (payload as Record<string, unknown>)[name]
    : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * What a command acts on, which must be visible, and what it creates, which must only not
 * belong to a Space the session cannot see.
 */
const commandTargets = (method: string, payload: unknown) => {
  const type = stringField(payload, "type");
  const created = new Set<string>();
  if (method === WS_METHODS.projectsMutate) {
    const projectId = stringField(payload, "projectId");
    return {
      threads: [],
      projects: type === "project.create" || projectId === undefined ? [] : [projectId],
      created: [],
    };
  }
  // A launch's client-chosen id that names a hidden Thread is handled by ThreadLaunchService,
  // which answers it like an unused id.
  if (method === ORCHESTRATION_V2_WS_METHODS.launchThread) {
    const projectId = stringField(payload, "projectId");
    return { threads: [], projects: projectId === undefined ? [] : [projectId], created: [] };
  }
  const createdField =
    type === "thread.create"
      ? "threadId"
      : type === "thread.fork" || type === "thread.created.record"
        ? "targetThreadId"
        : undefined;
  const threads: Array<string> = [];
  for (const field of [
    "threadId",
    "sourceThreadId",
    "targetThreadId",
    "parentThreadId",
    "senderThreadId",
  ]) {
    const id = stringField(payload, field);
    if (id === undefined) continue;
    if (field === createdField) created.add(id);
    else threads.push(id);
  }
  const projectId = stringField(payload, "projectId");
  return { threads, projects: projectId === undefined ? [] : [projectId], created: [...created] };
};

/**
 * Refuses the call when the payload names a Project or Thread the viewer may not see. A
 * missing one is refused the same way, so neither answer is an existence oracle.
 */
export const guardRpcPayload = Effect.fn("RpcSpaceAccess.guardRpcPayload")(function* (
  method: string,
  payload: unknown,
  visibility: SpaceVisibility.Visibility,
  spaceVisibility: SpaceVisibility.SpaceVisibility["Service"],
  userId: UserId | undefined,
) {
  /** No Thread named, or one with no row: a draft, or nothing at all. */
  const isDraftOrNone = Effect.fn(function* (threadId: string | undefined) {
    if (threadId === undefined) return true;
    const ids = [threadId as ThreadId];
    const [visible, hidden] = yield* Effect.all([
      spaceVisibility.visibleThreadIds(visibility, ids),
      spaceVisibility.hiddenThreadIds(visibility, ids),
    ]);
    return !visible.has(threadId as ThreadId) && !hidden.has(threadId);
  });
  // Spec 5 ticket 05: a copy read answers the file unmasked, so it keeps to what a save does.
  const access =
    method === WS_METHODS.projectsReadFile &&
    (payload as { readonly forCopy?: unknown } | null)?.forCopy === true
      ? "workIfThread"
      : spaceAccessForRpcMethod(method);
  // An RPC that does not say how it keeps to what the session may see runs for nobody.
  if (access === undefined) return yield* notFound();
  // The Owner sees everything (as does a session from before any Owner); no one else, not even
  // an Admin with every scope, acts on the Installation as a whole.
  if (access === "installation" || ownerOnlyCall(method, payload)) {
    if (!visibility.all) return yield* ownerOnly();
    return;
  }
  if (access === "readDirectory" || access === "workDirectory") {
    if (visibility.all) return;
    const named = localWorkspaceTargets(method, payload, DIRECTORY_TARGET_FIELDS[method] ?? []);

    if (named === "refused") return yield* notFound();
    for (const target of named) {
      const allowed =
        access === "workDirectory"
          ? yield* spaceVisibility.mayUseDirectory(visibility, userId, target)
          : yield* spaceVisibility.mayReadDirectory(visibility, target);
      if (!allowed) return yield* notFound();
    }
    return;
  }
  const threadId = stringField(payload, "threadId");
  let threadFolder: string | null | undefined;
  if (access === "readIfThread" || access === "workIfThread") {
    // With no Thread, a draft's (no row yet), or one on the Hub machine, the call runs on the
    // Hub's own disk: what it opens must be what the User may read, or work in for a write.
    const hubFolder =
      visibility.all || threadId === undefined
        ? Option.none<string | null>()
        : yield* spaceVisibility.hubThreadFolder(threadId);
    if (!visibility.all && ((yield* isDraftOrNone(threadId)) || Option.isSome(hubFolder))) {
      const named = localWorkspaceTargets(method, payload);
      if (named === "refused") return yield* notFound();
      for (const target of named) {
        const allowed =
          access === "workIfThread"
            ? yield* spaceVisibility.mayUseDirectory(visibility, userId, target)
            : yield* spaceVisibility.mayReadDirectory(visibility, target);
        if (!allowed) return yield* notFound();
      }
    }
    if (threadId === undefined) return;
    // So must the Hub Thread's own folder, once the Thread is the User's to read or work: a folder
    // today's rule does not trust is no folder of theirs.
    // A Hub Thread whose folder cannot be told (no worktree, no Project row) has none of theirs.
    if (Option.isSome(hubFolder)) threadFolder = hubFolder.value;
  }
  const requireThreadFolder = Effect.fn(function* () {
    if (threadFolder === undefined) return;
    if (threadFolder === null) return yield* notFound();
    const allowed =
      access === "workIfThread"
        ? yield* spaceVisibility.mayUseDirectory(visibility, userId, threadFolder)
        : yield* spaceVisibility.mayReadDirectory(visibility, threadFolder);
    if (!allowed) return yield* notFound();
  });
  // Before the Owner's early return: the Owner's drafts are held too, so no one else works them.
  if (access === "work" || access === "workIfThread") {
    const threadId = stringField(payload, "threadId");
    if (threadId === undefined) return yield* notFound();
    const work = yield* spaceVisibility.claimWork(visibility, userId, threadId);
    if (work === "hidden") return yield* notFound();
    if (work === "not-yours") return yield* notYours();
    for (const field of DIRECTORY_FIELDS[method] ?? []) {
      const directory = stringField(payload, field);
      if (
        directory !== undefined &&
        !(yield* spaceVisibility.mayUseDirectory(visibility, userId, directory))
      ) {
        return yield* new SpaceActionDeniedError({
          message:
            "You can only open terminals in your own Threads' folders and your team's Projects.",
        });
      }
    }
    return yield* requireThreadFolder();
  }
  if (access === "owned") {
    const threads = idsUnder(payload, THREAD_KEYS);
    if (threads.length === 0) return yield* notFound();
    for (const threadId of threads) {
      const work = yield* spaceVisibility.claimWork(visibility, userId, threadId, {
        drafts: false,
      });
      if (work === "hidden") return yield* notFound();
      if (work === "not-yours") {
        return yield* new SpaceActionDeniedError({
          message:
            "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        });
      }
    }
    return;
  }
  if (visibility.all) return;
  const requireVisible = Effect.fn(function* (
    threads: ReadonlyArray<string>,
    projects: ReadonlyArray<string>,
  ) {
    const [visibleThreads, visibleProjects] = yield* Effect.all([
      spaceVisibility.visibleThreadIds(visibility, threads as ReadonlyArray<ThreadId>),
      spaceVisibility.visibleProjectIds(visibility, projects as ReadonlyArray<ProjectId>),
    ]);
    if (
      threads.some((id) => !visibleThreads.has(id as ThreadId)) ||
      projects.some((id) => !visibleProjects.has(id as ProjectId))
    ) {
      return yield* notFound();
    }
  });
  if (access === "thread") {
    const threads = idsUnder(payload, THREAD_KEYS);
    if (stringField(payload, "threadId") === undefined) return yield* notFound();
    return yield* requireVisible(threads, idsUnder(payload, PROJECT_KEYS));
  }
  if (access === "project") return yield* requireVisible([], idsUnder(payload, PROJECT_KEYS));
  if (access === "workProject") {
    const projects: ReadonlyArray<string> = idsUnder(payload, PROJECT_KEYS);
    if (projects.length === 0) return yield* notFound();
    yield* requireVisible([], projects);
    const workable = yield* spaceVisibility.workableProjectIds(
      visibility,
      userId,
      projects as ReadonlyArray<ProjectId>,
    );
    if (projects.some((id) => !workable.has(id as ProjectId))) {
      return yield* new SpaceActionDeniedError({
        message: "Only Members and Admins of this Project's Space can change its pull requests.",
      });
    }
    return;
  }
  if (access === "readIfThread") {
    // A draft has no row yet and stays shown, as composer searches start before the Thread.
    const hidden = yield* spaceVisibility.hiddenThreadIds(
      visibility,
      idsUnder(payload, THREAD_KEYS),
    );
    if (hidden.size > 0) return yield* notFound();
    return yield* requireThreadFolder();
  }
  if (access === "named") {
    if (method === WS_METHODS.assetsCreateUrl) {
      const targets = assetReadTargets(payload);
      if (targets === "refused") return yield* notFound();
      for (const target of targets) {
        if (!(yield* spaceVisibility.mayReadDirectory(visibility, target))) {
          return yield* notFound();
        }
      }
    }
    yield* requireVisible([], idsUnder(payload, PROJECT_KEYS));
    const hidden = yield* spaceVisibility.hiddenThreadIds(
      visibility,
      idsUnder(payload, THREAD_KEYS),
    );
    if (hidden.size > 0) return yield* notFound();
    return;
  }
  if (access === "command") {
    const targets = commandTargets(method, payload);
    yield* requireVisible(targets.threads, targets.projects);
    // A new id that names a hidden Thread answers like any hidden Thread.
    const hidden = yield* spaceVisibility.hiddenThreadIds(visibility, targets.created);
    if (hidden.size > 0) return yield* notFound();
  }
});

export type AccessLost = SpaceResourceNotFoundError | SpaceActionDeniedError;

/**
 * Keeps a stream the middleware let open only while its payload still passes the same guard: it
 * subscribes to the User's access changes first, re-checks once (a revoke between the
 * middleware's check and the subscription is not missed), then again on each change. When the
 * guard refuses, `onLost` ends the stream (succeeds) or fails it with the RPC's own error.
 */
export const untilAccessLost =
  <E2>(
    method: string,
    payload: unknown,
    viewer: SpaceVisibility.CurrentViewer["Service"],
    spaceVisibility: SpaceVisibility.SpaceVisibility["Service"],
    userId: UserId | undefined,
    onLost: (lost: AccessLost) => Effect.Effect<void, E2>,
  ) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | E2, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* viewer.subscribeAccessChanges;
        const lost = Stream.concat(Stream.succeed(undefined), changes).pipe(
          Stream.runForEach(() =>
            Effect.flatMap(viewer.visibility, (visibility) =>
              guardRpcPayload(method, payload, visibility, spaceVisibility, userId),
            ),
          ),
          Effect.andThen(Effect.never),
          Effect.catch(onLost),
        );
        return Stream.interruptWhen(stream, lost);
      }),
    );
