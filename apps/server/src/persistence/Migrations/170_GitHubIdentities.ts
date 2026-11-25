import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 08: each User's linked GitHub account (one per User, one User per account, by
// numeric id) and the one-time codes that prove it, kept as SHA-256 and bound to the account they
// may link. Written by makita/GitHubIdentities.ts alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE github_identities (
      user_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      github_user_id INTEGER NOT NULL,
      login TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      UNIQUE (host, github_user_id)
    )
  `;
  yield* sql`
    CREATE TABLE github_link_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      github_user_id INTEGER NOT NULL,
      login TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      outcome TEXT CHECK (outcome IN ('linked', 'taken'))
    )
  `;
  yield* sql`CREATE INDEX github_link_codes_user_idx ON github_link_codes (user_id)`;
});
