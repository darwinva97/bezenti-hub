import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-16T00:00:00.000Z";
const later = "2026-11-23T00:00:00.000Z";
const limits = JSON.stringify({ kind: "ai-account", tokens: null, requests: null });

it.effect(
  "a lending link with no destination can be cancelled; every row, hash and rule survives",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 147 });
      const insert = (
        id: string,
        state: string,
        target: string | null,
        options: { readonly hash?: string; readonly endReason?: string } = {},
      ) => sql`
        INSERT INTO grants (
          grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
          state, end_reason, limits_json, offer_token_hash, offer_expires_at, created_at,
          created_by, decided_at, decided_by
        ) VALUES (${id}, 'ai-account', 'ana-key', 'user', 'ana', 'space', ${target}, ${state},
          ${options.endReason ?? null}, ${limits}, ${options.hash ?? null},
          ${options.hash === undefined ? null : later}, ${at}, 'ana',
          ${state === "offered" ? null : at}, ${state === "offered" ? null : "bob"})
      `;
      yield* insert("g1", "active", "org-acme");
      yield* insert("g2", "offered", null, { hash: "hash-open" });
      yield* insert("g3", "active", "personal:bob", { hash: "hash-used" });
      yield* insert("g4", "ended", "org-globex", { endReason: "revoked" });
      // Before: a link with no destination could not be cancelled.
      const before = yield* sql`
        UPDATE grants SET state = 'cancelled' WHERE grant_id = 'g2'
      `.pipe(Effect.flip);
      assert.equal(before._tag, "SqlError");

      yield* runMigrations({ toMigrationInclusive: 148 });

      // Every row came across as it was.
      const rows = yield* sql<{
        readonly id: string;
        readonly state: string;
        readonly target: string | null;
        readonly hash: string | null;
        readonly expires: string | null;
        readonly reason: string | null;
        readonly decidedBy: string | null;
      }>`
        SELECT grant_id AS id, state, target_id AS target, offer_token_hash AS hash,
          offer_expires_at AS expires, end_reason AS reason, decided_by AS "decidedBy"
        FROM grants ORDER BY grant_id
      `;
      assert.deepEqual(
        rows.map((row) => [row.id, row.state, row.target, row.hash, row.expires, row.reason]),
        [
          ["g1", "active", "org-acme", null, null, null],
          ["g2", "offered", null, "hash-open", later, null],
          ["g3", "active", "personal:bob", "hash-used", later, null],
          ["g4", "ended", "org-globex", null, null, "revoked"],
        ],
      );
      assert.equal(rows[2]?.decidedBy, "bob");

      // Now the link is cancelled with no destination.
      yield* sql`UPDATE grants SET state = 'cancelled' WHERE grant_id = 'g2'`;
      // A token hash is still unique.
      const sameHash = yield* insert("g5", "offered", null, { hash: "hash-used" }).pipe(
        Effect.flip,
      );
      assert.equal(sameHash._tag, "SqlError");
      // Nothing else goes without a destination.
      for (const state of ["pending", "active", "rejected"]) {
        const refused = yield* insert(`g-${state}`, state, null).pipe(Effect.flip);
        assert.equal(refused._tag, "SqlError", state);
      }
      const ended = yield* insert("g-ended", "ended", null, { endReason: "revoked" }).pipe(
        Effect.flip,
      );
      assert.equal(ended._tag, "SqlError");
      // An ended one still needs its reason, a live one none.
      assert.equal((yield* insert("g6", "ended", "org-x").pipe(Effect.flip))._tag, "SqlError");
      // One live loan per resource and Space, as before.
      assert.equal((yield* insert("g7", "pending", "org-acme").pipe(Effect.flip))._tag, "SqlError");
      yield* insert("g8", "pending", "org-globex");
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'grants'
          AND name NOT LIKE 'sqlite_autoindex%'
        ORDER BY name
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        ["grants_lender_idx", "grants_one_live_idx", "grants_resource_idx", "grants_target_idx"],
      );
      const count = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM grants`;
      assert.equal(count[0]?.n, 5);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
