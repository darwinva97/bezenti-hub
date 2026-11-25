import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 24: the labels a configuration lets Makita set, and per task whether it reported
// reproducing the problem and which labels it set (and has not removed).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE makita_configs ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN reproduced TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'`;
});
