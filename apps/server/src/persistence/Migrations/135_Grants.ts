import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants: an owner lends one resource to a destination with limits. One row per loan, kept after
// it ends (the history). At most one waiting or active loan of a resource to the same destination.
// Only `environment` is lent today; the other kinds and a Plan destination fit the same row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE grants (
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
      CHECK (target_id IS NOT NULL OR state = 'offered')
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX grants_one_live_idx
    ON grants(resource_kind, resource_id, target_kind, target_id)
    WHERE state IN ('pending', 'active')
  `;
  yield* sql`CREATE INDEX grants_target_idx ON grants(target_kind, target_id, state)`;
  yield* sql`CREATE INDEX grants_lender_idx ON grants(lender_kind, lender_id)`;
  yield* sql`CREATE INDEX grants_resource_idx ON grants(resource_kind, resource_id, state)`;
});
