import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("backfills each daily row's uncached input from its requests' shapes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 146 });
    // Anthropic's input leaves the cache out; OpenAI's and Gemini's count it in.
    yield* sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, key_id, account_id, provider,
        model, shape, status, duration_ms, failovers, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, grant_id)
      VALUES
        ('a1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'ana', 'org', 'k', 'claude-acct',
          'claude', 'claude-opus-5-5', 'anthropic', 200, 5, 0, 100, 10, 1000, 50, 'grant-1'),
        ('a2', '2026-11-01T11:00:00.000Z', '2026-11-01', 'ana', 'org', 'k', 'claude-acct',
          'claude', 'claude-opus-5-5', 'anthropic', 200, 5, 0, 20, 2, NULL, NULL, 'grant-1'),
        ('o1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'ana', 'org', 'k', 'openai-acct',
          'codex', 'gpt-5.5', 'openai', 200, 5, 0, 500, 30, 400, NULL, NULL),
        ('o2', '2026-11-01T12:00:00.000Z', '2026-11-01', 'ana', 'org', 'k', 'openai-acct',
          'codex', 'gpt-5.5', 'openai', 200, 5, 0, 60, 3, NULL, NULL, NULL),
        ('g1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'ana', 'org', 'k', 'gemini-acct',
          'gemini', 'gemini-4-argon', 'gemini', 200, 5, 0, 300, 9, 100, NULL, NULL),
        ('m1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'bea', 'org', 'k', 'openai-acct',
          'codex', 'gpt-5.5', 'openai', 200, 5, 0, 70, 1, 10, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES
        ('2026-11-01', 'ana', 'org', 'claude-acct', 'claude-opus-5-5', 'grant-1', 2, 120, 12,
          1000, 50),
        ('2026-11-01', 'ana', 'org', 'openai-acct', 'gpt-5.5', '', 2, 560, 33, 400, 0),
        ('2026-11-01', 'ana', 'org', 'gemini-acct', 'gemini-4-argon', '', 1, 300, 9, 100, 0),
        -- Its requests were swept: nothing says how much of its input was cached.
        ('2026-10-01', 'ana', 'org', 'openai-acct', 'gpt-5.5', '', 4, 800, 40, 300, 0),
        -- Half its requests were swept: the ones left do not add up to its input.
        ('2026-11-01', 'bea', 'org', 'openai-acct', 'gpt-5.5', '', 3, 210, 3, 30, 0),
        -- Refused for load, no account: no input at all.
        ('2026-11-01', 'ana', 'org', '', '', '', 5, 0, 0, 0, 0)
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 147 }), [
      [147, "AiUsageUncachedInput"],
    ]);

    const rows = yield* sql<{ readonly row: string }>`
      SELECT day || '|' || user_id || '|' || account_id || '|'
        || COALESCE(CAST(uncached_input_tokens AS TEXT), 'null') AS row
      FROM ai_usage_daily ORDER BY day, user_id, account_id
    `;
    assert.deepEqual(
      rows.map((entry) => entry.row),
      [
        "2026-10-01|ana|openai-acct|null",
        "2026-11-01|ana||0",
        "2026-11-01|ana|claude-acct|120",
        "2026-11-01|ana|gemini-acct|200",
        "2026-11-01|ana|openai-acct|160",
        "2026-11-01|bea|openai-acct|null",
      ],
    );
  }).pipe(Effect.provide(layer)),
);
