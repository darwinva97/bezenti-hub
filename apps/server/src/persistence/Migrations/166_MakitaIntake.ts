import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 04: what the poller read of each repository (one row per repository and feed,
// shared by every configuration: there is one token) and each GitHub event it decided on, once,
// by its natural key. Written by makita/ alone; events are deleted after 90 days.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE makita_repo_cursors (
      host TEXT NOT NULL,
      repo TEXT NOT NULL,
      feed TEXT NOT NULL,
      etag TEXT,
      cursor TEXT,
      next_poll_at TEXT,
      last_error TEXT,
      unreachable_since TEXT,
      PRIMARY KEY (host, repo, feed)
    )
  `;
  yield* sql`
    CREATE TABLE makita_events (
      event_key TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
      actor_github_id INTEGER,
      actor_login TEXT,
      created_at_github TEXT,
      seen_at TEXT NOT NULL,
      config_id TEXT,
      task_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('started', 'queued', 'ignored-not-allowed',
        'ignored-bot', 'ignored-self', 'ignored-paused', 'ignored-no-config', 'ignored-edited',
        'ignored-not-approver', 'guard', 'approval', 'land', 'command')),
      detail TEXT
    )
  `;
  yield* sql`CREATE INDEX makita_events_config_idx ON makita_events (config_id, seen_at)`;
  yield* sql`CREATE INDEX makita_events_outcome_idx ON makita_events (outcome, seen_at)`;
});
