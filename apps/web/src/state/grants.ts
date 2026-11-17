import { createGrantsEnvironmentAtoms } from "@t3tools/client-runtime/state/grants";

import { connectionAtomRuntime } from "../connection/runtime";

export const grantsEnvironment = createGrantsEnvironmentAtoms(connectionAtomRuntime);
