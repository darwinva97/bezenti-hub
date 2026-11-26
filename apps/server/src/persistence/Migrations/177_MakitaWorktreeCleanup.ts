import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 28: a finished task's worktree removed from its machine (or found gone), its retries
// and giving up, and the `makita/…` branch of a pull request a person merged or closed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN worktree_removed_at TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN worktree_failing_since TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN worktree_next_try_at TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN worktree_failure TEXT`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN worktree_gave_up_at TEXT`;
  yield* sql`
    ALTER TABLE makita_tasks ADD COLUMN branch_cleanup TEXT
      CHECK (branch_cleanup IS NULL OR branch_cleanup IN ('pending', 'deleted', 'failed'))
  `;
  yield* sql`
    CREATE INDEX makita_tasks_worktree_idx ON makita_tasks (updated_at)
    WHERE workspace_json IS NOT NULL AND worktree_removed_at IS NULL
      AND worktree_gave_up_at IS NULL
  `;
});
