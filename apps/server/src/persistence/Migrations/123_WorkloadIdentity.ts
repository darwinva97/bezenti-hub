import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Workload identity (ticket 07, ADR 0009): `identity` entries, always a sealed Secret file with an
// audience and a TTL, and the public halves of the Hub's signing keys. Rebuilt: `kind`'s CHECK.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE vault_entries_123 (
      entry_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('own', 'copy', 'link', 'provider', 'template', 'identity')),
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
      delivery TEXT NOT NULL DEFAULT 'env' CHECK (delivery IN ('env', 'file', 'none')),
      template_text TEXT CHECK (length(template_text) <= 65536),
      identity_audience TEXT CHECK (length(identity_audience) BETWEEN 1 AND 256),
      identity_ttl_seconds INTEGER CHECK (identity_ttl_seconds BETWEEN 60 AND 3600),
      CHECK ((kind = 'link') = (linked_entry_id IS NOT NULL)),
      CHECK ((kind IN ('link', 'provider', 'template', 'identity')) = (value_id IS NULL)),
      CHECK ((kind = 'link') = (class IS NULL)),
      CHECK ((kind = 'link') = (revealable IS NULL)),
      CHECK (class IS NULL OR class IN ('secret', 'variable')),
      CHECK (revealable IS NULL OR revealable IN (0, 1)),
      CHECK (class IS NOT 'variable' OR revealable = 0),
      CHECK ((kind = 'provider') = (provider_id IS NOT NULL AND provider_reference IS NOT NULL)),
      CHECK (kind = 'provider' OR provider_scope_id IS NULL),
      CHECK (kind <> 'provider' OR (class = 'secret' AND revealable = 0)),
      CHECK ((kind = 'template') = (template_text IS NOT NULL)),
      CHECK (kind <> 'template' OR (revealable = 0 AND delivery <> 'none')),
      CHECK ((kind = 'identity') = (identity_audience IS NOT NULL)),
      CHECK ((kind = 'identity') = (identity_ttl_seconds IS NOT NULL)),
      CHECK (kind <> 'identity' OR (class = 'secret' AND revealable = 0 AND delivery = 'file'))
    )
  `;
  yield* sql`
    INSERT INTO vault_entries_123 (entry_id, vault_id, name, description, kind, linked_entry_id,
      value_id, unmasked, version, created_at, updated_at, updated_by, class, revealable,
      provider_id, provider_reference, provider_scope_id, delivery, template_text)
    SELECT entry_id, vault_id, name, description, kind, linked_entry_id, value_id, unmasked,
      version, created_at, updated_at, updated_by, class, revealable, provider_id,
      provider_reference, provider_scope_id, delivery, template_text
    FROM vault_entries
  `;
  yield* sql`DROP TABLE vault_entries`;
  yield* sql`ALTER TABLE vault_entries_123 RENAME TO vault_entries`;
  yield* sql`CREATE UNIQUE INDEX vault_entries_name_idx ON vault_entries (vault_id, name)`;
  yield* sql`CREATE INDEX vault_entries_linked_idx ON vault_entries (linked_entry_id)`;
  yield* sql`CREATE INDEX vault_entries_provider_idx ON vault_entries (provider_id)`;
  // The private half of each key is sealed in the server's secret store (`identity-signing-<kid>`).
  yield* sql`
    CREATE TABLE identity_signing_keys (
      kid TEXT PRIMARY KEY,
      public_jwk TEXT NOT NULL,
      created_at TEXT NOT NULL,
      publish_at TEXT NOT NULL,
      sign_from TEXT NOT NULL,
      sign_until TEXT NOT NULL,
      retire_at TEXT NOT NULL
    )
  `;
});
