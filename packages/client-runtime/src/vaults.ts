import {
  type ResourceOwner,
  secretNameRisk,
  type VaultEntriesListResult,
  type VaultEntry,
  type VaultGroupId,
  type VaultGroupListResult,
  type VaultSource,
  type VaultGroupSummary,
  type VaultThreadEnvironment,
} from "@t3tools/contracts";

/** A dangerous name is replaced on a large screen only: never on a phone. */
export type VaultSurface = "web" | "desktop" | "mobile";

const VAULT_SOURCE_LABEL: Record<VaultSource, string> = {
  user: "yours",
  project: "added by the Project",
  space: "Space default",
};

export interface VaultActions {
  readonly add: boolean;
  readonly replace: boolean;
}

/**
 * What a client offers on one Vault: what the Hub says the viewer may do (`canEdit`) and the
 * session's grant for the command (`mayWrite`, its `permissionAtom`). The Hub decides again on
 * every call. Nothing reads a Secret back (owned-resources 01).
 */
export function vaultActions(
  vault: Pick<VaultGroupSummary, "canEdit">,
  context: { readonly mayWrite: boolean; readonly surface: VaultSurface },
): VaultActions {
  const edit = vault.canEdit && context.mayWrite;
  return { add: edit, replace: edit };
}

export interface EntryActions extends VaultActions {
  /** Make a Secret a Variable: with a new value. */
  readonly makeVariable: boolean;
  /** Make a Variable a Secret (sealed). */
  readonly makeSecret: boolean;
}

/** A name that changes how tools run is the Owner's (or, from owned-resources 04, its User's). */
export function entryActions(
  vault: Pick<VaultGroupSummary, "canEdit">,
  entry: Pick<VaultEntry, "kind" | "name"> & Partial<Pick<VaultEntry, "class">>,
  context: {
    readonly mayWrite: boolean;
    readonly surface: VaultSurface;
    readonly isOwner: boolean;
  },
): EntryActions {
  const base = vaultActions(vault, context);
  const dangerousOnPhone =
    context.surface === "mobile" && secretNameRisk(entry.name) === "dangerous";
  // A Provider entry's value is its provider's, a template's its entries': nothing to replace,
  // or reclassify here.
  const mayReplace =
    base.replace &&
    !dangerousOnPhone &&
    entry.kind !== "provider" &&
    entry.kind !== "template" &&
    (secretNameRisk(entry.name) !== "dangerous" || context.isOwner);
  const isVariable = entry.class === "variable";
  return {
    ...base,
    replace: mayReplace,
    makeVariable: mayReplace && !isVariable,
    makeSecret: mayReplace && isVariable,
  };
}

export function entryBadges(entry: VaultEntry): ReadonlyArray<string> {
  const badges: string[] = [];
  if (entry.kind === "template") {
    badges.push(entry.broken ? "broken" : "template");
  }
  if (entry.delivery === "file") badges.push("file");
  if (entry.delivery === "none") badges.push("not delivered");
  if (entry.unmasked) badges.push("not masked");
  return badges;
}

/** Whose Vault a group is part of, as a line under its name. */
export function vaultOwnerLine(
  group: Pick<VaultGroupSummary, "owner" | "ownerName" | "isDefault">,
  viewer: { readonly userId: string | null },
): string {
  const whose =
    group.owner.kind === "user" && group.owner.userId === viewer.userId
      ? "Your Vault"
      : `${group.ownerName ?? "A removed owner"}'s Vault`;
  return group.isDefault ? `${whose}; every Thread of its Space receives it` : whose;
}

/** One section of Settings → Vaults: an owner and its groups, `default` first. */
export interface VaultOwnerSection {
  readonly owner: ResourceOwner;
  readonly name: string;
  /** The viewer's own (a User's own Vault). */
  readonly mine: boolean;
  readonly groups: ReadonlyArray<VaultGroupSummary>;
  /** The viewer may create groups in it. */
  readonly canCreate: boolean;
}

const ownerKey = (owner: ResourceOwner) =>
  owner.kind === "user" ? `user:${owner.userId}` : `organization:${owner.spaceId}`;

/** The groups by owner, in the Hub's order (the viewer's own first); owners they may add to too. */
export function vaultSections(
  listed: Pick<VaultGroupListResult, "groups" | "owners">,
  viewer: { readonly userId: string | null },
): ReadonlyArray<VaultOwnerSection> {
  const sections = new Map<string, VaultOwnerSection>();
  const creatable = new Set(listed.owners.map((option) => ownerKey(option.owner)));
  const add = (owner: ResourceOwner, name: string) => {
    const key = ownerKey(owner);
    const found = sections.get(key);
    if (found !== undefined) return found;
    const section: VaultOwnerSection = {
      owner,
      name,
      mine: owner.kind === "user" && owner.userId === viewer.userId,
      groups: [],
      canCreate: creatable.has(key),
    };
    sections.set(key, section);
    return section;
  };
  for (const group of listed.groups) {
    const section = add(group.owner, group.ownerName ?? "A removed owner");
    sections.set(ownerKey(group.owner), { ...section, groups: [...section.groups, group] });
  }
  for (const option of listed.owners) add(option.owner, option.name);
  return [...sections.values()];
}

export interface ThreadSecretLine {
  readonly name: string;
  readonly from: string;
  readonly winsOver: string | null;
}

/** The lines of a Thread's «Secrets» panel: names and where they come from, never values. */
export function threadSecretLines(
  environment: Pick<VaultThreadEnvironment, "variables"> &
    Partial<Pick<VaultThreadEnvironment, "vaults">>,
): ReadonlyArray<ThreadSecretLine> {
  // A group is named with its owner's Vault (owned-resources 03): «default · Acme».
  const owners = new Map(
    (environment.vaults ?? []).map((vault) => [vault.vaultId as string, vault.ownerName ?? null]),
  );
  const groupName = (vaultId: string, name: string) => {
    const owner = owners.get(vaultId);
    return owner === null || owner === undefined ? name : `${name} · ${owner}`;
  };
  return environment.variables.map((variable) => ({
    name: variable.name,
    from: `${groupName(variable.vaultId, variable.vaultName)} (${VAULT_SOURCE_LABEL[variable.source]})`,
    winsOver:
      variable.shadowed.length === 0
        ? null
        : variable.shadowed
            .map(
              (other) =>
                `${groupName(other.vaultId, other.vaultName)} (${VAULT_SOURCE_LABEL[other.source]})`,
            )
            .join(", "),
  }));
}

/** Every group the viewer sees and its names, read in parallel. */
export async function loadVaultOverview(reads: {
  readonly list: () => Promise<VaultGroupListResult>;
  readonly entries: (vaultId: VaultGroupId) => Promise<VaultEntriesListResult>;
}): Promise<{
  readonly listed: VaultGroupListResult;
  readonly vaults: ReadonlyArray<VaultGroupSummary>;
  readonly entries: Readonly<Record<string, ReadonlyArray<VaultEntry>>>;
}> {
  const listed = await reads.list();
  const loaded = await Promise.all(
    listed.groups.map(
      async (group) => [group.id, (await reads.entries(group.id)).entries] as const,
    ),
  );
  return { listed, vaults: listed.groups, entries: Object.fromEntries(loaded) };
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
