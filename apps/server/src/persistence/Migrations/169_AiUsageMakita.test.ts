import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps every daily row's values and keys Makita configurations apart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 167 });
    // A User's own use, a loan's, an access key's with an estimate, one with no uncached input.
    yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id,
        access_key_id, requests, failed_requests, unknown_requests, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, uncached_input_tokens, estimated_tokens)
      VALUES ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', '', '', 3, 1, 1, 30, 20, 7, 5, 25, 0),
        ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 'grant-1', '', 2, 0, 0, 10, 4, 0, 0, 10, 0),
        ('2026-11-01', '', 'org-acme', 'acct', 'm', '', 'ak_1', 2, 0, 1, 100, 10, 40, 0, 60, 12),
        ('2026-11-02', 'bob', 'org-acme', '', '', '', '', 4, 4, 0, 0, 0, 0, 0, NULL, 0)
    `;
    const columns = `day, user_id, space_id, account_id, model, grant_id, access_key_id,
      requests, failed_requests, unknown_requests, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input_tokens, estimated_tokens`;
    const before = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${columns} FROM ai_usage_daily ORDER BY day, user_id, grant_id, access_key_id`,
    );

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 169 }), [[169, "AiUsageMakita"]]);

    const after = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${columns} FROM ai_usage_daily ORDER BY day, user_id, grant_id, access_key_id`,
    );
    assert.deepEqual(after, before);
    const keys = yield* sql<{ readonly key: string }>`
      SELECT makita_config_id AS key FROM ai_usage_daily
    `;
    assert.isTrue(keys.every((row) => row.key === ""));
    // Two configurations of one creator, same day, account and model: rows of their own.
    yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, makita_config_id,
        requests)
      VALUES ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 'mk_1', 1),
        ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 'mk_2', 1)
    `;
    const ana = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ai_usage_daily
      WHERE user_id = 'ana' AND day = '2026-11-01' AND grant_id = ''
    `;
    assert.strictEqual(ana[0]?.n, 3);
    // The per-request rows: NULL unless a Makita Thread made them.
    yield* sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, shape,
        status, duration_ms, failovers, makita_config_id)
      VALUES ('u1', '2026-11-03T10:00:00.000Z', '2026-11-03', 'ana', 'org-acme', 't1', 'k1',
        'anthropic', 200, 5, 0, 'mk_1')
    `;
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index'
        AND tbl_name IN ('ai_usage_daily', 'ai_usage')
      ORDER BY name
    `;
    assert.includeMembers(
      indexes.map((index) => index.name),
      [
        "ai_usage_daily_access_key_idx",
        "ai_usage_daily_grant_idx",
        "ai_usage_daily_makita_idx",
        "ai_usage_daily_space_idx",
        "ai_usage_daily_user_idx",
        "ai_usage_makita_idx",
      ],
    );
  }).pipe(Effect.provide(layer)),
);
