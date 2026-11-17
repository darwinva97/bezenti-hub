/**
 * The rows each way of losing a Vault's reach drops, so nothing comes back unseen and nothing of a
 * deleted Organization, Project or removed User remains. Each runs in its caller's transaction and
 * audits there; values go after it commits (`removeValues`). docs/internals/secrets.md.
 */
import type { ProjectId, SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { projectSpaceSql } from "../spaces/SpaceDirectory.ts";
import * as ThreadSecretValues from "./ThreadSecretValues.ts";
import * as VaultReach from "./VaultReach.ts";

/** A Vault group, its entries and every row that names it; the values its entries held. */
export const forgetVault = Effect.fn("VaultReachLoss.forgetVault")(function* (
  sql: SqlClient.SqlClient,
  vaultId: string,
) {
  const gone = yield* sql<{ readonly valueId: string | null }>`
    DELETE FROM vault_entries WHERE group_id = ${vaultId} RETURNING value_id AS "valueId"
  `;
  yield* sql`DELETE FROM vault_allowances WHERE group_id = ${vaultId}`;
  yield* sql`DELETE FROM space_default_vaults WHERE group_id = ${vaultId}`;
  yield* sql`DELETE FROM project_vault_choices WHERE group_id = ${vaultId}`;
  yield* sql`DELETE FROM vault_provider_scopes WHERE group_id = ${vaultId}`;
  yield* sql`DELETE FROM vault_unlinked_notices WHERE group_id = ${vaultId}`;
  yield* sql`DELETE FROM vault_groups WHERE group_id = ${vaultId}`;
  return {
    entries: gone.length,
    valueIds: gone.flatMap((row) => (row.valueId === null ? [] : [row.valueId])),
  };
});

/** A Space's default of the Vault and its Projects' choices of it. */
const forgetSpaceRows = Effect.fn("VaultReachLoss.forgetSpaceRows")(function* (
  sql: SqlClient.SqlClient,
  vaultId: string,
  spaceId: string,
) {
  yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${spaceId} AND group_id = ${vaultId}`;
  yield* sql`
    DELETE FROM project_vault_choices WHERE group_id = ${vaultId} AND project_id IN (
      SELECT project_id FROM projection_projects
      WHERE ${sql.literal(projectSpaceSql("space_id"))} = ${spaceId}
    )
  `;
});

/**
 * One of the Owner's Vaults taken back from a Space: its allowance, the Space's default of it and
 * its Projects' choices of it.
 */
export const forgetSpaceAllowance = Effect.fn("VaultReachLoss.forgetSpaceAllowance")(function* (
  sql: SqlClient.SqlClient,
  vaultId: string,
  spaceId: string,
) {
  yield* sql`
    DELETE FROM vault_allowances
    WHERE group_id = ${vaultId} AND subject_kind = 'space' AND subject_id = ${spaceId}
  `;
  yield* forgetSpaceRows(sql, vaultId, spaceId);
});

/**
 * One of the Owner's Vaults allowed to a Space: a default or choice of it there can only be left
 * from before (a Project that moved in, an earlier allowance), so it goes, never brought back unseen.
 */
export const clearForGrant = forgetSpaceRows;

/** One of the Owner's Vaults taken back from a User. */
export const forgetUserAllowance = (sql: SqlClient.SqlClient, vaultId: string, userId: string) =>
  sql`
    DELETE FROM vault_allowances
    WHERE group_id = ${vaultId} AND subject_kind = 'user' AND subject_id = ${userId}
  `.pipe(Effect.asVoid);

/**
 * A User removed from the Installation: every Vault allowed to them or to their (now frozen)
 * Personal space, and that Space's defaults, each allowance audited as taken back.
 */
export const forgetUser = Effect.fn("VaultReachLoss.forgetUser")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  user: { readonly userId: UserId; readonly displayName: string },
) {
  const personal = `personal:${user.userId}`;
  const allowed = yield* sql<{
    readonly vaultId: string;
    readonly name: string;
    readonly subjectKind: "user" | "space";
    readonly subjectId: string;
  }>`
    SELECT a.group_id AS "vaultId", v.name AS "name", a.subject_kind AS "subjectKind",
      a.subject_id AS "subjectId"
    FROM vault_allowances a JOIN vault_groups v ON v.group_id = a.group_id
    WHERE (a.subject_kind = 'user' AND a.subject_id = ${user.userId})
      OR (a.subject_kind = 'space' AND a.subject_id = ${personal})
    ORDER BY v.name
  `;
  yield* sql`
    DELETE FROM vault_allowances
    WHERE (subject_kind = 'user' AND subject_id = ${user.userId})
      OR (subject_kind = 'space' AND subject_id = ${personal})
  `;
  yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${personal}`;
  const choices = yield* sql<{
    readonly projectId: string;
    readonly vaultId: string;
    readonly name: string | null;
  }>`
    DELETE FROM project_vault_choices WHERE project_id IN (
      SELECT project_id FROM projection_projects
      WHERE ${sql.literal(projectSpaceSql("space_id"))} = ${personal}
    )
    RETURNING project_id AS "projectId", group_id AS "vaultId",
      (SELECT name FROM vault_groups g WHERE g.group_id = project_vault_choices.group_id) AS "name"
  `;
  const write = AuditLog.write(sql);
  for (const row of allowed) {
    yield* write({
      actor,
      action: "vault.allow",
      spaceId: row.subjectKind === "space" ? (personal as SpaceId) : null,
      target: { kind: "vault", id: row.vaultId, name: row.name },
      detail: {
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        subjectName: user.displayName,
        allowed: false,
      },
    });
  }
  // Its Projects' choices there go back to inherit, audited like any other choice dropped.
  for (const row of choices) {
    yield* write({
      actor,
      action: "vault.choose",
      spaceId: personal as SpaceId,
      target: {
        kind: "vault",
        id: row.vaultId,
        ...(row.name === null ? {} : { name: row.name }),
      },
      detail: { scope: "project", projectId: row.projectId, choice: "inherit" },
    });
  }
  return allowed.length;
});

/**
 * An Organization deleted: its Vault's groups with their entries, `default` included (audited
 * `vault.delete`), the Owner's groups' allowances to it (audited as taken back), its defaults and
 * its Projects' choices. The Owner's groups themselves stay. Answers the values to remove.
 */
export const forgetOrganization = Effect.fn("VaultReachLoss.forgetOrganization")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  organization: { readonly spaceId: SpaceId; readonly name: string },
) {
  const { spaceId } = organization;
  const write = AuditLog.write(sql);
  const own = yield* sql<{
    readonly vaultId: string;
    readonly name: string;
    readonly isDefault: number;
  }>`
    SELECT group_id AS "vaultId", name, is_default AS "isDefault" FROM vault_groups
    WHERE owner_kind = 'organization' AND owner_id = ${spaceId} ORDER BY name
  `;
  const valueIds: Array<string> = [];
  for (const vault of own) {
    const gone = yield* forgetVault(sql, vault.vaultId);
    valueIds.push(...gone.valueIds);
    // An empty `default` was never more than a place to put things: nothing to record.
    if (vault.isDefault === 1 && gone.entries === 0) continue;
    yield* write({
      actor,
      action: "vault_group.delete",
      spaceId,
      target: { kind: "vault", id: vault.vaultId, name: vault.name },
      detail: { entries: gone.entries },
    });
  }
  const allowed = yield* sql<{ readonly vaultId: string; readonly name: string }>`
    SELECT a.group_id AS "vaultId", v.name AS "name"
    FROM vault_allowances a JOIN vault_groups v ON v.group_id = a.group_id
    WHERE a.subject_kind = 'space' AND a.subject_id = ${spaceId} ORDER BY v.name
  `;
  yield* sql`DELETE FROM vault_allowances WHERE subject_kind = 'space' AND subject_id = ${spaceId}`;
  for (const row of allowed) {
    yield* write({
      actor,
      action: "vault.allow",
      spaceId,
      target: { kind: "vault", id: row.vaultId, name: row.name },
      detail: {
        subjectKind: "space",
        subjectId: spaceId,
        subjectName: organization.name,
        allowed: false,
      },
    });
  }
  yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${spaceId}`;
  yield* sql`
    DELETE FROM project_vault_choices WHERE project_id IN (
      SELECT project_id FROM projection_projects
      WHERE ${sql.literal(projectSpaceSql("space_id"))} = ${spaceId}
    )
  `;
  return { vaults: own.length, valueIds };
});

/**
 * A Project moving to Space `spaceId`, in the transaction that moves it: its choices of Vaults that
 * do not reach that Space go (`VaultReach.dropChoicesNotReaching`), each audited as `inherit` in
 * the Space it left.
 */
export const keepProjectChoicesReaching = Effect.fn("VaultReachLoss.keepProjectChoicesReaching")(
  function* (
    sql: SqlClient.SqlClient,
    input: { readonly projectId: ProjectId; readonly from: SpaceId; readonly spaceId: SpaceId },
  ) {
    const dropped = yield* VaultReach.dropChoicesNotReaching(sql, input.projectId, input.spaceId);
    if (dropped.length === 0) return;
    const actor = yield* AuditLog.currentActor;
    const write = AuditLog.write(sql);
    for (const row of dropped) {
      const [vault] = yield* sql<{ readonly name: string }>`
        SELECT name FROM vault_groups WHERE group_id = ${row.vaultId}
      `;
      yield* write({
        actor,
        action: "vault.choose",
        // Under the Space it left: only those who saw the choice there see it went.
        spaceId: input.from,
        target: {
          kind: "vault",
          id: row.vaultId,
          ...(vault === undefined ? {} : { name: vault.name }),
        },
        detail: { scope: "project", projectId: input.projectId, choice: "inherit" },
      });
    }
  },
);

/** A Project deleted, in the transaction that deletes it: its choices go with it. */
export const forgetProject = (sql: SqlClient.SqlClient, projectId: ProjectId) =>
  sql`DELETE FROM project_vault_choices WHERE project_id = ${projectId}`.pipe(Effect.asVoid);

/**
 * Removes values no row holds any more; a failure leaves them to the next start's sweep. A value an
 * entry still holds stays (a Secret link turned independent shares its original's until the Hub's
 * start copies it, owned-resources 03), as does one a Thread that is not deleted received (spec 5
 * ticket 05: still masked there); the start removes it once that Thread is gone.
 */
/** Whether an entry still holds the value. */
const heldByEntry = (sql: SqlClient.SqlClient, valueId: string) =>
  sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM vault_entries WHERE value_id = ${valueId}
  `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

export const removeValues = (
  sql: SqlClient.SqlClient,
  values: ServerSecretStore.VaultValueStore["Service"],
  valueIds: ReadonlyArray<string>,
) =>
  Effect.forEach(
    valueIds,
    (valueId) =>
      Effect.all([heldByEntry(sql, valueId), ThreadSecretValues.heldByThread(sql, valueId)]).pipe(
        Effect.flatMap(([entry, thread]) =>
          entry || thread ? Effect.void : values.remove(valueId),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Vaults: could not remove a value; the next start removes it", {
            valueId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
