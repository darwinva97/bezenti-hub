import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 15: a lent Vault group's use. Per Grant, UTC day (as AI usage's daily rows), User of the
// borrowing Space and lent name, how many processes received it. Names and counts only, never a
// value nor a Thread. Kept as history, like the Grant itself; a removed User's rows stay, as their
// AI usage does (users are never deleted).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE vault_grant_usage (
      grant_id TEXT NOT NULL,
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      deliveries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (grant_id, day, user_id, name)
    )
  `;
});
