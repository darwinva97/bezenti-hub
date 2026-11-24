import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps one «may use Makita» per User and Space", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 163 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 164 }), [
      [164, "MakitaPermissions"],
    ]);
    const grant = (userId: string, spaceId: string) => sql`
      INSERT INTO makita_permissions (user_id, space_id, granted_by, granted_at)
      VALUES (${userId}, ${spaceId}, 'owner', '2026-11-24T00:00:00.000Z')
    `;
    yield* grant("grace", "org-acme");
    yield* grant("grace", "org-globex");
    yield* grant("ada", "org-acme");
    assert.equal((yield* grant("grace", "org-acme").pipe(Effect.flip))._tag, "SqlError");
    const rows = yield* sql<{ readonly userId: string }>`
      SELECT user_id AS "userId" FROM makita_permissions WHERE space_id = 'org-acme'
      ORDER BY user_id
    `;
    assert.deepEqual(
      rows.map((row) => row.userId),
      ["ada", "grace"],
    );
  }).pipe(Effect.provide(layer)),
);
