import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 07: each allowance on the Owner's named Vault groups becomes an active Grant (one
// «to a User»: to their Personal space, also as its last default, since it reached them unchosen).
// What that narrows waits for the Owner's review; rows the read rule ignored go. See
// docs/internals/secrets.md, «Who reaches what».
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const LIMITS = '{"kind":"vault-group"}';
const OWNER = "(SELECT user_id FROM users WHERE is_owner = 1)";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE vault_group_grant_reviews (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id, space_id)
    )
  `;

  // The allowances that still meant something: on the Owner's own named groups, to a Space that
  // exists (not a removed User's Personal space) or to a User who is not removed.
  yield* sql`
    CREATE TEMP TABLE migrated_vault_allowances AS
    SELECT a.group_id AS group_id, a.subject_kind AS subject_kind, a.subject_id AS subject_id,
      v.owner_id AS lender_id, v.name AS group_name,
      CASE a.subject_kind
        WHEN 'space' THEN a.subject_id
        ELSE (SELECT s.space_id FROM spaces s
          WHERE s.kind = 'personal' AND s.personal_owner_user_id = a.subject_id)
      END AS target_id
    FROM vault_allowances a
    JOIN vault_groups v ON v.group_id = a.group_id
    WHERE v.is_default = 0 AND v.owner_kind = 'user' AND v.owner_id = ${sql.literal(OWNER)}
      AND (
        (a.subject_kind = 'space' AND EXISTS (
          SELECT 1 FROM spaces s WHERE s.space_id = a.subject_id AND s.deleting_at IS NULL
            AND (s.kind <> 'personal' OR EXISTS (SELECT 1 FROM users u
              WHERE u.user_id = s.personal_owner_user_id AND u.removed_at IS NULL))))
        OR (a.subject_kind = 'user' AND EXISTS (
          SELECT 1 FROM users u WHERE u.user_id = a.subject_id AND u.removed_at IS NULL))
      )
  `;

  // One Grant per group and destination, never into the Owner's own Personal space.
  yield* sql`
    CREATE TEMP TABLE migrated_vault_grants AS
    SELECT 'grant-' || lower(hex(randomblob(16))) AS grant_id, group_id, group_name, lender_id,
      target_id
    FROM (
      SELECT DISTINCT group_id, group_name, lender_id, target_id
      FROM migrated_vault_allowances
      WHERE target_id IS NOT NULL
        AND target_id NOT IN (SELECT space_id FROM spaces
          WHERE kind = 'personal' AND personal_owner_user_id = lender_id)
    )
  `;
  yield* sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind,
      target_id, state, limits_json, created_at, created_by, decided_at, decided_by)
    SELECT grant_id, 'vault-group', group_id, 'user', lender_id, 'space', target_id, 'active',
      ${LIMITS}, ${sql.literal(NOW)}, lender_id, ${sql.literal(NOW)}, lender_id
    FROM migrated_vault_grants
  `;
  yield* sql`
    INSERT INTO audit_log (at, actor_source, actor_user_id, space_id, space_name, action,
      target_kind, target_id, target_name, detail_json)
    SELECT ${sql.literal(NOW)}, 'system', NULL, g.target_id,
      (SELECT name FROM spaces WHERE space_id = g.target_id), 'grant.give', 'grant', g.grant_id,
      g.group_name,
      json_object('resourceKind', 'vault-group', 'resourceId', g.group_id,
        'resourceName', g.group_name, 'lenderId', g.lender_id, 'targetSpaceId', g.target_id,
        'state', 'active', 'via', 'migration')
    FROM migrated_vault_grants g
  `;

  // A group allowed to a User reached their turns unchosen: in their Personal space it stays so,
  // as its last defaults (by name), unless it is one already.
  yield* sql`
    CREATE TEMP TABLE migrated_vault_defaults AS
    SELECT n.target_id AS space_id, n.group_id AS group_id, n.group_name AS group_name,
      COALESCE((SELECT MAX(d.position) FROM space_default_vaults d
        WHERE d.space_id = n.target_id), -1)
        + ROW_NUMBER() OVER (PARTITION BY n.target_id ORDER BY n.group_name, n.group_id) AS position
    FROM (
      SELECT DISTINCT target_id, group_id, group_name FROM migrated_vault_allowances
      WHERE subject_kind = 'user' AND target_id IS NOT NULL
    ) n
    WHERE NOT EXISTS (SELECT 1 FROM space_default_vaults d
      WHERE d.space_id = n.target_id AND d.group_id = n.group_id)
  `;
  yield* sql`
    INSERT INTO space_default_vaults (space_id, group_id, position)
    SELECT space_id, group_id, position FROM migrated_vault_defaults
  `;
  yield* sql`
    INSERT INTO audit_log (at, actor_source, actor_user_id, space_id, space_name, action,
      target_kind, target_id, target_name, detail_json)
    SELECT ${sql.literal(NOW)}, 'system', NULL, d.space_id,
      (SELECT name FROM spaces WHERE space_id = d.space_id), 'vault.choose', 'vault', d.group_id,
      d.group_name,
      json_object('scope', 'space', 'choice', 'default', 'position', d.position,
        'via', 'migration')
    FROM migrated_vault_defaults d
  `;

  // What an allowance to a User reached that no Grant does: each Organization they work in (any,
  // for the Owner; archived ones too, since archiving is undone) without a Grant of that group.
  yield* sql`
    INSERT OR IGNORE INTO vault_group_grant_reviews (group_id, user_id, space_id, created_at)
    SELECT a.group_id, a.subject_id, s.space_id, ${sql.literal(NOW)}
    FROM migrated_vault_allowances a
    JOIN spaces s ON s.kind = 'organization' AND s.deleting_at IS NULL
    WHERE a.subject_kind = 'user'
      AND (
        EXISTS (SELECT 1 FROM users u WHERE u.user_id = a.subject_id AND u.is_owner = 1)
        OR EXISTS (SELECT 1 FROM space_memberships m
          WHERE m.space_id = s.space_id AND m.user_id = a.subject_id)
      )
      AND NOT EXISTS (SELECT 1 FROM migrated_vault_grants g
        WHERE g.group_id = a.group_id AND g.target_id = s.space_id)
  `;

  yield* sql`DROP TABLE migrated_vault_defaults`;
  yield* sql`DROP TABLE migrated_vault_grants`;
  yield* sql`DROP TABLE migrated_vault_allowances`;
  yield* sql`DROP TABLE vault_allowances`;
});
