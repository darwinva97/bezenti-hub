/**
 * The only place that computes which secrets a Thread's turn, terminal or script receives for the
 * User who starts it: value ids, never values, recomputed on every call. Rule and precedence (User,
 * then Project, then Space): docs/internals/secrets.md, «The effective set».
 */
import {
  ProjectId,
  secretNameRisk,
  type SpaceId,
  ThreadId,
  type UserId,
  type VaultEntryClass,
  VaultEntryId,
  VaultError,
  type VaultErrorReason,
  VaultId,
  type VaultShadowed,
  type VaultSource,
  type VaultThreadEnvironment,
  type VaultThreadEnvironmentInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { AI_CREDENTIAL_PREFIX_LENGTH } from "../ai/aiCredentialValue.ts";
import * as ServerConfig from "../config.ts";
import type * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultReach from "./VaultReach.ts";

/** One variable of the effective set. */
export interface EffectiveVariable {
  readonly name: string;
  readonly description: string | null;
  readonly entryId: VaultEntryId;
  readonly vaultId: VaultId;
  readonly vaultName: string;
  readonly source: VaultSource;
  /**
   * The VaultValueStore entry holding the value (a link's original's): read by delivery alone.
   * A new id after every replace, so it also says whether the value changed.
   */
  readonly valueId: string;
  /** A link's original's. A Variable is never masked. */
  readonly class: VaultEntryClass;
  readonly unmasked: boolean;
  /** A name that changes how tools run; only the Owner sets one (`secretNameRisk`). */
  readonly dangerous: boolean;
  /** The Vaults that also define it and lost, in precedence order. */
  readonly shadowed: ReadonlyArray<VaultShadowed>;
}

export interface EffectiveSet {
  readonly threadId: ThreadId;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  /** The Vaults it draws from, in the order that wins. */
  readonly vaults: ReadonlyArray<{
    readonly vaultId: VaultId;
    readonly name: string;
    readonly source: VaultSource;
  }>;
  /** By name. */
  readonly variables: ReadonlyArray<EffectiveVariable>;
}

export class EffectiveVaults extends Context.Service<
  EffectiveVaults,
  {
    /**
     * What a turn, terminal or script of the Thread receives when `actingUserId` starts it. Fails
     * `not-found` for a missing Thread and `forbidden` when the User no longer works in its Space.
     */
    readonly forThread: (input: {
      readonly threadId: ThreadId;
      readonly actingUserId: UserId;
    }) => Effect.Effect<EffectiveSet, VaultError>;
    /**
     * `forThread` for a Thread whose creation is being written (no row to read its Space from):
     * its own Space, else its Project's. SecretMasker masks its first events with it.
     */
    readonly forPlacement: (input: {
      readonly threadId: ThreadId;
      readonly spaceId: SpaceId | undefined;
      readonly projectId: ProjectId | null;
      readonly actingUserId: UserId;
    }) => Effect.Effect<EffectiveSet, VaultError>;
    /**
     * `vaults.threadEnvironment`: the names the calling User's turns in a Thread they see would
     * receive, and which Vault wins each. Never values or value ids.
     */
    readonly threadEnvironment: (
      input: VaultThreadEnvironmentInput,
    ) => Effect.Effect<VaultThreadEnvironment, VaultError>;
    /**
     * Spec 5 ticket 07: the Vaults a Project's Threads receive from Space `from`'s side (its
     * defaults, the Project's adds and removes there) and would not from `to`'s, by the same
     * Space-side rule as `forThread`: what the mover is warned of. A User's own Vaults follow the
     * User, never listed. Names only.
     */
    readonly projectMoveLoss: (input: {
      readonly projectId: ProjectId;
      readonly from: SpaceId;
      readonly to: SpaceId;
    }) => Effect.Effect<ReadonlyArray<SpaceSideVault>, VaultError>;
  }
>()("t3/vaults/EffectiveVaults") {}

/** A Vault a Project receives from its Space's side. */
export interface SpaceSideVault {
  readonly vaultId: VaultId;
  readonly name: string;
  readonly source: Exclude<VaultSource, "user">;
}

const fail = (reason: VaultErrorReason, message: string) =>
  Effect.fail(new VaultError({ reason, message }));

const NOT_FOUND = "That Thread does not exist.";

interface EntryRow {
  readonly vaultId: string;
  readonly entryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly valueId: string | null;
  readonly unmasked: number | null;
  readonly class: VaultEntryClass | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`EffectiveVaults: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  /** Entries of the Vaults, a link's value and length its original's (none once it is gone). */
  const entriesOf = (vaultIds: ReadonlyArray<VaultId>) =>
    vaultIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<EntryRow>)
      : sql<EntryRow>`
          SELECT e.vault_id AS "vaultId", e.entry_id AS "entryId", e.name AS "name",
            e.description AS "description",
            CASE WHEN e.kind = 'link' THEN o.value_id ELSE e.value_id END AS "valueId",
            CASE WHEN e.kind = 'link' THEN o.unmasked ELSE e.unmasked END AS "unmasked",
            CASE WHEN e.kind = 'link' THEN o.class ELSE e.class END AS "class"
          FROM vault_entries e
          LEFT JOIN vault_entries o
            ON e.kind = 'link' AND o.entry_id = e.linked_entry_id
            AND o.vault_id = (SELECT vault_id FROM vaults WHERE is_main = 1) AND o.kind <> 'link'
          WHERE e.vault_id IN ${sql.in(vaultIds)}
        `;

  /**
   * The Space side of the rule for a Project (none for a Thread without one) placed in `space`:
   * the Space's defaults, plus the Project's adds, minus its removes, each only while allowed to
   * that Space now and not archived; in the order that wins (the Project's adds, then the fixed
   * defaults, then the chosen ones).
   */
  const spaceSide = Effect.fn("EffectiveVaults.spaceSide")(function* (
    spaceId: SpaceId,
    projectId: string | null,
  ) {
    const [allowed, defaults, choices] = yield* Effect.all(
      [
        VaultReach.allowedToSpace(sql, spaceId),
        VaultReach.chosenDefaults(sql, spaceId),
        projectId === null ? Effect.succeed([]) : VaultReach.projectChoices(sql, projectId),
      ],
      { concurrency: "unbounded" },
    );
    const allowedById = new Map(allowed.map((row) => [row.vaultId, row]));
    const removed = new Set(
      choices.filter((choice) => choice.choice === "remove").map((c) => c.vaultId),
    );
    const added = new Set(
      choices.filter((choice) => choice.choice === "add").map((c) => c.vaultId),
    );
    const groups: Array<{
      readonly row: VaultReach.ReachRow;
      readonly source: Exclude<VaultSource, "user">;
    }> = [];
    const taken = new Set<VaultId>();
    const take = (row: VaultReach.ReachRow | undefined, source: Exclude<VaultSource, "user">) => {
      if (row === undefined || row.archived || taken.has(row.vaultId)) return;
      taken.add(row.vaultId);
      groups.push({ row, source });
    };
    // The fixed defaults (the Main vault in the Owner's Personal space): never a Project's choice.
    const fixed = new Set(VaultReach.fixedDefaults(allowed));
    for (const row of allowed) {
      if (added.has(row.vaultId) && !fixed.has(row.vaultId)) take(row, "project");
    }
    for (const vaultId of fixed) take(allowedById.get(vaultId), "space");
    for (const vaultId of defaults) {
      if (!removed.has(vaultId)) take(allowedById.get(vaultId), "space");
    }
    return groups;
  });

  const forThread = Effect.fn("EffectiveVaults.forThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly actingUserId: UserId;
  }) {
    const placement = yield* spaces
      .placementOf(input.threadId)
      .pipe(Effect.catch(storage("read the Thread's Space")));
    if (Option.isNone(placement)) return yield* fail("not-found", NOT_FOUND);
    return yield* compute({ ...input, ...placement.value });
  });

  const forPlacement = Effect.fn("EffectiveVaults.forPlacement")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly spaceId: SpaceId | undefined;
      readonly projectId: ProjectId | null;
      readonly actingUserId: UserId;
    }) {
      const space =
        input.spaceId !== undefined
          ? Option.map(yield* spaces.spaceById(input.spaceId), (found) => found.resource)
          : input.projectId === null
            ? Option.none()
            : yield* spaces.spaceOf({ kind: "project", id: input.projectId });
      if (Option.isNone(space)) return yield* fail("not-found", NOT_FOUND);
      return yield* compute({ ...input, space: space.value });
    },
    Effect.catchTags({ SpaceDirectoryStorageError: storage("read the Thread's Space") }),
  );

  const compute = Effect.fn("EffectiveVaults.compute")(function* (input: {
    readonly threadId: ThreadId;
    readonly actingUserId: UserId;
    readonly space: AccessPolicy.SpaceResource;
    readonly projectId: ProjectId | null;
  }) {
    const { space } = input;
    // A Thread without a Project (the scratch Project's) takes no Project's choices.
    const projectId =
      input.projectId === null ||
      (yield* VaultReach.isScratchProject(sql, path, baseDir, input.projectId).pipe(
        Effect.catch(storage("read the Thread's Project")),
      ))
        ? null
        : input.projectId;
    // Whoever no longer works in the Space (a removed Membership, a disabled User) starts
    // nothing there: nothing is computed for them, their own Vaults included.
    const can = yield* spaces
      .authorizer(input.actingUserId)
      .pipe(Effect.catch(storage("check what you may do")));
    if (!can("space.view", space)) {
      return yield* fail("forbidden", "You no longer work in this Thread's Space.");
    }

    const reach = yield* Effect.all(
      {
        spaceSide: spaceSide(space.id, projectId),
        ownVaults: VaultReach.allowedToUser(sql, input.actingUserId),
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.catch(storage("read the Thread's Vaults")));

    // The User's own first, then the Space side; a Vault in both counts as the User's.
    const groups: Array<{ readonly row: VaultReach.ReachRow; readonly source: VaultSource }> = [];
    const taken = new Set<VaultId>();
    for (const row of reach.ownVaults) {
      if (row.archived || taken.has(row.vaultId)) continue;
      taken.add(row.vaultId);
      groups.push({ row, source: "user" });
    }
    for (const group of reach.spaceSide) {
      if (!taken.has(group.row.vaultId)) groups.push(group);
    }

    const entries = yield* entriesOf(groups.map((group) => group.row.vaultId)).pipe(
      Effect.catch(storage("read the Thread's secrets")),
    );
    const byVault = new Map<string, Array<EntryRow>>();
    for (const entry of entries) {
      const list = byVault.get(entry.vaultId) ?? [];
      list.push(entry);
      byVault.set(entry.vaultId, list);
    }
    const winners = new Map<string, { variable: EffectiveVariable; shadowed: VaultShadowed[] }>();
    for (const { row, source } of groups) {
      for (const entry of byVault.get(row.vaultId) ?? []) {
        // A broken link holds nothing; a name the Hub keeps (or not a variable) is never set.
        if (entry.valueId === null) continue;
        const risk = secretNameRisk(entry.name);
        if (risk === "invalid" || risk === "gateway") continue;
        const winner = winners.get(entry.name);
        if (winner !== undefined) {
          winner.shadowed.push({ vaultId: row.vaultId, vaultName: row.name, source });
          continue;
        }
        winners.set(entry.name, {
          shadowed: [],
          variable: {
            name: entry.name,
            description: entry.description,
            entryId: VaultEntryId.make(entry.entryId),
            vaultId: row.vaultId,
            vaultName: row.name,
            source,
            valueId: entry.valueId,
            class: entry.class ?? "secret",
            unmasked: entry.unmasked === 1,
            dangerous: risk === "dangerous",
            shadowed: [],
          },
        });
      }
    }
    const variables = [...winners.values()]
      .map(({ variable, shadowed }) => ({ ...variable, shadowed }))
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      threadId: input.threadId,
      spaceId: space.id,
      projectId: projectId === null ? null : ProjectId.make(projectId),
      vaults: groups.map(({ row, source }) => ({ vaultId: row.vaultId, name: row.name, source })),
      variables,
    } satisfies EffectiveSet;
  });

  const threadEnvironment = Effect.fn("EffectiveVaults.threadEnvironment")(function* (
    input: VaultThreadEnvironmentInput,
  ) {
    const actor = yield* spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see a Thread's secrets."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
    );
    if (Option.isNone(actor)) return yield* fail("forbidden", "Sign in to see a Thread's secrets.");
    // A Thread the caller does not see (another Space, or one an agent is not bound to) answers
    // like a missing one.
    yield* spaces
      .authorizeItem(actor.value, "space.view", { kind: "thread", id: input.threadId })
      .pipe(
        Effect.catchTags({
          SpaceDirectoryStorageError: storage("read the Thread"),
          SpaceAccessDeniedError: () => fail("not-found", NOT_FOUND),
          SpaceResourceNotFoundError: () => fail("not-found", NOT_FOUND),
        }),
      );
    const set = yield* forThread({ threadId: input.threadId, actingUserId: actor.value });
    // Spec 4 ticket 07: the direct AI account credential the caller's turns last received in this
    // Thread (or its root's), by name: «AI account credential». Never a value.
    const credentialRows = yield* sql<{
      readonly name: string;
      readonly accountName: string | null;
    }>`
      SELECT v.name AS "name", (
          SELECT a.name FROM ai_accounts a
          WHERE a.credential_id = substr(v.value_id, ${AI_CREDENTIAL_PREFIX_LENGTH + 1})
            OR a.account_id = (SELECT r.account_id FROM ai_account_retired_credentials r
              WHERE r.credential_id = substr(v.value_id, ${AI_CREDENTIAL_PREFIX_LENGTH + 1}))
          LIMIT 1
        ) AS "accountName"
      FROM thread_secret_values v
      JOIN orchestration_v2_projection_threads t ON t.thread_id = ${input.threadId}
      LEFT JOIN orchestration_v2_projection_threads root
        ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
      WHERE v.value_id LIKE 'ai-account:%'
        AND COALESCE(t.owner_user_id, root.owner_user_id) = ${actor.value}
        AND v.thread_id IN (${input.threadId}, COALESCE(root.thread_id, ${input.threadId}))
      ORDER BY v.remembered_at DESC LIMIT 1
    `.pipe(Effect.catch(storage("read the Thread's AI account credential")));
    const credential = credentialRows[0];
    return {
      aiCredential:
        credential === undefined
          ? null
          : { name: credential.name, aiAccountName: credential.accountName ?? "AI account" },
      threadId: ThreadId.make(set.threadId),
      spaceId: set.spaceId,
      projectId: set.projectId,
      vaults: set.vaults,
      variables: set.variables.map((variable) => ({
        name: variable.name,
        description: variable.description,
        vaultId: variable.vaultId,
        vaultName: variable.vaultName,
        source: variable.source,
        class: variable.class,
        unmasked: variable.unmasked,
        dangerous: variable.dangerous,
        shadowed: variable.shadowed,
      })),
    } satisfies VaultThreadEnvironment;
  });

  const projectMoveLoss = Effect.fn("EffectiveVaults.projectMoveLoss")(function* (input: {
    readonly projectId: ProjectId;
    readonly from: SpaceId;
    readonly to: SpaceId;
  }) {
    if (input.from === input.to) return [];
    // The scratch Project spans every Space and takes no choices.
    const scratch = yield* VaultReach.isScratchProject(sql, path, baseDir, input.projectId).pipe(
      Effect.catch(storage("read the Project")),
    );
    const projectId = scratch ? null : input.projectId;
    const [before, after] = yield* Effect.all(
      [spaceSide(input.from, projectId), spaceSide(input.to, projectId)],
      { concurrency: "unbounded" },
    ).pipe(Effect.catch(storage("read the Project's Vaults")));
    // `after` reads the choices as they are; those the move drops do not reach `to` anyway.
    const kept = new Set<string>(after.map((group) => group.row.vaultId));
    return before
      .filter((group) => !kept.has(group.row.vaultId))
      .map(({ row, source }) => ({ vaultId: row.vaultId, name: row.name, source }));
  });

  return EffectiveVaults.of({ forThread, forPlacement, threadEnvironment, projectMoveLoss });
});

export const layer = Layer.effect(EffectiveVaults, make);
