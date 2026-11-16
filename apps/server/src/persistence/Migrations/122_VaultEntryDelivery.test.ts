import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect(
  "keeps every entry delivered as before and admits only valueless, sealable templates",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 120 });
      yield* sql`
      INSERT INTO vaults (vault_id, name, is_main, created_at, updated_at) VALUES
        ('vault-main', 'Main vault', 1, ${AT}, ${AT}), ('tools', 'Tools', 0, ${AT}, ${AT})
    `;
      yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, value_id, class,
        revealable, provider_id, provider_reference, created_at, updated_at)
      VALUES ('own', 'vault-main', 'TOKEN', 'own', NULL, 'v1', 'secret', 1, NULL, NULL, ${AT}, ${AT}),
        ('link', 'tools', 'LINKED', 'link', 'own', NULL, NULL, NULL, NULL, NULL, ${AT}, ${AT}),
        ('prov', 'tools', 'PROV', 'provider', NULL, NULL, 'secret', 0, 'vault', 'kv/a#b', ${AT}, ${AT})
    `;
      yield* runMigrations({ toMigrationInclusive: 122 });
      const rows = yield* sql<Record<string, unknown>>`
      SELECT entry_id, kind, value_id, revealable, provider_reference, delivery, template_text
      FROM vault_entries ORDER BY entry_id
    `;
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          {
            entry_id: "link",
            kind: "link",
            value_id: null,
            revealable: null,
            provider_reference: null,
            delivery: "env",
            template_text: null,
          },
          {
            entry_id: "own",
            kind: "own",
            value_id: "v1",
            revealable: 1,
            provider_reference: null,
            delivery: "env",
            template_text: null,
          },
          {
            entry_id: "prov",
            kind: "provider",
            value_id: null,
            revealable: 0,
            provider_reference: "kv/a#b",
            delivery: "env",
            template_text: null,
          },
        ],
      );
      const refused = <E>(insert: Effect.Effect<unknown, E>) =>
        insert.pipe(
          Effect.as(false),
          Effect.orElseSucceed(() => true),
        );
      const entry = (
        id: string,
        over: {
          readonly kind?: string;
          readonly valueId?: string | null;
          readonly text?: string | null;
          readonly revealable?: number;
          readonly delivery?: string;
        } = {},
      ) => sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
        delivery, template_text, created_at, updated_at)
      VALUES (${id}, 'tools', ${id.toUpperCase()}, ${over.kind ?? "template"},
        ${over.valueId ?? null}, 'secret', ${over.revealable ?? 0}, ${over.delivery ?? "file"},
        ${over.text === undefined ? "server: {{ KUBE_SERVER }}" : over.text}, ${AT}, ${AT})
    `;
      assert.isFalse(yield* refused(entry("t1")), "a template delivered as a file");
      assert.isFalse(yield* refused(entry("t2", { delivery: "env" })), "or as a variable");
      assert.isTrue(yield* refused(entry("t3", { text: null })), "a template has a text");
      assert.isTrue(yield* refused(entry("t4", { valueId: "v9" })), "and no value of its own");
      assert.isTrue(yield* refused(entry("t5", { revealable: 1 })), "never revealable");
      assert.isTrue(yield* refused(entry("t6", { delivery: "none" })), "never `none`");
      assert.isTrue(yield* refused(entry("t7", { delivery: "disk" })), "a known delivery");
      assert.isTrue(
        yield* refused(entry("t8", { text: "x".repeat(65537) })),
        "a text of at most 64 KiB",
      );
      assert.isTrue(
        yield* refused(entry("o1", { kind: "own", valueId: "v2" })),
        "only a template has a text",
      );
      assert.isFalse(
        yield* refused(entry("o2", { kind: "own", valueId: "v2", text: null, delivery: "none" })),
        "an entry that only feeds a template",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
