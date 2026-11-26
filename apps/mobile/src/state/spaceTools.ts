import { createSpaceToolsEnvironmentAtoms } from "@t3tools/client-runtime/state/spaceTools";

import { connectionAtomRuntime } from "../connection/runtime";

/** A Space's MCP servers and Skills, from the one client-runtime source web uses. */
export const spaceToolsEnvironment = createSpaceToolsEnvironmentAtoms(connectionAtomRuntime);
