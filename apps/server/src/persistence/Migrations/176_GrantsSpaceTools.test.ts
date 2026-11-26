import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-26T00:00:00.000Z";

it.effect("a Space MCP or Skill can be lent; every earlier loan and its names survive", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 175 });
    const insert = (id: string, kind: string, resourceId = `${id}-resource`) => sql`
      INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
        target_kind, target_id, state, limits_json, created_at, resource_name, lender_name,
        target_name)
      VALUES (${id}, ${kind}, ${resourceId}, 'organization', 'org-acme', 'space',
        'org-beta', 'active', ${`{"kind":"${kind}"}`}, ${at}, 'Thing', 'Acme', 'Beta')
    `;
    yield* insert("g-vault", "vault-group");
    const refusedBefore = yield* insert("g-mcp-early", "space-mcp").pipe(
      Effect.as(false),
      Effect.orElseSucceed(() => true),
    );
    assert.isTrue(refusedBefore);

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 176 }), [
      [176, "GrantsSpaceTools"],
    ]);
    yield* insert("g-mcp", "space-mcp");
    yield* insert("g-skill", "space-skill");
    const rows = yield* sql<{ readonly id: string; readonly names: string }>`
      SELECT grant_id AS id, resource_name || '/' || lender_name || '/' || target_name AS names
      FROM grants ORDER BY grant_id
    `;
    assert.deepEqual(rows, [
      { id: "g-mcp", names: "Thing/Acme/Beta" },
      { id: "g-skill", names: "Thing/Acme/Beta" },
      { id: "g-vault", names: "Thing/Acme/Beta" },
    ]);
    // One live loan of a resource per destination, as before.
    const duplicate = yield* insert("g-mcp-again", "space-mcp", "g-mcp-resource").pipe(
      Effect.as(false),
      Effect.orElseSucceed(() => true),
    );
    assert.isTrue(duplicate);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
