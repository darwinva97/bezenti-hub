import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "gives configurations an empty label list and tasks no report and no labels, for the ones before it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 171 });
      yield* sql`
        INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at, updated_at,
          repos_json, triggers_json, callers_mode, model_selection_json)
        VALUES ('mk_1', 'org-acme', 'Widget bugs', 'u1', '2026-11-24T10:00:00Z',
          '2026-11-24T10:00:00Z', '{"all":true}', '{"label":"makita"}', 'list', '{}')
      `;
      yield* sql`
        INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
          kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
        VALUES ('mkt_1', 'mk_1', 'org-acme', 'p1', 'github.com', 'acme/widgets', 12, 'issue',
          't1', 1, 'octocat', 'running', '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z')
      `;

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 172 }), [
        [172, "MakitaTriage"],
      ]);

      const config = sql<{ readonly labels: string }>`
        SELECT labels_json AS labels FROM makita_configs WHERE config_id = 'mk_1'
      `;
      const task = sql<{ readonly reproduced: string | null; readonly labels: string }>`
        SELECT reproduced, labels_json AS labels FROM makita_tasks WHERE task_id = 'mkt_1'
      `;
      assert.deepEqual(yield* config, [{ labels: "[]" }]);
      assert.deepEqual(yield* task, [{ reproduced: null, labels: "[]" }]);
      yield* sql`UPDATE makita_configs SET labels_json = '["bug"]' WHERE config_id = 'mk_1'`;
      yield* sql`
        UPDATE makita_tasks SET reproduced = 'yes', labels_json = '["bug"]'
        WHERE task_id = 'mkt_1'
      `;
      assert.deepEqual(yield* config, [{ labels: '["bug"]' }]);
      assert.deepEqual(yield* task, [{ reproduced: "yes", labels: '["bug"]' }]);
    }).pipe(Effect.provide(layer)),
);
