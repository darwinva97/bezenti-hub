import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Access keys (access-keys ticket 01): a Space's AI gateway keys. Only a key's SHA-256 and its
// last four characters are kept, never the key. `models_json` `["*"]`: every model;
// `accounts_json` NULL: every AI account the Space owns. Rows are never deleted (usage, audit).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ai_access_keys (
      key_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      space_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      models_json TEXT NOT NULL,
      accounts_json TEXT,
      expires_at TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_reason TEXT,
      revoked_by TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX ai_access_keys_space_idx ON ai_access_keys (space_id, created_at)`;
  // A request by an access key: no User (`user_id = ''`), the key here.
  yield* sql`ALTER TABLE ai_usage ADD COLUMN access_key_id TEXT`;
});
