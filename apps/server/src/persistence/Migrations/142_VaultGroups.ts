import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 03: each `vaults` row becomes a group (same id) of its owner's Vault: the Main
// vault is the Owner's `default`; Organizations get an empty one. Links and copies become own
// Secrets (a live link shares its original's value until `Vaults.unshareValues`); broken ones go.
// Children are rebuilt before `vaults` is dropped: foreign keys are on.
const OWNER = `(SELECT user_id FROM users WHERE is_owner = 1)`;

/** A link that still delivers: its original is a non-link of the Main vault that holds a value. */
const LIVE_ORIGINAL = `
  LEFT JOIN vault_entries o ON e.kind = 'link' AND o.entry_id = e.linked_entry_id
    AND o.vault_id = 'vault-main' AND o.kind <> 'link' AND o.value_id IS NOT NULL`;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE vault_groups (
      group_id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'organization')),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      position INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      CHECK (is_default = 0 OR (archived_at IS NULL AND name = 'default'))
    )
  `;

  // No Owner yet: nothing could have been added to the Main vault, so it goes with its rows; the
  // Owner's `default` is made with the Owner.
  const orphanMain = `SELECT vault_id FROM vaults WHERE is_main = 1 AND ${OWNER} IS NULL`;
  yield* sql`DELETE FROM vault_entries WHERE vault_id IN (${sql.literal(orphanMain)})`;
  yield* sql`DELETE FROM vault_allowances WHERE vault_id IN (${sql.literal(orphanMain)})`;
  yield* sql`DELETE FROM space_default_vaults WHERE vault_id IN (${sql.literal(orphanMain)})`;
  yield* sql`DELETE FROM project_vault_choices WHERE vault_id IN (${sql.literal(orphanMain)})`;
  yield* sql`DELETE FROM vault_provider_scopes WHERE vault_id IN (${sql.literal(orphanMain)})`;
  yield* sql`DELETE FROM vaults WHERE vault_id IN (${sql.literal(orphanMain)})`;

  // `default` is the default group's alone: a Vault already named so is renamed (names were
  // unique across the Hub, so an owner holds at most one of each).
  yield* sql`
    INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, description, is_default,
      position, archived_at, created_at, updated_at, created_by)
    SELECT v.vault_id,
      CASE WHEN v.space_id IS NULL THEN 'user' ELSE 'organization' END,
      CASE WHEN v.space_id IS NULL THEN COALESCE(${sql.literal(OWNER)}, v.created_by, '')
        ELSE v.space_id END,
      CASE
        WHEN v.is_main = 1 THEN 'default'
        WHEN lower(v.name) <> 'default' THEN v.name
        WHEN EXISTS (SELECT 1 FROM vaults w WHERE lower(w.name) = 'default (old)')
          THEN 'default (old ' || substr(v.vault_id, -6) || ')'
        ELSE 'default (old)'
      END,
      v.description, v.is_main, v.position,
      CASE WHEN v.is_main = 1 THEN NULL ELSE v.archived_at END,
      v.created_at, v.updated_at, v.created_by
    FROM vaults v
  `;
  yield* sql`
    INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
      updated_at)
    SELECT 'vault-default-' || lower(hex(randomblob(16))), 'organization', s.space_id, 'default',
      1, ${sql.literal(NOW)}, ${sql.literal(NOW)}
    FROM spaces s
    WHERE s.kind = 'organization' AND s.deleting_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM vault_groups g
      WHERE g.owner_kind = 'organization' AND g.owner_id = s.space_id AND g.is_default = 1
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX vault_groups_name_idx
    ON vault_groups (owner_kind, owner_id, name COLLATE NOCASE)
  `;
  yield* sql`
    CREATE UNIQUE INDEX vault_groups_default_idx
    ON vault_groups (owner_kind, owner_id) WHERE is_default = 1
  `;

  // The links that become independent: for the Owner's one-time notice, and audited.
  yield* sql`
    CREATE TABLE vault_unlinked_notices (
      entry_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      original_name TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO vault_unlinked_notices (entry_id, group_id, name, original_name, created_at)
    SELECT e.entry_id, e.vault_id, e.name, o.name, ${sql.literal(NOW)}
    FROM vault_entries e ${sql.literal(LIVE_ORIGINAL)}
    WHERE e.kind = 'link' AND o.entry_id IS NOT NULL
  `;
  const audited = (op: string, where: string, from: string) => sql`
    INSERT INTO audit_log (at, actor_source, actor_user_id, space_id, space_name, action,
      target_kind, target_id, target_name, detail_json)
    SELECT ${sql.literal(NOW)}, 'system', NULL, v.space_id,
      (SELECT name FROM spaces WHERE space_id = v.space_id), 'secret.edit', 'secret',
      e.entry_id, e.name,
      json_object('vault', v.name, 'vaultId', v.vault_id, 'kind', 'own', 'op', ${op},
        'from', ${from})
    FROM vault_entries e JOIN vaults v ON v.vault_id = e.vault_id ${sql.literal(LIVE_ORIGINAL)}
    WHERE ${sql.literal(where)}
  `;
  yield* audited("unlinked", "e.kind = 'link' AND o.entry_id IS NOT NULL", "link");
  yield* audited("unlinked", "e.kind = 'copy'", "copy");
  yield* audited("delete", "e.kind = 'link' AND o.entry_id IS NULL", "broken-link");

  yield* sql`
    CREATE TABLE vault_entries_142 (
      entry_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES vault_groups(group_id),
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('own', 'provider', 'template', 'identity')),
      value_id TEXT,
      unmasked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      class TEXT NOT NULL DEFAULT 'secret' CHECK (class IN ('secret', 'variable')),
      revealable INTEGER NOT NULL DEFAULT 0 CHECK (revealable IN (0, 1)),
      provider_id TEXT,
      provider_reference TEXT CHECK (length(provider_reference) <= 1024),
      provider_scope_id TEXT,
      delivery TEXT NOT NULL DEFAULT 'env' CHECK (delivery IN ('env', 'file', 'none')),
      template_text TEXT CHECK (length(template_text) <= 65536),
      identity_audience TEXT CHECK (length(identity_audience) BETWEEN 1 AND 256),
      identity_ttl_seconds INTEGER CHECK (identity_ttl_seconds BETWEEN 60 AND 3600),
      CHECK ((kind IN ('provider', 'template', 'identity')) = (value_id IS NULL)),
      CHECK (class <> 'variable' OR revealable = 0),
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
    INSERT INTO vault_entries_142 (entry_id, group_id, name, description, kind, value_id,
      unmasked, version, created_at, updated_at, updated_by, class, revealable, provider_id,
      provider_reference, provider_scope_id, delivery, template_text, identity_audience,
      identity_ttl_seconds)
    SELECT e.entry_id, e.vault_id, e.name, e.description,
      CASE WHEN e.kind IN ('link', 'copy') THEN 'own' ELSE e.kind END,
      CASE WHEN e.kind = 'link' THEN o.value_id ELSE e.value_id END,
      CASE WHEN e.kind = 'link' THEN o.unmasked ELSE e.unmasked END,
      e.version, e.created_at, e.updated_at, e.updated_by,
      COALESCE(CASE WHEN e.kind = 'link' THEN o.class ELSE e.class END, 'secret'),
      0, e.provider_id, e.provider_reference, e.provider_scope_id, e.delivery, e.template_text,
      e.identity_audience, e.identity_ttl_seconds
    FROM vault_entries e ${sql.literal(LIVE_ORIGINAL)}
    WHERE e.kind <> 'link' OR o.entry_id IS NOT NULL
  `;
  yield* sql`DROP TABLE vault_entries`;
  yield* sql`ALTER TABLE vault_entries_142 RENAME TO vault_entries`;
  yield* sql`CREATE UNIQUE INDEX vault_entries_name_idx ON vault_entries (group_id, name)`;
  yield* sql`CREATE INDEX vault_entries_provider_idx ON vault_entries (provider_id)`;
  yield* sql`CREATE INDEX vault_entries_value_idx ON vault_entries (value_id)`;

  // The tables that name a Vault now name its group: same rows, the column renamed.
  yield* sql`
    CREATE TABLE vault_allowances_142 (
      group_id TEXT NOT NULL REFERENCES vault_groups(group_id),
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('space', 'user')),
      subject_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, subject_kind, subject_id)
    )
  `;
  yield* sql`
    INSERT INTO vault_allowances_142 (group_id, subject_kind, subject_id, created_at)
    SELECT vault_id, subject_kind, subject_id, created_at FROM vault_allowances
  `;
  yield* sql`DROP TABLE vault_allowances`;
  yield* sql`ALTER TABLE vault_allowances_142 RENAME TO vault_allowances`;

  yield* sql`
    CREATE TABLE space_default_vaults_142 (
      space_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES vault_groups(group_id),
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (space_id, group_id)
    )
  `;
  yield* sql`
    INSERT INTO space_default_vaults_142 (space_id, group_id, position)
    SELECT space_id, vault_id, position FROM space_default_vaults
  `;
  yield* sql`DROP TABLE space_default_vaults`;
  yield* sql`ALTER TABLE space_default_vaults_142 RENAME TO space_default_vaults`;

  yield* sql`
    CREATE TABLE project_vault_choices_142 (
      project_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES vault_groups(group_id),
      choice TEXT NOT NULL CHECK (choice IN ('add', 'remove')),
      PRIMARY KEY (project_id, group_id)
    )
  `;
  yield* sql`
    INSERT INTO project_vault_choices_142 (project_id, group_id, choice)
    SELECT project_id, vault_id, choice FROM project_vault_choices
  `;
  yield* sql`DROP TABLE project_vault_choices`;
  yield* sql`ALTER TABLE project_vault_choices_142 RENAME TO project_vault_choices`;

  yield* sql`
    CREATE TABLE vault_provider_scopes_142 (
      group_id TEXT NOT NULL REFERENCES vault_groups(group_id),
      scope_id TEXT NOT NULL REFERENCES secret_provider_scopes(scope_id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, scope_id)
    )
  `;
  yield* sql`
    INSERT INTO vault_provider_scopes_142 (group_id, scope_id, created_at)
    SELECT vault_id, scope_id, created_at FROM vault_provider_scopes
  `;
  yield* sql`DROP TABLE vault_provider_scopes`;
  yield* sql`ALTER TABLE vault_provider_scopes_142 RENAME TO vault_provider_scopes`;
  yield* sql`CREATE INDEX vault_provider_scopes_scope_idx ON vault_provider_scopes (scope_id)`;

  yield* sql`DROP TABLE vaults`;
});
