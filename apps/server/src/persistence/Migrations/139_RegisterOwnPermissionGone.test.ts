import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("forgets `environments.registerOwn` grants and keeps the Users' machines", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 138 });
    yield* sql`
      INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
      VALUES ('owner', 'Owner', 'owner', 1, ${AT}), ('grace', 'Grace', 'grace', 0, ${AT}),
        ('linus', 'Linus', 'linus', 0, ${AT})
    `;
    yield* sql`
      INSERT INTO installation_permissions (user_id, permission, granted_by, granted_at)
      VALUES ('grace', 'environments.registerOwn', 'owner', ${AT}),
        ('linus', 'environments.registerOwn', 'owner', ${AT})
    `;
    yield* runMigrations({ toMigrationInclusive: 139 });
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM installation_permissions
    `;
    assert.equal(rows[0]?.count, 0);
    const users = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM users`;
    assert.equal(users[0]?.count, 3);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
