import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-18T00:00:00.000Z";

it.effect("adds Provider scopes and the Vaults allowed each", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 120 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
      [121, "SecretProviderScopes"],
    ]);
    yield* sql`
      INSERT INTO vaults (vault_id, name, is_main, created_at, updated_at)
      VALUES ('acme', 'Acme', 0, ${AT}, ${AT})
    `;
    const scope = (id: string, label: string, paths: string, provider = "vault") => sql`
      INSERT INTO secret_provider_scopes (scope_id, provider_id, label, allowed_paths_json,
        created_at, updated_at)
      VALUES (${id}, ${provider}, ${label}, ${paths}, ${AT}, ${AT})
    `;
    const refused = <E>(insert: Effect.Effect<unknown, E>) =>
      insert.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
    assert.isFalse(yield* refused(scope("s1", "Acme", '["kv/acme"]')));
    assert.isTrue(yield* refused(scope("s2", "acme", '["kv/other"]')), "a label once per provider");
    assert.isFalse(yield* refused(scope("s3", "acme", '["kv/other"]', "other")));
    assert.isTrue(yield* refused(scope("s4", "Empty", "[]")), "at least one allowed path");
    yield* sql`
      INSERT INTO vault_provider_scopes (vault_id, scope_id, created_at) VALUES ('acme', 's1', ${AT})
    `;
    const rows = yield* sql<{ readonly writable: number; readonly auth: string }>`
      SELECT writable, auth_json AS auth FROM secret_provider_scopes WHERE scope_id = 's1'
    `;
    assert.deepEqual({ ...rows[0] }, { writable: 0, auth: "{}" });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
