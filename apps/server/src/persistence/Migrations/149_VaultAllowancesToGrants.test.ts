import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// Captured from EffectiveVaults before Grants ticket 07 (allowances), on the same Hub.
import GOLDEN from "./149_VaultAllowancesToGrants.golden.json" with { type: "json" };
import {
  effectiveSets,
  type Received,
  seedBefore149,
} from "./149_VaultAllowancesToGrants.testkit.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

const migrate = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 148 });
  yield* seedBefore149;
  assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 149 }), [
    [149, "VaultAllowancesToGrants"],
  ]);
});

it.effect(
  "turns each allowance on the Owner's named groups into an active Grant of the Owner",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      const grants = yield* sql<{
        readonly group: string;
        readonly target: string;
        readonly rest: string;
      }>`
      SELECT resource_id AS "group", target_id AS target,
        resource_kind || '|' || lender_kind || ':' || lender_id || '|' || state || '|'
          || limits_json || '|' || created_by || '|' || decided_by AS rest
      FROM grants ORDER BY resource_id, target_id
    `;
      // To Spaces as they were; to Ana and Bob as their Personal spaces, once each (o-multi was
      // allowed to Ana and to her Personal space). Nothing into the Owner's own Personal space, to a
      // gone Space, a removed or unknown User, on a `default` or on Ana's own group.
      assert.deepEqual(
        grants.map((grant) => `${grant.group}>${grant.target}`),
        [
          "o-archived>org-acme",
          "o-multi>org-acme",
          "o-multi>personal:ana",
          "o-shared>org-acme",
          "o-shared>org-initech",
          "o-user>personal:ana",
          "o-user>personal:bob",
        ],
      );
      for (const grant of grants) {
        assert.equal(
          grant.rest,
          'vault-group|user:owner|active|{"kind":"vault-group"}|owner|owner',
        );
      }
      const audited = yield* sql<{ readonly detail: string; readonly actor: string }>`
      SELECT detail_json AS detail, actor_source AS actor FROM audit_log
      WHERE action = 'grant.give' ORDER BY target_name, space_id
    `;
      assert.equal(audited.length, grants.length);
      for (const row of audited) {
        const detail = JSON.parse(row.detail) as Record<string, unknown>;
        assert.equal(row.actor, "system");
        assert.equal(detail.via, "migration");
        assert.equal(detail.resourceKind, "vault-group");
      }
      // A group allowed to a User is now one of their Personal space's defaults, after theirs.
      const defaults = yield* sql<{ readonly row: string }>`
      SELECT space_id || '>' || group_id || '@' || position AS "row" FROM space_default_vaults
      WHERE space_id LIKE 'personal:%' ORDER BY space_id, position
    `;
      assert.deepEqual(
        defaults.map((row) => row.row),
        [
          "personal:ana>o-multi@0",
          "personal:ana>o-user@1",
          "personal:bob>o-user@0",
          "personal:owner>o-user@0",
        ],
      );
      const chosen = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'vault.choose' AND json_extract(detail_json, '$.via') = 'migration'
    `;
      assert.equal(chosen[0]?.n, 3);
      const table = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vault_allowances'
    `;
      assert.equal(table[0]?.n, 0);
    }).pipe(Effect.provide(layer)),
);

/** The Owner reads other Users' Personal spaces and starts nothing there (`personal-space-read-only`). */
const OWNER_READS_ONLY = "owner|personal:dan|- o-user";
/** A Project's remove now holds for a group the User had by allowance: Acme still borrows it. */
const PROJECT_REMOVES = "ana|org-acme|p-acme o-multi";

it.effect(
  "keeps what every User's turns receive in every Space, except exactly what the review lists",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      const after = yield* effectiveSets;
      const reviews = yield* sql<{ readonly row: string }>`
        SELECT group_id || '|' || user_id || '|' || space_id AS "row"
        FROM vault_group_grant_reviews ORDER BY group_id, user_id, space_id
      `;
      assert.deepEqual(
        reviews.map((review) => review.row),
        [
          "o-multi|ana|org-globex",
          "o-user|ana|org-acme",
          "o-user|ana|org-globex",
          "o-user|bob|org-acme",
          "o-user|bob|org-initech",
          "o-user|owner|org-acme",
          "o-user|owner|org-globex",
          "o-user|owner|org-initech",
        ],
      );
      const listed = new Set(reviews.map((review) => review.row));
      const before = GOLDEN as Record<string, Received | string>;
      assert.sameMembers(Object.keys(after), Object.keys(before));
      const lost: Array<string> = [];
      const flipped: Array<string> = [];
      for (const [key, was] of Object.entries(before)) {
        const now = after[key];
        if (typeof was === "string" || typeof now === "string") {
          assert.deepEqual(now, was, `${key} refused`);
          continue;
        }
        assert.ok(now !== undefined, key);
        const [user, space] = key.split("|");
        // Nothing widens anywhere.
        assert.deepEqual(
          now.vaults.filter((vault) => !was.vaults.includes(vault)),
          [],
          `${key} gained`,
        );
        for (const vault of was.vaults.filter((vault) => !now.vaults.includes(vault))) {
          if (!listed.has(`${vault}|${user}|${space}`)) lost.push(`${key} ${vault}`);
        }
        // A name keeps its winner, unless that winner was the User's own allowance: then the
        // Space's order decides among what still reaches (its owner's `default` first).
        for (const [name, winner] of Object.entries(was.winners)) {
          const next = now.winners[name];
          if (!now.vaults.includes(winner)) continue;
          if (next === winner) continue;
          assert.equal(was.sources[winner], "user", `${key} ${name} changed winner`);
          assert.ok(next !== undefined, `${key} ${name}`);
          flipped.push(`${key} ${name} ${winner}>${next}`);
        }
      }
      // Lost besides the review: exactly these two.
      assert.deepEqual(lost.toSorted(), [PROJECT_REMOVES, OWNER_READS_ONLY].toSorted());
      assert.deepEqual(flipped.toSorted(), [
        "ana|org-acme|- SHARED_NAME o-multi>acme-default",
        "ana|personal:ana|- USER_NAME o-user>ana-default",
        "owner|personal:ana|- SHARED_NAME o-user>o-multi",
        "owner|personal:ana|- USER_NAME o-user>ana-default",
        "owner|personal:owner|- SHARED_NAME o-user>owner-default",
      ]);
    }).pipe(Effect.provide(layer)),
);
