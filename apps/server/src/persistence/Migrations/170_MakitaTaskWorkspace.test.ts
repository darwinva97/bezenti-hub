import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("gives every Makita task a workspace column, empty for the ones before it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 168 });
    yield* sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
      VALUES ('mkt_1', 'mk_1', 'org-acme', 'p1', 'github.com', 'acme/widgets', 12, 'issue',
        't1', 1, 'octocat', 'running', '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z')
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 170 }), [
      [170, "MakitaTaskWorkspace"],
    ]);

    const before = yield* sql<{ readonly workspace: string | null }>`
      SELECT workspace_json AS workspace FROM makita_tasks WHERE task_id = 'mkt_1'
    `;
    assert.deepEqual(before, [{ workspace: null }]);
    yield* sql`
      UPDATE makita_tasks SET workspace_json = '{"cwd":"/w"}' WHERE task_id = 'mkt_1'
    `;
    const after = yield* sql<{ readonly workspace: string | null }>`
      SELECT workspace_json AS workspace FROM makita_tasks WHERE task_id = 'mkt_1'
    `;
    assert.deepEqual(after, [{ workspace: '{"cwd":"/w"}' }]);
  }).pipe(Effect.provide(layer)),
);
