import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// Captured from AllowedAiAccounts before grants ticket 02 (allowances), on the same Hub.
import GOLDEN from "./145_AiAccountAllowancesToGrants.golden.json" with { type: "json" };
import { seedBefore145, usableSets } from "./145_AiAccountAllowancesToGrants.testkit.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

const migrate = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 144 });
  yield* seedBefore145;
  assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 145 }), [
    [145, "AiAccountAllowancesToGrants"],
  ]);
});

it.effect("turns each allowance into an active Grant of the Owner, with no cap", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    const grants = yield* sql<{
      readonly account: string;
      readonly target: string;
      readonly rest: string;
    }>`
      SELECT resource_id AS account, target_id AS target,
        resource_kind || '|' || lender_kind || ':' || lender_id || '|' || state || '|'
          || limits_json || '|' || created_by || '|' || decided_by AS rest
      FROM grants ORDER BY resource_id, target_id
    `;
    // To Spaces as they were; to Ana and Bob as their Personal spaces. Nothing into the Owner's
    // own Personal space (an allowance there, or to the Owner), to a gone Space, a removed or
    // unknown User, on a deleted account or on an account the Owner does not own.
    assert.deepEqual(
      grants.map((grant) => `${grant.account}>${grant.target}`),
      [
        "o-claude>org-acme",
        "o-claude>personal:ana",
        "o-codex>org-globex",
        "o-codex>org-initech",
        "o-codex>personal:bob",
        "o-direct>org-acme",
        "o-direct>personal:ana",
        "o-disabled>org-globex",
      ],
    );
    for (const grant of grants) {
      assert.equal(
        grant.rest,
        'ai-account|user:owner|active|{"kind":"ai-account","tokens":null,"requests":null}|owner|owner',
      );
    }
    // Each audited as given by the migration, without a token or a credential.
    const audited = yield* sql<{ readonly detail: string; readonly actor: string }>`
      SELECT detail_json AS detail, actor_source AS actor FROM audit_log
      WHERE action = 'grant.give' ORDER BY target_name, space_id
    `;
    assert.equal(audited.length, grants.length);
    for (const row of audited) {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      assert.equal(row.actor, "system");
      assert.equal(detail.via, "migration");
      assert.equal(detail.state, "active");
      assert.equal(detail.resourceKind, "ai-account");
    }
    // The allowances are gone.
    const table = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ai_account_allowances'
    `;
    assert.equal(table[0]?.n, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps every User's usable AI accounts in every Space, except exactly what the review lists",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      // Today's AllowedAiAccounts reads what later tickets added (Keycloak sign-in's identities
      // and managed Memberships): it reads the database migrated to today.
      yield* runMigrations();
      const after = yield* usableSets;
      const reviews = yield* sql<{
        readonly account: string;
        readonly user: string;
        readonly space: string;
        readonly used: number;
      }>`
        SELECT account_id AS account, user_id AS user, space_id AS space,
          used_recently AS used
        FROM ai_account_grant_reviews ORDER BY account_id, user_id, space_id
      `;
      assert.deepEqual(
        reviews.map((row) => `${row.account}|${row.user}|${row.space}|${row.used}`),
        [
          // Ana used it in Globex lately; Bob used Codex in Acme long ago.
          "o-claude|ana|org-globex|1",
          "o-claude|owner|org-globex|0",
          "o-claude|owner|org-initech|0",
          "o-codex|bob|org-acme|0",
          "o-direct|ana|org-globex|0",
        ],
      );
      const listed = new Set(reviews.map((row) => `${row.account}|${row.user}|${row.space}`));
      const before = GOLDEN as Record<string, ReadonlyArray<string>>;
      assert.sameMembers(Object.keys(after), Object.keys(before));
      for (const [pair, was] of Object.entries(before)) {
        const [user, space] = pair.split("|");
        const now = after[pair] ?? [];
        // Nothing widens anywhere: no account appears where it was not usable.
        assert.deepEqual(
          now.filter((account) => !was.includes(account)),
          [],
          `${pair} gained`,
        );
        // What it lost is exactly what the review lists for that User and Space.
        assert.deepEqual(
          was.filter((account) => !now.includes(account)),
          was.filter((account) => listed.has(`${account}|${user}|${space}`)),
          `${pair} lost`,
        );
        // And the order of what stayed is kept.
        assert.deepEqual(
          now,
          was.filter((account) => now.includes(account)),
          `${pair} order`,
        );
      }
      // Every review row is a real loss of a User who could use it there (or an archived
      // Organization's, which nobody uses until it is restored).
      for (const row of reviews) {
        const key = `${row.user}|${row.space}`;
        if (row.space === "org-initech") continue;
        assert.include(before[key] ?? [], row.account, key);
        assert.notInclude(after[key] ?? [], row.account, key);
      }
    }).pipe(Effect.provide(layer)),
);
