import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Makita, the GitHub bot teammate: its account and who may use it (the Owner's, Platform → Makita).
 * No answer carries its token; only `setAccount` sends one, once.
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
  };
}
