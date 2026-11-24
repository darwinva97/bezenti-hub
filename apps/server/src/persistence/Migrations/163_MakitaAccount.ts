import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 01: the bot's GitHub account, one row per Hub. The token lives in the Hub's sealed
// store; here only its last four characters. `scopes_json`: a classic token's `X-OAuth-Scopes`
// (NULL for a fine-grained one). Written by makita/ alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE makita_account (
      account_id TEXT PRIMARY KEY CHECK (account_id = 'makita'),
      host TEXT NOT NULL,
      login TEXT NOT NULL,
      github_user_id INTEGER NOT NULL,
      token_kind TEXT NOT NULL CHECK (token_kind IN ('classic', 'fine-grained')),
      token_hint TEXT NOT NULL,
      scopes_json TEXT,
      token_expires_at TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('ok', 'token-invalid', 'rate-limited', 'unreachable')),
      checked_at TEXT NOT NULL,
      global_paused_at TEXT,
      global_paused_by TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
