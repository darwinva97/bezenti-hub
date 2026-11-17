import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 08: an AI account is a User's or an Organization's. The ones that exist were the
// Installation's, so they become the Owner's (their allowances stay, read only on the Owner's
// own accounts). A name is unique per owner, and `priority` orders one owner's accounts only.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE ai_accounts ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user'
      CHECK (owner_kind IN ('user', 'organization'))
  `;
  yield* sql`ALTER TABLE ai_accounts ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`;
  // No Owner yet (nothing could have made an account then): whoever created it, as a fallback.
  yield* sql`
    UPDATE ai_accounts SET owner_kind = 'user',
      owner_id = COALESCE((SELECT user_id FROM users WHERE is_owner = 1), created_by, '')
  `;
  yield* sql`DROP INDEX IF EXISTS ai_accounts_name_idx`;
  yield* sql`DROP INDEX IF EXISTS ai_accounts_priority_idx`;
  yield* sql`
    CREATE UNIQUE INDEX ai_accounts_owner_name_idx
    ON ai_accounts (owner_kind, owner_id, name COLLATE NOCASE)
  `;
  yield* sql`
    CREATE INDEX ai_accounts_owner_priority_idx ON ai_accounts (owner_kind, owner_id, priority)
  `;
});
