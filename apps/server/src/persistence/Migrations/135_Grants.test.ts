import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-16T00:00:00.000Z";
const limits = JSON.stringify({
  kind: "environment",
  cpus: 2,
  memoryBytes: 4,
  pids: 64,
  diskBytes: 8,
});

it.effect("one waiting or active Grant per resource and Space; ended rows keep a reason", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 135 });
    const insert = (id: string, state: string, endReason: string | null, target = "org-acme") =>
      sql`
        INSERT INTO grants (
          grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
          state, end_reason, limits_json, created_at, created_by
        ) VALUES (${id}, 'environment', 'env-vps', 'user', 'ana', 'space', ${target}, ${state},
          ${endReason}, ${limits}, ${at}, 'ana')
      `;
    yield* insert("g1", "pending", null);
    // A second live loan of the same machine to the same Space is refused.
    assert.equal((yield* insert("g2", "active", null).pipe(Effect.flip))._tag, "SqlError");
    // To another Space it is fine, and history does not count.
    yield* insert("g3", "active", null, "org-globex");
    yield* insert("g4", "ended", "revoked");
    yield* insert("g5", "rejected", null);
    // An ended Grant says why; a live one has no reason.
    assert.equal((yield* insert("g6", "ended", null).pipe(Effect.flip))._tag, "SqlError");
    assert.equal((yield* insert("g7", "cancelled", "revoked").pipe(Effect.flip))._tag, "SqlError");
    // Only a lending link has no destination yet.
    const noTarget = yield* sql`
      INSERT INTO grants (
        grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
        state, limits_json, created_at
      ) VALUES ('g8', 'environment', 'env-vps', 'user', 'ana', 'space', NULL, 'pending',
        ${limits}, ${at})
    `.pipe(Effect.flip);
    assert.equal(noTarget._tag, "SqlError");
    const rows = yield* sql<{ readonly id: string }>`
      SELECT grant_id AS id FROM grants ORDER BY grant_id
    `;
    assert.deepEqual(
      rows.map((row) => row.id),
      ["g1", "g3", "g4", "g5"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
