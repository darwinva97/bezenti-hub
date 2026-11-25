import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita tickets 25–27: what a configuration does on its own (one JSON, every option off), when a
// task's pull request was seen closed, and each issue Makita ever closed (once per issue, ever).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE makita_configs ADD COLUMN autonomy_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`ALTER TABLE makita_tasks ADD COLUMN pr_closed_at TEXT`;
  yield* sql`
    CREATE TABLE makita_issue_closes (
      host TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      config_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('wanted', 'not-wanted', 'duplicate',
        'cannot-reproduce', 'already-fixed')),
      ref_number INTEGER,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      state_reason TEXT NOT NULL CHECK (state_reason IN ('completed', 'not_planned')),
      claimed_at TEXT NOT NULL,
      closed_at TEXT,
      reopened_at TEXT,
      reopened_by_github_id INTEGER,
      reopened_by_login TEXT,
      reopened_via TEXT CHECK (reopened_via IS NULL OR reopened_via IN ('github', 'command')),
      PRIMARY KEY (host, repo, number)
    )
  `;
  yield* sql`CREATE UNIQUE INDEX makita_issue_closes_task_idx ON makita_issue_closes (task_id)`;
  yield* sql`
    CREATE INDEX makita_issue_closes_config_idx ON makita_issue_closes (config_id, claimed_at)
  `;
});
