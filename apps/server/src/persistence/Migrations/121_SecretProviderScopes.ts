import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Provider scopes: a provider's role and the path prefixes a Vault may read through it (ticket 03),
// and which Vaults may use each. No secrets here: a scope's credentials are sealed in the store.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE secret_provider_scopes (
      scope_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_json TEXT NOT NULL DEFAULT '{}',
      allowed_paths_json TEXT NOT NULL CHECK (json_array_length(allowed_paths_json) > 0),
      allowed_dynamic_json TEXT NOT NULL DEFAULT '[]',
      writable INTEGER NOT NULL DEFAULT 0 CHECK (writable IN (0, 1)),
      probe_reference TEXT CHECK (length(probe_reference) <= 1024),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX secret_provider_scopes_label_idx
    ON secret_provider_scopes (provider_id, label COLLATE NOCASE)
  `;
  yield* sql`
    CREATE TABLE vault_provider_scopes (
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      scope_id TEXT NOT NULL REFERENCES secret_provider_scopes(scope_id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (vault_id, scope_id)
    )
  `;
  yield* sql`CREATE INDEX vault_provider_scopes_scope_idx ON vault_provider_scopes (scope_id)`;
});
