/**
 * Vaults. Metadata in the database; each value a sealed entry of `VaultValueStore`, replaced by a
 * new one per write. Rights are AccessPolicy's `vault.*` via SpaceDirectory.authorizer. No door
 * returns a Secret's value (ADR 0012); a Variable's is listed to whoever may read Variables.
 * Everything is audited without a value. See docs/internals/secrets.md.
 */
import {
  IDENTITY_TTL_DEFAULT_SECONDS,
  IDENTITY_TTL_MAX_SECONDS,
  IDENTITY_TTL_MIN_SECONDS,
  DEFAULT_VAULT_GROUP_NAME,
  type ProjectId,
  type ResourceOwner,
  SECRET_MASK_MIN_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  secretNameRisk,
  type SpaceId,
  type ThreadId,
  type UserId,
  type VaultGroupCreateInput,
  type VaultGroupDeleteInput,
  type VaultGroupDeleteResult,
  type VaultEntriesListInput,
  type VaultEntriesListResult,
  type VaultEntry,
  type VaultEntryDeleteInput,
  type VaultEntryDeleteResult,
  VaultEntryId,
  type VaultEntryKind,
  type VaultEntryPutInput,
  type VaultEntryResult,
  VaultError,
  type VaultErrorReason,
  VaultGroupId,
  type VaultEntryClass,
  type VaultProviderScopes,
  type VaultProviderScopesInput,
  ProviderScopeId,
  type SecretProviderId,
  type VaultEntryDelivery,
  looksLikeCredential,
  parseTemplate,
  templateNames,
  templatePathNames,
  type VaultGroupListResult,
  type VaultGroupSummary,
  type VaultGroupUpdateInput,
  type VaultWarning,
  type InstallationUser,
  // Spec 5 ticket 03.
  type VaultAllowance,
  type VaultAllowInput,
  type VaultChoices,
  type VaultChoicesInput,
  type VaultProjectChoiceSetInput,
  type VaultSpaceDefaultsSetInput,
  type VaultUnlinkedDismissResult,
  type VaultUnlinkedEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as IdentityIssuer from "../identity/IdentityIssuer.ts";
import * as IdentityTokens from "../identity/IdentityTokens.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { projectSpaceSql } from "../spaces/SpaceDirectory.ts";
import * as ProviderReads from "./ProviderReads.ts";
import { pathsOf } from "./providerScopeRules.ts";
import * as ThreadSecretValues from "./ThreadSecretValues.ts";
import * as VaultGroups from "./VaultGroups.ts";
import * as VaultKeyCheck from "./VaultKeyCheck.ts";
import * as VaultReach from "./VaultReach.ts";
import * as VaultReachLoss from "./VaultReachLoss.ts";

export class Vaults extends Context.Service<
  Vaults,
  {
    /** The groups the acting User sees, by owner (theirs first), `default` first in each. */
    readonly list: Effect.Effect<VaultGroupListResult, VaultError>;
    readonly create: (input: VaultGroupCreateInput) => Effect.Effect<VaultGroupSummary, VaultError>;
    readonly update: (input: VaultGroupUpdateInput) => Effect.Effect<VaultGroupSummary, VaultError>;
    readonly remove: (
      input: VaultGroupDeleteInput,
    ) => Effect.Effect<VaultGroupDeleteResult, VaultError>;
    readonly listEntries: (
      input: VaultEntriesListInput,
    ) => Effect.Effect<VaultEntriesListResult, VaultError>;
    readonly putEntry: (input: VaultEntryPutInput) => Effect.Effect<VaultEntryResult, VaultError>;
    readonly deleteEntry: (
      input: VaultEntryDeleteInput,
    ) => Effect.Effect<VaultEntryDeleteResult, VaultError>;
    /** `vaults.unlinkedNotice.dismiss`: the Owner has read which entries were Secret links. */
    readonly dismissUnlinked: Effect.Effect<VaultUnlinkedDismissResult, VaultError>;
    // Spec 5 ticket 03: allowances and choices. What a Thread receives is EffectiveVaults'.
    /** `vaults.allow`: the Owner allows one of their Vaults to a Space or a User, or takes it back. */
    readonly allow: (input: VaultAllowInput) => Effect.Effect<VaultGroupSummary, VaultError>;
    /** `vaults.choices`: a Space's defaults and a Project's choices, for whoever sees the Space. */
    readonly choices: (input: VaultChoicesInput) => Effect.Effect<VaultChoices, VaultError>;
    /** `vaults.spaceDefaults.set`: the Owner or the Space's Admins, among the allowed Vaults. */
    readonly setSpaceDefaults: (
      input: VaultSpaceDefaultsSetInput,
    ) => Effect.Effect<VaultChoices, VaultError>;
    /** `vaults.projectChoices.set`: the Owner or the Space's Admins, among the allowed Vaults. */
    readonly setProjectChoice: (
      input: VaultProjectChoiceSetInput,
    ) => Effect.Effect<VaultChoices, VaultError>;
    /**
     * Spec 5 ticket 06: where an answer to a Thread's `request_secret` may also be saved. The
     * Vaults the acting User may edit (`vault.edit`), not archived, that reach the Thread's Space,
     * in the Owner's order. The one rule for the card's picker and for the save itself.
     */
    readonly saveTargets: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<VaultGroupSummary>, VaultError>;
    /**
     * `vaults.providerScopes` (ticket 03): for whoever edits the Vault, the Provider scopes allowed
     * to it, and for the Owner also each provider «Direct». Never a credential or a scope's auth.
     */
    readonly providerScopes: (
      input: VaultProviderScopesInput,
    ) => Effect.Effect<VaultProviderScopes, VaultError>;
  }
>()("t3/vaults/Vaults") {}

const isVaultError = Schema.is(VaultError);

const fail = (reason: VaultErrorReason, message: string) =>
  Effect.fail(new VaultError({ reason, message }));

const NOT_FOUND = "That Vault or secret does not exist.";

/** A group of a Vault (owned-resources 03): its owner, and whether it is the owner's `default`. */
interface VaultRow {
  readonly vaultId: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerKind: "user" | "organization";
  readonly ownerId: string;
  readonly isDefault: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
}

interface EntryRow {
  readonly entryId: string;
  readonly vaultId: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: VaultEntryKind;
  readonly valueId: string | null;
  readonly unmasked: number;
  readonly class: VaultEntryClass;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  /** A Provider entry's provider (a key of `settings.secretProviders`) and reference. */
  readonly providerId: string | null;
  readonly providerReference: string | null;
  /** Its Provider scope (ticket 03), and that scope's label; null: the Owner's «Direct». */
  readonly providerScopeId: string | null;
  readonly scopeLabel: string | null;
  readonly delivery: VaultEntryDelivery;
  /** A Template entry's text: names of entries of its Vault, never values. */
  readonly templateText: string | null;
  /** A workload identity entry's audience and lifetime (ticket 07). */
  readonly identityAudience: string | null;
  readonly identityTtlSeconds: number | null;
}

const classOf = (row: EntryRow): VaultEntryClass => row.class;

/** The store entry holding what an entry delivers. */
const valueIdOf = (row: EntryRow): string | null => row.valueId;

const VAULT_COLUMNS = `
  v.group_id AS "vaultId", v.name AS "name", v.description AS "description",
  v.owner_kind AS "ownerKind", v.owner_id AS "ownerId", v.is_default AS "isDefault",
  v.archived_at AS "archivedAt", v.created_at AS "createdAt", v.updated_at AS "updatedAt",
  (SELECT COUNT(*) FROM vault_entries e WHERE e.group_id = v.group_id) AS "entryCount"
`;

/** Settings' order within an owner: `default` first, then by position, name. */
const GROUP_ORDER = `v.is_default DESC, v.position, v.name COLLATE NOCASE`;

const ENTRY_COLUMNS = `
  e.entry_id AS "entryId", e.group_id AS "vaultId", e.name AS "name",
  e.description AS "description", e.kind AS "kind",
  e.value_id AS "valueId", e.unmasked AS "unmasked", e.class AS "class",
  e.version AS "version",
  e.updated_at AS "updatedAt", e.updated_by AS "updatedBy",
  e.provider_id AS "providerId", e.provider_reference AS "providerReference",
  e.provider_scope_id AS "providerScopeId", s.label AS "scopeLabel",
  e.delivery AS "delivery", e.template_text AS "templateText",
  e.identity_audience AS "identityAudience", e.identity_ttl_seconds AS "identityTtlSeconds"
`;

/** UTF-8 text without NUL, not empty, at most SECRET_VALUE_MAX_BYTES. Says why, never what. */
const valueProblem = (value: string): string | undefined => {
  if (value.length === 0) return "A secret needs a value.";
  if (value.includes("\u0000")) return "A secret's value cannot contain a NUL character.";
  if (new TextEncoder().encode(value).byteLength > SECRET_VALUE_MAX_BYTES) {
    return `A secret's value is at most ${SECRET_VALUE_MAX_BYTES / 1024} KiB.`;
  }
  return undefined;
};

const isShort = (value: string) => [...value].length < SECRET_MASK_MIN_LENGTH;

/** An entry of a Vault as a template of that Vault sees it: names, never values. */
interface TemplateInput {
  readonly name: string;
  readonly kind: VaultEntryKind;
  readonly class: VaultEntryClass;
  readonly delivery: VaultEntryDelivery;
}

/**
 * Why `text` is not a template its Vault can deliver, or undefined: its syntax, a name that is not
 * an entry of the Vault (another Vault's never is), another template, or `| path` of an entry not
 * delivered as a file. Names only.
 */
const templateProblem = (
  text: string,
  inputs: ReadonlyArray<TemplateInput>,
): string | undefined => {
  const parsed = parseTemplate(text);
  if (parsed._tag === "invalid") return parsed.message;
  const byName = new Map(inputs.map((input) => [input.name, input]));
  const paths = templatePathNames(parsed.parts);
  // A token is the Hub's to refresh in its file: a template takes the file, never the token.
  const valueUses = new Set(
    parsed.parts.flatMap((part) =>
      part._tag === "ref" && !(part.filters.length === 1 && part.filters[0] === "path")
        ? [part.name]
        : [],
    ),
  );
  for (const name of templateNames(parsed.parts)) {
    const input = byName.get(name);
    if (input === undefined) {
      return `${name} is not an entry of this Vault: a template names entries of its own Vault only.`;
    }
    if (input.kind === "template") return `${name} is a template: a template never names another.`;
    if (input.kind === "identity" && valueUses.has(name)) {
      return `${name} is a workload identity token: a template takes its file ({{ ${name} | path }}), never the token.`;
    }
    if (paths.has(name) && input.delivery !== "file") {
      return `{{ ${name} | path }} takes ${name}'s Secret file: deliver ${name} as a file.`;
    }
  }
  return undefined;
};

/** A template is a Variable only when every entry it names is one; else a sealed Secret. */
const templateClassOf = (text: string, inputs: ReadonlyArray<TemplateInput>): VaultEntryClass => {
  const parsed = parseTemplate(text);
  if (parsed._tag === "invalid") return "secret";
  const byName = new Map(inputs.map((input) => [input.name, input]));
  const names = templateNames(parsed.parts);
  return names.length > 0 && names.every((name) => byName.get(name)?.class === "variable")
    ? "variable"
    : "secret";
};

type Can = (action: AccessPolicy.Action, resource: AccessPolicy.Resource) => boolean;
type Spaces = ReadonlyMap<
  SpaceId,
  { readonly resource: AccessPolicy.SpaceResource; readonly name: string }
>;

interface AllowanceRow {
  readonly vaultId: string;
  readonly subjectKind: "space" | "user";
  readonly subjectId: string;
}

/**
 * What deciding on groups needs: their Organizations, allowances, the allowed Users' names, whose
 * groups are the Installation Owner's and the owners' names.
 */
interface Known {
  readonly spaces: Spaces;
  readonly allowances: ReadonlyMap<string, ReadonlyArray<AllowanceRow>>;
  readonly userNames: ReadonlyMap<string, string>;
  readonly installationOwner: string | null;
  /** The display names of the Users owning the groups. */
  readonly ownerNames: ReadonlyMap<string, string>;
}

/** A group's owner as the contracts say it. */
const ownerOf = (row: VaultRow): ResourceOwner =>
  row.ownerKind === "organization"
    ? { kind: "organization", spaceId: row.ownerId as SpaceId }
    : { kind: "user", userId: row.ownerId as UserId };

const ownerNameOf = (row: VaultRow, known: Known): string | null =>
  row.ownerKind === "organization"
    ? (known.spaces.get(row.ownerId as SpaceId)?.name ?? null)
    : (known.ownerNames.get(row.ownerId) ?? null);

/** Where a group's audit rows go: its Organization; a User's own, nowhere in particular. */
const auditSpaceOf = (row: VaultRow): SpaceId | null =>
  row.ownerKind === "organization" ? (row.ownerId as SpaceId) : null;

/**
 * A group as AccessPolicy decides on it. A group of a deleted Organization has no Space. Allowances
 * count only on the Owner's own named groups, as in VaultReach.
 */
const resourceOf = (row: VaultRow, known: Known): AccessPolicy.VaultResource => {
  const isInstallationOwner = row.ownerKind === "user" && row.ownerId === known.installationOwner;
  const counts = row.isDefault === 0 && isInstallationOwner;
  const allowances = counts ? (known.allowances.get(row.vaultId) ?? []) : [];
  return {
    kind: "vault",
    owner:
      row.ownerKind === "organization"
        ? {
            kind: "organization",
            space: known.spaces.get(row.ownerId as SpaceId)?.resource ?? null,
          }
        : { kind: "user", userId: row.ownerId as UserId, isInstallationOwner },
    isDefault: row.isDefault === 1,
    allowedSpaces: allowances.flatMap((allowance) => {
      const space =
        allowance.subjectKind === "space"
          ? known.spaces.get(allowance.subjectId as SpaceId)
          : undefined;
      return space === undefined ? [] : [space.resource];
    }),
    allowedUsers: allowances.flatMap((allowance) =>
      allowance.subjectKind === "user" ? [allowance.subjectId as UserId] : [],
    ),
  };
};

const allowancesShown = (row: VaultRow, known: Known): ReadonlyArray<VaultAllowance> =>
  (known.allowances.get(row.vaultId) ?? []).map((allowance) =>
    allowance.subjectKind === "space"
      ? {
          subject: { kind: "space", spaceId: allowance.subjectId as SpaceId },
          name: known.spaces.get(allowance.subjectId as SpaceId)?.name ?? null,
        }
      : {
          subject: { kind: "user", userId: allowance.subjectId as UserId },
          name: known.userNames.get(allowance.subjectId) ?? null,
        },
  );

const summaryOf = (row: VaultRow, known: Known, can: Can): VaultGroupSummary => {
  const resource = resourceOf(row, known);
  const canManage = can("vault.manage", resource);
  return {
    id: VaultGroupId.make(row.vaultId),
    name: row.name,
    description: row.description,
    owner: ownerOf(row),
    ownerName: ownerNameOf(row, known),
    isDefault: row.isDefault === 1,
    archived: row.archivedAt !== null,
    entryCount: row.entryCount,
    canEdit: row.archivedAt === null && can("vault.edit", resource),
    canManage,
    // Whom a Vault reaches is the Owner's to know.
    allowances: canManage ? allowancesShown(row, known) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/** An entry's name and what it is; a Variable's value for whoever may read Variables. */
const entryOf = (
  row: EntryRow,
  canEdit: boolean,
  readsVariables: boolean,
  variableValue: string | undefined,
  provider: ProviderReads.ProviderStatus | undefined,
  templateBroken: boolean,
): VaultEntry => {
  // A Provider entry whose provider is gone (or cannot be read here) is broken for everyone, as is
  // a template naming an entry its group no longer has.
  const broken =
    (row.kind === "provider" && (provider === undefined || provider.broken)) || templateBroken;
  const entryClass = classOf(row);
  return {
    id: VaultEntryId.make(row.entryId),
    vaultId: VaultGroupId.make(row.vaultId),
    name: row.name,
    description: row.description,
    kind: row.kind,
    class: entryClass,
    ...(entryClass === "variable" && variableValue !== undefined ? { value: variableValue } : {}),
    ...(row.kind === "provider"
      ? {
          provider: {
            label: provider?.label ?? null,
            // Where it reads is its editors' to know.
            reference: canEdit ? row.providerReference : null,
            scope: row.providerScopeId === null ? null : (row.scopeLabel ?? null),
          },
        }
      : {}),
    ...(row.kind === "template"
      ? { template: { text: readsVariables ? row.templateText : null } }
      : {}),
    ...(row.kind === "identity"
      ? {
          identity: {
            audience: row.identityAudience ?? "",
            ttlSeconds: row.identityTtlSeconds ?? IDENTITY_TTL_DEFAULT_SECONDS,
          },
        }
      : {}),
    delivery: row.delivery,
    broken,
    unmasked: row.unmasked === 1,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy as UserId | null,
  };
};

const UNAVAILABLE = new VaultError({
  reason: "unavailable",
  message: "Vaults live on the Hub; this machine keeps none.",
});

const refuse = Effect.fn("Vaults.unavailable")(function* (_input: unknown) {
  return yield* UNAVAILABLE;
});

/** A joined machine: no Vaults, nothing written. */
const unavailable = Vaults.of({
  list: Effect.fail(UNAVAILABLE),
  create: refuse,
  update: refuse,
  remove: refuse,
  listEntries: refuse,
  putEntry: refuse,
  deleteEntry: refuse,
  dismissUnlinked: Effect.fail(UNAVAILABLE),
  allow: refuse,
  choices: refuse,
  setSpaceDefaults: refuse,
  setProjectChoice: refuse,
  saveTargets: refuse,
  providerScopes: refuse,
});

const invalidName = (name: string) =>
  `${JSON.stringify(name.slice(0, 40))} is not an environment variable name: use capital letters, digits and _ (not starting with a digit), at most 128.`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  // Workload identity (ticket 07): its issuer, when the Hub has one.
  const identityIssuer = yield* Effect.serviceOption(IdentityIssuer.IdentityIssuer);
  const audit = yield* AuditLog.AuditLog;
  const values = yield* ServerSecretStore.VaultValueStore;
  // Provider entries (ticket 02): what Settings says of their provider; never a read here.
  const providerReads = yield* Effect.serviceOption(ProviderReads.ProviderReads);
  const providerStatus = (providerId: string | null) =>
    providerId === null || Option.isNone(providerReads)
      ? Effect.succeed(undefined)
      : providerReads.value.status(providerId);
  /**
   * A Provider entry's provider as Settings says, broken too when its scope (ticket 03) no
   * longer allows it in this Vault: removed, narrowed or taken back. Never a read.
   */
  const providerStatusOf = Effect.fn("Vaults.providerStatusOf")(function* (row: EntryRow) {
    const status = yield* providerStatus(row.providerId);
    if (status === undefined || status.broken || Option.isNone(providerReads)) return status;
    const allowed = yield* providerReads.value.allowed({
      providerId: row.providerId ?? "",
      scopeId: row.providerScopeId,
      reference: row.providerReference ?? "",
      vaultId: row.vaultId,
    });
    return allowed ? status : { ...status, broken: true };
  });
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;

  /** Logs what failed (never a value: none reaches these causes) and answers generically. */
  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`Vaults: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  /** Inside a transaction: a VaultError is the answer, anything else is storage's. */
  const orStorage = (what: string) => (error: unknown) =>
    isVaultError(error) ? Effect.fail(error) : storage(what)(error);

  // Spec 5 ticket 07: what a write checked before its transaction is checked again inside it, so
  // a move, a removal or an Organization's deletion between the two never lets a row outlive it.

  /** Whether the Space still takes Vaults: it exists, is not being deleted and is not frozen. */
  const spaceTakesVaults = (spaceId: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM spaces
      WHERE space_id = ${spaceId} AND deleting_at IS NULL AND frozen_at IS NULL
    `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

  /** Whether a User may still own what they write: not removed. */
  const userTakesVaults = (userId: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM users WHERE user_id = ${userId} AND removed_at IS NULL
    `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

  /**
   * In a write's transaction: the group exists and its owner is still there (an Organization not
   * being deleted, a User not removed).
   */
  const stillWritable = (vaultId: string) =>
    sql<{ readonly ownerKind: string; readonly ownerId: string }>`
      SELECT owner_kind AS "ownerKind", owner_id AS "ownerId" FROM vault_groups
      WHERE group_id = ${vaultId}
    `.pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? fail("not-found", NOT_FOUND)
          : Effect.flatMap(
              row.ownerKind === "organization"
                ? spaceTakesVaults(row.ownerId)
                : userTakesVaults(row.ownerId),
              (alive) => (alive ? Effect.void : fail("not-found", NOT_FOUND)),
            ),
      ),
    );

  /** In a write's transaction: each Vault still reaches the Space (a move or revoke may have won). */
  const stillReaching = (vaultIds: ReadonlyArray<string>, spaceId: SpaceId) =>
    VaultReach.allowedToSpace(sql, spaceId).pipe(
      Effect.flatMap((allowed) => {
        const reaching = new Set<string>(allowed.map((row) => row.vaultId));
        const missing = vaultIds.find((vaultId) => !reaching.has(vaultId));
        return missing === undefined ? Effect.void : notAllowedHere(missing);
      }),
    );

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (prefix: string) =>
    random
      .randomBytes(16)
      .pipe(Effect.map((bytes) => `${prefix}-${Buffer.from(bytes).toString("hex")}`));

  const actor = spaces.actingUser.pipe(
    Effect.catchTags({
      SpaceAccessDeniedError: () => fail("forbidden", "Sign in to use Vaults."),
      SpaceDirectoryStorageError: storage("read who you are"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => fail("forbidden", "Sign in to use Vaults."),
        onSome: Effect.succeed,
      }),
    ),
  );

  /** The acting User and what they may do, decided once per request. */
  const caller = Effect.gen(function* () {
    const userId = yield* actor;
    const can = yield* spaces
      .authorizer(userId)
      .pipe(Effect.catch(storage("check what you may do")));
    return { userId, can };
  });

  /**
   * The Vaults' Spaces and allowances, in a few reads; the allowed Users' names only for `who`,
   * when they manage one of the Vaults (whom a Vault reaches is the Owner's to know), in one read.
   */
  const spacesOf = Effect.fn("Vaults.knownOf")(function* (
    rows: ReadonlyArray<VaultRow>,
    who?: { readonly userId: UserId; readonly can: Can },
  ) {
    const vaultIds = rows.map((row) => row.vaultId);
    const allowanceRows =
      vaultIds.length === 0
        ? []
        : yield* sql<AllowanceRow>`
            SELECT group_id AS "vaultId", subject_kind AS "subjectKind", subject_id AS "subjectId"
            FROM vault_allowances WHERE group_id IN ${sql.in(vaultIds)}
            ORDER BY subject_kind, subject_id
          `.pipe(Effect.catch(storage("read whom the Vaults are allowed to")));
    const allowances = new Map<string, Array<AllowanceRow>>();
    for (const allowance of allowanceRows) {
      const list = allowances.get(allowance.vaultId) ?? [];
      list.push(allowance);
      allowances.set(allowance.vaultId, list);
    }
    const spaceIds = new Set<SpaceId>();
    for (const row of rows)
      if (row.ownerKind === "organization") spaceIds.add(row.ownerId as SpaceId);
    for (const allowance of allowanceRows) {
      if (allowance.subjectKind === "space") spaceIds.add(allowance.subjectId as SpaceId);
    }
    const known = yield* spaces
      .spacesById([...spaceIds])
      .pipe(Effect.catch(storage("read the Vaults' Organizations")));
    const userOwners = [
      ...new Set(rows.flatMap((row) => (row.ownerKind === "user" ? [row.ownerId] : []))),
    ];
    const people = yield* sql<{
      readonly userId: string;
      readonly displayName: string;
      readonly isOwner: number;
    }>`
      SELECT user_id AS "userId", display_name AS "displayName", is_owner AS "isOwner" FROM users
      WHERE is_owner = 1 ${userOwners.length === 0 ? sql.literal("") : sql`OR user_id IN ${sql.in(userOwners)}`}
    `.pipe(Effect.catch(storage("read whose the Vaults are")));
    const userNames = new Map<string, string>();
    const base: Known = {
      spaces: known,
      allowances,
      userNames,
      installationOwner: people.find((person) => person.isOwner === 1)?.userId ?? null,
      ownerNames: new Map(people.map((person) => [person.userId, person.displayName])),
    };
    const named =
      who !== undefined &&
      allowanceRows.some((allowance) => allowance.subjectKind === "user") &&
      rows.some((row) => who.can("vault.manage", resourceOf(row, base)));
    if (named) {
      const users = yield* spaces
        .listUsers(who.userId)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<InstallationUser> => []));
      for (const user of users) userNames.set(user.id, user.displayName);
    }
    return base;
  });

  const findVault = (vaultId: string) =>
    sql<VaultRow>`SELECT ${sql.literal(VAULT_COLUMNS)} FROM vault_groups v WHERE v.group_id = ${vaultId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.catch(storage("read the Vault")),
    );

  /**
   * The Vault, once the acting User may take `action` on it. A Vault they cannot see answers
   * exactly like a missing one.
   */
  const authorizeVault = Effect.fn("Vaults.authorizeVault")(function* (
    vaultId: string,
    action: AccessPolicy.Action,
  ) {
    const { userId, can } = yield* caller;
    const row = yield* findVault(vaultId);
    if (Option.isNone(row)) return yield* fail("not-found", NOT_FOUND);
    const known = yield* spacesOf([row.value], { userId, can });
    const resource = resourceOf(row.value, known);
    if (!can("vault.view", resource)) return yield* fail("not-found", NOT_FOUND);
    if (action === "vault.manage" && resource.isDefault) {
      return yield* fail(
        "default-group",
        "The default group is never renamed, archived, deleted or allowed elsewhere.",
      );
    }
    if (!can(action, resource)) {
      return yield* fail(
        "forbidden",
        action === "vault.edit"
          ? resource.owner.kind === "organization"
            ? "Only the Owner and the Organization's Admins edit this group's secrets."
            : "Only its owner edits this group."
          : resource.owner.kind === "organization"
            ? "Only the Owner and the Organization's Admins manage its groups."
            : "Only its owner manages this group.",
      );
    }
    if (action === "vault.edit" && row.value.archivedAt !== null) {
      return yield* fail("forbidden", "This Vault is archived: restore it to change its secrets.");
    }
    return { userId, can, row: row.value, resource, known };
  });

  /**
   * The name rule, for every write: never the Hub's own; a name that changes how tools run only
   * from whom the policy lets set one (the Owner), and only confirmed. Says whether it is one.
   */
  const checkName = Effect.fn("Vaults.checkName")(function* (
    name: string,
    can: Can,
    resource: AccessPolicy.VaultResource,
    confirmed: boolean | undefined,
  ) {
    switch (secretNameRisk(name)) {
      case "invalid":
        return yield* fail("invalid-name", invalidName(name));
      case "gateway":
        return yield* fail("reserved-name", `${name} is reserved: the Hub sets it.`);
      case "dangerous":
        if (!can("vault.dangerousName", resource)) {
          return yield* fail(
            "dangerous-name",
            `${name} changes how the agent's tools run or whom they trust: only the Owner sets it, or a User in their own Vault.`,
          );
        }
        if (confirmed !== true) {
          return yield* fail(
            "confirm-dangerous",
            `${name} changes how the agent's tools run or whom they trust. Confirm to save it.`,
          );
        }
        return true;
      default:
        return false;
    }
  });

  const ENTRY_FROM = `
    FROM vault_entries e
    LEFT JOIN secret_provider_scopes s ON s.scope_id = e.provider_scope_id
  `;

  const entriesOf = (vaultId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)} ${sql.literal(ENTRY_FROM)}
      WHERE e.group_id = ${vaultId}
      ORDER BY e.name
    `.pipe(Effect.catch(storage("read the Vault's secrets")));

  const findEntry = (vaultId: string, entryId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)} ${sql.literal(ENTRY_FROM)}
      WHERE e.group_id = ${vaultId} AND e.entry_id = ${entryId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.catch(storage("read the secret")),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("not-found", NOT_FOUND),
          onSome: Effect.succeed,
        }),
      ),
    );

  const nameTaken = (vaultId: string, name: string, except?: string) =>
    sql<{ readonly entryId: string }>`
      SELECT entry_id AS "entryId" FROM vault_entries WHERE group_id = ${vaultId} AND name = ${name}
    `.pipe(
      Effect.map((rows) => rows.some((row) => row.entryId !== except)),
      Effect.catch(storage("read the Vault's secrets")),
      Effect.flatMap((taken) =>
        taken
          ? fail("duplicate-name", `This group already has a secret named ${name}.`)
          : Effect.void,
      ),
    );

  const inputsQuery = (vaultId: string) =>
    sql<TemplateInput>`
      SELECT e.name AS "name", e.kind AS "kind", e.delivery AS "delivery", e.class AS "class"
      ${sql.literal(ENTRY_FROM)}
      WHERE e.group_id = ${vaultId}
    `;
  /** The entries a template of the Vault may name, as it sees them. */
  const inputsOf = (vaultId: string) =>
    inputsQuery(vaultId).pipe(Effect.catch(storage("read the Vault's secrets")));

  /**
   * In a write's transaction: each template of the Vault takes the class its entries give it now
   * (delivery decides again from the live entries, so a stale one never shows a Secret).
   */
  const refreshTemplateClasses = Effect.fn("Vaults.refreshTemplateClasses")(function* (
    vaultId: string,
  ) {
    const templates = yield* sql<{
      readonly entryId: string;
      readonly text: string;
      readonly class: VaultEntryClass;
    }>`
      SELECT entry_id AS "entryId", template_text AS "text", class AS "class"
      FROM vault_entries WHERE group_id = ${vaultId} AND kind = 'template'
    `;
    if (templates.length === 0) return;
    const inputs = yield* inputsQuery(vaultId);
    for (const template of templates) {
      const next = templateClassOf(template.text, inputs);
      if (next !== template.class) {
        yield* sql`UPDATE vault_entries SET class = ${next} WHERE entry_id = ${template.entryId}`;
      }
    }
  });

  /** Whether a template of the Vault names `name` (so a `none` entry reaches something). */
  const namedByTemplate = Effect.fn("Vaults.namedByTemplate")(function* (
    vaultId: string,
    name: string,
    pathOnly: boolean,
  ) {
    const templates = yield* sql<{ readonly text: string }>`
      SELECT template_text AS "text" FROM vault_entries
      WHERE group_id = ${vaultId} AND kind = 'template'
    `.pipe(Effect.catch(storage("read the Vault's templates")));
    return templates.some((template) => {
      const parsed = parseTemplate(template.text);
      if (parsed._tag === "invalid") return false;
      return pathOnly
        ? templatePathNames(parsed.parts).has(name)
        : templateNames(parsed.parts).includes(name);
    });
  });

  /** A new value under a new id: no row points at it until its transaction commits. */
  const writeValue = Effect.fn("Vaults.writeValue")(function* (value: string) {
    const valueId = yield* newId("value");
    yield* values
      .set(valueId, new TextEncoder().encode(value))
      .pipe(Effect.catch(storage("store the secret")));
    return valueId;
  });

  /**
   * Removes a value no row points at; one left behind by a failure is swept at the next start. A
   * value a living Thread received stays, so it is still masked there (ticket 05); the start
   * removes it once those Threads are gone.
   */
  const removeValue = (valueId: string | null) =>
    VaultReachLoss.removeValues(sql, values, valueId === null ? [] : [valueId]);

  const readValue = (valueId: string | null) =>
    valueId === null
      ? fail("not-found", "This secret's value is missing.")
      : values.get(valueId).pipe(
          Effect.catch(storage("read the secret")),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("not-found", "This secret's value is missing."),
              onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
            }),
          ),
        );

  const recordEdit = (input: {
    readonly userId: UserId;
    readonly vault: VaultRow;
    readonly entryId: string;
    readonly name: string;
    readonly kind: VaultEntryKind;
    readonly op: string;
    readonly from?: string;
    readonly dangerous?: boolean;
    readonly class?: VaultEntryClass;
    /** A Provider entry's provider, by its label; never its reference. */
    readonly provider?: string;
    readonly delivery?: VaultEntryDelivery;
  }) =>
    audit.record({
      actor: AuditLog.userActor(input.userId),
      action: "secret.edit",
      spaceId: auditSpaceOf(input.vault),
      target: { kind: "secret", id: input.entryId, name: input.name },
      detail: {
        vault: input.vault.name,
        vaultId: input.vault.vaultId,
        kind: input.kind,
        op: input.op,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.dangerous === true ? { dangerous: true } : {}),
        ...(input.class === undefined ? {} : { class: input.class }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      },
    });

  const result = Effect.fn("Vaults.result")(function* (
    can: Can,
    resource: AccessPolicy.VaultResource,
    vaultId: string,
    entryId: string,
    warnings: ReadonlyArray<VaultWarning>,
  ) {
    const row = yield* findEntry(vaultId, entryId);
    const [entry] = yield* shown([row], can, resource);
    return { entry: entry!, warnings } satisfies VaultEntryResult;
  });

  /**
   * Entries as the caller sees them: a Variable's value for whoever may read Variables (Guests
   * never), the only value a WS answer carries; a Secret's, never. One the store cannot give is
   * left out rather than failing the list.
   */
  const shown = Effect.fn("Vaults.shown")(function* (
    rows: ReadonlyArray<EntryRow>,
    can: Can,
    resource: AccessPolicy.VaultResource,
  ) {
    const canEdit = can("vault.edit", resource);
    const readsVariables = can("vault.readVariables", resource);
    // A template is broken when it names what its Vault no longer has (no value is read for it).
    const templates = rows.filter((row) => row.kind === "template");
    const siblings = templates.length === 0 ? [] : yield* inputsOf(templates[0]!.vaultId);
    return yield* Effect.forEach(rows, (row) =>
      Effect.all([
        readsVariables && classOf(row) === "variable" && valueIdOf(row) !== null
          ? readValue(valueIdOf(row)).pipe(Effect.orElseSucceed(() => undefined))
          : Effect.succeed(undefined),
        providerStatusOf(row),
      ]).pipe(
        Effect.map(([value, provider]) =>
          entryOf(
            row,
            canEdit,
            readsVariables,
            value,
            provider,
            row.kind === "template" &&
              templateProblem(row.templateText ?? "", siblings) !== undefined,
          ),
        ),
      ),
    );
  });

  /**
   * Runs `write` (the rows and the audit) in one transaction after `value` is stored under a new
   * id; on failure that value goes, and on success `replaced` (the old one) does.
   */
  const withNewValue = Effect.fn("Vaults.withNewValue")(function* <A, E>(
    value: string | undefined,
    what: string,
    write: (valueId: string | null) => Effect.Effect<A, E>,
  ) {
    const valueId = value === undefined ? null : yield* writeValue(value);
    return yield* sql
      .withTransaction(write(valueId))
      .pipe(
        Effect.catch((error) => removeValue(valueId).pipe(Effect.andThen(orStorage(what)(error)))),
      );
  });

  /** The owners the caller may create groups for: themselves, and each open Organization they manage. */
  const ownerOptions = Effect.fn("Vaults.ownerOptions")(function* (who: {
    readonly userId: UserId;
    readonly can: Can;
  }) {
    const installationOwner = (yield* sql<{ readonly userId: string }>`
      SELECT user_id AS "userId" FROM users WHERE is_owner = 1
    `.pipe(Effect.catch(storage("read who the Owner is"))))[0]?.userId;
    const options: Array<{ readonly owner: ResourceOwner; readonly name: string }> = [];
    const self: AccessPolicy.VaultResource = {
      kind: "vault",
      owner: {
        kind: "user",
        userId: who.userId,
        isInstallationOwner: who.userId === installationOwner,
      },
      isDefault: false,
      allowedSpaces: [],
      allowedUsers: [],
    };
    if (who.can("vault.manage", self)) {
      const me = yield* spaces
        .installationUser(who.userId)
        .pipe(Effect.catch(storage("read who you are")));
      options.push({
        owner: { kind: "user", userId: who.userId },
        name: Option.match(me, { onNone: () => "Mine", onSome: (user) => user.displayName }),
      });
    }
    const viewed = (yield* spaces.view(who.userId).pipe(Effect.catch(storage("read your Spaces"))))
      .spaces;
    const organizations = viewed.filter(
      (space) => space.kind === "organization" && space.archived !== true,
    );
    const known = yield* spaces
      .spacesById(organizations.map((space) => space.id))
      .pipe(Effect.catch(storage("read your Organizations")));
    for (const space of organizations) {
      const resource = known.get(space.id)?.resource;
      if (resource === undefined) continue;
      const group: AccessPolicy.VaultResource = {
        kind: "vault",
        owner: { kind: "organization", space: resource },
        isDefault: false,
        allowedSpaces: [],
        allowedUsers: [],
      };
      if (who.can("vault.manage", group)) {
        options.push({ owner: { kind: "organization", spaceId: space.id }, name: space.name });
      }
    }
    return options;
  });

  /** For the Owner, until dismissed: the entries that were Secret links (owned-resources 03). */
  const unlinkedFor = Effect.fn("Vaults.unlinkedFor")(function* (userId: UserId) {
    const rows = yield* sql<{
      readonly vaultId: string;
      readonly vaultName: string | null;
      readonly entryId: string;
      readonly name: string;
      readonly originalName: string | null;
    }>`
      SELECT n.group_id AS "vaultId", g.name AS "vaultName", n.entry_id AS "entryId",
        COALESCE(e.name, n.name) AS "name", n.original_name AS "originalName"
      FROM vault_unlinked_notices n
      JOIN users u ON u.user_id = ${userId} AND u.is_owner = 1
      JOIN vault_entries e ON e.entry_id = n.entry_id
      LEFT JOIN vault_groups g ON g.group_id = n.group_id
      ORDER BY g.name, n.name
    `.pipe(Effect.catch(storage("read which entries were Secret links")));
    return rows.map((row): VaultUnlinkedEntry => ({
      vaultId: VaultGroupId.make(row.vaultId),
      vaultName: row.vaultName,
      entryId: VaultEntryId.make(row.entryId),
      name: row.name,
      originalName: row.originalName,
    }));
  });

  const dismissUnlinked = Effect.gen(function* () {
    const { userId } = yield* caller;
    const [user] = yield* sql<{ readonly isOwner: number }>`
      SELECT is_owner AS "isOwner" FROM users WHERE user_id = ${userId}
    `.pipe(Effect.catch(storage("read who you are")));
    if (user?.isOwner !== 1) return yield* fail("forbidden", "Only the Owner sees this notice.");
    const gone = yield* sql<{ readonly entryId: string }>`
      DELETE FROM vault_unlinked_notices RETURNING entry_id AS "entryId"
    `.pipe(Effect.catch(storage("dismiss the notice")));
    return { dismissed: gone.length } satisfies VaultUnlinkedDismissResult;
  }).pipe(Effect.withSpan("Vaults.dismissUnlinked"));

  const list = Effect.gen(function* () {
    const who = yield* caller;
    const { can } = who;
    const rows = yield* sql<VaultRow>`
      SELECT ${sql.literal(VAULT_COLUMNS)} FROM vault_groups v
      ORDER BY v.owner_kind DESC, v.owner_id, ${sql.literal(GROUP_ORDER)}
    `.pipe(Effect.catch(storage("read the Vaults")));
    const known = yield* spacesOf(rows, who);
    // The caller's own first, then each owner's groups together by the owner's name, each
    // owner's in Settings' order (`default` first).
    const mine = (row: VaultRow) => row.ownerKind === "user" && row.ownerId === who.userId;
    const groups = rows
      .filter((row) => can("vault.view", resourceOf(row, known)))
      .toSorted(
        (left, right) =>
          Number(mine(right)) - Number(mine(left)) ||
          (ownerNameOf(left, known) ?? "").localeCompare(ownerNameOf(right, known) ?? ""),
      )
      .map((row) => summaryOf(row, known, can));
    return {
      groups,
      owners: yield* ownerOptions(who),
      unlinked: yield* unlinkedFor(who.userId),
    } satisfies VaultGroupListResult;
  }).pipe(Effect.withSpan("Vaults.list"));

  const providerScopes = Effect.fn("Vaults.providerScopes")(function* (
    input: VaultProviderScopesInput,
  ) {
    const { can, row } = yield* authorizeVault(input.vaultId, "vault.edit");
    if (Option.isNone(providerReads)) return { scopes: [], direct: [] };
    const readable = new Map(
      (yield* providerReads.value.providers).map((provider) => [provider.providerId, provider]),
    );
    const rows = yield* sql<{
      readonly scopeId: string;
      readonly providerId: string;
      readonly label: string;
      readonly paths: string;
    }>`
      SELECT s.scope_id AS "scopeId", s.provider_id AS "providerId", s.label, s.allowed_paths_json AS "paths"
      FROM secret_provider_scopes s
      JOIN vault_provider_scopes a ON a.scope_id = s.scope_id AND a.group_id = ${row.vaultId}
      ORDER BY s.label
    `.pipe(Effect.catch(storage("read the Vault's Provider scopes")));
    return {
      scopes: rows.flatMap((scope) => {
        const provider = readable.get(scope.providerId);
        return provider === undefined
          ? []
          : [
              {
                id: ProviderScopeId.make(scope.scopeId),
                label: scope.label,
                providerId: scope.providerId as SecretProviderId,
                providerLabel: provider.label,
                allowedPaths: pathsOf(scope.paths),
                referencePlaceholder: provider.referencePlaceholder,
              },
            ];
      }),
      direct: can("secretProvider.manage", AccessPolicy.installation)
        ? [...readable.values()].map((provider) => ({
            providerId: provider.providerId as SecretProviderId,
            providerLabel: provider.label,
            referencePlaceholder: provider.referencePlaceholder,
          }))
        : [],
    } satisfies VaultProviderScopes;
  });

  const saveTargets = Effect.fn("Vaults.saveTargets")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const who = yield* caller;
    const placement = yield* spaces
      .placementOf(input.threadId)
      .pipe(Effect.catch(storage("read the Thread's Space")));
    if (Option.isNone(placement)) return [];
    // In the order that reaches the Space: its owner's `default` first.
    const reaching = (yield* VaultReach.allowedToSpace(sql, placement.value.space.id).pipe(
      Effect.catch(storage("read the Vaults allowed to the Space")),
    )).map((reach) => reach.vaultId);
    const found =
      reaching.length === 0
        ? []
        : yield* sql<VaultRow>`
            SELECT ${sql.literal(VAULT_COLUMNS)} FROM vault_groups v
            WHERE v.group_id IN ${sql.in(reaching)}
          `.pipe(Effect.catch(storage("read the Vaults")));
    const byId = new Map(found.map((row) => [row.vaultId, row]));
    const rows = reaching.flatMap((vaultId) => {
      const row = byId.get(vaultId);
      return row === undefined ? [] : [row];
    });
    const known = yield* spacesOf(rows, who);
    return rows.map((row) => summaryOf(row, known, who.can)).filter((summary) => summary.canEdit);
  });

  const create = Effect.fn("Vaults.create")(function* (input: VaultGroupCreateInput) {
    const { userId, can } = yield* caller;
    const { owner } = input;
    let resource: AccessPolicy.VaultResource;
    if (owner.kind === "organization") {
      const found = yield* spaces
        .spaceById(owner.spaceId)
        .pipe(Effect.catch(storage("read the Organization")));
      if (Option.isNone(found) || found.value.resource.kind !== "organization") {
        return yield* fail("not-found", "That Organization does not exist.");
      }
      resource = {
        kind: "vault",
        owner: { kind: "organization", space: found.value.resource },
        isDefault: false,
        allowedSpaces: [],
        allowedUsers: [],
      };
    } else {
      const [user] = yield* sql<{ readonly isOwner: number }>`
        SELECT is_owner AS "isOwner" FROM users WHERE user_id = ${owner.userId}
      `.pipe(Effect.catch(storage("read the User")));
      resource = {
        kind: "vault",
        owner: { kind: "user", userId: owner.userId, isInstallationOwner: user?.isOwner === 1 },
        isDefault: false,
        allowedSpaces: [],
        allowedUsers: [],
      };
    }
    if (!can("vault.manage", resource)) {
      return yield* fail("forbidden", "You do not manage that Vault.");
    }
    if (input.name.toLowerCase() === DEFAULT_VAULT_GROUP_NAME) {
      return yield* fail("duplicate-name", "Every Vault already has its default group.");
    }
    const ownerId = owner.kind === "organization" ? owner.spaceId : owner.userId;
    const vaultId = yield* newId("vault");
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (owner.kind === "organization" && !(yield* spaceTakesVaults(owner.spaceId))) {
            return yield* fail("not-found", "That Organization does not exist.");
          }
          const taken = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM vault_groups
            WHERE owner_kind = ${owner.kind} AND owner_id = ${ownerId}
              AND name = ${input.name} COLLATE NOCASE
          `;
          if ((taken[0]?.n ?? 0) > 0) {
            return yield* fail("duplicate-name", `There is already a group named ${input.name}.`);
          }
          yield* sql`
            INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, description, is_default,
              created_at, updated_at, created_by)
            VALUES (${vaultId}, ${owner.kind}, ${ownerId}, ${input.name},
              ${input.description ?? null}, 0, ${at}, ${at}, ${userId})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault_group.create",
            spaceId: owner.kind === "organization" ? owner.spaceId : null,
            target: { kind: "vault", id: vaultId, name: input.name },
            detail: { ownerKind: owner.kind, ownerId },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("create the group")));
    const row = yield* findVault(vaultId);
    if (Option.isNone(row)) return yield* fail("not-found", NOT_FOUND);
    return summaryOf(row.value, yield* spacesOf([row.value], { userId, can }), can);
  });

  const update = Effect.fn("Vaults.update")(function* (input: VaultGroupUpdateInput) {
    const { userId, can, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    const renamed = input.name !== undefined && input.name !== row.name;
    if (renamed && (input.name ?? "").toLowerCase() === DEFAULT_VAULT_GROUP_NAME) {
      return yield* fail("duplicate-name", "Only the default group is called default.");
    }
    const at = yield* now;
    const archivedAt =
      input.archived === undefined
        ? row.archivedAt
        : input.archived
          ? (row.archivedAt ?? at)
          : null;
    const archiveChanged = (archivedAt !== null) !== (row.archivedAt !== null);
    const described = input.description !== undefined && input.description !== row.description;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (renamed) {
            const taken = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM vault_groups
              WHERE owner_kind = ${row.ownerKind} AND owner_id = ${row.ownerId}
                AND name = ${input.name ?? ""} COLLATE NOCASE AND group_id <> ${row.vaultId}
            `;
            if ((taken[0]?.n ?? 0) > 0) {
              return yield* fail(
                "duplicate-name",
                `There is already a group named ${input.name ?? ""}.`,
              );
            }
          }
          yield* sql`
            UPDATE vault_groups SET
              name = ${input.name ?? row.name},
              description = ${input.description === undefined ? row.description : input.description},
              archived_at = ${archivedAt},
              updated_at = ${at}
            WHERE group_id = ${row.vaultId}
          `;
          if (renamed || described || archiveChanged) {
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "vault_group.update",
              spaceId: auditSpaceOf(row),
              target: { kind: "vault", id: row.vaultId, name: input.name ?? row.name },
              detail: {
                ...(renamed ? { from: row.name, to: input.name ?? row.name } : {}),
                ...(described ? { described: true } : {}),
                ...(archiveChanged ? { archived: archivedAt !== null } : {}),
              },
            });
          }
        }),
      )
      .pipe(Effect.catch(orStorage("change the Vault")));
    const updated = yield* findVault(row.vaultId);
    if (Option.isNone(updated)) return yield* fail("not-found", NOT_FOUND);
    return summaryOf(updated.value, yield* spacesOf([updated.value], { userId, can }), can);
  });

  const remove = Effect.fn("Vaults.remove")(function* (input: VaultGroupDeleteInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    // The values the deleted rows held, read in the same transaction that deletes them.
    const removed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const gone = yield* VaultReachLoss.forgetVault(sql, row.vaultId);
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault_group.delete",
            spaceId: auditSpaceOf(row),
            target: { kind: "vault", id: row.vaultId, name: row.name },
            detail: { entries: gone.entries },
          });
          return gone.valueIds;
        }),
      )
      .pipe(Effect.catch(storage("delete the Vault")));
    yield* VaultReachLoss.removeValues(sql, values, removed);
    return { deleted: true };
  });

  const listEntries = Effect.fn("Vaults.listEntries")(function* (input: VaultEntriesListInput) {
    const { can, row, resource, known } = yield* authorizeVault(input.vaultId, "vault.view");
    const entries = yield* entriesOf(row.vaultId);
    return {
      group: summaryOf(row, known, can),
      entries: yield* shown(entries, can, resource),
    } satisfies VaultEntriesListResult;
  });

  /**
   * A Provider entry (ticket 02, ADR 0008): where a sealed Secret's value is read, never a value.
   * The Owner's alone (`vault.providerEntry`) to add or change; ticket 03 lets Admins within the
   * scopes allowed to the Vault. The reference is checked here and again before every read.
   */
  const putProviderEntry = Effect.fn("Vaults.putProviderEntry")(function* (
    input: VaultEntryPutInput,
    context: {
      readonly userId: UserId;
      readonly can: Can;
      readonly row: VaultRow;
      readonly resource: AccessPolicy.VaultResource;
      readonly dangerous: boolean;
      readonly existing: EntryRow | undefined;
    },
  ) {
    const { userId, can, row, resource, dangerous, existing } = context;
    if (!can("vault.providerEntry", resource)) {
      return yield* fail(
        "forbidden",
        "Only the Owner and the Organization's Admins add Provider entries.",
      );
    }
    // «Direct» (no scope) is the Owner's own access; anyone else reads through a scope.
    const isOwner = can("secretProvider.manage", AccessPolicy.installation);
    if (existing !== undefined && existing.kind !== "provider") {
      return yield* fail(
        "invalid-value",
        `${existing.name} holds a value of its own: delete it and add a Provider entry instead.`,
      );
    }
    if (input.value !== undefined || input.class !== undefined || input.template !== undefined) {
      return yield* fail(
        "invalid-value",
        "A Provider entry is a sealed Secret read from its provider: it takes no value or class.",
      );
    }
    const delivery = input.delivery ?? existing?.delivery ?? "env";
    if (existing !== undefined && delivery !== "file" && existing.delivery === "file") {
      yield* keepsItsPath(row.vaultId, existing.name);
    }
    const source =
      input.provider === undefined
        ? existing === undefined
          ? undefined
          : {
              providerId: existing.providerId ?? "",
              reference: existing.providerReference ?? "",
              scopeId: existing.providerScopeId,
            }
        : { ...input.provider, scopeId: input.provider.scopeId ?? null };
    if (source === undefined) return yield* fail("invalid-value", "Name the provider to read.");
    if (
      !isOwner &&
      (source.scopeId === null || (existing !== undefined && existing.providerScopeId === null))
    ) {
      return yield* fail(
        "forbidden",
        "Only the Owner reads a provider directly: choose a Provider scope allowed to this Vault.",
      );
    }
    if (input.provider !== undefined || !isOwner) {
      const problem = Option.isNone(providerReads)
        ? "Secret providers are read only on a Hub."
        : yield* providerReads.value.referenceProblem({
            providerId: source.providerId,
            scopeId: source.scopeId,
            reference: source.reference,
            vaultId: row.vaultId,
          });
      if (problem !== undefined) return yield* fail("invalid-reference", problem);
    }
    const label = (yield* providerStatus(source.providerId))?.label ?? source.providerId;
    const at = yield* now;
    if (existing === undefined) {
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* stillWritable(row.vaultId);
            yield* sql`
              INSERT INTO vault_entries (entry_id, group_id, name, description, kind, value_id,
                unmasked, class, revealable, provider_id, provider_reference, provider_scope_id,
                delivery, version, created_at, updated_at, updated_by)
              VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null},
                'provider', NULL, 0, 'secret', 0, ${source.providerId}, ${source.reference},
                ${source.scopeId}, ${delivery}, 1, ${at}, ${at}, ${userId})
            `;
            yield* refreshTemplateClasses(row.vaultId);
            yield* recordEdit({
              userId,
              vault: row,
              entryId,
              name: input.name,
              kind: "provider",
              op: "add",
              dangerous,
              provider: label,
            });
          }),
        )
        .pipe(Effect.catch(orStorage("add the Provider entry")));
      return yield* result(
        can,
        resource,
        row.vaultId,
        entryId,
        yield* deliveryWarnings(row.vaultId, input.name, delivery),
      );
    }
    const renamed = input.name !== existing.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, existing.entryId);
    const described = input.description !== undefined && input.description !== existing.description;
    const moved =
      source.providerId !== existing.providerId ||
      source.reference !== existing.providerReference ||
      source.scopeId !== existing.providerScopeId;
    const redelivered = delivery !== existing.delivery;
    if (!renamed && !described && !moved && !redelivered) {
      return yield* result(can, resource, row.vaultId, existing.entryId, []);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* stillWritable(row.vaultId);
          yield* sql`
            UPDATE vault_entries SET
              name = ${input.name},
              description = ${input.description === undefined ? existing.description : input.description},
              provider_id = ${source.providerId},
              provider_reference = ${source.reference},
              provider_scope_id = ${source.scopeId},
              delivery = ${delivery},
              version = version + ${moved ? 1 : 0},
              updated_at = ${at},
              updated_by = ${userId}
            WHERE entry_id = ${existing.entryId}
          `;
          yield* recordEdit({
            userId,
            vault: row,
            entryId: existing.entryId,
            name: input.name,
            kind: "provider",
            op: moved ? "reference" : renamed ? "rename" : redelivered ? "delivery" : "describe",
            ...(renamed ? { from: existing.name } : {}),
            ...(redelivered ? { delivery } : {}),
            dangerous,
            provider: label,
          });
          yield* refreshTemplateClasses(row.vaultId);
        }),
      )
      .pipe(Effect.catch(orStorage("change the Provider entry")));
    return yield* result(
      can,
      resource,
      row.vaultId,
      existing.entryId,
      yield* deliveryWarnings(row.vaultId, input.name, delivery),
    );
  });

  /** `| path` of an entry takes its Secret file: it stays a file while a template takes it. */
  const keepsItsPath = Effect.fn("Vaults.keepsItsPath")(function* (vaultId: string, name: string) {
    if (yield* namedByTemplate(vaultId, name, true)) {
      return yield* fail(
        "invalid-template",
        `A template of this Vault takes ${name}'s Secret file ({{ ${name} | path }}): keep ${name} a file.`,
      );
    }
  });

  /** `none` reaches a process only through a template of its Vault: said when none names it. */
  const deliveryWarnings = Effect.fn("Vaults.deliveryWarnings")(function* (
    vaultId: string,
    name: string,
    delivery: VaultEntryDelivery,
  ) {
    const warnings: Array<VaultWarning> = [];
    if (delivery === "none" && !(yield* namedByTemplate(vaultId, name, false))) {
      warnings.push("not-used-by-template");
    }
    return warnings;
  });

  /**
   * A workload identity entry (ticket 07, ADR 0009): a token the Hub signs for each Thread, for one
   * audience, delivered as a sealed Secret file it refreshes. The Owner's alone, in any Vault. It
   * holds no value: only its audience and lifetime, and nobody reveals it.
   */
  const putIdentityEntry = Effect.fn("Vaults.putIdentityEntry")(function* (
    input: VaultEntryPutInput,
    context: {
      readonly userId: UserId;
      readonly can: Can;
      readonly row: VaultRow;
      readonly resource: AccessPolicy.VaultResource;
      readonly dangerous: boolean;
      readonly existing: EntryRow | undefined;
    },
  ) {
    const { userId, can, row, resource, dangerous, existing } = context;
    if (!can("vault.identityEntry", resource)) {
      return yield* fail("forbidden", "Only the Owner adds or changes workload identity entries.");
    }
    if (existing !== undefined && existing.kind !== "identity") {
      return yield* fail(
        "invalid-value",
        `${existing.name} is not a workload identity entry: delete it and add one instead.`,
      );
    }
    if (
      input.value !== undefined ||
      input.class !== undefined ||
      input.provider !== undefined ||
      input.template !== undefined ||
      (input.delivery !== undefined && input.delivery !== "file")
    ) {
      return yield* fail(
        "invalid-value",
        "A workload identity entry is a token the Hub signs, delivered as a sealed Secret file: it takes no value, class or other delivery.",
      );
    }
    const issuer = Option.flatMap(identityIssuer, (found) =>
      Option.map(found.issuer, () => found.hubOrigins),
    );
    if (Option.isNone(issuer)) {
      return yield* fail(
        "identity-no-issuer",
        "Workload identity is off on this Hub: its operator sets T3CODE_IDENTITY_ISSUER or T3CODE_PUBLIC_URL.",
      );
    }
    const audience = input.identity?.audience ?? existing?.identityAudience ?? "";
    const audienceIssue = IdentityTokens.audienceProblem(audience, issuer.value);
    if (audienceIssue !== undefined) return yield* fail("invalid-value", audienceIssue);
    const ttl =
      input.identity?.ttlSeconds ?? existing?.identityTtlSeconds ?? IDENTITY_TTL_DEFAULT_SECONDS;
    if (
      !Number.isInteger(ttl) ||
      ttl < IDENTITY_TTL_MIN_SECONDS ||
      ttl > IDENTITY_TTL_MAX_SECONDS
    ) {
      return yield* fail(
        "invalid-value",
        `A token lives ${IDENTITY_TTL_MIN_SECONDS} to ${IDENTITY_TTL_MAX_SECONDS} seconds.`,
      );
    }
    const at = yield* now;
    if (existing === undefined) {
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* stillWritable(row.vaultId);
            yield* sql`
              INSERT INTO vault_entries (entry_id, group_id, name, description, kind, value_id,
                unmasked, class, revealable, delivery, identity_audience, identity_ttl_seconds,
                version, created_at, updated_at, updated_by)
              VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null},
                'identity', NULL, 0, 'secret', 0, 'file', ${audience}, ${ttl}, 1, ${at}, ${at},
                ${userId})
            `;
            yield* refreshTemplateClasses(row.vaultId);
            yield* recordEdit({
              userId,
              vault: row,
              entryId,
              name: input.name,
              kind: "identity",
              op: "add",
              dangerous,
            });
          }),
        )
        .pipe(Effect.catch(orStorage("add the workload identity entry")));
      return yield* result(can, resource, row.vaultId, entryId, []);
    }
    const renamed = input.name !== existing.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, existing.entryId);
    const described = input.description !== undefined && input.description !== existing.description;
    const retargeted =
      audience !== existing.identityAudience || ttl !== existing.identityTtlSeconds;
    if (!renamed && !described && !retargeted) {
      return yield* result(can, resource, row.vaultId, existing.entryId, []);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* stillWritable(row.vaultId);
          yield* sql`
            UPDATE vault_entries SET
              name = ${input.name},
              description = ${input.description === undefined ? existing.description : input.description},
              identity_audience = ${audience},
              identity_ttl_seconds = ${ttl},
              version = version + ${retargeted ? 1 : 0},
              updated_at = ${at},
              updated_by = ${userId}
            WHERE entry_id = ${existing.entryId}
          `;
          yield* recordEdit({
            userId,
            vault: row,
            entryId: existing.entryId,
            name: input.name,
            kind: "identity",
            op: retargeted ? "identity" : renamed ? "rename" : "describe",
            ...(renamed ? { from: existing.name } : {}),
            dangerous,
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change the workload identity entry")));
    return yield* result(can, resource, row.vaultId, existing.entryId, []);
  });

  /**
   * A Template entry: a text naming entries of the same Vault, never values, so it is stored in
   * clear. Whoever edits the Vault adds or changes one. Its class follows its entries (a Variable
   * only when all are), and it is never revealed: nobody reads its value from the Hub.
   */
  const putTemplateEntry = Effect.fn("Vaults.putTemplateEntry")(function* (
    input: VaultEntryPutInput,
    context: {
      readonly userId: UserId;
      readonly can: Can;
      readonly row: VaultRow;
      readonly resource: AccessPolicy.VaultResource;
      readonly dangerous: boolean;
      readonly existing: EntryRow | undefined;
    },
  ) {
    const { userId, can, row, resource, dangerous, existing } = context;
    if (existing !== undefined && existing.kind !== "template") {
      return yield* fail(
        "invalid-value",
        `${existing.name} is not a template: delete it and add a template instead.`,
      );
    }
    if (input.value !== undefined || input.class !== undefined || input.provider !== undefined) {
      return yield* fail(
        "invalid-value",
        "A template is composed from its Vault's entries: it takes no value, class or provider.",
      );
    }
    const text = input.template?.text ?? existing?.templateText ?? "";
    const delivery = input.delivery ?? existing?.delivery ?? "env";
    if (delivery === "none") {
      return yield* fail(
        "invalid-template",
        "A template is delivered as a variable or a file, never only to other templates.",
      );
    }
    const inputs = yield* inputsOf(row.vaultId);
    const problem = templateProblem(text, inputs);
    if (problem !== undefined) return yield* fail("invalid-template", problem);
    const entryClass = templateClassOf(text, inputs);
    const at = yield* now;
    if (existing === undefined) {
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* stillWritable(row.vaultId);
            yield* sql`
              INSERT INTO vault_entries (entry_id, group_id, name, description, kind, value_id,
                unmasked, class, revealable, delivery, template_text, version, created_at,
                updated_at, updated_by)
              VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null},
                'template', NULL, 0, ${entryClass}, 0, ${delivery}, ${text}, 1, ${at}, ${at},
                ${userId})
            `;
            yield* recordEdit({
              userId,
              vault: row,
              entryId,
              name: input.name,
              kind: "template",
              op: "add",
              dangerous,
              class: entryClass,
              delivery,
            });
          }),
        )
        .pipe(Effect.catch(orStorage("add the template")));
      return yield* result(can, resource, row.vaultId, entryId, []);
    }
    const renamed = input.name !== existing.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, existing.entryId);
    const described = input.description !== undefined && input.description !== existing.description;
    const rewritten = text !== existing.templateText;
    const redelivered = delivery !== existing.delivery;
    if (!renamed && !described && !rewritten && !redelivered) {
      return yield* result(can, resource, row.vaultId, existing.entryId, []);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* stillWritable(row.vaultId);
          yield* sql`
            UPDATE vault_entries SET
              name = ${input.name},
              description = ${input.description === undefined ? existing.description : input.description},
              template_text = ${text},
              class = ${entryClass},
              delivery = ${delivery},
              version = version + ${rewritten ? 1 : 0},
              updated_at = ${at},
              updated_by = ${userId}
            WHERE entry_id = ${existing.entryId}
          `;
          yield* recordEdit({
            userId,
            vault: row,
            entryId: existing.entryId,
            name: input.name,
            kind: "template",
            op: rewritten ? "template" : redelivered ? "delivery" : renamed ? "rename" : "describe",
            ...(renamed ? { from: existing.name } : {}),
            ...(redelivered ? { delivery } : {}),
            dangerous,
            class: entryClass,
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change the template")));
    return yield* result(can, resource, row.vaultId, existing.entryId, []);
  });

  const putEntry = Effect.fn("Vaults.putEntry")(function* (input: VaultEntryPutInput) {
    const { userId, can, row, resource } = yield* authorizeVault(input.vaultId, "vault.edit");
    const dangerous = yield* checkName(input.name, can, resource, input.confirmDangerous);
    const existing =
      input.entryId === undefined ? undefined : yield* findEntry(row.vaultId, input.entryId);
    if (input.provider !== undefined || existing?.kind === "provider") {
      return yield* putProviderEntry(input, { userId, can, row, resource, dangerous, existing });
    }
    if (input.template !== undefined || existing?.kind === "template") {
      return yield* putTemplateEntry(input, { userId, can, row, resource, dangerous, existing });
    }
    if (input.identity !== undefined || existing?.kind === "identity") {
      return yield* putIdentityEntry(input, { userId, can, row, resource, dangerous, existing });
    }
    const value = input.value === undefined ? undefined : Redacted.value(input.value);
    if (value !== undefined) {
      const problem = valueProblem(value);
      if (problem !== undefined) return yield* fail("invalid-value", problem);
    }
    /** A Secret's short value is never masked; a Variable's credential-looking one is a mistake. */
    const warningsFor = (
      entryClass: VaultEntryClass,
      checked: boolean,
    ): ReadonlyArray<VaultWarning> =>
      entryClass === "variable"
        ? checked && looksLikeCredential(input.name, value)
          ? ["looks-like-credential"]
          : []
        : value !== undefined && isShort(value)
          ? ["short-value"]
          : [];
    const at = yield* now;

    if (input.entryId === undefined) {
      if (value === undefined) return yield* fail("invalid-value", "A secret needs a value.");
      // Every Secret is sealed (ADR 0012): `revealable` is always 0.
      const entryClass = input.class ?? "secret";
      const delivery = input.delivery ?? "env";
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      yield* withNewValue(value, "add the secret", (valueId) =>
        Effect.gen(function* () {
          yield* stillWritable(row.vaultId);
          yield* sql`
            INSERT INTO vault_entries (entry_id, group_id, name, description, kind, value_id, unmasked, class, revealable, delivery, version, created_at, updated_at, updated_by)
            VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null}, 'own', ${valueId}, ${isShort(value) ? 1 : 0}, ${entryClass}, 0, ${delivery}, 1, ${at}, ${at}, ${userId})
          `;
          yield* refreshTemplateClasses(row.vaultId);
          yield* recordEdit({
            userId,
            vault: row,
            entryId,
            name: input.name,
            kind: "own",
            op: "add",
            dangerous,
            ...(entryClass === "variable" ? { class: entryClass } : {}),
          });
        }),
      ).pipe(
        Effect.catch((error) =>
          // A name taken meanwhile says so; anything else stays storage's.
          nameTaken(row.vaultId, input.name).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
      return yield* result(can, resource, row.vaultId, entryId, [
        ...warningsFor(entryClass, true),
        ...(yield* deliveryWarnings(row.vaultId, input.name, delivery)),
      ]);
    }

    const entry = yield* findEntry(row.vaultId, input.entryId);
    // A name that changes how tools run stays the Owner's, whatever the change.
    yield* checkName(entry.name, can, resource, input.confirmDangerous);
    const renamed = input.name !== entry.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, entry.entryId);
    const described = input.description !== undefined && input.description !== entry.description;

    // Class: a Variable becomes a sealed Secret as it is; a Secret becomes a Variable only with a
    // new value in the same request, so the old one is never read for it (owned-resources 01).
    const wasClass = classOf(entry);
    const nextClass = input.class ?? wasClass;
    const classChanged = nextClass !== wasClass;
    if (classChanged && nextClass === "variable" && value === undefined) {
      return yield* fail(
        "needs-new-value",
        `Making ${entry.name} a Variable takes a new value: a Secret's is never shown.`,
      );
    }
    const delivery = input.delivery ?? entry.delivery;
    const redelivered = delivery !== entry.delivery;
    if (redelivered && entry.delivery === "file") yield* keepsItsPath(row.vaultId, entry.name);
    if (value === undefined && !renamed && !described && !classChanged && !redelivered) {
      return yield* result(can, resource, row.vaultId, entry.entryId, []);
    }
    // The new value under a new id; the row, its version and the audit move to it together.
    const replaced = yield* withNewValue(value, "change the secret", (valueId) =>
      Effect.gen(function* () {
        yield* stillWritable(row.vaultId);
        const current = yield* sql<{ readonly valueId: string | null }>`
          SELECT value_id AS "valueId" FROM vault_entries WHERE entry_id = ${entry.entryId}
        `;
        const before = current[0];
        if (before === undefined) return yield* fail("not-found", NOT_FOUND);
        yield* sql`
          UPDATE vault_entries SET
            name = ${input.name},
            description = ${input.description === undefined ? entry.description : input.description},
            value_id = ${valueId ?? before.valueId},
            unmasked = ${value === undefined ? entry.unmasked : isShort(value) ? 1 : 0},
            class = ${nextClass},
            revealable = 0,
            delivery = ${delivery},
            version = version + ${value === undefined ? 0 : 1},
            updated_at = ${at},
            updated_by = ${userId}
          WHERE entry_id = ${entry.entryId}
        `;
        const edit = { userId, vault: row, entryId: entry.entryId, name: input.name };
        if (classChanged) {
          yield* recordEdit({ ...edit, kind: entry.kind, op: "class", class: nextClass });
        }
        if (redelivered) {
          yield* recordEdit({ ...edit, kind: entry.kind, op: "delivery", delivery });
        }
        if (value !== undefined || renamed || described) {
          yield* recordEdit({
            ...edit,
            kind: entry.kind,
            op: value !== undefined ? "replace" : renamed ? "rename" : "describe",
            ...(renamed ? { from: entry.name } : {}),
            dangerous,
          });
        }
        yield* refreshTemplateClasses(row.vaultId);
        return valueId === null ? null : before.valueId;
      }),
    );
    yield* removeValue(replaced);
    return yield* result(can, resource, row.vaultId, entry.entryId, [
      ...warningsFor(nextClass, value !== undefined || renamed || classChanged),
      ...(yield* deliveryWarnings(row.vaultId, input.name, delivery)),
    ]);
  });

  const deleteEntry = Effect.fn("Vaults.deleteEntry")(function* (input: VaultEntryDeleteInput) {
    const { userId, row, can, resource } = yield* authorizeVault(input.vaultId, "vault.edit");
    const entry = yield* findEntry(row.vaultId, input.entryId);
    if (entry.kind === "identity" && !can("vault.identityEntry", resource)) {
      return yield* fail("forbidden", "Only the Owner changes workload identity entries.");
    }
    const gone = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const deleted = yield* sql<{ readonly valueId: string | null }>`
            DELETE FROM vault_entries WHERE entry_id = ${entry.entryId} RETURNING value_id AS "valueId"
          `;
          if (deleted.length === 0) return yield* fail("not-found", NOT_FOUND);
          yield* recordEdit({
            userId,
            vault: row,
            entryId: entry.entryId,
            name: entry.name,
            kind: entry.kind,
            op: "delete",
          });
          yield* refreshTemplateClasses(row.vaultId);
          return deleted[0]?.valueId ?? null;
        }),
      )
      .pipe(Effect.catch(orStorage("delete the secret")));
    yield* removeValue(gone);
    return { deleted: true } satisfies VaultEntryDeleteResult;
  });

  // Spec 5 ticket 03: allowances, a Space's defaults and a Project's choices. Which Vaults may
  // reach a Space is VaultReach's rule; what a Thread receives is EffectiveVaults'.

  const allow = Effect.fn("Vaults.allow")(function* (input: VaultAllowInput) {
    const { userId, can, row, known } = yield* authorizeVault(input.vaultId, "vault.manage");
    // Only the Owner's own named groups are allowed elsewhere (until Grants); `default` never
    // (authorizeVault refused it).
    if (row.ownerKind !== "user" || row.ownerId !== known.installationOwner) {
      return yield* fail(
        "not-allowed",
        "A group reaches its own owner's Space only: lending it elsewhere is a Grant.",
      );
    }
    const subject = input.subject;
    const subjectId = subject.kind === "space" ? subject.spaceId : subject.userId;
    // Allowing needs a living Space or User; taking back never does (it may have been deleted).
    let subjectName: string = subjectId;
    if (subject.kind === "space") {
      const found = yield* spaces
        .spaceById(subject.spaceId)
        .pipe(Effect.catch(storage("read the Space")));
      if (Option.isSome(found)) subjectName = found.value.name;
      else if (input.allowed) return yield* fail("not-found", "That Space does not exist.");
    } else {
      const found = yield* spaces
        .installationUser(subject.userId)
        .pipe(Effect.catch(storage("read the User")));
      if (Option.isSome(found)) subjectName = found.value.displayName;
      if (input.allowed && (Option.isNone(found) || found.value.status === "removed")) {
        return yield* fail("not-found", "That User does not exist.");
      }
    }
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM vault_allowances
            WHERE group_id = ${row.vaultId} AND subject_kind = ${subject.kind} AND subject_id = ${subjectId}
          `;
          const had = (existing[0]?.n ?? 0) > 0;
          if (had === input.allowed) return;
          if (input.allowed) {
            // Checked again here: a removal, a freeze or a deletion since the read above wins.
            yield* stillWritable(row.vaultId);
            if (subject.kind === "space" && !(yield* spaceTakesVaults(subjectId))) {
              return yield* fail("not-found", "That Space does not exist.");
            }
            if (subject.kind === "user") {
              const [user] = yield* sql<{ readonly removed: number }>`
                SELECT removed_at IS NOT NULL AS removed FROM users WHERE user_id = ${subjectId}
              `;
              if (user === undefined || user.removed === 1) {
                return yield* fail("not-found", "That User does not exist.");
              }
            }
            yield* sql`
              INSERT INTO vault_allowances (group_id, subject_kind, subject_id, created_at)
              VALUES (${row.vaultId}, ${subject.kind}, ${subjectId}, ${at})
            `;
            // A default or choice of it there can only be left from before: it never comes back.
            if (subject.kind === "space") {
              yield* VaultReachLoss.clearForGrant(sql, row.vaultId, subjectId);
            }
          } else {
            // Taken back from a Space: its default and its Projects' choices go too, so allowing
            // it again later does not bring them back unseen.
            yield* subject.kind === "space"
              ? VaultReachLoss.forgetSpaceAllowance(sql, row.vaultId, subjectId)
              : VaultReachLoss.forgetUserAllowance(sql, row.vaultId, subjectId);
          }
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.allow",
            spaceId: subject.kind === "space" ? subject.spaceId : null,
            target: { kind: "vault", id: row.vaultId, name: row.name },
            detail: { subjectKind: subject.kind, subjectId, subjectName, allowed: input.allowed },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change whom the Vault is allowed to")));
    const updated = yield* findVault(row.vaultId);
    if (Option.isNone(updated)) return yield* fail("not-found", NOT_FOUND);
    return summaryOf(updated.value, yield* spacesOf([updated.value], { userId, can }), can);
  });

  /**
   * The Space a choice is about, once the caller sees it (a Project's, when one is named): a
   * hidden one answers like a missing one, an agent bound to another Space included.
   */
  const choiceSpace = Effect.fn("Vaults.choiceSpace")(function* (input: {
    readonly spaceId?: SpaceId | undefined;
    readonly projectId?: ProjectId | undefined;
  }) {
    const { userId, can } = yield* caller;
    const hidden = () => fail("not-found", "That Space or Project does not exist.");
    let space: AccessPolicy.SpaceResource;
    if (input.projectId !== undefined) {
      yield* spaces
        .authorizeItem(userId, "space.view", { kind: "project", id: input.projectId })
        .pipe(
          Effect.catchTags({
            SpaceDirectoryStorageError: storage("read the Project"),
            SpaceAccessDeniedError: hidden,
            SpaceResourceNotFoundError: hidden,
          }),
        );
      const found = yield* spaces
        .spaceOf({ kind: "project", id: input.projectId })
        .pipe(Effect.catch(storage("read the Project's Space")));
      if (Option.isNone(found)) return yield* hidden();
      if (input.spaceId !== undefined && found.value.id !== input.spaceId) return yield* hidden();
      space = found.value;
    } else {
      if (input.spaceId === undefined) return yield* hidden();
      const found = yield* spaces
        .spaceById(input.spaceId)
        .pipe(Effect.catch(storage("read the Space")));
      if (Option.isNone(found)) return yield* hidden();
      space = found.value.resource;
    }
    if (!can("space.view", space)) return yield* hidden();
    const allowed = yield* VaultReach.allowedToSpace(sql, space.id).pipe(
      Effect.catch(storage("read the Space's Vaults")),
    );
    return { userId, can, space, allowed };
  });

  const choicesOf = Effect.fn("Vaults.choicesOf")(function* (
    can: Can,
    space: AccessPolicy.SpaceResource,
    allowed: ReadonlyArray<VaultReach.ReachRow>,
    projectId: ProjectId | null,
  ) {
    const allowedIds = new Set<string>(allowed.map((row) => row.vaultId));
    const read = Effect.gen(function* () {
      const defaults = yield* VaultReach.chosenDefaults(sql, space.id);
      const choices = projectId === null ? [] : yield* VaultReach.projectChoices(sql, projectId);
      const names =
        allowed.length === 0
          ? []
          : yield* sql<{ readonly vaultId: string; readonly name: string }>`
              SELECT group_id AS "vaultId", name FROM vault_entries
              WHERE group_id IN ${sql.in(allowed.map((row) => row.vaultId))} ORDER BY name
            `;
      return { defaults, choices, names };
    });
    const { defaults, choices, names } = yield* read.pipe(
      Effect.catch(storage("read the Space's Vaults")),
    );
    // Its names, as `listEntries` would show them: only to whoever may see the Vault.
    const rows =
      allowed.length === 0
        ? []
        : yield* sql<VaultRow>`
            SELECT ${sql.literal(VAULT_COLUMNS)} FROM vault_groups v
            WHERE v.group_id IN ${sql.in(allowed.map((row) => row.vaultId))}
          `.pipe(Effect.catch(storage("read the Space's Vaults")));
    const known = yield* spacesOf(rows);
    const visible = new Set(
      rows.filter((row) => can("vault.view", resourceOf(row, known))).map((row) => row.vaultId),
    );
    const rowById = new Map(rows.map((row) => [row.vaultId, row]));
    return {
      spaceId: space.id,
      projectId,
      canChoose: can("vault.choose", space),
      allowed: allowed.flatMap((row) => {
        const group = rowById.get(row.vaultId);
        return group === undefined
          ? []
          : [
              {
                vaultId: row.vaultId,
                name: row.name,
                owner: ownerOf(group),
                ownerName: ownerNameOf(group, known),
                isDefault: row.isDefault,
                archived: row.archived,
                names: visible.has(row.vaultId)
                  ? names
                      .filter((entry) => entry.vaultId === row.vaultId)
                      .map((entry) => entry.name)
                  : [],
              },
            ];
      }),
      defaults: defaults.filter((vaultId) => allowedIds.has(vaultId)),
      fixedDefaults: VaultReach.fixedDefaults(allowed),
      projectChoices: choices.filter((choice) => allowedIds.has(choice.vaultId)),
    } satisfies VaultChoices;
  });

  const choices = Effect.fn("Vaults.choices")(function* (input: VaultChoicesInput) {
    const { can, space, allowed } = yield* choiceSpace(input);
    return yield* choicesOf(can, space, allowed, input.projectId ?? null);
  });

  const refuseChoice = (space: AccessPolicy.SpaceResource) =>
    fail(
      "forbidden",
      space.kind === "personal"
        ? "Only its User chooses the groups of a Personal space."
        : "Only the Owner and the Organization's Admins choose its groups.",
    );

  const notAllowedHere = (vaultId: string) =>
    fail(
      "not-allowed",
      `That group does not reach this Space: a group reaches its owner's Space, and the Owner's named groups whom they are allowed to (${vaultId}).`,
    );

  const setSpaceDefaults = Effect.fn("Vaults.setSpaceDefaults")(function* (
    input: VaultSpaceDefaultsSetInput,
  ) {
    const { userId, can, space, allowed } = yield* choiceSpace({ spaceId: input.spaceId });
    if (!can("vault.choose", space)) return yield* refuseChoice(space);
    const byId = new Map<string, VaultReach.ReachRow>(allowed.map((row) => [row.vaultId, row]));
    const fixed = new Set<string>(VaultReach.fixedDefaults(allowed));
    // What the Space received as defaults: the stored ones still allowed (stale rows are not).
    const effectiveBefore = (stored: ReadonlyArray<VaultGroupId>) =>
      stored.filter((vaultId) => byId.has(vaultId) && !fixed.has(vaultId));
    const current = new Set(
      effectiveBefore(
        yield* VaultReach.chosenDefaults(sql, space.id).pipe(
          Effect.catch(storage("read the Space's default Vaults")),
        ),
      ),
    );
    const wanted: Array<VaultReach.ReachRow> = [];
    for (const vaultId of new Set(input.vaultIds)) {
      const row = byId.get(vaultId);
      if (row === undefined) return yield* notAllowedHere(vaultId);
      // A fixed default (the `default` of the Space's owner) is never a chosen one.
      if (fixed.has(vaultId)) continue;
      // An archived Vault already a default may stay (or be unchecked); it never becomes one.
      if (row.archived && !current.has(vaultId)) {
        return yield* fail("not-allowed", `${row.name} is archived: restore it first.`);
      }
      wanted.push(row);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Checked again here: a revoke or the Space's deletion since the read above wins.
          if (!(yield* spaceTakesVaults(space.id))) {
            return yield* fail("not-found", "That Space or Project does not exist.");
          }
          yield* stillReaching(
            wanted.map((row) => row.vaultId),
            space.id,
          );
          const before = effectiveBefore(yield* VaultReach.chosenDefaults(sql, space.id));
          yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${space.id}`;
          for (const [position, row] of wanted.entries()) {
            yield* sql`
              INSERT INTO space_default_vaults (space_id, group_id, position)
              VALUES (${space.id}, ${row.vaultId}, ${position})
            `;
          }
          const record = (vaultId: string, name: string, choice: string, position?: number) =>
            audit.record({
              actor: AuditLog.userActor(userId),
              action: "vault.choose",
              spaceId: space.id,
              target: { kind: "vault", id: vaultId, name },
              detail: { scope: "space", choice, ...(position === undefined ? {} : { position }) },
            });
          for (const [position, row] of wanted.entries()) {
            if (before.indexOf(row.vaultId) !== position) {
              yield* record(row.vaultId, row.name, "default", position);
            }
          }
          for (const vaultId of before) {
            if (wanted.some((row) => row.vaultId === vaultId)) continue;
            yield* record(vaultId, byId.get(vaultId)?.name ?? vaultId, "none");
          }
        }),
      )
      .pipe(Effect.catch(orStorage("change the Space's default Vaults")));
    return yield* choicesOf(can, space, allowed, null);
  });

  const setProjectChoice = Effect.fn("Vaults.setProjectChoice")(function* (
    input: VaultProjectChoiceSetInput,
  ) {
    const { userId, can, space, allowed } = yield* choiceSpace({ projectId: input.projectId });
    if (!can("vault.choose", space)) return yield* refuseChoice(space);
    const scratch = yield* VaultReach.isScratchProject(sql, path, baseDir, input.projectId).pipe(
      Effect.catch(storage("read the Project")),
    );
    if (scratch) {
      return yield* fail(
        "not-allowed",
        "Threads without a Project use their Space's default Vaults: choose them on the Space.",
      );
    }
    const row = allowed.find((candidate) => candidate.vaultId === input.vaultId);
    if (input.choice !== "inherit" && row === undefined)
      return yield* notAllowedHere(input.vaultId);
    if (input.choice !== "inherit" && VaultReach.fixedDefaults(allowed).includes(input.vaultId)) {
      return yield* fail(
        "not-allowed",
        "The default group is always a default of its owner's Space: a Project neither adds nor removes it.",
      );
    }
    if (input.choice === "add" && row?.archived === true) {
      return yield* fail("not-allowed", `${row.name} is archived: restore it first.`);
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.choice !== "inherit") {
            // Checked again here: the Project may have moved, or the Vault been taken back.
            const [placed] = yield* sql<{ readonly spaceId: string }>`
              SELECT ${sql.literal(projectSpaceSql("space_id"))} AS "spaceId"
              FROM projection_projects
              WHERE project_id = ${input.projectId} AND deleted_at IS NULL
            `;
            if (placed === undefined || placed.spaceId !== space.id) {
              return yield* fail("not-found", "That Space or Project does not exist.");
            }
            yield* stillReaching([input.vaultId], space.id);
          }
          const current = yield* sql<{ readonly choice: string }>`
            SELECT choice FROM project_vault_choices
            WHERE project_id = ${input.projectId} AND group_id = ${input.vaultId}
          `;
          const was = current[0]?.choice ?? "inherit";
          if (was === input.choice) return;
          if (input.choice === "inherit") {
            yield* sql`
              DELETE FROM project_vault_choices
              WHERE project_id = ${input.projectId} AND group_id = ${input.vaultId}
            `;
          } else {
            yield* sql`
              INSERT INTO project_vault_choices (project_id, group_id, choice)
              VALUES (${input.projectId}, ${input.vaultId}, ${input.choice})
              ON CONFLICT (project_id, group_id) DO UPDATE SET choice = excluded.choice
            `;
          }
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.choose",
            spaceId: space.id,
            target: { kind: "vault", id: input.vaultId, name: row?.name ?? input.vaultId },
            detail: { scope: "project", projectId: input.projectId, choice: input.choice },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change the Project's Vaults")));
    return yield* choicesOf(can, space, allowed, input.projectId);
  });

  return Vaults.of({
    list,
    allow,
    choices,
    setSpaceDefaults,
    setProjectChoice,
    saveTargets,
    providerScopes,
    create,
    update,
    remove,
    listEntries,
    putEntry,
    deleteEntry,
    dismissUnlinked,
  });
});

/**
 * Every owner has its `default` group (owned-resources 03, 04): every User not removed and
 * every Organization not being deleted. Made with them (VaultGroups.ensureDefault); this catches
 * the rest.
 */
const ensureDefaultGroups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owners = yield* sql<{
    readonly ownerKind: "user" | "organization";
    readonly ownerId: string;
  }>`
    SELECT 'user' AS "ownerKind", user_id AS "ownerId" FROM users WHERE removed_at IS NULL
    UNION ALL
    SELECT 'organization', space_id FROM spaces
    WHERE kind = 'organization' AND deleting_at IS NULL
  `;
  for (const owner of owners) yield* VaultGroups.ensureDefault(sql, owner);
});

/**
 * Owned-resources 03: before any request, each value held by several entries (a former link's)
 * is copied under a new id for all but one. A crash midway leaves every entry deliverable and an
 * unheld copy the sweep removes; the next start finishes. Idempotent.
 */
export const unshareValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const values = yield* ServerSecretStore.VaultValueStore;
  const random = yield* SecureRandom.SecureRandom;
  const shared = yield* sql<{ readonly entryId: string; readonly valueId: string }>`
    SELECT entry_id AS "entryId", value_id AS "valueId" FROM vault_entries
    WHERE value_id IN (
      SELECT value_id FROM vault_entries WHERE value_id IS NOT NULL
      GROUP BY value_id HAVING COUNT(*) > 1
    )
    ORDER BY value_id, created_at, entry_id
  `;
  const first = new Set<string>();
  let copied = 0;
  for (const { entryId, valueId } of shared) {
    if (!first.has(valueId)) {
      first.add(valueId);
      continue;
    }
    const bytes = yield* values.get(valueId);
    // A value gone from the store is the next start's to find missing: nothing to copy.
    if (Option.isNone(bytes)) continue;
    const next = `value-${Buffer.from(yield* random.randomBytes(16)).toString("hex")}`;
    yield* values.set(next, bytes.value);
    yield* sql`
      UPDATE vault_entries SET value_id = ${next}
      WHERE entry_id = ${entryId} AND value_id = ${valueId}
    `;
    copied += 1;
  }
  if (copied > 0)
    yield* Effect.logInfo("Vaults: gave former Secret links their own values", { copied });
});

/**
 * Values no row points at (a write or deletion that stopped half-way, or an older database
 * restored): removed, so no sealed value outlives its secret. Only the Vault values' own folder.
 */
const sweepOrphanValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const values = yield* ServerSecretStore.VaultValueStore;
  const stored = yield* values.list;
  const held = new Set(
    (yield* sql<{ readonly valueId: string }>`
      SELECT value_id AS "valueId" FROM vault_entries WHERE value_id IS NOT NULL
    `).map((row) => row.valueId),
  );
  // Values living Threads received stay masked there (ticket 05); deleted and gone ones go.
  for (const valueId of yield* ThreadSecretValues.pruneAndListHeld(sql)) held.add(valueId);
  let removed = 0;
  for (const valueId of stored) {
    if (held.has(valueId)) continue;
    yield* values.remove(valueId).pipe(Effect.ignore);
    removed += 1;
  }
  if (removed > 0) yield* Effect.logInfo("Vaults: removed values no secret holds", { removed });
});

/**
 * The Hub's start: the database's key check first (a wrong key changes nothing in the database),
 * then every owner's `default`, former links' own values and the sweep. A joined machine has no
 * master key and no Vaults: nothing is
 * written and every call says so.
 */
export const layer = Layer.effect(
  Vaults,
  Effect.gen(function* () {
    const { keyring } = yield* ServerSecretStore.MasterKeyring;
    if (Option.isNone(keyring)) return unavailable;
    yield* VaultKeyCheck.checkDatabaseKey(keyring.value).pipe(
      Effect.catchTags({ SqlError: (cause) => Effect.die(cause) }),
    );
    yield* ensureDefaultGroups.pipe(Effect.orDie);
    // Before any request reads or writes an entry: a shared value is never replaced in place.
    yield* unshareValues.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Vaults: could not give former Secret links their own values", {
          cause,
        }),
      ),
    );
    yield* sweepOrphanValues.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Vaults: could not sweep values no secret holds", { cause }),
      ),
    );
    return yield* make;
  }),
);
