import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-16T00:00:00.000Z";

it.effect(
  "keeps every machine; a lent Sandbox names its Grant and host and holds no credential",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 135 });
      yield* sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
        credential_issued_at, registered_at
      ) VALUES
        ('env-laptop', 'laptop', 'external', 'personal', 'ana', NULL, 'hash-laptop', ${at}, ${at}),
        ('env-vps', 'vps', 'external', 'dedicated', NULL, 'org-acme', 'hash-vps', ${at}, ${at}),
        ('sandbox:org-acme', 'Acme', 'sandbox', 'sandbox', NULL, 'org-acme', 'hash-sb', ${at},
          ${at})
    `;
      yield* runMigrations({ toMigrationInclusive: 136 });
      const rows = yield* sql<{ readonly id: string; readonly mode: string }>`
      SELECT environment_id AS id, mode FROM environments WHERE kind <> 'hub' ORDER BY id
    `;
      assert.deepEqual(rows, [
        { id: "env-laptop", mode: "personal" },
        { id: "env-vps", mode: "dedicated" },
        { id: "sandbox:org-acme", mode: "sandbox" },
      ]);
      const lent = (id: string, grantId: string | null, host: string | null, hash: string | null) =>
        sql`
        INSERT INTO environments (
          environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
          registered_at, grant_id, host_environment_id
        ) VALUES (${id}, 'laptop for Acme', 'sandbox', 'lent', NULL, 'org-acme', ${hash}, ${at},
          ${grantId}, ${host})
      `;
      yield* lent("lent:g1", "g1", "env-laptop", null);
      // A lent Sandbox always names its Grant and host, holds no credential, and one per Grant.
      assert.equal(
        (yield* lent("lent:g2", null, "env-laptop", null).pipe(Effect.flip))._tag,
        "SqlError",
      );
      assert.equal((yield* lent("lent:g3", "g3", null, null).pipe(Effect.flip))._tag, "SqlError");
      assert.equal(
        (yield* lent("lent:g4", "g4", "env-laptop", "h").pipe(Effect.flip))._tag,
        "SqlError",
      );
      assert.equal(
        (yield* lent("lent:g5", "g1", "env-laptop", null).pipe(Effect.flip))._tag,
        "SqlError",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
