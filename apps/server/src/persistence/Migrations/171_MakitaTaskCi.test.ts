import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("gives every Makita task CI columns, empty for the ones before it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 170 });
    yield* sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
      VALUES ('mkt_1', 'mk_1', 'org-acme', 'p1', 'github.com', 'acme/widgets', 12, 'issue',
        't1', 1, 'octocat', 'running', '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z')
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 171 }), [[171, "MakitaTaskCi"]]);

    const read = sql<{
      readonly sha: string | null;
      readonly state: string | null;
      readonly since: string | null;
      readonly failing: string | null;
    }>`
      SELECT ci_sha AS sha, ci_state AS state, ci_since AS since, ci_failing_json AS failing
      FROM makita_tasks WHERE task_id = 'mkt_1'
    `;
    assert.deepEqual(yield* read, [{ sha: null, state: null, since: null, failing: null }]);
    yield* sql`
      UPDATE makita_tasks SET ci_sha = 'abc', ci_state = 'pending',
        ci_since = '2026-11-24T10:05:00Z', ci_failing_json = '[]'
      WHERE task_id = 'mkt_1'
    `;
    assert.deepEqual(yield* read, [
      { sha: "abc", state: "pending", since: "2026-11-24T10:05:00Z", failing: "[]" },
    ]);
  }).pipe(Effect.provide(layer)),
);
