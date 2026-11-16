import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-16T00:00:00.000Z";

it.effect("keeps a Hub's existing secrets revealable, links inheriting, and seals new ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 118 });
    yield* sql`
      INSERT INTO vaults (vault_id, name, is_main, created_at, updated_at) VALUES
        ('vault-main', 'Main vault', 1, ${AT}, ${AT}), ('tools', 'Tools', 0, ${AT}, ${AT})
    `;
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, value_id, created_at, updated_at)
      VALUES ('own', 'vault-main', 'TOKEN', 'own', NULL, 'v1', ${AT}, ${AT}),
        ('copy', 'tools', 'COPIED', 'copy', NULL, 'v2', ${AT}, ${AT}),
        ('link', 'tools', 'LINKED', 'link', 'own', NULL, ${AT}, ${AT})
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 119 }), [
      [119, "VaultEntryClass"],
    ]);
    const rows = yield* sql<{
      readonly entryId: string;
      readonly class: string | null;
      readonly revealable: number | null;
    }>`SELECT entry_id AS "entryId", class, revealable FROM vault_entries ORDER BY entry_id`;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { entryId: "copy", class: "secret", revealable: 1 },
        { entryId: "link", class: null, revealable: null },
        { entryId: "own", class: "secret", revealable: 1 },
      ],
    );

    // A row written without the columns is a sealed Secret.
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, created_at, updated_at)
      VALUES ('new', 'tools', 'NEW', 'own', 'v3', ${AT}, ${AT})
    `;
    const fresh = yield* sql<{ readonly class: string; readonly revealable: number }>`
      SELECT class, revealable FROM vault_entries WHERE entry_id = 'new'
    `;
    assert.deepEqual({ ...fresh[0] }, { class: "secret", revealable: 0 });

    const refused = <E>(insert: Effect.Effect<unknown, E>) =>
      insert.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
    const entry = (id: string, kind: string, klass: string | null, revealable: number | null) =>
      sql`
        INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, value_id, class, revealable, created_at, updated_at)
        VALUES (${id}, 'tools', ${id.toUpperCase()}, ${kind}, ${kind === "link" ? "own" : null},
          ${kind === "link" ? null : "v-" + id}, ${klass}, ${revealable}, ${AT}, ${AT})
      `;
    assert.isTrue(yield* refused(entry("a", "link", "secret", null)), "a link has no class");
    assert.isTrue(yield* refused(entry("b", "link", null, 1)), "a link is not revealable itself");
    assert.isTrue(yield* refused(entry("c", "own", null, 0)), "an own entry has a class");
    assert.isTrue(yield* refused(entry("d", "own", "config", 0)), "only secret or variable");
    assert.isTrue(yield* refused(entry("e", "own", "secret", 2)), "revealable is 0 or 1");
    assert.isTrue(
      yield* refused(entry("f", "own", "variable", 1)),
      "a Variable is never revealable",
    );
    assert.isFalse(yield* refused(entry("g", "copy", "variable", 0)));
    assert.isFalse(yield* refused(entry("h", "link", null, null)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
