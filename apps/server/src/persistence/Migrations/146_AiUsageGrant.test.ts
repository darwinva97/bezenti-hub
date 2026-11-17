import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps every usage row as own use and keys the daily summary by Grant too", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 145 });
    yield* sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
        provider, model, shape, status, duration_ms, failovers, input_tokens, output_tokens)
      VALUES ('u1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'ana', 'org-acme', 't1', 'k1',
        'acct', 'claude', 'm', 'anthropic', 200, 5, 0, 11, 7)
    `;
    yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, requests,
        input_tokens, output_tokens, cache_write_tokens)
      VALUES ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 3, 30, 20, 5),
        ('2026-11-01', 'ana', 'org-acme', '', '', 2, 0, 0, 0)
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 146 }), [[146, "AiUsageGrant"]]);

    const usage = yield* sql<{ readonly grantId: string | null; readonly input: number }>`
      SELECT grant_id AS "grantId", input_tokens AS input FROM ai_usage
    `;
    assert.deepEqual(usage, [{ grantId: null, input: 11 }]);
    const daily = yield* sql<{ readonly row: string }>`
      SELECT account_id || '|' || grant_id || '|' || requests || '|' || input_tokens || '|'
        || output_tokens || '|' || cache_write_tokens AS row
      FROM ai_usage_daily ORDER BY account_id
    `;
    assert.deepEqual(
      daily.map((entry) => entry.row),
      ["||2|0|0|0", "acct||3|30|20|5"],
    );
    // The same day, User, Space, account and model through a Grant is a row of its own.
    yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests)
      VALUES ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 'grant-1', 1)
    `;
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ai_usage_daily`;
    assert.equal(rows[0]?.n, 3);
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_usage_daily'
      ORDER BY name
    `;
    assert.includeMembers(
      indexes.map((index) => index.name),
      ["ai_usage_daily_grant_idx", "ai_usage_daily_space_idx", "ai_usage_daily_user_idx"],
    );
  }).pipe(Effect.provide(layer)),
);
