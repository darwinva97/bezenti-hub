import { createMakitaEnvironmentAtoms } from "@t3tools/client-runtime/state/makita";

import { connectionAtomRuntime } from "../connection/runtime";

export const makitaEnvironment = createMakitaEnvironmentAtoms(connectionAtomRuntime);
