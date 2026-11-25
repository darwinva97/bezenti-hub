import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps one live Makita task per issue, each with its own Thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 166 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 167 }), [[167, "MakitaTasks"]]);
    const task = (
      id: string,
      over: {
        readonly number?: number;
        readonly thread?: string;
        readonly state?: string;
        readonly kind?: string;
      } = {},
    ) => sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
      VALUES (${id}, 'mk_1', 'org-acme', 'p1', 'github.com', 'acme/widgets',
        ${over.number ?? 12}, ${over.kind ?? "issue"}, ${over.thread ?? `thread-${id}`}, 1,
        'octocat', ${over.state ?? "running"}, '2026-11-24T00:00:00.000Z',
        '2026-11-24T00:00:00.000Z')
    `;
    yield* task("mkt_1");
    // A second live task for the same issue is refused; an ended one does not count.
    assert.equal((yield* task("mkt_2").pipe(Effect.flip))._tag, "SqlError");
    yield* sql`UPDATE makita_tasks SET state = 'stopped' WHERE task_id = 'mkt_1'`;
    yield* task("mkt_3", { state: "waiting-reply" });
    assert.equal((yield* task("mkt_4", { state: "running" }).pipe(Effect.flip))._tag, "SqlError");
    // One Thread, one task; states and kinds it does not know are refused.
    for (const [id, over] of [
      ["mkt_5", { number: 13, thread: "thread-mkt_3" }],
      ["mkt_6", { number: 14, state: "sleeping" }],
      ["mkt_7", { number: 15, kind: "discussion" }],
    ] as const) {
      assert.equal((yield* task(id, over).pipe(Effect.flip))._tag, "SqlError", id);
    }
    const rows = yield* sql<{ readonly id: string; readonly replies: number }>`
      SELECT task_id AS id, replies_without_person AS replies FROM makita_tasks ORDER BY task_id
    `;
    assert.deepEqual(rows, [
      { id: "mkt_1", replies: 0 },
      { id: "mkt_3", replies: 0 },
    ]);
  }).pipe(Effect.provide(layer)),
);
