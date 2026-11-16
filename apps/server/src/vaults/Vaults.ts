/**
 * Vaults. Metadata in the database; each value a sealed entry of `VaultValueStore`, replaced by a
 * new one per write. Rights are AccessPolicy's `vault.*` via SpaceDirectory.authorizer. Only
 * `reveal` returns a value; everything is audited without one. See docs/internals/secrets.md.
 */
import {
  MAIN_VAULT_ID,
  type ProjectId,
  SECRET_MASK_MIN_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  secretNameRisk,
  type SpaceId,
  type ThreadId,
  type UserId,
  type VaultBrokenLink,
  type VaultCreateInput,
  type VaultDeleteInput,
  type VaultDeleteResult,
  type VaultEntriesListInput,
  type VaultEntriesListResult,
  type VaultEntry,
  type VaultEntryDeleteInput,
  type VaultEntryDeleteResult,
  type VaultEntryFromMainInput,
  VaultEntryId,
  type VaultEntryKind,
  type VaultEntryPutInput,
  type VaultEntryResult,
  VaultError,
  type VaultErrorReason,
  VaultId,
  type VaultEntryClass,
  type VaultProviderScopes,
  type VaultProviderScopesInput,
  ProviderScopeId,
  type SecretProviderId,
  looksLikeCredential,
  type VaultListResult,
  type VaultSummary,
  type VaultUpdateInput,
  type VaultWarning,
  type InstallationUser,
  // Spec 5 ticket 03.
  type VaultAllowance,
  type VaultAllowInput,
  type VaultChoices,
  type VaultChoicesInput,
  type VaultProjectChoiceSetInput,
  type VaultSpaceDefaultsSetInput,
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
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { projectSpaceSql } from "../spaces/SpaceDirectory.ts";
import * as ProviderReads from "./ProviderReads.ts";
import { pathsOf } from "./providerScopeRules.ts";
import * as ThreadSecretValues from "./ThreadSecretValues.ts";
import * as VaultKeyCheck from "./VaultKeyCheck.ts";
import * as VaultReach from "./VaultReach.ts";
import * as VaultReachLoss from "./VaultReachLoss.ts";

const MAIN_VAULT_NAME = "Main vault";

export interface RevealedSecret {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export class Vaults extends Context.Service<
  Vaults,
  {
    /** The Vaults the acting User sees, the Main vault first. */
    readonly list: Effect.Effect<VaultListResult, VaultError>;
    readonly create: (input: VaultCreateInput) => Effect.Effect<VaultSummary, VaultError>;
    readonly update: (input: VaultUpdateInput) => Effect.Effect<VaultSummary, VaultError>;
    readonly remove: (input: VaultDeleteInput) => Effect.Effect<VaultDeleteResult, VaultError>;
    readonly listEntries: (
      input: VaultEntriesListInput,
    ) => Effect.Effect<VaultEntriesListResult, VaultError>;
    readonly putEntry: (input: VaultEntryPutInput) => Effect.Effect<VaultEntryResult, VaultError>;
    readonly deleteEntry: (
      input: VaultEntryDeleteInput,
    ) => Effect.Effect<VaultEntryDeleteResult, VaultError>;
    readonly linkEntry: (
      input: VaultEntryFromMainInput,
    ) => Effect.Effect<VaultEntryResult, VaultError>;
    readonly copyEntry: (
      input: VaultEntryFromMainInput,
    ) => Effect.Effect<VaultEntryResult, VaultError>;
    /**
     * Refuses, as `reveal` would, before the door asks for a strong factor: nobody but whom the
     * policy lets reveal ever has a proof checked.
     */
    readonly authorizeReveal: (input: {
      readonly vaultId: VaultId;
      readonly entryId: VaultEntryId;
    }) => Effect.Effect<void, VaultError>;
    /**
     * A secret's value, for the acting User when the policy lets them reveal it (the Owner),
     * audited before it is handed out. The door asks for the strong factor first.
     */
    readonly reveal: (input: {
      readonly vaultId: VaultId;
      readonly entryId: VaultEntryId;
    }) => Effect.Effect<RevealedSecret, VaultError>;
    // Spec 5 ticket 03: allowances and choices. What a Thread receives is EffectiveVaults'.
    /** `vaults.allow`: the Owner allows one of their Vaults to a Space or a User, or takes it back. */
    readonly allow: (input: VaultAllowInput) => Effect.Effect<VaultSummary, VaultError>;
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
    }) => Effect.Effect<ReadonlyArray<VaultSummary>, VaultError>;
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

interface VaultRow {
  readonly vaultId: string;
  readonly name: string;
  readonly description: string | null;
  readonly spaceId: string | null;
  readonly isMain: number;
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
  readonly linkedEntryId: string | null;
  readonly valueId: string | null;
  readonly unmasked: number;
  /** Null on a link: its original's. */
  readonly class: VaultEntryClass | null;
  readonly revealable: number | null;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  /** A link's original, when it still exists in the Main vault. */
  readonly linkedName: string | null;
  readonly linkedUnmasked: number | null;
  readonly linkedValueId: string | null;
  readonly linkedClass: VaultEntryClass | null;
  readonly linkedRevealable: number | null;
  /** A Provider entry's provider (a key of `settings.secretProviders`) and reference. */
  readonly providerId: string | null;
  readonly providerReference: string | null;
  /** Its Provider scope (ticket 03), and that scope's label; null: the Owner's «Direct». */
  readonly providerScopeId: string | null;
  readonly scopeLabel: string | null;
}

/** An entry's class: a link's original's; a broken link's, a Secret. */
const classOf = (row: EntryRow): VaultEntryClass =>
  (row.kind === "link" ? row.linkedClass : row.class) ?? "secret";

/** A Secret nobody reveals: a broken link's too. */
const isSealed = (row: EntryRow): boolean =>
  classOf(row) === "secret" &&
  (row.kind === "link"
    ? row.linkedName === null || row.linkedRevealable !== 1
    : row.revealable !== 1);

/** The store entry holding what an entry delivers: a link's original's. */
const valueIdOf = (row: EntryRow): string | null =>
  row.kind === "link" ? row.linkedValueId : row.valueId;

const VAULT_COLUMNS = `
  v.vault_id AS "vaultId", v.name AS "name", v.description AS "description",
  v.space_id AS "spaceId", v.is_main AS "isMain", v.archived_at AS "archivedAt",
  v.created_at AS "createdAt", v.updated_at AS "updatedAt",
  (SELECT COUNT(*) FROM vault_entries e WHERE e.vault_id = v.vault_id) AS "entryCount"
`;

const ENTRY_COLUMNS = `
  e.entry_id AS "entryId", e.vault_id AS "vaultId", e.name AS "name",
  e.description AS "description", e.kind AS "kind", e.linked_entry_id AS "linkedEntryId",
  e.value_id AS "valueId", e.unmasked AS "unmasked", e.class AS "class",
  e.revealable AS "revealable", e.version AS "version",
  e.updated_at AS "updatedAt", e.updated_by AS "updatedBy",
  o.name AS "linkedName", o.unmasked AS "linkedUnmasked", o.value_id AS "linkedValueId",
  o.class AS "linkedClass", o.revealable AS "linkedRevealable",
  e.provider_id AS "providerId", e.provider_reference AS "providerReference",
  e.provider_scope_id AS "providerScopeId", s.label AS "scopeLabel"
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

/** What deciding on Vaults needs: their Spaces, allowances, and the allowed Users' names. */
interface Known {
  readonly spaces: Spaces;
  readonly allowances: ReadonlyMap<string, ReadonlyArray<AllowanceRow>>;
  readonly userNames: ReadonlyMap<string, string>;
}

const mainResource: AccessPolicy.VaultResource = {
  kind: "vault",
  isMain: true,
  space: null,
  allowedSpaces: [],
  allowedUsers: [],
};

/**
 * A Vault of a deleted Organization is the Owner's alone, like the Owner's own. Allowances count
 * only on the Owner's own Vaults other than the Main vault, as in VaultReach.
 */
const resourceOf = (row: VaultRow, known: Known): AccessPolicy.VaultResource => {
  const counts = row.isMain === 0 && row.spaceId === null;
  const allowances = counts ? (known.allowances.get(row.vaultId) ?? []) : [];
  return {
    kind: "vault",
    isMain: row.isMain === 1,
    space:
      row.spaceId === null ? null : (known.spaces.get(row.spaceId as SpaceId)?.resource ?? null),
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

const summaryOf = (row: VaultRow, known: Known, can: Can): VaultSummary => {
  const spaces = known.spaces;
  const resource = resourceOf(row, known);
  const canManage = can("vault.manage", resource);
  return {
    id: VaultId.make(row.vaultId),
    name: row.name,
    description: row.description,
    spaceId: row.spaceId as SpaceId | null,
    spaceName: row.spaceId === null ? null : (spaces.get(row.spaceId as SpaceId)?.name ?? null),
    isMain: row.isMain === 1,
    archived: row.archivedAt !== null,
    entryCount: row.entryCount,
    canEdit: row.archivedAt === null && can("vault.edit", resource),
    canManage,
    canReveal: can("vault.reveal", resource),
    // Whom a Vault reaches is the Owner's to know.
    allowances: canManage ? allowancesShown(row, known) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/**
 * A secret's name and what it is. A link's original is the Main vault's: whoever does not see the
 * Main vault learns nothing of it (whether it is short, or gone) beyond the link's own row; its
 * editors learn that it broke.
 */
const entryOf = (
  row: EntryRow,
  seesMain: boolean,
  canEdit: boolean,
  variableValue: string | undefined,
  provider: ProviderReads.ProviderStatus | undefined,
): VaultEntry => {
  const isLink = row.kind === "link";
  // A Provider entry whose provider is gone (or cannot be read here) is broken for everyone.
  const providerBroken = row.kind === "provider" && (provider === undefined || provider.broken);
  const broken = (isLink && row.linkedName === null) || providerBroken;
  const entryClass = classOf(row);
  return {
    id: VaultEntryId.make(row.entryId),
    vaultId: VaultId.make(row.vaultId),
    name: row.name,
    description: row.description,
    kind: row.kind,
    class: entryClass,
    sealed: isSealed(row),
    ...(entryClass === "variable" && variableValue !== undefined ? { value: variableValue } : {}),
    ...(row.kind === "provider"
      ? {
          provider: {
            label: provider?.label ?? null,
            // Where it reads is its editors' to know, as a link's original is the Owner's.
            reference: canEdit ? row.providerReference : null,
            scope: row.providerScopeId === null ? null : (row.scopeLabel ?? null),
          },
        }
      : {}),
    broken: providerBroken || (broken && (seesMain || canEdit)),
    linkedFrom:
      seesMain && isLink && row.linkedEntryId !== null && !broken
        ? { entryId: VaultEntryId.make(row.linkedEntryId), name: row.linkedName ?? "" }
        : null,
    unmasked: isLink ? seesMain && row.linkedUnmasked === 1 : row.unmasked === 1,
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
  linkEntry: refuse,
  copyEntry: refuse,
  authorizeReveal: refuse,
  reveal: refuse,
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

  /** In a write's transaction: the Vault exists and its Organization is not being deleted. */
  const stillWritable = (vaultId: string) =>
    sql<{ readonly spaceId: string | null }>`
      SELECT space_id AS "spaceId" FROM vaults WHERE vault_id = ${vaultId}
    `.pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? fail("not-found", NOT_FOUND)
          : row.spaceId === null
            ? Effect.void
            : Effect.flatMap(spaceTakesVaults(row.spaceId), (alive) =>
                alive ? Effect.void : fail("not-found", NOT_FOUND),
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
            SELECT vault_id AS "vaultId", subject_kind AS "subjectKind", subject_id AS "subjectId"
            FROM vault_allowances WHERE vault_id IN ${sql.in(vaultIds)}
            ORDER BY subject_kind, subject_id
          `.pipe(Effect.catch(storage("read whom the Vaults are allowed to")));
    const allowances = new Map<string, Array<AllowanceRow>>();
    for (const allowance of allowanceRows) {
      const list = allowances.get(allowance.vaultId) ?? [];
      list.push(allowance);
      allowances.set(allowance.vaultId, list);
    }
    const spaceIds = new Set<SpaceId>();
    for (const row of rows) if (row.spaceId !== null) spaceIds.add(row.spaceId as SpaceId);
    for (const allowance of allowanceRows) {
      if (allowance.subjectKind === "space") spaceIds.add(allowance.subjectId as SpaceId);
    }
    const known = yield* spaces
      .spacesById([...spaceIds])
      .pipe(Effect.catch(storage("read the Vaults' Organizations")));
    const userNames = new Map<string, string>();
    const base: Known = { spaces: known, allowances, userNames };
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
    sql<VaultRow>`SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v WHERE v.vault_id = ${vaultId}`.pipe(
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
    if (!can(action, resource)) {
      return yield* fail(
        "forbidden",
        action === "vault.edit"
          ? resource.isMain || resource.space === null
            ? "Only the Owner edits this Vault."
            : "Only the Owner and the Organization's Admins edit this Vault's secrets."
          : action === "vault.reveal"
            ? "Only the Owner reveals a secret's value."
            : "Only the Owner manages Vaults.",
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
            `${name} changes how the agent's tools run or whom they trust: only the Owner sets it.`,
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
    LEFT JOIN vault_entries o ON o.entry_id = e.linked_entry_id AND o.vault_id = '${MAIN_VAULT_ID}'
    LEFT JOIN secret_provider_scopes s ON s.scope_id = e.provider_scope_id
  `;

  const entriesOf = (vaultId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)} ${sql.literal(ENTRY_FROM)}
      WHERE e.vault_id = ${vaultId}
      ORDER BY e.name
    `.pipe(Effect.catch(storage("read the Vault's secrets")));

  const findEntry = (vaultId: string, entryId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)} ${sql.literal(ENTRY_FROM)}
      WHERE e.vault_id = ${vaultId} AND e.entry_id = ${entryId}
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
      SELECT entry_id AS "entryId" FROM vault_entries WHERE vault_id = ${vaultId} AND name = ${name}
    `.pipe(
      Effect.map((rows) => rows.some((row) => row.entryId !== except)),
      Effect.catch(storage("read the Vault's secrets")),
      Effect.flatMap((taken) =>
        taken
          ? fail("duplicate-name", `This Vault already has a secret named ${name}.`)
          : Effect.void,
      ),
    );

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
    readonly brokenLinks?: number;
    readonly dangerous?: boolean;
    readonly class?: VaultEntryClass;
    /** A Provider entry's provider, by its label; never its reference. */
    readonly provider?: string;
  }) =>
    audit.record({
      actor: AuditLog.userActor(input.userId),
      action: "secret.edit",
      spaceId: input.vault.spaceId as SpaceId | null,
      target: { kind: "secret", id: input.entryId, name: input.name },
      detail: {
        vault: input.vault.name,
        vaultId: input.vault.vaultId,
        kind: input.kind,
        op: input.op,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.brokenLinks === undefined ? {} : { brokenLinks: input.brokenLinks }),
        ...(input.dangerous === true ? { dangerous: true } : {}),
        ...(input.class === undefined ? {} : { class: input.class }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
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
    const seesMain = can("vault.view", mainResource);
    const canEdit = can("vault.edit", resource);
    const readsVariables = can("vault.readVariables", resource);
    return yield* Effect.forEach(rows, (row) =>
      Effect.all([
        readsVariables && classOf(row) === "variable" && valueIdOf(row) !== null
          ? readValue(valueIdOf(row)).pipe(Effect.orElseSucceed(() => undefined))
          : Effect.succeed(undefined),
        providerStatusOf(row),
      ]).pipe(Effect.map(([value, provider]) => entryOf(row, seesMain, canEdit, value, provider))),
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

  const list = Effect.gen(function* () {
    const who = yield* caller;
    const { can } = who;
    const rows = yield* sql<VaultRow>`
      SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v ORDER BY v.is_main DESC, v.position, v.name
    `.pipe(Effect.catch(storage("read the Vaults")));
    const known = yield* spacesOf(rows, who);
    const vaults = rows
      .filter((row) => can("vault.view", resourceOf(row, known)))
      .map((row) => summaryOf(row, known, can));
    return { vaults };
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
      JOIN vault_provider_scopes a ON a.scope_id = s.scope_id AND a.vault_id = ${row.vaultId}
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
    const reaching = new Set<string>(
      (yield* VaultReach.allowedToSpace(sql, placement.value.space.id).pipe(
        Effect.catch(storage("read the Vaults allowed to the Space")),
      )).map((reach) => reach.vaultId),
    );
    const rows = yield* sql<VaultRow>`
      SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v ORDER BY v.is_main DESC, v.position, v.name
    `.pipe(Effect.catch(storage("read the Vaults")));
    const known = yield* spacesOf(rows, who);
    return rows
      .filter((row) => reaching.has(row.vaultId))
      .map((row) => summaryOf(row, known, who.can))
      .filter((summary) => summary.canEdit);
  });

  const create = Effect.fn("Vaults.create")(function* (input: VaultCreateInput) {
    const { userId, can } = yield* caller;
    let space: AccessPolicy.SpaceResource | null = null;
    if (input.spaceId !== null) {
      const found = yield* spaces
        .spaceById(input.spaceId)
        .pipe(Effect.catch(storage("read the Organization")));
      if (Option.isNone(found) || found.value.resource.kind !== "organization") {
        return yield* fail("not-found", "A Vault belongs to an Organization, or to the Owner.");
      }
      space = found.value.resource;
    }
    if (
      !can("vault.manage", {
        kind: "vault",
        isMain: false,
        space,
        allowedSpaces: [],
        allowedUsers: [],
      })
    ) {
      return yield* fail("forbidden", "Only the Owner creates Vaults.");
    }
    const vaultId = yield* newId("vault");
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.spaceId !== null && !(yield* spaceTakesVaults(input.spaceId))) {
            return yield* fail("not-found", "A Vault belongs to an Organization, or to the Owner.");
          }
          const taken = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM vaults WHERE name = ${input.name} COLLATE NOCASE
          `;
          if ((taken[0]?.n ?? 0) > 0) {
            return yield* fail("duplicate-name", `There is already a Vault named ${input.name}.`);
          }
          yield* sql`
            INSERT INTO vaults (vault_id, name, description, space_id, is_main, created_at, updated_at, created_by)
            VALUES (${vaultId}, ${input.name}, ${input.description ?? null}, ${input.spaceId}, 0, ${at}, ${at}, ${userId})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.create",
            spaceId: input.spaceId,
            target: { kind: "vault", id: vaultId, name: input.name },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("create the Vault")));
    const row = yield* findVault(vaultId);
    if (Option.isNone(row)) return yield* fail("not-found", NOT_FOUND);
    return summaryOf(row.value, yield* spacesOf([row.value], { userId, can }), can);
  });

  const update = Effect.fn("Vaults.update")(function* (input: VaultUpdateInput) {
    const { userId, can, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    const renamed = input.name !== undefined && input.name !== row.name;
    if (row.isMain === 1 && (renamed || input.archived !== undefined)) {
      return yield* fail("main-vault", "The Main vault keeps its name and is never archived.");
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
              SELECT COUNT(*) AS n FROM vaults
              WHERE name = ${input.name ?? ""} COLLATE NOCASE AND vault_id <> ${row.vaultId}
            `;
            if ((taken[0]?.n ?? 0) > 0) {
              return yield* fail(
                "duplicate-name",
                `There is already a Vault named ${input.name ?? ""}.`,
              );
            }
          }
          yield* sql`
            UPDATE vaults SET
              name = ${input.name ?? row.name},
              description = ${input.description === undefined ? row.description : input.description},
              archived_at = ${archivedAt},
              updated_at = ${at}
            WHERE vault_id = ${row.vaultId}
          `;
          if (renamed || described || archiveChanged) {
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "vault.update",
              spaceId: row.spaceId as SpaceId | null,
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

  const remove = Effect.fn("Vaults.remove")(function* (input: VaultDeleteInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    if (row.isMain === 1) {
      return yield* fail("main-vault", "The Main vault is never deleted.");
    }
    // The values the deleted rows held, read in the same transaction that deletes them.
    const removed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const gone = yield* VaultReachLoss.forgetVault(sql, row.vaultId);
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.delete",
            spaceId: row.spaceId as SpaceId | null,
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
      vault: summaryOf(row, known, can),
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
    if (input.value !== undefined || input.class !== undefined || input.allowReveal !== undefined) {
      return yield* fail(
        "invalid-value",
        "A Provider entry is a sealed Secret read from its provider: it takes no value, class or reveal.",
      );
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
              INSERT INTO vault_entries (entry_id, vault_id, name, description, kind, value_id,
                unmasked, class, revealable, provider_id, provider_reference, provider_scope_id,
                version, created_at, updated_at, updated_by)
              VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null},
                'provider', NULL, 0, 'secret', 0, ${source.providerId}, ${source.reference},
                ${source.scopeId}, 1, ${at}, ${at}, ${userId})
            `;
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
      return yield* result(can, resource, row.vaultId, entryId, []);
    }
    const renamed = input.name !== existing.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, existing.entryId);
    const described = input.description !== undefined && input.description !== existing.description;
    const moved =
      source.providerId !== existing.providerId ||
      source.reference !== existing.providerReference ||
      source.scopeId !== existing.providerScopeId;
    if (!renamed && !described && !moved) {
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
            op: moved ? "reference" : renamed ? "rename" : "describe",
            ...(renamed ? { from: existing.name } : {}),
            dangerous,
            provider: label,
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change the Provider entry")));
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
      // A new Secret is sealed unless reveal is allowed now, with its value.
      const entryClass = input.class ?? "secret";
      const revealable = entryClass === "secret" && input.allowReveal === true ? 1 : 0;
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      yield* withNewValue(value, "add the secret", (valueId) =>
        Effect.gen(function* () {
          yield* stillWritable(row.vaultId);
          yield* sql`
            INSERT INTO vault_entries (entry_id, vault_id, name, description, kind, value_id, unmasked, class, revealable, version, created_at, updated_at, updated_by)
            VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null}, 'own', ${valueId}, ${isShort(value) ? 1 : 0}, ${entryClass}, ${revealable}, 1, ${at}, ${at}, ${userId})
          `;
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
      return yield* result(can, resource, row.vaultId, entryId, warningsFor(entryClass, true));
    }

    const entry = yield* findEntry(row.vaultId, input.entryId);
    if (entry.kind === "link") {
      if (value !== undefined) {
        return yield* fail(
          "not-linkable",
          `${entry.name} is a Secret link: its value is the Main vault's. Replace the original there, or delete the link and add a secret of this Vault's own.`,
        );
      }
      if (input.class !== undefined || input.allowReveal !== undefined) {
        return yield* fail(
          "not-linkable",
          `${entry.name} is a Secret link: it is what its original in the Main vault is. Change the original there.`,
        );
      }
    }
    // A name that changes how tools run stays the Owner's, whatever the change.
    yield* checkName(entry.name, can, resource, input.confirmDangerous);
    const renamed = input.name !== entry.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, entry.entryId);
    const described = input.description !== undefined && input.description !== entry.description;

    // Class and reveal: sealing is one way; undoing it, or showing a Secret as a Variable, takes a
    // new value in the same request, so the old one is never read for it.
    const wasClass = classOf(entry);
    const wasRevealable = wasClass === "secret" && entry.revealable === 1;
    const nextClass = input.class ?? wasClass;
    const classChanged = entry.kind !== "link" && nextClass !== wasClass;
    if (classChanged && nextClass === "variable" && value === undefined) {
      return yield* fail(
        "needs-new-value",
        `Making ${entry.name} a Variable takes a new value: a Secret's is never shown.`,
      );
    }
    const nextRevealable =
      entry.kind === "link" || nextClass === "variable"
        ? false
        : input.allowReveal === undefined
          ? classChanged
            ? false
            : wasRevealable
          : input.allowReveal;
    if (nextRevealable && !(wasRevealable && !classChanged) && value === undefined) {
      return yield* fail(
        "needs-new-value",
        `${entry.name} is sealed: allowing reveal takes a new value, so the sealed one is never read.`,
      );
    }
    const revealChanged =
      !classChanged && entry.kind !== "link" && nextRevealable !== wasRevealable;
    if (value === undefined && !renamed && !described && !classChanged && !revealChanged) {
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
            class = ${entry.kind === "link" ? null : nextClass},
            revealable = ${entry.kind === "link" ? null : nextRevealable ? 1 : 0},
            version = version + ${value === undefined ? 0 : 1},
            updated_at = ${at},
            updated_by = ${userId}
          WHERE entry_id = ${entry.entryId}
        `;
        const edit = { userId, vault: row, entryId: entry.entryId, name: input.name };
        if (classChanged) {
          yield* recordEdit({ ...edit, kind: entry.kind, op: "class", class: nextClass });
        } else if (revealChanged) {
          yield* recordEdit({
            ...edit,
            kind: entry.kind,
            op: nextRevealable ? "allow-reveal" : "seal",
          });
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
        return valueId === null ? null : before.valueId;
      }),
    );
    yield* removeValue(replaced);
    return yield* result(
      can,
      resource,
      row.vaultId,
      entry.entryId,
      warningsFor(nextClass, value !== undefined || renamed || classChanged),
    );
  });

  const linksTo = (entryId: string) =>
    sql<VaultBrokenLink>`
      SELECT e.vault_id AS "vaultId", v.name AS "vaultName", e.entry_id AS "entryId", e.name AS "name"
      FROM vault_entries e JOIN vaults v ON v.vault_id = e.vault_id
      WHERE e.kind = 'link' AND e.linked_entry_id = ${entryId}
      ORDER BY v.name, e.name
    `.pipe(Effect.catch(storage("read the Secret links")));

  const deleteEntry = Effect.fn("Vaults.deleteEntry")(function* (input: VaultEntryDeleteInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.edit");
    const entry = yield* findEntry(row.vaultId, input.entryId);
    // Only the Main vault's secrets have links, and only the Owner edits it: the list is theirs.
    const links = row.vaultId === MAIN_VAULT_ID ? yield* linksTo(entry.entryId) : [];
    if (links.length > 0 && input.breakLinks !== true) {
      return { deleted: false, brokenLinks: links } satisfies VaultEntryDeleteResult;
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
            ...(links.length > 0 ? { brokenLinks: links.length } : {}),
          });
          return deleted[0]?.valueId ?? null;
        }),
      )
      .pipe(Effect.catch(orStorage("delete the secret")));
    yield* removeValue(gone);
    return { deleted: true, brokenLinks: links } satisfies VaultEntryDeleteResult;
  });

  /**
   * A link to, or a copy of, a Main vault secret: it takes editing the Main vault (the Owner) as
   * well as the Vault it goes into, so no one reaches a Main vault value through another Vault.
   */
  const fromMain = Effect.fn("Vaults.fromMain")(function* (
    input: VaultEntryFromMainInput,
    kind: "link" | "copy",
  ) {
    const { userId, can, row, resource } = yield* authorizeVault(input.vaultId, "vault.edit");
    if (!can("vault.edit", mainResource)) {
      return yield* fail("forbidden", "Only the Owner links or copies the Main vault's secrets.");
    }
    if (row.vaultId === MAIN_VAULT_ID) {
      return yield* fail(
        "not-linkable",
        "Secret links and copies go into another Vault, not the Main vault itself.",
      );
    }
    const source = yield* findEntry(MAIN_VAULT_ID, input.sourceEntryId);
    if (source.kind === "link") {
      return yield* fail("not-linkable", "A Secret link points at a secret, never at a link.");
    }
    // Copying would read the provider into the Hub (ticket 08's «Copy into the Hub»).
    if (source.kind === "provider") {
      return yield* fail(
        "not-linkable",
        `${source.name} is read from a provider: add a Provider entry with the same reference in this Vault instead.`,
      );
    }
    const name = input.name ?? source.name;
    const dangerous = yield* checkName(name, can, resource, input.confirmDangerous);
    yield* nameTaken(row.vaultId, name);
    const entryId = yield* newId("secret");
    const at = yield* now;
    const description = input.description === undefined ? source.description : input.description;
    const copied = kind === "copy" ? yield* readValue(source.valueId) : undefined;
    yield* withNewValue(copied, `add the ${kind}`, (valueId) =>
      Effect.gen(function* () {
        yield* stillWritable(row.vaultId);
        yield* sql`
          INSERT INTO vault_entries (entry_id, vault_id, name, description, kind, linked_entry_id, value_id, unmasked, class, revealable, version, created_at, updated_at, updated_by)
          VALUES (${entryId}, ${row.vaultId}, ${name}, ${description}, ${kind}, ${kind === "link" ? source.entryId : null}, ${valueId}, ${source.unmasked},
            ${kind === "link" ? null : classOf(source)}, ${kind === "link" ? null : source.revealable === 1 ? 1 : 0},
            1, ${at}, ${at}, ${userId})
        `;
        yield* recordEdit({
          userId,
          vault: row,
          entryId,
          name,
          kind,
          op: kind,
          from: source.name,
          dangerous,
        });
      }),
    );
    const warnings: ReadonlyArray<VaultWarning> =
      classOf(source) === "secret" && source.unmasked === 1 ? ["short-value"] : [];
    return yield* result(can, resource, row.vaultId, entryId, warnings);
  });

  /** An entry the Owner may reveal: refused before its value is read, a sealed one always. */
  const revealable = Effect.fn("Vaults.revealable")(function* (input: {
    readonly vaultId: VaultId;
    readonly entryId: VaultEntryId;
  }) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.reveal");
    const entry = yield* findEntry(row.vaultId, input.entryId);
    if (entry.kind === "link" && entry.linkedName === null) {
      return yield* fail("not-found", `${entry.name} is a broken link: its original is gone.`);
    }
    if (isSealed(entry)) {
      return yield* fail(
        "sealed",
        `${entry.name} is sealed: nobody reveals it, not even the Owner. Replace it or delete it.`,
      );
    }
    return { userId, row, entry };
  });

  const reveal = Effect.fn("Vaults.reveal")(function* (input: {
    readonly vaultId: VaultId;
    readonly entryId: VaultEntryId;
  }) {
    const { userId, row, entry } = yield* revealable(input);
    const value = yield* readValue(valueIdOf(entry));
    // Recorded before the value leaves: one whose reveal could not be recorded is not shown.
    yield* audit
      .record({
        actor: AuditLog.userActor(userId),
        action: "secret.reveal",
        spaceId: row.spaceId as SpaceId | null,
        target: { kind: "secret", id: entry.entryId, name: entry.name },
        detail: { vault: row.name, vaultId: row.vaultId, kind: entry.kind },
      })
      .pipe(Effect.catch(storage("record the reveal")));
    return { name: entry.name, value: Redacted.make(value) } satisfies RevealedSecret;
  });

  const authorizeReveal = Effect.fn("Vaults.authorizeReveal")(function* (input: {
    readonly vaultId: VaultId;
    readonly entryId: VaultEntryId;
  }) {
    yield* revealable(input);
  });

  // Spec 5 ticket 03: allowances, a Space's defaults and a Project's choices. Which Vaults may
  // reach a Space is VaultReach's rule; what a Thread receives is EffectiveVaults'.

  const allow = Effect.fn("Vaults.allow")(function* (input: VaultAllowInput) {
    const { userId, can, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    if (row.isMain === 1) {
      return yield* fail(
        "main-vault",
        "The Main vault reaches only your Personal space: link or copy its secrets into another Vault.",
      );
    }
    if (row.spaceId !== null) {
      return yield* fail(
        "not-allowed",
        "An Organization's Vault reaches its own Organization only: its Admins edit it.",
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
            WHERE vault_id = ${row.vaultId} AND subject_kind = ${subject.kind} AND subject_id = ${subjectId}
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
              INSERT INTO vault_allowances (vault_id, subject_kind, subject_id, created_at)
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
              SELECT vault_id AS "vaultId", name FROM vault_entries
              WHERE vault_id IN ${sql.in(allowed.map((row) => row.vaultId))} ORDER BY name
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
            SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v
            WHERE v.vault_id IN ${sql.in(allowed.map((row) => row.vaultId))}
          `.pipe(Effect.catch(storage("read the Space's Vaults")));
    const known = yield* spacesOf(rows);
    const visible = new Set(
      rows.filter((row) => can("vault.view", resourceOf(row, known))).map((row) => row.vaultId),
    );
    return {
      spaceId: space.id,
      projectId,
      canChoose: can("vault.choose", space),
      allowed: allowed.map((row) => ({
        vaultId: row.vaultId,
        name: row.name,
        isMain: row.isMain,
        archived: row.archived,
        names: visible.has(row.vaultId)
          ? names.filter((entry) => entry.vaultId === row.vaultId).map((entry) => entry.name)
          : [],
      })),
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
        ? "Only the Owner chooses the Vaults of a Personal space."
        : "Only the Owner and the Organization's Admins choose its Vaults.",
    );

  const notAllowedHere = (vaultId: string) =>
    fail(
      "not-allowed",
      `${vaultId === MAIN_VAULT_ID ? "The Main vault" : "That Vault"} is not allowed to this Space: the Owner allows Vaults in Settings → Vaults.`,
    );

  const setSpaceDefaults = Effect.fn("Vaults.setSpaceDefaults")(function* (
    input: VaultSpaceDefaultsSetInput,
  ) {
    const { userId, can, space, allowed } = yield* choiceSpace({ spaceId: input.spaceId });
    if (!can("vault.choose", space)) return yield* refuseChoice(space);
    const byId = new Map<string, VaultReach.ReachRow>(allowed.map((row) => [row.vaultId, row]));
    const fixed = new Set<string>(VaultReach.fixedDefaults(allowed));
    // What the Space received as defaults: the stored ones still allowed (stale rows are not).
    const effectiveBefore = (stored: ReadonlyArray<VaultId>) =>
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
      // A fixed default (the Main vault in the Owner's Personal space) is never a chosen one.
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
              INSERT INTO space_default_vaults (space_id, vault_id, position)
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
        "The Main vault is always a default of your Personal space: a Project neither adds nor removes it.",
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
            WHERE project_id = ${input.projectId} AND vault_id = ${input.vaultId}
          `;
          const was = current[0]?.choice ?? "inherit";
          if (was === input.choice) return;
          if (input.choice === "inherit") {
            yield* sql`
              DELETE FROM project_vault_choices
              WHERE project_id = ${input.projectId} AND vault_id = ${input.vaultId}
            `;
          } else {
            yield* sql`
              INSERT INTO project_vault_choices (project_id, vault_id, choice)
              VALUES (${input.projectId}, ${input.vaultId}, ${input.choice})
              ON CONFLICT (project_id, vault_id) DO UPDATE SET choice = excluded.choice
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
    authorizeReveal,
    create,
    update,
    remove,
    listEntries,
    putEntry,
    deleteEntry,
    linkEntry: Effect.fn("Vaults.linkEntry")((input: VaultEntryFromMainInput) =>
      fromMain(input, "link"),
    ),
    copyEntry: Effect.fn("Vaults.copyEntry")((input: VaultEntryFromMainInput) =>
      fromMain(input, "copy"),
    ),
    reveal,
  });
});

/** The Main vault exists from the start: the Owner's, never deleted. */
const ensureMainVault = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO vaults (vault_id, name, description, space_id, is_main, position, created_at, updated_at)
    VALUES (${MAIN_VAULT_ID}, ${MAIN_VAULT_NAME}, NULL, NULL, 1, 0, ${at}, ${at})
    ON CONFLICT (vault_id) DO NOTHING
  `;
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
 * then the Main vault and the sweep. A joined machine has no master key and no Vaults: nothing is
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
    yield* ensureMainVault.pipe(Effect.orDie);
    yield* sweepOrphanValues.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Vaults: could not sweep values no secret holds", { cause }),
      ),
    );
    return yield* make;
  }),
);
