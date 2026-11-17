import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("forgets `personalSpace.create` grants and keeps every other permission", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 123 });
    yield* sql`
      INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
      VALUES ('owner', 'Owner', 'owner', 1, ${AT}), ('grace', 'Grace', 'grace', 0, ${AT})
    `;
    yield* sql`
      INSERT INTO installation_permissions (user_id, permission, granted_by, granted_at)
      VALUES ('grace', 'personalSpace.create', 'owner', ${AT}),
        ('grace', 'environments.registerOwn', 'owner', ${AT})
    `;
    yield* runMigrations({ toMigrationInclusive: 150 });
    const rows = yield* sql<{ readonly permission: string }>`
      SELECT permission FROM installation_permissions WHERE user_id = 'grace'
    `;
    assert.deepEqual(
      rows.map((row) => row.permission),
      ["environments.registerOwn"],
    );
    // Her Personal space was there all along, as for every User.
    const spaces = yield* sql<{ readonly spaceId: string }>`
      SELECT space_id AS "spaceId" FROM spaces WHERE personal_owner_user_id = 'grace'
    `;
    assert.deepEqual(
      spaces.map((space) => space.spaceId),
      ["personal:grace"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
