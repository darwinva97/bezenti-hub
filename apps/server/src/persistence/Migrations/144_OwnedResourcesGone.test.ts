import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import OwnedResourcesGone from "./144_OwnedResourcesGone.ts";

const AT = "2026-11-17T00:00:00.000Z";

it.effect(
  "drops what a removed User or a deleted Organization still owned, ends their loans, leaves live owners alone, and runs twice the same",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 143 });
      yield* sql`
        INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
          ('owner', 'Owner', 1, ${AT}), ('ana', 'Ana', 0, ${AT}), ('gone', 'Gone', 0, ${AT})
      `;
      yield* sql`UPDATE users SET removed_at = ${AT}, disabled_at = ${AT} WHERE user_id = 'gone'`;
      yield* sql`
        INSERT INTO spaces (space_id, kind, name, created_at)
        VALUES ('org-acme', 'organization', 'Acme', ${AT})
      `;
      // Groups: the removed User's, an Organization's whose row is gone, Ana's and Acme's.
      yield* sql`
        INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
          updated_at) VALUES
          ('g-gone', 'user', 'gone', 'default', 1, ${AT}, ${AT}),
          ('g-ghost', 'organization', 'org-ghost', 'Ghost keys', 0, ${AT}, ${AT}),
          ('g-ana', 'user', 'ana', 'default', 1, ${AT}, ${AT}),
          ('g-acme', 'organization', 'org-acme', 'Acme keys', 0, ${AT}, ${AT})
      `;
      for (const group of ["g-gone", "g-ghost", "g-ana", "g-acme"]) {
        yield* sql`
          INSERT INTO vault_entries (entry_id, group_id, name, kind, value_id, created_at, updated_at)
          VALUES (${`e-${group}`}, ${group}, 'TOKEN', 'own', ${`v-${group}`}, ${AT}, ${AT})
        `;
        yield* sql`
          INSERT INTO space_default_vaults (space_id, group_id) VALUES ('org-acme', ${group})
        `;
      }
      // AI accounts: the removed User's, the gone Organization's, Ana's and Acme's.
      const account = (id: string, kind: string, owner: string, priority: number) => sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, created_at,
          updated_at, owner_kind, owner_id, credential_id)
        VALUES (${id}, ${id}, 'api-key', 'claude', ${priority}, ${AT}, ${AT}, ${kind}, ${owner},
          ${`cred-${id}`})
      `;
      yield* account("a-gone", "user", "gone", 1);
      yield* account("a-ghost", "organization", "org-ghost", 1);
      yield* account("a-ana", "user", "ana", 1);
      yield* account("a-acme", "organization", "org-acme", 1);
      yield* sql`
        INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
        VALUES ('a-gone', 'space', 'org-acme', ${AT}), ('a-acme', 'user', 'ana', ${AT})
      `;
      // Loans: given by the removed User, to its Personal space, to the gone Organization, a link
      // it offered, and Ana's live one to Acme.
      const grant = (
        id: string,
        kind: string,
        lenderKind: string,
        lender: string,
        target: string | null,
        state: string,
      ) => sql`
        INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
          target_kind, target_id, state, limits_json, created_at)
        VALUES (${id}, ${kind}, ${`r-${id}`}, ${lenderKind}, ${lender}, 'space', ${target},
          ${state}, '{}', ${AT})
      `;
      yield* grant("by-gone", "environment", "user", "gone", "org-acme", "active");
      yield* grant("to-gone", "ai-account", "user", "ana", "personal:gone", "pending");
      yield* grant("to-ghost", "environment", "user", "ana", "org-ghost", "active");
      yield* grant("link-gone", "vault-group", "user", "gone", null, "offered");
      yield* grant("ana-acme", "environment", "user", "ana", "org-acme", "active");
      yield* sql`
        INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, space_id,
          credential_hash, credential_issued_at, registered_at)
        VALUES ('laptop', 'Laptop', 'external', 'personal', 'ana', NULL, 'h1', ${AT}, ${AT})
      `;
      yield* sql`
        INSERT INTO environments (environment_id, name, kind, mode, space_id, registered_at,
          grant_id, host_environment_id) VALUES
          ('lent:to-ghost', 'Laptop for Ghost', 'sandbox', 'lent', 'org-ghost', ${AT}, 'to-ghost',
            'laptop'),
          ('lent:ana-acme', 'Laptop for Acme', 'sandbox', 'lent', 'org-acme', ${AT}, 'ana-acme',
            'laptop')
      `;

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 144 }), [
        [144, "OwnedResourcesGone"],
      ]);

      const snapshot = Effect.gen(function* () {
        const groups = yield* sql<{ readonly id: string }>`
          SELECT group_id AS id FROM vault_groups ORDER BY group_id
        `;
        const entries = yield* sql<{ readonly id: string }>`
          SELECT group_id AS id FROM vault_entries ORDER BY group_id
        `;
        const defaults = yield* sql<{ readonly id: string }>`
          SELECT group_id AS id FROM space_default_vaults ORDER BY group_id
        `;
        const accounts = yield* sql<{
          readonly id: string;
          readonly deleted: number;
          readonly credential: string | null;
          readonly status: string;
        }>`
          SELECT account_id AS id, deleted_at IS NOT NULL AS deleted,
            credential_id AS credential, status
          FROM ai_accounts ORDER BY account_id
        `;
        const retired = yield* sql<{ readonly id: string }>`
          SELECT credential_id AS id FROM ai_account_retired_credentials ORDER BY credential_id
        `;
        const allowances = yield* sql<{ readonly id: string }>`
          SELECT account_id AS id FROM ai_account_allowances ORDER BY account_id
        `;
        const grants = yield* sql<{
          readonly id: string;
          readonly state: string;
          readonly reason: string | null;
          readonly expired: number;
        }>`
          SELECT grant_id AS id, state, end_reason AS reason,
            offer_expires_at IS NOT NULL AS expired
          FROM grants ORDER BY grant_id
        `;
        const lent = yield* sql<{ readonly id: string; readonly revoked: number }>`
          SELECT environment_id AS id, revoked_at IS NOT NULL AS revoked FROM environments
          WHERE mode = 'lent' ORDER BY environment_id
        `;
        return {
          groups: groups.map((row) => row.id),
          entries: entries.map((row) => row.id),
          defaults: defaults.map((row) => row.id),
          accounts: accounts.map((row) => ({ ...row })),
          retired: retired.map((row) => row.id),
          allowances: allowances.map((row) => row.id),
          grants: grants.map((row) => ({ ...row })),
          lent: lent.map((row) => ({ ...row })),
        };
      });
      const after = yield* snapshot;
      assert.deepEqual(after.groups, ["g-acme", "g-ana"]);
      assert.deepEqual(after.entries, ["g-acme", "g-ana"]);
      assert.deepEqual(after.defaults, ["g-acme", "g-ana"]);
      assert.deepEqual(after.accounts, [
        { id: "a-acme", deleted: 0, credential: "cred-a-acme", status: "pending" },
        { id: "a-ana", deleted: 0, credential: "cred-a-ana", status: "pending" },
        { id: "a-ghost", deleted: 1, credential: null, status: "removing" },
        { id: "a-gone", deleted: 1, credential: null, status: "removing" },
      ]);
      assert.deepEqual(after.retired, ["cred-a-ghost", "cred-a-gone"]);
      assert.deepEqual(after.allowances, ["a-acme"]);
      assert.deepEqual(after.grants, [
        { id: "ana-acme", state: "active", reason: null, expired: 0 },
        { id: "by-gone", state: "ended", reason: "lender-gone", expired: 0 },
        { id: "link-gone", state: "offered", reason: null, expired: 1 },
        { id: "to-ghost", state: "ended", reason: "target-gone", expired: 0 },
        { id: "to-gone", state: "ended", reason: "target-gone", expired: 0 },
      ]);
      assert.deepEqual(after.lent, [
        { id: "lent:ana-acme", revoked: 0 },
        { id: "lent:to-ghost", revoked: 1 },
      ]);

      // Run again (as a Hub restarted mid-way would): nothing more changes.
      yield* OwnedResourcesGone;
      assert.deepEqual(yield* snapshot, after);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
