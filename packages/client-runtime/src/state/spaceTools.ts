import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * A Space's MCP servers and Skills (Space settings → MCP servers & Skills). An MCP server's
 * settings come back with `${NAME}` Vault references, never a value.
 */
export function createSpaceToolsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:list",
      tag: WS_METHODS.spaceToolsList,
    }),
    getMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:mcp-get",
      tag: WS_METHODS.spaceToolsMcpGet,
    }),
    putMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:mcp-put",
      tag: WS_METHODS.spaceToolsMcpPut,
    }),
    searchMcp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:mcp-search",
      tag: WS_METHODS.spaceToolsMcpSearch,
    }),
    getSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:skill-get",
      tag: WS_METHODS.spaceToolsSkillGet,
    }),
    putSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:skill-put",
      tag: WS_METHODS.spaceToolsSkillPut,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:set-enabled",
      tag: WS_METHODS.spaceToolsSetEnabled,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:space-tools:delete",
      tag: WS_METHODS.spaceToolsDelete,
    }),
  };
}
