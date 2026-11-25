import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("links one GitHub account per User and one User per GitHub account", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 169 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 170 }), [
      [170, "GitHubIdentities"],
    ]);
    const link = (userId: string, githubUserId: number) => sql`
      INSERT INTO github_identities (user_id, host, github_user_id, login, linked_at)
      VALUES (${userId}, 'github.com', ${githubUserId}, 'octocat', '2026-11-24T00:00:00.000Z')
    `;
    yield* link("user-ada", 1);
    // The same account for another User, or a second account for Ada, is refused.
    assert.equal((yield* link("user-grace", 1).pipe(Effect.flip))._tag, "SqlError");
    assert.equal((yield* link("user-ada", 2).pipe(Effect.flip))._tag, "SqlError");
    const code = (hash: string, outcome: string | null) => sql`
      INSERT INTO github_link_codes (code_hash, user_id, host, github_user_id, login, created_at,
        expires_at, outcome)
      VALUES (${hash}, 'user-grace', 'github.com', 3, 'grace-gh', '2026-11-24T00:00:00.000Z',
        '2026-11-24T00:15:00.000Z', ${outcome})
    `;
    yield* code("hash-1", null);
    yield* code("hash-2", "taken");
    assert.equal((yield* code("hash-1", null).pipe(Effect.flip))._tag, "SqlError");
    assert.equal((yield* code("hash-3", "maybe").pipe(Effect.flip))._tag, "SqlError");
  }).pipe(Effect.provide(layer)),
);
