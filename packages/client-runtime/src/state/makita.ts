import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Makita, the GitHub bot teammate: its account and who may use it (the Owner's, Platform → Makita),
 * and a Space's configurations. No answer carries its token; only `setAccount` sends one, once.
 */
export function createMakitaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    getAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:account-get",
      tag: WS_METHODS.makitaAccountGet,
    }),
    setAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:account-set",
      tag: WS_METHODS.makitaAccountSet,
    }),
    pauseAll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:pause-all",
      tag: WS_METHODS.makitaAccountPauseAll,
    }),
    resumeAll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:resume-all",
      tag: WS_METHODS.makitaAccountResumeAll,
    }),
    // «May use Makita» per User and Space (the Owner's).
    listPermissions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:permissions-list",
      tag: WS_METHODS.makitaPermissionsList,
    }),
    grantPermission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:permissions-grant",
      tag: WS_METHODS.makitaPermissionsGrant,
    }),
    revokePermission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:permissions-revoke",
      tag: WS_METHODS.makitaPermissionsRevoke,
    }),
    // A Space's configurations (Space settings → Makita).
    listConfigs: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-list",
      tag: WS_METHODS.makitaConfigsList,
    }),
    createConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-create",
      tag: WS_METHODS.makitaConfigsCreate,
    }),
    updateConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-update",
      tag: WS_METHODS.makitaConfigsUpdate,
    }),
    deleteConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-delete",
      tag: WS_METHODS.makitaConfigsDelete,
    }),
    pauseConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-pause",
      tag: WS_METHODS.makitaConfigsPause,
    }),
    resumeConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-resume",
      tag: WS_METHODS.makitaConfigsResume,
    }),
    // Ticket 24: the labels in the chosen Projects' repositories, offered by the form.
    repoLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:configs-labels",
      tag: WS_METHODS.makitaConfigsLabels,
    }),
    // Ticket 06: stop one task now (its configuration's pausers).
    stopTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:tasks-stop",
      tag: WS_METHODS.makitaTasksStop,
    }),
    // Ticket 11: the Owner approves a task's waiting push.
    approveTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:tasks-approve",
      tag: WS_METHODS.makitaTasksApprove,
    }),
    // Ticket 21: a repository added by name, its Project made or reused.
    addRepo: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:repos-add",
      tag: WS_METHODS.makitaReposAdd,
    }),
    // Ticket 22: the Owner's ceiling on tasks at once across the Hub.
    setTaskLimit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:account-set-task-limit",
      tag: WS_METHODS.makitaAccountSetTaskLimit,
    }),
    // What Makita does and spends (ticket 07), read again every 30 s while a screen shows it.
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:makita:activity",
      tag: WS_METHODS.makitaActivity,
      idleTtlMs: 0,
      refreshIntervalMs: 30_000,
    }),
    // Ticket 08: the session's own linked GitHub account (User settings → Account).
    getGitHubIdentity: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:github-identity-get",
      tag: WS_METHODS.githubIdentityGet,
    }),
    githubLinkCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:github-identity-link-code",
      tag: WS_METHODS.githubIdentityLinkCode,
    }),
    unlinkGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:makita:github-identity-unlink",
      tag: WS_METHODS.githubIdentityUnlink,
    }),
    // The Makita tasks of the Threads one sees: the Thread header and the list's «Makita» filter.
    threads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:makita:threads",
      tag: WS_METHODS.makitaThreads,
      refreshIntervalMs: 60_000,
    }),
  };
}
