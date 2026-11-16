import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect("keeps every entry and admits identity entries only as sealed Secret files", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 122 });
    yield* sql`
      INSERT INTO vaults (vault_id, name, is_main, created_at, updated_at)
      VALUES ('tools', 'Tools', 0, ${AT}, ${AT})
    `;
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
        delivery, template_text, created_at, updated_at)
      VALUES ('own', 'tools', 'TOKEN', 'own', 'v1', 'secret', 1, 'file', NULL, ${AT}, ${AT}),
        ('tpl', 'tools', 'KUBECONFIG', 'template', NULL, 'secret', 0, 'file', 'x', ${AT}, ${AT})
    `;
    yield* runMigrations({ toMigrationInclusive: 123 });
    const rows = yield* sql<Record<string, unknown>>`
      SELECT entry_id, kind, value_id, revealable, delivery, template_text, identity_audience,
        identity_ttl_seconds
      FROM vault_entries ORDER BY entry_id
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          entry_id: "own",
          kind: "own",
          value_id: "v1",
          revealable: 1,
          delivery: "file",
          template_text: null,
          identity_audience: null,
          identity_ttl_seconds: null,
        },
        {
          entry_id: "tpl",
          kind: "template",
          value_id: null,
          revealable: 0,
          delivery: "file",
          template_text: "x",
          identity_audience: null,
          identity_ttl_seconds: null,
        },
      ],
    );
    const refused = <E>(insert: Effect.Effect<unknown, E>) =>
      insert.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
    const identity = (
      id: string,
      over: {
        readonly valueId?: string | null;
        readonly cls?: string;
        readonly revealable?: number;
        readonly delivery?: string;
        readonly audience?: string | null;
        readonly ttl?: number | null;
      } = {},
    ) => sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
        delivery, identity_audience, identity_ttl_seconds, created_at, updated_at)
      VALUES (${id}, 'tools', ${id}, 'identity', ${over.valueId ?? null}, ${over.cls ?? "secret"},
        ${over.revealable ?? 0}, ${over.delivery ?? "file"},
        ${over.audience === undefined ? "kubernetes" : over.audience},
        ${over.ttl === undefined ? 600 : over.ttl}, ${AT}, ${AT})
    `;
    assert.isFalse(yield* refused(identity("ID_OK")));
    for (const [id, over] of [
      ["ID_ENV", { delivery: "env" }],
      ["ID_NONE", { delivery: "none" }],
      ["ID_VALUE", { valueId: "v2" }],
      ["ID_VARIABLE", { cls: "variable" }],
      ["ID_REVEAL", { revealable: 1 }],
      ["ID_NO_AUD", { audience: null }],
      ["ID_EMPTY_AUD", { audience: "" }],
      ["ID_SHORT", { ttl: 59 }],
      ["ID_LONG", { ttl: 3601 }],
      ["ID_NO_TTL", { ttl: null }],
    ] as const) {
      assert.isTrue(yield* refused(identity(id, over)), id);
    }
    // Only an identity entry has an audience or a TTL.
    assert.isTrue(
      yield* refused(sql`
        INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
          identity_audience, created_at, updated_at)
        VALUES ('own2', 'tools', 'OWN2', 'own', 'v3', 'secret', 0, 'kubernetes', ${AT}, ${AT})
      `),
    );
    // The signing keys' public halves and schedule; the private halves are sealed elsewhere.
    yield* sql`
      INSERT INTO identity_signing_keys (kid, public_jwk, created_at, publish_at, sign_from,
        sign_until, retire_at)
      VALUES ('k1', '{}', ${AT}, ${AT}, ${AT}, ${AT}, ${AT})
    `;
    const keys = yield* sql<{ readonly kid: string }>`SELECT kid FROM identity_signing_keys`;
    assert.deepEqual(
      keys.map((key) => key.kid),
      ["k1"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
