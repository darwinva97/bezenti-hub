import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("gives every User who is not removed their own `default` group, once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 142 });
    yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
        ('owner', 'Owner', 1, ${AT}), ('ana', 'Ana', 0, ${AT}), ('gone', 'Gone', 0, ${AT})
    `;
    yield* sql`UPDATE users SET removed_at = ${AT}, disabled_at = ${AT} WHERE user_id = 'gone'`;
    // The Owner's `default` came from the Main vault (migration 142).
    yield* sql`
      INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
        updated_at)
      VALUES ('vault-main', 'user', 'owner', 'default', 1, ${AT}, ${AT})
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 143 }), [
      [143, "PersonalVaults"],
    ]);
    const rows = yield* sql<{ readonly ownerId: string; readonly n: number }>`
      SELECT owner_id AS "ownerId", COUNT(*) AS n FROM vault_groups
      WHERE owner_kind = 'user' AND is_default = 1 GROUP BY owner_id ORDER BY owner_id
    `;
    assert.deepEqual(
      rows.map((row) => `${row.ownerId}:${row.n}`),
      ["ana:1", "owner:1"],
    );
    const [main] = yield* sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM vault_groups WHERE owner_id = 'owner'
    `;
    assert.equal(main?.groupId, "vault-main");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
