import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 11: loans keep their resource's, lender's and destination's names once those rows
// are gone; filled here for every loan. Live loans of resources earlier Hubs deleted end
// (`resource-gone`), their open links are cancelled, their Sandboxes reach nothing. Idempotent.
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const NAMES = `
  resource_name = COALESCE(CASE grants.resource_kind
    WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = grants.resource_id)
    WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = grants.resource_id)
    WHEN 'vault-group' THEN (SELECT name FROM vault_groups WHERE group_id = grants.resource_id)
    END, grants.resource_name),
  lender_name = COALESCE(CASE grants.lender_kind
    WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = grants.lender_id)
    ELSE (SELECT name FROM spaces WHERE space_id = grants.lender_id) END, grants.lender_name),
  target_name = COALESCE((SELECT name FROM spaces WHERE space_id = grants.target_id),
    grants.target_name)`;
const RESOURCE_GONE = `(
  (resource_kind = 'ai-account'
    AND resource_id NOT IN (SELECT account_id FROM ai_accounts WHERE deleted_at IS NULL))
  OR (resource_kind = 'vault-group' AND resource_id NOT IN (SELECT group_id FROM vault_groups))
  OR (resource_kind = 'environment'
    AND resource_id NOT IN (SELECT environment_id FROM environments WHERE revoked_at IS NULL)))`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(grants)`;
  for (const column of ["resource_name", "lender_name", "target_name"]) {
    if (columns.some((row) => row.name === column)) continue;
    yield* sql`ALTER TABLE grants ADD COLUMN ${sql.literal(column)} TEXT`;
  }
  yield* sql`UPDATE grants SET ${sql.literal(NAMES)}`;
  yield* sql`
    UPDATE grants SET state = 'ended', end_reason = 'resource-gone', ended_at = ${sql.literal(NOW)}
    WHERE state IN ('pending', 'active') AND ${sql.literal(RESOURCE_GONE)}
  `;
  yield* sql`
    UPDATE grants SET state = 'cancelled', decided_at = ${sql.literal(NOW)}
    WHERE state = 'offered' AND ${sql.literal(RESOURCE_GONE)}
  `;
  const closed = `SELECT e.environment_id FROM environments e JOIN grants g ON g.grant_id = e.grant_id
    WHERE g.state <> 'active'`;
  yield* sql`
    DELETE FROM dedicated_sandbox_credentials WHERE environment_id IN (${sql.literal(closed)})
  `;
  yield* sql`
    UPDATE environments SET revoked_at = ${sql.literal(NOW)}
    WHERE revoked_at IS NULL AND environment_id IN (${sql.literal(closed)})
  `;
});
