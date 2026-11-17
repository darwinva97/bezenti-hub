import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A lent machine's Sandbox is an Environment of its own (`mode = 'lent'`): no owner, the borrowing
// Space, its Grant and host, never a stored credential (`dedicated_sandbox_credentials` holds it).
// The host's report and each lent home's disk use are kept. SQLite cannot change a CHECK, so
// `environments` is rebuilt.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE environments_new (
      environment_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('hub', 'external', 'sandbox')),
      mode TEXT NOT NULL DEFAULT 'personal'
        CHECK (mode IN ('personal', 'dedicated', 'sandbox', 'lent')),
      owner_user_id TEXT,
      space_id TEXT,
      credential_hash TEXT UNIQUE,
      credential_issued_at TEXT,
      credential_issued_by TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_os TEXT,
      last_hostname TEXT,
      last_protocol_version INTEGER,
      last_resources_json TEXT,
      last_providers_json TEXT,
      revoked_at TEXT,
      grant_id TEXT UNIQUE,
      host_environment_id TEXT,
      sandbox_host_json TEXT,
      last_disk_json TEXT,
      CHECK (
        (kind = 'hub' AND mode = 'personal' AND owner_user_id IS NULL AND space_id IS NULL
          AND credential_hash IS NULL)
        OR (kind = 'external' AND credential_hash IS NOT NULL AND credential_issued_at IS NOT NULL
          AND ((mode = 'personal' AND owner_user_id IS NOT NULL AND space_id IS NULL)
            OR (mode = 'dedicated' AND owner_user_id IS NULL AND space_id IS NOT NULL)))
        OR (kind = 'sandbox' AND mode = 'sandbox' AND owner_user_id IS NULL
          AND space_id IS NOT NULL AND credential_hash IS NOT NULL
          AND credential_issued_at IS NOT NULL)
        OR (kind = 'sandbox' AND mode = 'lent' AND owner_user_id IS NULL
          AND space_id IS NOT NULL AND credential_hash IS NULL)
      ),
      CHECK ((mode = 'lent') = (grant_id IS NOT NULL AND host_environment_id IS NOT NULL))
    )
  `;
  yield* sql`
    INSERT INTO environments_new (
      environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
      credential_issued_at, credential_issued_by, registered_at, last_seen_at, last_os,
      last_hostname, last_protocol_version, last_resources_json, last_providers_json, revoked_at
    )
    SELECT environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
      credential_issued_at, credential_issued_by, registered_at, last_seen_at, last_os,
      last_hostname, last_protocol_version, last_resources_json, last_providers_json, revoked_at
    FROM environments
  `;
  yield* sql`DROP TABLE environments`;
  yield* sql`ALTER TABLE environments_new RENAME TO environments`;
  yield* sql`CREATE UNIQUE INDEX environments_one_hub ON environments(kind) WHERE kind = 'hub'`;
  yield* sql`CREATE INDEX environments_owner_idx ON environments(owner_user_id)`;
  yield* sql`CREATE INDEX environments_space_idx ON environments(space_id)`;
  yield* sql`CREATE INDEX environments_host_idx ON environments(host_environment_id)`;
});
