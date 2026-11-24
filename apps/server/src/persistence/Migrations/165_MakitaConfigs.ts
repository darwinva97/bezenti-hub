import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 03: a Space's Makita configurations, every column of the spec from now on (the
// service limits what each batch accepts). `environment_id` NULL: the Space's Sandbox. Rows are
// never removed (`deleted_at`): tasks, usage and the audit name them. Written by makita/ alone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE makita_configs (
      config_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      repos_json TEXT NOT NULL,
      triggers_json TEXT NOT NULL,
      callers_mode TEXT NOT NULL CHECK (callers_mode IN ('creator', 'list', 'members', 'anyone')),
      callers_json TEXT NOT NULL DEFAULT '[]',
      strangers TEXT NOT NULL DEFAULT 'ignore' CHECK (strangers IN ('ignore', 'reply')),
      ignore_json TEXT NOT NULL DEFAULT '[]',
      model_selection_json TEXT NOT NULL,
      capability TEXT NOT NULL DEFAULT 'comment' CHECK (capability IN ('comment', 'push')),
      may_land INTEGER NOT NULL DEFAULT 0 CHECK (may_land IN (0, 1)),
      approval TEXT NOT NULL DEFAULT 'others' CHECK (approval IN ('others', 'always', 'never')),
      approvers_json TEXT NOT NULL DEFAULT '[]',
      base_branch TEXT,
      environment_id TEXT,
      paused_at TEXT,
      paused_by TEXT,
      paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN
        ('manual', 'owner', 'permission-revoked', 'creator-disabled', 'creator-left')),
      CHECK (may_land = 0 OR capability = 'push'),
      CHECK ((paused_at IS NULL) = (paused_reason IS NULL))
    )
  `;
  yield* sql`
    CREATE INDEX makita_configs_space_idx ON makita_configs (space_id, created_at)
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX makita_configs_creator_idx ON makita_configs (created_by, space_id)
    WHERE deleted_at IS NULL
  `;
});
