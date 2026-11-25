import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("caps a configuration at 3 tasks at once and the Hub at 10, within their bounds", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 173 });
    yield* sql`
      INSERT INTO makita_account (account_id, host, login, github_user_id, token_kind,
        token_hint, status, checked_at, created_by, created_at, updated_at)
      VALUES ('makita', 'github.com', 'makita-bot', 4242, 'classic', 'abcd', 'ok',
        '2026-11-25T10:00:00Z', 'owner', '2026-11-25T10:00:00Z', '2026-11-25T10:00:00Z')
    `;
    yield* sql`
      INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at, updated_at,
        repos_json, triggers_json, callers_mode, callers_json, strangers, model_selection_json,
        capability, approval, approvers_json)
      VALUES ('mk_1', 'org-acme', 'Widget bugs', 'grace', '2026-11-25T10:00:00Z',
        '2026-11-25T10:00:00Z', '{"all":true}', '{"label":"makita"}', 'list', '[]', 'ignore',
        '{}', 'comment', 'others', '[]')
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 174 }), [
      [174, "MakitaTaskCaps"],
    ]);

    const config = yield* sql<{ readonly n: number }>`
      SELECT max_tasks AS n FROM makita_configs WHERE config_id = 'mk_1'
    `;
    const account = yield* sql<{ readonly n: number }>`
      SELECT max_tasks AS n FROM makita_account WHERE account_id = 'makita'
    `;
    assert.deepEqual([config[0]?.n, account[0]?.n], [3, 10]);

    const refused = <E>(statement: Effect.Effect<unknown, E>) =>
      statement.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
    assert.isTrue(yield* refused(sql`UPDATE makita_configs SET max_tasks = 0`));
    assert.isTrue(yield* refused(sql`UPDATE makita_configs SET max_tasks = 21`));
    assert.isTrue(yield* refused(sql`UPDATE makita_account SET max_tasks = 101`));
    assert.isFalse(yield* refused(sql`UPDATE makita_configs SET max_tasks = 20`));
    assert.isFalse(yield* refused(sql`UPDATE makita_account SET max_tasks = 1`));
  }).pipe(Effect.provide(layer)),
);
