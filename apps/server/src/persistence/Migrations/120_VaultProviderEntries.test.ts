import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("keeps every entry and admits sealed Provider entries that name a provider", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 119 });
    yield* sql`
      INSERT INTO vaults (vault_id, name, is_main, created_at, updated_at) VALUES
        ('vault-main', 'Main vault', 1, ${AT}, ${AT}), ('tools', 'Tools', 0, ${AT}, ${AT})
    `;
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, value_id, class, revealable, created_at, updated_at)
      VALUES ('own', 'vault-main', 'TOKEN', 'own', NULL, 'v1', 'secret', 1, ${AT}, ${AT}),
        ('var', 'tools', 'REGION', 'own', NULL, 'v2', 'variable', 0, ${AT}, ${AT}),
        ('link', 'tools', 'LINKED', 'link', 'own', NULL, NULL, NULL, ${AT}, ${AT})
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 120 }), [
      [120, "VaultProviderEntries"],
    ]);
    const rows = yield* sql<Record<string, unknown>>`
      SELECT entry_id, kind, value_id, class, revealable, provider_id FROM vault_entries
      ORDER BY entry_id
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          entry_id: "link",
          kind: "link",
          value_id: null,
          class: null,
          revealable: null,
          provider_id: null,
        },
        {
          entry_id: "own",
          kind: "own",
          value_id: "v1",
          class: "secret",
          revealable: 1,
          provider_id: null,
        },
        {
          entry_id: "var",
          kind: "own",
          value_id: "v2",
          class: "variable",
          revealable: 0,
          provider_id: null,
        },
      ],
    );

    const refused = <E>(insert: Effect.Effect<unknown, E>) =>
      insert.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
    const provider = (
      id: string,
      over: {
        readonly providerId?: string | null;
        readonly reference?: string | null;
        readonly valueId?: string | null;
        readonly klass?: string;
        readonly revealable?: number;
      } = {},
    ) => sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
        provider_id, provider_reference, created_at, updated_at)
      VALUES (${id}, 'tools', ${id.toUpperCase()}, 'provider', ${over.valueId ?? null},
        ${over.klass ?? "secret"}, ${over.revealable ?? 0},
        ${over.providerId === undefined ? "vault" : over.providerId},
        ${over.reference === undefined ? "kv/acme#token" : over.reference}, ${AT}, ${AT})
    `;
    assert.isFalse(yield* refused(provider("p1")), "a sealed Secret naming a provider");
    assert.isTrue(yield* refused(provider("p2", { providerId: null })), "names its provider");
    assert.isTrue(yield* refused(provider("p3", { reference: null })), "names its reference");
    assert.isTrue(yield* refused(provider("p4", { valueId: "v9" })), "holds no value of its own");
    assert.isTrue(yield* refused(provider("p5", { revealable: 1 })), "never revealable");
    assert.isTrue(yield* refused(provider("p6", { klass: "variable" })), "a Secret, in 02");
    assert.isTrue(
      yield* refused(provider("p7", { reference: "x".repeat(1025) })),
      "a reference of at most 1024 characters",
    );
    assert.isTrue(
      yield* refused(sql`
        INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
          provider_id, provider_reference, created_at, updated_at)
        VALUES ('o2', 'tools', 'O2', 'own', 'v3', 'secret', 0, 'vault', 'kv/x', ${AT}, ${AT})
      `),
      "only a Provider entry names a provider",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
