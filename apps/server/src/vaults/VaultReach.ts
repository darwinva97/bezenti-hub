/**
 * Which Vault groups may reach a Space or a User: the one rule for Vaults.ts and EffectiveVaults.ts
 * (owned-resources 03). A group reaches its owner's Space (a User's Personal space, an
 * Organization); the Owner's named groups also reach whom they were allowed to. Other allowance
 * rows are ignored. See docs/internals/secrets.md.
 */
import { type SpaceId, type UserId, VaultGroupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import { isScratchWorkspaceRoot } from "../environment/ScratchWorkspace.ts";

export interface ReachRow {
  readonly vaultId: VaultGroupId;
  readonly name: string;
  /** Its owner's `default`: a fixed default of the owner's Space. */
  readonly isDefault: boolean;
  readonly archived: boolean;
}

interface RawReachRow {
  readonly vaultId: string;
  readonly name: string;
  readonly isDefault: number;
  readonly archivedAt: string | null;
}

const COLUMNS = `v.group_id AS "vaultId", v.name AS "name", v.is_default AS "isDefault",
  v.archived_at AS "archivedAt"`;

/** The order Settings lists them in: `default` first, then by position, name. */
const GROUP_ORDER = `v.is_default DESC, v.position, v.name COLLATE NOCASE`;

const toReach = (row: RawReachRow): ReachRow => ({
  vaultId: VaultGroupId.make(row.vaultId),
  name: row.name,
  isDefault: row.isDefault === 1,
  archived: row.archivedAt !== null,
});

/** The Owner's id: whose named groups an allowance may widen. */
const INSTALLATION_OWNER = `(SELECT user_id FROM users WHERE is_owner = 1)`;

/** Group `v` is the Installation Owner's own (an allowance on it counts). */
export const ownersGroupSql = `(v.owner_kind = 'user' AND v.owner_id = ${INSTALLATION_OWNER})`;

/**
 * The SQL of a group's own Space, from `v`: an Organization's id, or a User's Personal space
 * (`personal:<id>`).
 */
const ownSpaceSql = `(CASE v.owner_kind WHEN 'organization' THEN v.owner_id
  ELSE 'personal:' || v.owner_id END)`;

/**
 * The fixed defaults among the groups reaching a Space: its owner's `default` (the only `default`
 * that reaches it). A Project neither removes nor re-adds it.
 */
export const fixedDefaults = (allowed: ReadonlyArray<ReachRow>): ReadonlyArray<VaultGroupId> =>
  allowed.filter((row) => row.isDefault).map((row) => row.vaultId);

/**
 * The rule as SQL: whether group `v` reaches the Space named by the SQL expression `space` (a
 * column, never a value).
 */
export const reachesSpaceSql = (space: string) => `(
  ${ownSpaceSql} = ${space}
  OR (v.is_default = 0 AND ${ownersGroupSql} AND EXISTS (
    SELECT 1 FROM vault_allowances a
    WHERE a.group_id = v.group_id AND a.subject_kind = 'space' AND a.subject_id = ${space}
  )))`;

/** The groups reaching a Space, archived ones included, in Settings' order. */
export const allowedToSpace = (sql: SqlClient.SqlClient, spaceId: SpaceId) =>
  sql<RawReachRow>`
    SELECT ${sql.literal(COLUMNS)} FROM vault_groups v, (SELECT ${spaceId} AS space_id) target
    WHERE ${sql.literal(reachesSpaceSql("target.space_id"))}
    ORDER BY ${sql.literal(GROUP_ORDER)}
  `.pipe(Effect.map((rows) => rows.map(toReach)));

/**
 * Drops the Project's choices of groups that do not reach Space `spaceId` (a Project moving
 * there), and answers them, for the audit.
 */
export const dropChoicesNotReaching = (
  sql: SqlClient.SqlClient,
  projectId: string,
  spaceId: SpaceId,
) =>
  sql<{ readonly vaultId: string; readonly choice: string }>`
    DELETE FROM project_vault_choices
    WHERE project_id = ${projectId} AND group_id NOT IN (
      SELECT v.group_id FROM vault_groups v, (SELECT ${spaceId} AS space_id) target
      WHERE ${sql.literal(reachesSpaceSql("target.space_id"))}
    )
    RETURNING group_id AS "vaultId", choice AS "choice"
  `;

/** The groups allowed to a User themselves: the Owner's named ones, never a `default`. */
export const allowedToUser = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<RawReachRow>`
    SELECT ${sql.literal(COLUMNS)} FROM vault_groups v
    WHERE v.is_default = 0 AND ${sql.literal(ownersGroupSql)} AND EXISTS (
      SELECT 1 FROM vault_allowances a
      WHERE a.group_id = v.group_id AND a.subject_kind = 'user' AND a.subject_id = ${userId}
    )
    ORDER BY ${sql.literal(GROUP_ORDER)}
  `.pipe(Effect.map((rows) => rows.map(toReach)));

/** A Space's chosen defaults, in their order (the first wins a shared name). */
export const chosenDefaults = (sql: SqlClient.SqlClient, spaceId: SpaceId) =>
  sql<{ readonly vaultId: string }>`
    SELECT group_id AS "vaultId" FROM space_default_vaults
    WHERE space_id = ${spaceId} ORDER BY position, group_id
  `.pipe(Effect.map((rows) => rows.map((row) => VaultGroupId.make(row.vaultId))));

/**
 * Whether a Project is the scratch one, which holds the Threads without a Project: those use their
 * Space's defaults and their User's groups, never a Project's choices (it spans every Space).
 */
export const isScratchProject = (
  sql: SqlClient.SqlClient,
  path: Path.Path,
  baseDir: string,
  projectId: string,
) =>
  sql<{ readonly workspaceRoot: string }>`
    SELECT workspace_root AS "workspaceRoot" FROM projection_projects WHERE project_id = ${projectId}
  `.pipe(
    Effect.map((rows) => {
      const row = rows[0];
      return row !== undefined && isScratchWorkspaceRoot(path, baseDir, row.workspaceRoot);
    }),
  );

/** A Project's adds and removes. */
export const projectChoices = (sql: SqlClient.SqlClient, projectId: string) =>
  sql<{ readonly vaultId: string; readonly choice: "add" | "remove" }>`
    SELECT group_id AS "vaultId", choice AS "choice" FROM project_vault_choices
    WHERE project_id = ${projectId} ORDER BY group_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ vaultId: VaultGroupId.make(row.vaultId), choice: row.choice })),
    ),
  );
