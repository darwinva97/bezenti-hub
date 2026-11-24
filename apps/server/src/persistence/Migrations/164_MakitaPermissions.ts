import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 02: «may use Makita», given by the Owner per User and Space. A row takes effect
// only while its User is still an Admin or Member there (or it is their own Personal space).
// Written by makita/ alone; a User removed from the Hub loses theirs in the removal.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE makita_permissions (
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, space_id)
    )
  `;
  yield* sql`CREATE INDEX makita_permissions_space_idx ON makita_permissions (space_id)`;
});
