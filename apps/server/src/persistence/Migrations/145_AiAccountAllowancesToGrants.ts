import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 02: each allowance on the Owner's live account becomes an active, uncapped Grant
// to its Space (one «to a User»: to their Personal space). What that narrows (the Organizations
// they worked in) is kept for the Owner's review and grants nothing. Audited `via: migration`.
// See docs/internals/ai-gateway.md, «Allowances became Grants».
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const NO_CAP = '{"kind":"ai-account","tokens":null,"requests":null}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE ai_account_grant_reviews (
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      -- The User used the account in that Organization in the 90 days before the migration.
      used_recently INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, user_id, space_id)
    )
  `;

  // The allowances that still meant something: the Owner's own live accounts, to a Space that
  // exists (not a removed User's Personal space) or to a User who is not removed.
  yield* sql`
    CREATE TEMP TABLE migrated_ai_allowances AS
    SELECT l.account_id AS account_id, l.subject_kind AS subject_kind,
      l.subject_id AS subject_id, a.owner_id AS lender_id, a.name AS account_name,
      CASE l.subject_kind
        WHEN 'space' THEN l.subject_id
        ELSE (SELECT s.space_id FROM spaces s
          WHERE s.kind = 'personal' AND s.personal_owner_user_id = l.subject_id)
      END AS target_id
    FROM ai_account_allowances l
    JOIN ai_accounts a ON a.account_id = l.account_id
    WHERE a.deleted_at IS NULL AND a.owner_kind = 'user'
      AND a.owner_id = (SELECT user_id FROM users WHERE is_owner = 1)
      AND (
        (l.subject_kind = 'space' AND EXISTS (
          SELECT 1 FROM spaces s WHERE s.space_id = l.subject_id AND s.deleting_at IS NULL
            AND (s.kind <> 'personal' OR EXISTS (SELECT 1 FROM users u
              WHERE u.user_id = s.personal_owner_user_id AND u.removed_at IS NULL))))
        OR (l.subject_kind = 'user' AND EXISTS (
          SELECT 1 FROM users u WHERE u.user_id = l.subject_id AND u.removed_at IS NULL))
      )
  `;

  // One Grant per account and destination, never into the Owner's own Personal space.
  yield* sql`
    CREATE TEMP TABLE migrated_ai_grants AS
    SELECT 'grant-' || lower(hex(randomblob(16))) AS grant_id, account_id, account_name,
      lender_id, target_id
    FROM (
      SELECT DISTINCT account_id, account_name, lender_id, target_id
      FROM migrated_ai_allowances
      WHERE target_id IS NOT NULL
        AND target_id NOT IN (SELECT space_id FROM spaces
          WHERE kind = 'personal' AND personal_owner_user_id = lender_id)
    )
  `;
  yield* sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind,
      target_id, state, limits_json, created_at, created_by, decided_at, decided_by)
    SELECT grant_id, 'ai-account', account_id, 'user', lender_id, 'space', target_id, 'active',
      ${NO_CAP}, ${sql.literal(NOW)}, lender_id, ${sql.literal(NOW)}, lender_id
    FROM migrated_ai_grants
  `;
  yield* sql`
    INSERT INTO audit_log (at, actor_source, actor_user_id, space_id, space_name, action,
      target_kind, target_id, target_name, detail_json)
    SELECT ${sql.literal(NOW)}, 'system', NULL, g.target_id,
      (SELECT name FROM spaces WHERE space_id = g.target_id), 'grant.give', 'grant', g.grant_id,
      g.account_name,
      json_object('resourceKind', 'ai-account', 'resourceId', g.account_id,
        'resourceName', g.account_name, 'lenderId', g.lender_id, 'targetSpaceId', g.target_id,
        'state', 'active', 'via', 'migration')
    FROM migrated_ai_grants g
  `;

  // What an allowance to a User reached that no Grant does: each Organization they work in (any,
  // for the Owner; archived ones too, since archiving is undone) without a Grant of that account.
  yield* sql`
    INSERT OR IGNORE INTO ai_account_grant_reviews (account_id, user_id, space_id, used_recently,
      created_at)
    SELECT l.account_id, l.subject_id, s.space_id,
      EXISTS (SELECT 1 FROM ai_usage u WHERE u.account_id = l.account_id
        AND u.user_id = l.subject_id AND u.space_id = s.space_id
        AND u.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')),
      ${sql.literal(NOW)}
    FROM migrated_ai_allowances l
    JOIN spaces s ON s.kind = 'organization' AND s.deleting_at IS NULL
    WHERE l.subject_kind = 'user'
      AND (
        EXISTS (SELECT 1 FROM users u WHERE u.user_id = l.subject_id AND u.is_owner = 1)
        OR EXISTS (SELECT 1 FROM space_memberships m
          WHERE m.space_id = s.space_id AND m.user_id = l.subject_id)
      )
      AND NOT EXISTS (SELECT 1 FROM migrated_ai_grants g
        WHERE g.account_id = l.account_id AND g.target_id = s.space_id)
  `;

  yield* sql`DROP TABLE migrated_ai_grants`;
  yield* sql`DROP TABLE migrated_ai_allowances`;
  yield* sql`DROP TABLE ai_account_allowances`;
});
