import { createSpaceToolsEnvironmentAtoms } from "@t3tools/client-runtime/state/spaceTools";

import { connectionAtomRuntime } from "../connection/runtime";

export const spaceToolsEnvironment = createSpaceToolsEnvironmentAtoms(connectionAtomRuntime);
