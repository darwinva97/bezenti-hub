import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 04: an Invitation without a Space (and so without a Role) is a
// Platform invitation, the Owner's hand-made User. `space_id` and `role` are null together or set
// together. Rebuilt because SQLite cannot change NOT NULL or a CHECK; same columns, rows,
// references and indexes, plus one for listing Platform invitations. No table points at it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE space_invitations_new (
      invitation_id TEXT PRIMARY KEY,
      space_id TEXT REFERENCES spaces(space_id),
      role TEXT CHECK (role IN ('admin', 'member', 'guest')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT REFERENCES users(user_id),
      revoked_at TEXT,
      CHECK (accepted_at IS NULL OR revoked_at IS NULL),
      CHECK ((space_id IS NULL) = (role IS NULL))
    )
  `;
  yield* sql`
    INSERT INTO space_invitations_new (invitation_id, space_id, role, token_hash, created_by,
      created_at, expires_at, accepted_at, accepted_by, revoked_at)
    SELECT invitation_id, space_id, role, token_hash, created_by, created_at, expires_at,
      accepted_at, accepted_by, revoked_at
    FROM space_invitations
  `;
  yield* sql`DROP TABLE space_invitations`;
  yield* sql`ALTER TABLE space_invitations_new RENAME TO space_invitations`;
  yield* sql`CREATE INDEX space_invitations_space_idx ON space_invitations(space_id, created_at)`;
  yield* sql`
    CREATE INDEX space_invitations_platform_idx ON space_invitations(created_at)
    WHERE space_id IS NULL
  `;
});
