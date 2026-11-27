import { EnvironmentId, GrantId, SpaceId, VaultGroupId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { startKeycloak } from "~/environments/primary/userAccounts";
import { keycloakProofOf, keycloakResultMessage, keycloakReturnTo } from "./keycloakSignIn.logic";

/** What a page left for «Confirm with Keycloak», to resume once it comes back. */
const PendingStepUp = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("accept-grant"), grantId: GrantId }),
  Schema.Struct({ kind: Schema.Literal("claim-offer"), spaceId: SpaceId }),
  Schema.Struct({
    kind: Schema.Literal("lend-machine"),
    machine: Schema.Struct({ id: EnvironmentId, name: Schema.String }),
    spaceId: SpaceId,
    cpus: Schema.String,
    memory: Schema.String,
    pids: Schema.String,
    disk: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("lend-vault-group"),
    group: Schema.Struct({ id: VaultGroupId, name: Schema.String }),
    spaceId: SpaceId,
    useAsDefault: Schema.Boolean,
    /** Opened from the Owner's review of migrated loans rather than from the Vault. */
    fromReview: Schema.Boolean,
  }),
]);
export type PendingStepUp = typeof PendingStepUp.Type;
type Kind = PendingStepUp["kind"];
type PendingOf<K extends Kind> = Extract<PendingStepUp, { readonly kind: K }>;

/** The resumed action with the proof, or why Keycloak refused it (the form opens again). */
export type KeycloakStepUpReturn<K extends Kind> =
  | { readonly pending: PendingOf<K>; readonly proofId: string }
  | { readonly pending: PendingOf<K>; readonly failure: string };

const STASH_KEY = "t3:keycloak-step-up";
const decode = Schema.decodeUnknownOption(PendingStepUp);

const readStash = <K extends Kind>(kind: K): PendingOf<K> | null => {
  try {
    const raw = window.sessionStorage.getItem(STASH_KEY);
    if (raw === null) return null;
    const pending = Option.getOrNull(decode(JSON.parse(raw)));
    return pending?.kind === kind ? (pending as PendingOf<K>) : null;
  } catch {
    return null;
  }
};

const backFromKeycloak = () =>
  keycloakProofOf(window.location.hash) !== null ||
  keycloakResultMessage(window.location.search) !== null;

/**
 * Leaves for Keycloak to confirm it's you with the second factor; the action waits in this tab.
 * Without storage the page comes back without it: the person starts over, nothing is spent.
 */
export async function confirmWithKeycloak(pending: PendingStepUp): Promise<void> {
  try {
    window.sessionStorage.setItem(STASH_KEY, JSON.stringify(pending));
  } catch {
    // See above.
  }
  await startKeycloak({
    intent: "step-up",
    returnTo: keycloakReturnTo(window.location),
    strongFactor: true,
  });
}

/** The action of this kind this page came back from Keycloak with, without taking it. */
export const peekKeycloakStepUp = <K extends Kind>(kind: K): PendingOf<K> | null =>
  backFromKeycloak() ? readStash(kind) : null;

/**
 * Takes the action of this kind back from Keycloak, once: the stash and the address's proof (or
 * refusal) go at once, so no reload, copied link or screenshot carries them.
 */
export function takeKeycloakStepUp<K extends Kind>(kind: K): KeycloakStepUpReturn<K> | null {
  const pending = peekKeycloakStepUp(kind);
  if (pending === null) return null;
  const proofId = keycloakProofOf(window.location.hash);
  const failure = keycloakResultMessage(window.location.search);
  try {
    window.sessionStorage.removeItem(STASH_KEY);
  } catch {
    // Read above, so it can be removed.
  }
  window.history.replaceState(window.history.state, "", keycloakReturnTo(window.location));
  if (proofId !== null) return { pending, proofId };
  return { pending, failure: failure ?? "Confirming with Keycloak did not go through. Try again." };
}
