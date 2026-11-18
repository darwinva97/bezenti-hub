import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 06: a lending link nobody applied has no destination, and its lender may cancel
// it. 135 allowed a missing destination only while `offered`; now also once `cancelled`. Rebuilt
// because SQLite cannot change a CHECK; same columns, rows and indexes. No table points at it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE grants_new (
      grant_id TEXT PRIMARY KEY,
      resource_kind TEXT NOT NULL
        CHECK (resource_kind IN ('environment', 'ai-account', 'vault-group')),
      resource_id TEXT NOT NULL,
      lender_kind TEXT NOT NULL CHECK (lender_kind IN ('user', 'organization')),
      lender_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('space', 'plan')),
      target_id TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('offered', 'pending', 'active', 'rejected', 'cancelled', 'ended')),
      end_reason TEXT CHECK (end_reason IN (
        'revoked', 'returned', 'resource-gone', 'target-gone', 'lender-gone', 'owner-changed'
      )),
      limits_json TEXT NOT NULL,
      offer_token_hash TEXT UNIQUE,
      offer_expires_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      decided_at TEXT,
      decided_by TEXT,
      ended_at TEXT,
      ended_by TEXT,
      CHECK ((state = 'ended') = (end_reason IS NOT NULL)),
      CHECK (target_id IS NOT NULL OR state IN ('offered', 'cancelled'))
    )
  `;
  yield* sql`
    INSERT INTO grants_new (grant_id, resource_kind, resource_id, lender_kind, lender_id,
      target_kind, target_id, state, end_reason, limits_json, offer_token_hash, offer_expires_at,
      created_at, created_by, decided_at, decided_by, ended_at, ended_by)
    SELECT grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
      state, end_reason, limits_json, offer_token_hash, offer_expires_at, created_at, created_by,
      decided_at, decided_by, ended_at, ended_by
    FROM grants
  `;
  yield* sql`DROP TABLE grants`;
  yield* sql`ALTER TABLE grants_new RENAME TO grants`;
  yield* sql`
    CREATE UNIQUE INDEX grants_one_live_idx
    ON grants(resource_kind, resource_id, target_kind, target_id)
    WHERE state IN ('pending', 'active')
  `;
  yield* sql`CREATE INDEX grants_target_idx ON grants(target_kind, target_id, state)`;
  yield* sql`CREATE INDEX grants_lender_idx ON grants(lender_kind, lender_id)`;
  yield* sql`CREATE INDEX grants_resource_idx ON grants(resource_kind, resource_id, state)`;
});
