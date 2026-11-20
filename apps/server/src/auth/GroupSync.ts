/**
 * Keycloak groups → Memberships (Keycloak sign-in spec, «Grupos → memberships», ticket 05): pure,
 * no I/O. From a User's Memberships, the groups their ID token names and the Owner's mappings, the
 * changes that make the Hub say what Keycloak says. Where a group maps, Keycloak decides; manual
 * Memberships without a mapped group are left alone; archived Organizations are not touched.
 */
import { MAX_GROUP_LENGTH, type SpaceId, type SpaceRole } from "@t3tools/contracts";

/** One of the User's Memberships, as stored. */
export interface CurrentMembership {
  readonly spaceId: SpaceId;
  readonly role: SpaceRole;
  /** Whether a mapped group manages it (`space_memberships.managed_by_keycloak`). */
  readonly managed: boolean;
  /** The group that decided it, when managed. */
  readonly group: string | null;
  readonly archived: boolean;
}

/** One of the Owner's mappings, with what the sign-in needs to know about its Organization. */
export interface GroupMapping {
  /** Kept without a leading `/` (`normalizeGroup`). */
  readonly group: string;
  readonly spaceId: SpaceId;
  readonly role: SpaceRole;
  /** The Owner is the Organization's Admin or Steward; otherwise the mapping applies nothing. */
  readonly enabled: boolean;
  readonly archived: boolean;
}

export interface GroupSyncInput {
  readonly memberships: ReadonlyArray<CurrentMembership>;
  /** The token's groups (`groupsOf`): an absent claim is an empty list. */
  readonly groups: ReadonlyArray<string>;
  readonly mappings: ReadonlyArray<GroupMapping>;
}

export type GroupChange =
  /** A new Membership, managed. */
  | {
      readonly kind: "add";
      readonly spaceId: SpaceId;
      readonly role: SpaceRole;
      readonly group: string;
    }
  /** A managed Membership's Role follows its groups. */
  | {
      readonly kind: "changeRole";
      readonly spaceId: SpaceId;
      readonly from: SpaceRole;
      readonly to: SpaceRole;
      readonly group: string;
    }
  /** A manual Membership where a group maps becomes managed, with the group's Role. */
  | {
      readonly kind: "manage";
      readonly spaceId: SpaceId;
      readonly from: SpaceRole;
      readonly to: SpaceRole;
      readonly group: string;
    }
  /** No mapped group of theirs applies any more: the Membership the group gave goes. */
  | {
      readonly kind: "remove";
      readonly spaceId: SpaceId;
      readonly role: SpaceRole;
      readonly group: string | null;
    }
  /**
   * The Organization has no mapping that applies (removed, or disabled because the Owner is no
   * longer its Admin or Steward): the managed Membership becomes manual, its Role kept, so it is
   * never left where nobody may change it.
   */
  | {
      readonly kind: "release";
      readonly spaceId: SpaceId;
      readonly role: SpaceRole;
      readonly group: string | null;
    }
  /** Same Role, decided now by another of their groups: only the label changes. */
  | {
      readonly kind: "relabel";
      readonly spaceId: SpaceId;
      readonly role: SpaceRole;
      readonly group: string;
    };

/** The most groups read from one token; a realm that sends more is cut, never refused. */
export const MAX_TOKEN_GROUPS = 500;

const RANK: Record<SpaceRole, number> = { admin: 3, member: 2, guest: 1 };

/** A group as mappings keep it and as it is compared: without one leading `/`. */
export const normalizeGroup = (group: string): string =>
  group.startsWith("/") ? group.slice(1) : group;

/**
 * The groups in the ID token's claim `claimName`: a top-level array of strings. Anything else, or
 * no claim (Keycloak omits it when the person has no groups), is an empty list. Entries that are
 * not strings, empty or too long are skipped.
 */
export const groupsOf = (
  claims: Readonly<Record<string, unknown>>,
  claimName: string,
): ReadonlyArray<string> => {
  const value = Object.hasOwn(claims, claimName) ? claims[claimName] : undefined;
  if (!Array.isArray(value)) return [];
  const kept = new Set<string>();
  for (const entry of value as ReadonlyArray<unknown>) {
    if (kept.size >= MAX_TOKEN_GROUPS) break;
    if (typeof entry !== "string") continue;
    const group = normalizeGroup(entry);
    if (group.length === 0 || group.length > MAX_GROUP_LENGTH) continue;
    kept.add(group);
  }
  return [...kept];
};

/** The Role a change leaves, when it leaves one. */
const roleAfter = (change: GroupChange): SpaceRole | undefined => {
  switch (change.kind) {
    case "add":
    case "release":
    case "relabel":
      return change.role;
    case "changeRole":
    case "manage":
      return change.to;
    case "remove":
      return undefined;
  }
};

/** Whether the change makes the User an Admin where they were not one: a promotion. */
export const promotesToAdmin = (change: GroupChange): boolean =>
  roleAfter(change) === "admin" &&
  (change.kind === "add" ||
    ((change.kind === "changeRole" || change.kind === "manage") && change.from !== "admin"));

/** Whether the plan leaves the User an Admin of any Organization it touches. */
export const grantsAdmin = (changes: ReadonlyArray<GroupChange>): boolean =>
  changes.some(promotesToAdmin);

/** Whether any mapped group of theirs applies: a new identity's permanent Invitation. */
export const anyAdded = (changes: ReadonlyArray<GroupChange>): boolean =>
  changes.some((change) => change.kind === "add");

export const planGroupSync = (input: GroupSyncInput): ReadonlyArray<GroupChange> => {
  const tokenGroups = new Set(input.groups.map(normalizeGroup));
  const archived = new Set<SpaceId>();
  for (const membership of input.memberships) {
    if (membership.archived) archived.add(membership.spaceId);
  }
  /** Organizations with a mapping that applies, and the Role and group each wants. */
  const mapped = new Set<SpaceId>();
  const desired = new Map<SpaceId, { readonly role: SpaceRole; readonly group: string }>();
  for (const mapping of input.mappings) {
    if (mapping.archived) archived.add(mapping.spaceId);
    if (!mapping.enabled) continue;
    mapped.add(mapping.spaceId);
    const group = normalizeGroup(mapping.group);
    if (!tokenGroups.has(group)) continue;
    const best = desired.get(mapping.spaceId);
    // The highest Role wins; between groups giving the same Role, the first by name, so the label
    // does not flip from one sign-in to the next.
    if (
      best === undefined ||
      RANK[mapping.role] > RANK[best.role] ||
      (RANK[mapping.role] === RANK[best.role] && group < best.group)
    ) {
      desired.set(mapping.spaceId, { role: mapping.role, group });
    }
  }

  const current = new Map(input.memberships.map((membership) => [membership.spaceId, membership]));
  const spaces = new Set<SpaceId>([
    ...mapped,
    ...input.memberships.filter((membership) => membership.managed).map((m) => m.spaceId),
  ]);
  const changes: Array<GroupChange> = [];
  for (const spaceId of [...spaces].toSorted()) {
    if (archived.has(spaceId)) continue;
    const membership = current.get(spaceId);
    if (!mapped.has(spaceId)) {
      if (membership?.managed === true) {
        changes.push({ kind: "release", spaceId, role: membership.role, group: membership.group });
      }
      continue;
    }
    const want = desired.get(spaceId);
    if (want === undefined) {
      if (membership?.managed === true) {
        changes.push({ kind: "remove", spaceId, role: membership.role, group: membership.group });
      }
      continue;
    }
    if (membership === undefined) {
      changes.push({ kind: "add", spaceId, role: want.role, group: want.group });
    } else if (!membership.managed) {
      changes.push({
        kind: "manage",
        spaceId,
        from: membership.role,
        to: want.role,
        group: want.group,
      });
    } else if (membership.role !== want.role) {
      changes.push({
        kind: "changeRole",
        spaceId,
        from: membership.role,
        to: want.role,
        group: want.group,
      });
    } else if (membership.group !== want.group) {
      changes.push({ kind: "relabel", spaceId, role: want.role, group: want.group });
    }
  }
  return changes;
};
