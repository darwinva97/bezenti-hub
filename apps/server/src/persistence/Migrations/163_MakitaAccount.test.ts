import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps Makita's account as one row, with its token kind and status checked", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 162 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 163 }), [[163, "MakitaAccount"]]);
    const row = (id: string, kind = "classic", status = "ok") => sql`
      INSERT INTO makita_account (account_id, host, login, github_user_id, token_kind, token_hint,
        scopes_json, token_expires_at, status, checked_at, created_by, created_at, updated_at)
      VALUES (${id}, 'github.com', 'makita-bot', 42, ${kind}, 'abcd', '["public_repo"]', NULL,
        ${status}, '2026-11-24T00:00:00.000Z', 'owner', '2026-11-24T00:00:00.000Z',
        '2026-11-24T00:00:00.000Z')
    `;
    yield* row("makita");
    // One account per Hub: no other id, no second row.
    assert.equal((yield* row("other").pipe(Effect.flip))._tag, "SqlError");
    assert.equal((yield* row("makita").pipe(Effect.flip))._tag, "SqlError");
    yield* sql`DELETE FROM makita_account`;
    assert.equal((yield* row("makita", "oauth").pipe(Effect.flip))._tag, "SqlError");
    assert.equal((yield* row("makita", "classic", "broken").pipe(Effect.flip))._tag, "SqlError");
    const rows = yield* sql<{ readonly login: string; readonly paused: string | null }>`
      SELECT login, global_paused_at AS paused FROM makita_account
    `;
    assert.deepEqual(rows, []);
  }).pipe(Effect.provide(layer)),
);
