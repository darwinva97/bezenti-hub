import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("leaves the creator of Organizations from before unknown", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 150 });
    yield* sql`
      INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
      VALUES ('owner', 'Owner', 'owner', 1, ${AT})
    `;
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES ('acme', 'organization', 'Acme', ${AT})
    `;
    yield* runMigrations({ toMigrationInclusive: 151 });
    const rows = yield* sql<{ readonly spaceId: string; readonly createdBy: string | null }>`
      SELECT space_id AS "spaceId", created_by_user_id AS "createdBy" FROM spaces ORDER BY space_id
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { spaceId: "acme", createdBy: null },
        { spaceId: "personal:owner", createdBy: null },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
