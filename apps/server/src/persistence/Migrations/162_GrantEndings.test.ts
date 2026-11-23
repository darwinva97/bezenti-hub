import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import GrantEndings from "./162_GrantEndings.ts";

const AT = "2026-11-20T00:00:00.000Z";
const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "keeps every loan's names, ends the live loans of resources already gone and cancels their links, and runs twice the same",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 161 });
      yield* sql`
        INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
          ('owner', 'Owner', 1, ${AT}), ('ana', 'Ana', 0, ${AT})
      `;
      yield* sql`
        INSERT INTO spaces (space_id, kind, name, created_at)
        VALUES ('org-acme', 'organization', 'Acme', ${AT})
      `;
      yield* sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, created_at,
          updated_at, owner_kind, owner_id, deleted_at)
        VALUES ('a-live', 'Ana Claude', 'api-key', 'claude', 1, ${AT}, ${AT}, 'user', 'ana', NULL),
          ('a-deleted', 'Ana Old', 'api-key', 'claude', 2, ${AT}, ${AT}, 'user', 'ana', ${AT})
      `;
      yield* sql`
        INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
          updated_at)
        VALUES ('g-live', 'user', 'ana', 'Ana tools', 0, ${AT}, ${AT})
      `;
      yield* sql`
        INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, credential_hash,
          credential_issued_at, registered_at, revoked_at)
        VALUES ('box-gone', 'Ana box', 'external', 'personal', 'ana', 'hash-box', ${AT}, ${AT},
          ${AT})
      `;
      const loan = (
        id: string,
        kind: string,
        resource: string,
        state: string,
        target: string | null,
      ) => sql`
        INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
          target_kind, target_id, state, end_reason, limits_json, created_at, offer_token_hash,
          offer_expires_at)
        VALUES (${id}, ${kind}, ${resource}, 'user', 'ana', 'space', ${target}, ${state},
          ${state === "ended" ? "revoked" : null}, '{}',
          ${AT}, ${state === "offered" ? `hash-${id}` : null},
          ${state === "offered" ? "2099-01-01T00:00:00.000Z" : null})
      `;
      yield* loan("live-account", "ai-account", "a-live", "active", "org-acme");
      yield* loan("deleted-account", "ai-account", "a-deleted", "active", "org-acme");
      yield* loan("deleted-account-link", "ai-account", "a-deleted", "offered", null);
      yield* loan("missing-group", "vault-group", "g-missing", "pending", "org-acme");
      yield* loan("live-group", "vault-group", "g-live", "active", "org-acme");
      yield* loan("revoked-box", "environment", "box-gone", "active", "org-acme");
      yield* loan("history", "ai-account", "a-deleted", "ended", "org-acme");
      yield* sql`
        INSERT INTO environments (environment_id, name, kind, mode, space_id, credential_hash,
          registered_at, grant_id, host_environment_id)
        VALUES ('lent:revoked-box', 'Ana box', 'sandbox', 'lent', 'org-acme', NULL, ${AT},
          'revoked-box', 'box-gone')
      `;

      yield* runMigrations({ toMigrationInclusive: 162 });
      yield* GrantEndings;

      const rows = yield* sql<{
        readonly id: string;
        readonly state: string;
        readonly reason: string | null;
        readonly resource: string | null;
        readonly lender: string | null;
        readonly target: string | null;
      }>`
        SELECT grant_id AS id, state, end_reason AS reason, resource_name AS resource,
          lender_name AS lender, target_name AS target
        FROM grants ORDER BY grant_id
      `;
      assert.deepEqual(
        rows.map((row) => [row.id, row.state, row.reason, row.resource, row.lender, row.target]),
        [
          ["deleted-account", "ended", "resource-gone", "Ana Old", "Ana", "Acme"],
          ["deleted-account-link", "cancelled", null, "Ana Old", "Ana", null],
          ["history", "ended", "revoked", "Ana Old", "Ana", "Acme"],
          ["live-account", "active", null, "Ana Claude", "Ana", "Acme"],
          ["live-group", "active", null, "Ana tools", "Ana", "Acme"],
          ["missing-group", "ended", "resource-gone", null, "Ana", "Acme"],
          ["revoked-box", "ended", "resource-gone", "Ana box", "Ana", "Acme"],
        ],
      );
      const [sandbox] = yield* sql<{ readonly revokedAt: string | null }>`
        SELECT revoked_at AS "revokedAt" FROM environments WHERE environment_id = 'lent:revoked-box'
      `;
      assert.isNotNull(sandbox?.revokedAt ?? null, "the ended loan's Sandbox reaches nothing");
    }).pipe(Effect.provide(layer)),
);
