import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Grants (loans of a machine to a Space): the loans a User gave and those their Spaces received,
 * where they may lend, and the changes that need no strong factor. Giving and accepting go over
 * HTTP with the strong factor a machine needs.
 */
export function createGrantsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listGiven: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:list-given",
      tag: WS_METHODS.grantsListGiven,
    }),
    listReceived: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:list-received",
      tag: WS_METHODS.grantsListReceived,
    }),
    targets: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:targets",
      tag: WS_METHODS.grantsTargets,
    }),
    reject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:reject",
      tag: WS_METHODS.grantsReject,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:cancel",
      tag: WS_METHODS.grantsCancel,
    }),
    end: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:end",
      tag: WS_METHODS.grantsEnd,
    }),
    setLimits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:set-limits",
      tag: WS_METHODS.grantsSetLimits,
    }),
  };
}
