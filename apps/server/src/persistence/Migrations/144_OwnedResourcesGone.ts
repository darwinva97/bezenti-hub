import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 10: what earlier Hubs left of owners that are gone (a removed User, an
// Organization without its row): their Vault groups with every row naming them (the start's
// sweep removes the values), their AI accounts retired as «Delete» does (the gateway's next sync
// takes them out), and their live loans ended. Idempotent; a live owner's rows are untouched.
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const REMOVED_USERS = `SELECT user_id FROM users WHERE removed_at IS NOT NULL`;
const GONE_OWNER = (kind: string, id: string) => `(
  (${kind} = 'user' AND ${id} IN (${REMOVED_USERS}))
  OR (${kind} = 'organization' AND ${id} NOT IN (SELECT space_id FROM spaces)))`;
const GONE_TARGET = `(target_kind = 'space' AND target_id IS NOT NULL AND (
  target_id IN (SELECT 'personal:' || user_id FROM users WHERE removed_at IS NOT NULL)
  OR (target_id NOT LIKE 'personal:%' AND target_id NOT IN (SELECT space_id FROM spaces))))`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const groups = `SELECT group_id FROM vault_groups g WHERE ${GONE_OWNER("g.owner_kind", "g.owner_id")}`;
  for (const table of [
    "vault_entries",
    "vault_allowances",
    "space_default_vaults",
    "project_vault_choices",
    "vault_provider_scopes",
    "vault_unlinked_notices",
  ]) {
    yield* sql`DELETE FROM ${sql.literal(table)} WHERE group_id IN (${sql.literal(groups)})`;
  }
  yield* sql`DELETE FROM vault_groups WHERE group_id IN (${sql.literal(groups)})`;

  const accounts = `SELECT account_id FROM ai_accounts a
    WHERE a.deleted_at IS NULL AND ${GONE_OWNER("a.owner_kind", "a.owner_id")}`;
  yield* sql`
    INSERT OR IGNORE INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
    SELECT credential_id, account_id, ${sql.literal(NOW)} FROM ai_accounts
    WHERE credential_id IS NOT NULL AND account_id IN (${sql.literal(accounts)})
  `;
  yield* sql`DELETE FROM ai_account_allowances WHERE account_id IN (${sql.literal(accounts)})`;
  yield* sql`DELETE FROM ai_account_migrated_keys WHERE account_id IN (${sql.literal(accounts)})`;
  yield* sql`
    UPDATE ai_accounts SET deleted_at = ${sql.literal(NOW)}, credential_id = NULL,
      status = 'removing', status_message = NULL, updated_at = ${sql.literal(NOW)}
    WHERE account_id IN (${sql.literal(accounts)})
  `;

  // Live loans: the lender's side first, then the destination's.
  const lenderGone = GONE_OWNER("lender_kind", "lender_id");
  yield* sql`
    UPDATE grants SET state = 'ended', end_reason = 'lender-gone', ended_at = ${sql.literal(NOW)}
    WHERE state IN ('pending', 'active') AND ${sql.literal(lenderGone)}
  `;
  yield* sql`
    UPDATE grants SET state = 'ended', end_reason = 'target-gone', ended_at = ${sql.literal(NOW)}
    WHERE state IN ('pending', 'active') AND ${sql.literal(GONE_TARGET)}
  `;
  // Offers no one may take up any more: cancelled, or a link with no destination expired.
  yield* sql`
    UPDATE grants SET state = 'cancelled', decided_at = ${sql.literal(NOW)}
    WHERE state = 'offered' AND target_id IS NOT NULL
      AND (${sql.literal(lenderGone)} OR ${sql.literal(GONE_TARGET)})
  `;
  yield* sql`
    UPDATE grants SET offer_expires_at = ${sql.literal(NOW)}
    WHERE state = 'offered' AND target_id IS NULL AND ${sql.literal(lenderGone)}
      AND (offer_expires_at IS NULL OR offer_expires_at > ${sql.literal(NOW)})
  `;
  // The Sandboxes of loans that ended reach nothing any more.
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
