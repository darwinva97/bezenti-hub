/**
 * Which Vault groups may reach a Space: the one rule for Vaults.ts and EffectiveVaults.ts
 * (owned-resources 03, Grants ticket 07). A group reaches its owner's Space (a User's Personal
 * space, an Organization), and a named one also each Space it is lent to by an active Grant. See
 * docs/internals/secrets.md.
 */
import { GrantId, type SpaceId, VaultGroupId } from "@t3tools/contracts";
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
  /** Whose group it is. */
  readonly ownerKind: "user" | "organization";
  readonly ownerId: string;
  /** The active Grant that lends it to the Space; null for the Space's own (Grants ticket 07). */
  readonly grantId: GrantId | null;
}

interface RawReachRow {
  readonly vaultId: string;
  readonly name: string;
  readonly isDefault: number;
  readonly archivedAt: string | null;
  readonly ownerKind: "user" | "organization";
  readonly ownerId: string;
  readonly grantId: string | null;
}

const toReach = (row: RawReachRow): ReachRow => ({
  vaultId: VaultGroupId.make(row.vaultId),
  name: row.name,
  isDefault: row.isDefault === 1,
  archived: row.archivedAt !== null,
  ownerKind: row.ownerKind,
  ownerId: row.ownerId,
  grantId: row.grantId === null ? null : GrantId.make(row.grantId),
});

/**
 * The SQL of a group's own Space, from `v`: an Organization's id, or a User's Personal space
 * (`personal:<id>`).
 */
const ownSpaceSql = `(CASE v.owner_kind WHEN 'organization' THEN v.owner_id
  ELSE 'personal:' || v.owner_id END)`;

/**
 * The active Grants lending group `v` to the Space named by the SQL expression `space`, while their
 * lender may lend it (Grants ticket 13, as AI accounts and machines): still its owner, a User not
 * disabled or removed, an Organization not archived, frozen or gone.
 */
const lentSql = (space: string) => `
  SELECT g.grant_id FROM grants g
  WHERE g.resource_kind = 'vault-group' AND g.resource_id = v.group_id
    AND g.target_kind = 'space' AND g.target_id = ${space} AND g.state = 'active'
    AND g.lender_kind = v.owner_kind AND g.lender_id = v.owner_id
    AND (g.lender_kind <> 'user' OR EXISTS (
      SELECT 1 FROM users u WHERE u.user_id = g.lender_id
        AND u.disabled_at IS NULL AND u.removed_at IS NULL))
    AND (g.lender_kind <> 'organization' OR EXISTS (
      SELECT 1 FROM spaces s WHERE s.space_id = g.lender_id AND s.kind = 'organization'
        AND s.archived_at IS NULL AND s.frozen_at IS NULL))`;

/**
 * The fixed defaults among the groups reaching a Space: its owner's `default` (the only `default`
 * that reaches it). A Project neither removes nor re-adds it.
 */
export const fixedDefaults = (allowed: ReadonlyArray<ReachRow>): ReadonlyArray<VaultGroupId> =>
  allowed.filter((row) => row.isDefault && row.grantId === null).map((row) => row.vaultId);

/**
 * The rule as SQL: whether group `v` reaches the Space named by the SQL expression `space` (a
 * column, never a value). A `default` is never lent: it is its owner's Space's fixed default.
 */
export const reachesSpaceSql = (space: string) => `(
  ${ownSpaceSql} = ${space}
  OR (v.is_default = 0 AND EXISTS (${lentSql(space)})))`;

/**
 * The groups reaching a Space, archived ones included: its own in Settings' order (`default`
 * first, then by position, name), then the lent ones by when they were lent there.
 */
export const allowedToSpace = (sql: SqlClient.SqlClient, spaceId: SpaceId) =>
  sql<RawReachRow>`
    SELECT r.* FROM (
      SELECT v.group_id AS "vaultId", v.name AS "name", v.is_default AS "isDefault",
        v.archived_at AS "archivedAt", v.owner_kind AS "ownerKind", v.owner_id AS "ownerId",
        v.position AS "position",
        CASE WHEN ${sql.literal(ownSpaceSql)} = target.space_id THEN NULL
          ELSE (${sql.literal(lentSql("target.space_id"))} LIMIT 1) END AS "grantId",
        (SELECT g.decided_at FROM grants g WHERE g.resource_kind = 'vault-group'
          AND g.resource_id = v.group_id AND g.target_kind = 'space'
          AND g.target_id = target.space_id AND g.state = 'active') AS "lentAt"
      FROM vault_groups v, (SELECT ${spaceId} AS space_id) target
      WHERE ${sql.literal(reachesSpaceSql("target.space_id"))}
    ) r
    ORDER BY r."grantId" IS NOT NULL, r."lentAt", r."isDefault" DESC, r."position",
      r."name" COLLATE NOCASE, r."vaultId"
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
