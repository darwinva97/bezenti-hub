import {
  secretNameRisk,
  type VaultEntriesListResult,
  type VaultEntry,
  type VaultId,
  type VaultListResult,
  type VaultSource,
  type VaultSummary,
  type VaultThreadEnvironment,
} from "@t3tools/contracts";

/** Revealing a value needs a strong factor on a large screen: never on a phone. */
export type VaultSurface = "web" | "desktop" | "mobile";

const VAULT_SOURCE_LABEL: Record<VaultSource, string> = {
  user: "yours",
  project: "added by the Project",
  space: "Space default",
};

export interface VaultActions {
  readonly add: boolean;
  readonly replace: boolean;
  readonly reveal: boolean;
}

/**
 * What a client offers on one Vault: what the Hub says the viewer may do (`canEdit`, `canReveal`)
 * and the session's grant for the command (`mayWrite`, its `permissionAtom`). The Hub decides
 * again on every call.
 */
export function vaultActions(
  vault: Pick<VaultSummary, "canEdit" | "canReveal">,
  context: { readonly mayWrite: boolean; readonly surface: VaultSurface },
): VaultActions {
  const edit = vault.canEdit && context.mayWrite;
  return {
    add: edit,
    replace: edit,
    reveal: vault.canReveal && context.surface !== "mobile",
  };
}

export interface EntryActions extends VaultActions {
  /** Seal a revealable Secret: one way, no value. */
  readonly seal: boolean;
  /** Make a sealed Secret revealable: with a new value. */
  readonly allowReveal: boolean;
  /** Make a Secret a Variable: with a new value. */
  readonly makeVariable: boolean;
  /** Make a Variable a Secret (sealed). */
  readonly makeSecret: boolean;
}

/**
 * A link is replaced at its original, and is what its original is; a name that changes how tools
 * run is the Owner's. «Reveal» only on a revealable Secret: never a sealed one or a Variable.
 */
export function entryActions(
  vault: Pick<VaultSummary, "canEdit" | "canReveal">,
  entry: Pick<VaultEntry, "kind" | "name"> & Partial<Pick<VaultEntry, "class" | "sealed">>,
  context: {
    readonly mayWrite: boolean;
    readonly surface: VaultSurface;
    readonly isOwner: boolean;
  },
): EntryActions {
  const base = vaultActions(vault, context);
  const dangerousOnPhone =
    context.surface === "mobile" && secretNameRisk(entry.name) === "dangerous";
  // A Provider entry's value is its provider's: nothing to replace, seal or reclassify here.
  const mayReplace =
    base.replace &&
    !dangerousOnPhone &&
    entry.kind !== "link" &&
    entry.kind !== "provider" &&
    (secretNameRisk(entry.name) !== "dangerous" || context.isOwner);
  const isVariable = entry.class === "variable";
  return {
    ...base,
    replace: mayReplace,
    reveal: base.reveal && !isVariable && entry.sealed !== true,
    seal: mayReplace && !isVariable && entry.sealed !== true,
    allowReveal: mayReplace && !isVariable && entry.sealed === true,
    makeVariable: mayReplace && !isVariable,
    makeSecret: mayReplace && isVariable,
  };
}

export function entryBadges(entry: VaultEntry): ReadonlyArray<string> {
  const badges: string[] = [];
  if (entry.kind === "link") {
    badges.push(
      entry.broken
        ? "broken"
        : `linked from Main vault${entry.linkedFrom === null ? "" : ` (${entry.linkedFrom.name})`}`,
    );
  } else if (entry.kind === "copy") {
    badges.push("copy");
  }
  if (entry.unmasked) badges.push("not masked");
  return badges;
}

export function vaultOwnerLine(vault: Pick<VaultSummary, "isMain" | "spaceName">): string {
  if (vault.isMain) return "Yours alone; reaches Organizations only through links or copies";
  return vault.spaceName === null ? "Yours alone" : `${vault.spaceName}'s`;
}

export interface ThreadSecretLine {
  readonly name: string;
  readonly from: string;
  readonly winsOver: string | null;
}

/** The lines of a Thread's «Secrets» panel: names and where they come from, never values. */
export function threadSecretLines(
  environment: Pick<VaultThreadEnvironment, "variables">,
): ReadonlyArray<ThreadSecretLine> {
  return environment.variables.map((variable) => ({
    name: variable.name,
    from: `${variable.vaultName} (${VAULT_SOURCE_LABEL[variable.source]})`,
    winsOver:
      variable.shadowed.length === 0
        ? null
        : variable.shadowed
            .map((other) => `${other.vaultName} (${VAULT_SOURCE_LABEL[other.source]})`)
            .join(", "),
  }));
}

/** Every Vault the viewer sees and its names, read in parallel. */
export async function loadVaultOverview(reads: {
  readonly list: () => Promise<VaultListResult>;
  readonly entries: (vaultId: VaultId) => Promise<VaultEntriesListResult>;
}): Promise<{
  readonly vaults: ReadonlyArray<VaultSummary>;
  readonly entries: Readonly<Record<string, ReadonlyArray<VaultEntry>>>;
}> {
  const listed = await reads.list();
  const loaded = await Promise.all(
    listed.vaults.map(
      async (vault) => [vault.id, (await reads.entries(vault.id)).entries] as const,
    ),
  );
  return { vaults: listed.vaults, entries: Object.fromEntries(loaded) };
}

const VAULT_FAILURE_TAGS = new Set(["VaultError", "EnvironmentAuthorizationError"]);

/**
 * A Vault's refusals name secrets, never values; anything else (transport or encoding failures,
 * which could carry what was typed) gets the generic copy.
 */
export function vaultFailureMessage(failure: unknown, fallback = "That did not work."): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    VAULT_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return fallback;
}
