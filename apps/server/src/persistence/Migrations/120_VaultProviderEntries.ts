import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Provider entry keeps where to read its value (a provider of `settings.secretProviders` and a
// reference), never a value; a sealed Secret. The scope is ticket 03's. Rebuilt: `kind`'s CHECK.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE vault_entries_120 (
      entry_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('own', 'copy', 'link', 'provider')),
      linked_entry_id TEXT,
      value_id TEXT,
      unmasked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      class TEXT DEFAULT 'secret',
      revealable INTEGER DEFAULT 0,
      provider_id TEXT,
      provider_reference TEXT CHECK (length(provider_reference) <= 1024),
      provider_scope_id TEXT,
      CHECK ((kind = 'link') = (linked_entry_id IS NOT NULL)),
      CHECK ((kind IN ('link', 'provider')) = (value_id IS NULL)),
      CHECK ((kind = 'link') = (class IS NULL)),
      CHECK ((kind = 'link') = (revealable IS NULL)),
      CHECK (class IS NULL OR class IN ('secret', 'variable')),
      CHECK (revealable IS NULL OR revealable IN (0, 1)),
      CHECK (class IS NOT 'variable' OR revealable = 0),
      CHECK ((kind = 'provider') = (provider_id IS NOT NULL AND provider_reference IS NOT NULL)),
      CHECK (kind = 'provider' OR provider_scope_id IS NULL),
      CHECK (kind <> 'provider' OR (class = 'secret' AND revealable = 0))
    )
  `;
  yield* sql`
    INSERT INTO vault_entries_120 (entry_id, vault_id, name, description, kind, linked_entry_id,
      value_id, unmasked, version, created_at, updated_at, updated_by, class, revealable)
    SELECT entry_id, vault_id, name, description, kind, linked_entry_id, value_id, unmasked,
      version, created_at, updated_at, updated_by, class, revealable
    FROM vault_entries
  `;
  yield* sql`DROP TABLE vault_entries`;
  yield* sql`ALTER TABLE vault_entries_120 RENAME TO vault_entries`;
  yield* sql`CREATE UNIQUE INDEX vault_entries_name_idx ON vault_entries (vault_id, name)`;
  yield* sql`CREATE INDEX vault_entries_linked_idx ON vault_entries (linked_entry_id)`;
  yield* sql`CREATE INDEX vault_entries_provider_idx ON vault_entries (provider_id)`;
});
