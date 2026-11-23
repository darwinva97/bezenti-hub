import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** The Hub's AI gateway (Settings → AI gateway, the Owner's) and its AI accounts. */
export function createAiGatewayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Streamed: a crash and its restart show at once.
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ai-gateway:status",
      tag: WS_METHODS.aiGatewayStatus,
      idleTtlMs: 0,
    }),
    // Fetched while the section is open and again on request; dropped when it closes.
    checkForUpdates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ai-gateway:check-for-updates",
      tag: WS_METHODS.aiGatewayCheckForUpdates,
      idleTtlMs: 0,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:update",
      tag: WS_METHODS.aiGatewayUpdate,
    }),
    rollback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:rollback",
      tag: WS_METHODS.aiGatewayRollback,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:set-enabled",
      tag: WS_METHODS.aiGatewaySetEnabled,
    }),
    // AI accounts (spec 4): everyone lists what they may use; the Owner changes them. No answer
    // carries a credential.
    listAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:list",
      tag: WS_METHODS.aiAccountsList,
    }),
    createAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:create",
      tag: WS_METHODS.aiAccountsCreate,
    }),
    updateAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:update",
      tag: WS_METHODS.aiAccountsUpdate,
    }),
    deleteAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:delete",
      tag: WS_METHODS.aiAccountsDelete,
    }),
    reorderAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:reorder",
      tag: WS_METHODS.aiAccountsReorder,
    }),
    // Spec 4 ticket 08: the composer's picker (what the User may use in one Space, with models)
    // and a Thread's switch (same provider: next request; another: a context handoff).
    pickerAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:picker",
      tag: WS_METHODS.aiAccountsPicker,
    }),
    setThreadAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:set-ai-account",
      tag: WS_METHODS.threadSetAiAccount,
    }),
    // AI usage (spec 4 ticket 05): counts per day, User, Space and AI account, narrowed by the Hub
    // to what the session may see. Fetched while a screen shows it, again every 30 s.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ai-usage:summary",
      tag: WS_METHODS.aiUsageSummary,
      idleTtlMs: 0,
      refreshIntervalMs: 30_000,
    }),
    // A User's own local CLI keys (spec 4 ticket 10); the Owner's list holds everyone's. Only
    // `createKey` answers with a key, once.
    listKeys: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway-keys:list",
      tag: WS_METHODS.aiGatewayKeysList,
    }),
    createKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway-keys:create",
      tag: WS_METHODS.aiGatewayKeysCreate,
    }),
    revokeKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway-keys:revoke",
      tag: WS_METHODS.aiGatewayKeysRevoke,
    }),
    // A Space's access keys (access-keys ticket 01), for whoever manages it; the Owner's list
    // may hold every Space's. Only `createAccessKey` answers with a key, once.
    listAccessKeys: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:access-keys:list",
      tag: WS_METHODS.accessKeysList,
    }),
    createAccessKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:access-keys:create",
      tag: WS_METHODS.accessKeysCreate,
    }),
    revokeAccessKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:access-keys:revoke",
      tag: WS_METHODS.accessKeysRevoke,
    }),
    // What a key of the Space may reach: its own gateway accounts and their models (the form).
    // Renew, extend, or change a key's caps, models, accounts or label (access-keys ticket 06).
    updateAccessKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:access-keys:update",
      tag: WS_METHODS.accessKeysUpdate,
    }),
    accessKeyModelOptions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:access-keys:model-options",
      tag: WS_METHODS.accessKeysModelOptions,
    }),
    // Subscriptions (spec 4 ticket 03): the Owner signs in through the Hub's CLIProxyAPI, pasting
    // the address the browser lands on; a Vertex service account is imported.
    startAccountLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:login-start",
      tag: WS_METHODS.aiAccountsLoginStart,
    }),
    completeAccountLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:login-complete",
      tag: WS_METHODS.aiAccountsLoginComplete,
    }),
    importVertexAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:import-vertex",
      tag: WS_METHODS.aiAccountsImportVertex,
    }),
    // Spec 4 ticket 15: another CLIProxyAPI's auth files, as disabled subscriptions.
    importCliproxyAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:import-cliproxy",
      tag: WS_METHODS.aiAccountsImportCliproxy,
    }),
  };
}
