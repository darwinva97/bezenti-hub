import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("keeps one cursor per repository and feed, and each GitHub event once by its key", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 165 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 166 }), [[166, "MakitaIntake"]]);
    const cursor = (cursorValue: string) => sql`
      INSERT INTO makita_repo_cursors (host, repo, feed, cursor)
      VALUES ('github.com', 'acme/widgets', 'issue-events', ${cursorValue})
    `;
    yield* cursor("10");
    assert.equal((yield* cursor("11").pipe(Effect.flip))._tag, "SqlError");
    const event = (key: string, over: { readonly kind?: string; readonly outcome?: string } = {}) =>
      sql<{ readonly key: string }>`
        INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
          actor_login, seen_at, outcome)
        VALUES (${key}, 'github.com', 'acme/widgets', 12, ${over.kind ?? "issue"}, 1, 'octocat',
          '2026-11-24T00:00:00.000Z', ${over.outcome ?? "queued"})
        ON CONFLICT (event_key) DO NOTHING
        RETURNING event_key AS key
      `;
    assert.deepEqual(yield* event("gh:issue-event:1"), [{ key: "gh:issue-event:1" }]);
    // The same event again: nobody else processes it.
    assert.deepEqual(yield* event("gh:issue-event:1"), []);
    for (const [key, over] of [
      ["gh:issue-event:2", { kind: "discussion" }],
      ["gh:issue-event:3", { outcome: "maybe" }],
    ] as const) {
      assert.equal((yield* event(key, over).pipe(Effect.flip))._tag, "SqlError", key);
    }
  }).pipe(Effect.provide(layer)),
);
