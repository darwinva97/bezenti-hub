import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 12: the CI of a task's pull request, on the exact commit Makita pushed: which
// commit, what was decided about it, since when it is watched, and the failing checks of a RED.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN ci_sha TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN ci_state TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN ci_since TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN ci_failing_json TEXT`;
});
