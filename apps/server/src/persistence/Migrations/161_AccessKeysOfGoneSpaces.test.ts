import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("revokes the live access keys of Spaces that no longer exist, and no other", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 160 });
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES ('org-acme', 'organization', 'Acme', '2026-11-01T00:00:00.000Z')
    `;
    const key = (id: string, spaceId: string, revoked: string | null) => sql`
      INSERT INTO ai_access_keys (key_id, key_hash, key_hint, space_id, label, created_by,
        created_at, models_json, accounts_json, expires_at, limits_json, updated_at, revoked_at,
        revoked_reason)
      VALUES (${id}, ${`hash-${id}`}, 'abcd', ${spaceId}, 'Partner', 'ana',
        '2026-11-01T00:00:00.000Z', '["*"]', NULL, '2026-12-01T00:00:00.000Z',
        '{"total":null,"day":null,"week":null,"month":null}', '2026-11-01T00:00:00.000Z',
        ${revoked}, ${revoked === null ? null : "revoked"})
    `;
    yield* key("ak_live", "org-acme", null);
    yield* key("ak_gone", "org-gone", null);
    yield* key("ak_done", "org-gone", "2026-11-02T00:00:00.000Z");

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 161 }), [
      [161, "AccessKeysOfGoneSpaces"],
    ]);
    const rows = yield* sql<{
      readonly keyId: string;
      readonly reason: string | null;
      readonly revokedAt: string | null;
    }>`
      SELECT key_id AS "keyId", revoked_reason AS reason, revoked_at AS "revokedAt"
      FROM ai_access_keys ORDER BY key_id
    `;
    assert.deepEqual(
      rows.map((row) => [row.keyId, row.reason]),
      [
        ["ak_done", "revoked"],
        ["ak_gone", "space-gone"],
        ["ak_live", null],
      ],
    );
    // An instant as the Hub writes them; the one already revoked keeps its own.
    assert.match(rows[1]!.revokedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.equal(rows[0]!.revokedAt, "2026-11-02T00:00:00.000Z");
  }).pipe(Effect.provide(layer)),
);
