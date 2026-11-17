import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("seals every revealable Secret and leaves Variables and links as they were", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 140 });
    yield* sql`
      INSERT INTO vaults (vault_id, name, space_id, is_main, created_at, updated_at)
      VALUES ('vault-main', 'Main', NULL, 1, ${AT}, ${AT})
    `;
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, value_id, class,
        revealable, created_at, updated_at)
      VALUES ('open', 'vault-main', 'OPEN', 'own', NULL, 'v1', 'secret', 1, ${AT}, ${AT}),
        ('shut', 'vault-main', 'SHUT', 'own', NULL, 'v2', 'secret', 0, ${AT}, ${AT}),
        ('conf', 'vault-main', 'CONF', 'own', NULL, 'v3', 'variable', 0, ${AT}, ${AT}),
        ('link', 'vault-main', 'LINK', 'link', 'open', NULL, NULL, NULL, ${AT}, ${AT})
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 141 }), [
      [141, "VaultEntriesSealed"],
    ]);
    const rows = yield* sql<{
      readonly entryId: string;
      readonly class: string | null;
      readonly revealable: number | null;
    }>`
      SELECT entry_id AS "entryId", class, revealable FROM vault_entries ORDER BY entry_id
    `;
    assert.deepEqual(
      rows.map((row) => `${row.entryId}:${row.class}:${row.revealable}`),
      ["conf:variable:0", "link:null:null", "open:secret:0", "shut:secret:0"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
