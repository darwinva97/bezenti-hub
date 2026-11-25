import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "gives configurations their autonomy (all off), tasks a PR close time, and one close per issue",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 171 });
      yield* sql`
      INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at, updated_at,
        repos_json, triggers_json, callers_mode, callers_json, model_selection_json)
      VALUES ('mk_1', 'org-acme', 'Widgets', 'u1', '2026-11-24T10:00:00Z',
        '2026-11-24T10:00:00Z', '{"all":true}', '{}', 'list', '[]', '{}')
    `;
      yield* sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
      VALUES ('mkt_1', 'mk_1', 'org-acme', 'p1', 'github.com', 'acme/widgets', 12, 'issue',
        't1', 1, 'octocat', 'running', '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z')
    `;

      // Later ids may land between 171 and 174 on other branches; this one only adds.
      yield* runMigrations({ toMigrationInclusive: 174 });

      const [config] = yield* sql<{ readonly autonomy: string }>`
      SELECT autonomy_json AS autonomy FROM makita_configs WHERE config_id = 'mk_1'
    `;
      assert.strictEqual(config?.autonomy, "{}");
      const [task] = yield* sql<{ readonly closed: string | null }>`
      SELECT pr_closed_at AS closed FROM makita_tasks WHERE task_id = 'mkt_1'
    `;
      assert.strictEqual(task?.closed, null);

      const close = (taskId: string, verdict = "not-wanted") => sql`
      INSERT INTO makita_issue_closes (host, repo, number, config_id, task_id, verdict,
        confidence, state_reason, claimed_at)
      VALUES ('github.com', 'acme/widgets', 12, 'mk_1', ${taskId}, ${verdict}, 0.9,
        'not_planned', '2026-11-24T10:00:00Z')
    `;
      yield* close("mkt_1");
      // Once per issue, ever: a second close of the same issue (another task) is refused.
      assert.isTrue((yield* Effect.exit(close("mkt_2")))._tag === "Failure");
      assert.isTrue((yield* Effect.exit(close("mkt_3", "maybe")))._tag === "Failure");
    }).pipe(Effect.provide(layer)),
);
