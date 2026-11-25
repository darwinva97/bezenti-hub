import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 10: where a pushing task's own worktree is (its machine, the path there and the
// commit it started from), written once it exists, so a restart never makes or resets it again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN workspace_json TEXT`;
});
