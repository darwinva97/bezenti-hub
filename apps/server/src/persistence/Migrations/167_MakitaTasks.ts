import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 05: one task per issue or pull request, with its Thread. The row is written
// before the Thread exists and is the Thread's Makita mark (Vaults, the MCP door, the gateway and
// usage read it). Every column of the spec from now on; one live task per issue. Written by
// makita/ alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE makita_tasks (
      task_id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
      thread_id TEXT NOT NULL,
      caller_github_id INTEGER NOT NULL,
      caller_login TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('awaiting-approval', 'running', 'waiting-ci',
        'waiting-reply', 'done', 'stopped', 'failed')),
      branch TEXT,
      base_branch TEXT,
      head_sha TEXT,
      pr_number INTEGER,
      pending_push_json TEXT,
      approved_through TEXT,
      last_push_at TEXT,
      landed_sha TEXT,
      ci_fix_attempts INTEGER NOT NULL DEFAULT 0,
      replies_without_person INTEGER NOT NULL DEFAULT 0,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX makita_tasks_thread_idx ON makita_tasks (thread_id)`;
  yield* sql`
    CREATE UNIQUE INDEX makita_tasks_live_idx ON makita_tasks (host, repo, number)
    WHERE state NOT IN ('done', 'stopped', 'failed')
  `;
  yield* sql`CREATE INDEX makita_tasks_config_idx ON makita_tasks (config_id, created_at)`;
});
