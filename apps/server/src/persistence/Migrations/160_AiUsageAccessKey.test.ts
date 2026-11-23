import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "keeps every daily row's values, keys access keys apart and sums their days again by key",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 159 });
      // Users' rows: own use, a loan's, and one whose uncached input nobody kept.
      yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
        failed_requests, unknown_requests, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, uncached_input_tokens)
      VALUES ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', '', 3, 1, 1, 30, 20, 7, 5, 25),
        ('2026-11-01', 'ana', 'org-acme', 'acct', 'm', 'grant-1', 2, 0, 0, 10, 4, 0, 0, 10),
        ('2026-11-02', 'bob', 'org-acme', '', '', '', 4, 4, 0, 0, 0, 0, 0, NULL)
    `;
      const columns = `day, user_id, space_id, account_id, model, grant_id, requests,
      failed_requests, unknown_requests, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, uncached_input_tokens`;
      const before = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT ${columns} FROM ai_usage_daily ORDER BY day, user_id, grant_id`,
      );
      // Two access keys' requests (ticket 01 wrote them with no User and no key in the summary).
      yield* sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
        provider, model, shape, status, duration_ms, failovers, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, grant_id, access_key_id)
      VALUES
        ('u1', '2026-11-03T10:00:00.000Z', '2026-11-03', '', 'org-acme', NULL, 'ak_1', 'acct',
          'codex', 'm', 'openai', 200, 5, 0, 100, 10, 40, 0, NULL, 'ak_1'),
        ('u2', '2026-11-03T11:00:00.000Z', '2026-11-03', '', 'org-acme', NULL, 'ak_1', 'acct',
          'codex', 'm', 'openai', 200, 5, 0, NULL, NULL, NULL, NULL, NULL, 'ak_1'),
        ('u3', '2026-11-03T12:00:00.000Z', '2026-11-03', '', 'org-acme', NULL, 'ak_2', NULL,
          NULL, NULL, 'anthropic', 403, 5, 0, NULL, NULL, NULL, NULL, NULL, 'ak_2')
    `;
      yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, requests,
        input_tokens, output_tokens)
      VALUES ('2026-11-03', '', 'org-acme', 'acct', 'm', 2, 100, 10),
        ('2026-11-03', '', 'org-acme', '', '', 1, 0, 0)
    `;

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 160 }), [
        [160, "AiUsageAccessKey"],
      ]);

      const after = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT ${columns} FROM ai_usage_daily WHERE user_id <> '' ORDER BY day, user_id, grant_id`,
      );
      assert.deepEqual(after, before);
      const others = yield* sql<{ readonly key: string; readonly estimated: number }>`
      SELECT access_key_id AS key, estimated_tokens AS estimated FROM ai_usage_daily
      WHERE user_id <> ''
    `;
      assert.isTrue(others.every((row) => row.key === "" && row.estimated === 0));
      const keys = yield* sql<{ readonly row: string }>`
      SELECT access_key_id || '|' || account_id || '|' || requests || '|' || failed_requests
        || '|' || unknown_requests || '|' || input_tokens || '|' || output_tokens || '|'
        || cache_read_tokens || '|' || uncached_input_tokens AS row
      FROM ai_usage_daily WHERE user_id = '' ORDER BY access_key_id
    `;
      assert.deepEqual(
        keys.map((entry) => entry.row),
        ["ak_1|acct|2|0|1|100|10|40|60", "ak_2||1|1|0|0|0|0|0"],
      );
      // Two keys on the same day, account and model are rows of their own.
      yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, access_key_id,
        requests)
      VALUES ('2026-11-03', '', 'org-acme', 'acct', 'm', 'ak_3', 1)
    `;
      const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_usage_daily'
      ORDER BY name
    `;
      assert.includeMembers(
        indexes.map((index) => index.name),
        [
          "ai_usage_daily_access_key_idx",
          "ai_usage_daily_grant_idx",
          "ai_usage_daily_space_idx",
          "ai_usage_daily_user_idx",
        ],
      );
    }).pipe(Effect.provide(layer)),
);
