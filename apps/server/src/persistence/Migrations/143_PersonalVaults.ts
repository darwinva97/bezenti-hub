import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 04: every User's Vault, with its `default` group, for the Users there already
// (a removed User keeps none: their Personal space is frozen). New ones get it when they are made.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
      updated_at)
    SELECT 'vault-default-' || lower(hex(randomblob(16))), 'user', u.user_id, 'default', 1,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM users u
    WHERE u.removed_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM vault_groups g
      WHERE g.owner_kind = 'user' AND g.owner_id = u.user_id AND g.is_default = 1
    )
  `;
});
