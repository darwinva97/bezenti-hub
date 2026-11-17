import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

const account = (sql: SqlClient.SqlClient, id: string, name: string, priority: number) => sql`
  INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
    models_json, created_at, updated_at, created_by)
  VALUES (${id}, ${name}, 'api-key', 'claude', ${priority}, 'working', 0, '[]', ${AT}, ${AT},
    'owner')
`;

it.effect(
  "makes every existing AI account the Owner's, keeps their order and allowances, and names them per owner",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 139 });
      yield* sql`
        INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
        VALUES ('owner', 'Owner', 'owner', 1, ${AT}), ('grace', 'Grace', 'grace', 0, ${AT})
      `;
      yield* account(sql, "a1", "Acme Claude", 2);
      yield* account(sql, "a2", "Team Claude", 1);
      yield* sql`
        INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
        VALUES ('a1', 'space', 'org-acme', ${AT}), ('a2', 'user', 'grace', ${AT})
      `;
      yield* runMigrations({ toMigrationInclusive: 140 });

      const rows = yield* sql<{
        readonly accountId: string;
        readonly ownerKind: string;
        readonly ownerId: string;
        readonly priority: number;
      }>`
        SELECT account_id AS "accountId", owner_kind AS "ownerKind", owner_id AS "ownerId",
          priority FROM ai_accounts ORDER BY priority
      `;
      assert.deepEqual(rows, [
        { accountId: "a2", ownerKind: "user", ownerId: "owner", priority: 1 },
        { accountId: "a1", ownerKind: "user", ownerId: "owner", priority: 2 },
      ]);
      const allowances = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ai_account_allowances
      `;
      assert.equal(allowances[0]?.count, 2);

      // A name is unique per owner only: Grace may call hers as the Owner calls theirs.
      yield* sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
          models_json, created_at, updated_at, created_by, owner_kind, owner_id)
        VALUES ('g1', 'acme claude', 'api-key', 'claude', 1, 'working', 0, '[]', ${AT}, ${AT},
          'grace', 'user', 'grace')
      `;
      const twice = yield* sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
          models_json, created_at, updated_at, created_by, owner_kind, owner_id)
        VALUES ('g2', 'ACME CLAUDE', 'api-key', 'claude', 2, 'working', 0, '[]', ${AT}, ${AT},
          'grace', 'user', 'grace')
      `.pipe(Effect.flip);
      assert.equal(twice._tag, "SqlError");
      // Only a User or an Organization owns one.
      const nobody = yield* sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
          models_json, created_at, updated_at, created_by, owner_kind, owner_id)
        VALUES ('x1', 'Stray', 'api-key', 'claude', 1, 'working', 0, '[]', ${AT}, ${AT},
          'grace', 'installation', 'hub')
      `.pipe(Effect.flip);
      assert.equal(nobody._tag, "SqlError");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
