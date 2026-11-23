import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "keeps every usage row as it was, with no access key, and keeps access keys by hash",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 158 });
      yield* sql`
      INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
        provider, model, shape, status, duration_ms, failovers, input_tokens, output_tokens,
        grant_id)
      VALUES ('u1', '2026-11-01T10:00:00.000Z', '2026-11-01', 'ana', 'org-acme', 't1', 'k1',
        'acct', 'claude', 'm', 'anthropic', 200, 5, 0, 11, 7, NULL)
    `;
      const before = yield* sql<Record<string, unknown>>`SELECT * FROM ai_usage`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 159 }), [
        [159, "AiAccessKeys"],
      ]);

      const after = yield* sql<Record<string, unknown>>`SELECT * FROM ai_usage`;
      assert.deepEqual(after, [{ ...before[0], access_key_id: null }]);

      const key = (id: string, hash: string) => sql`
      INSERT INTO ai_access_keys (key_id, key_hash, key_hint, space_id, label, created_by,
        created_at, models_json, accounts_json, expires_at, limits_json, updated_at)
      VALUES (${id}, ${hash}, 'abcd', 'org-acme', 'Partner', 'ana', '2026-11-01T00:00:00.000Z',
        '["*"]', NULL, '2026-12-01T00:00:00.000Z',
        '{"total":null,"day":null,"week":null,"month":null}', '2026-11-01T00:00:00.000Z')
    `;
      yield* key("ak_1", "hash-1");
      // One row per hash: two keys never share one.
      const duplicate = yield* key("ak_2", "hash-1").pipe(Effect.flip);
      assert.equal(duplicate._tag, "SqlError");
      const rows = yield* sql<{ readonly keyId: string; readonly revokedAt: string | null }>`
      SELECT key_id AS "keyId", revoked_at AS "revokedAt" FROM ai_access_keys
    `;
      assert.deepEqual(rows, [{ keyId: "ak_1", revokedAt: null }]);
    }).pipe(Effect.provide(layer)),
);
