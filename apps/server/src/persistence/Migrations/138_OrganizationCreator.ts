import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who created an Organization, now that any User may: the Steward plans-and-limits starts from.
// NULL for Organizations from before, which the Owner created.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE spaces ADD COLUMN created_by_user_id TEXT REFERENCES users(user_id)`;
});
