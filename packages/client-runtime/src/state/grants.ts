import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Grants (loans of a machine, an AI account or a Vault group to a Space): the loans a User gave and
 * those their Spaces received, where they may lend, and the changes that need no strong factor.
 * Giving and accepting go over HTTP with the strong factor a machine or a Vault group needs.
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
    // Grants ticket 02: the Owner's review of allowances «to a User» that narrowed.
    migrationReviews: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:migration-reviews",
      tag: WS_METHODS.grantsMigrationReviews,
    }),
    dismissMigrationReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:dismiss-migration-review",
      tag: WS_METHODS.grantsDismissMigrationReview,
    }),
    // Grants ticket 06: lending links, made by the lender and applied by whoever holds one.
    createOffer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:create-offer",
      tag: WS_METHODS.grantsCreateOffer,
    }),
    readOffer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:read-offer",
      tag: WS_METHODS.grantsReadOffer,
    }),
    claimOffer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grants:claim-offer",
      tag: WS_METHODS.grantsClaimOffer,
    }),
  };
}
