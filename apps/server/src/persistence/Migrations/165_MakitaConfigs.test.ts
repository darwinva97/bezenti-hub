import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "keeps Makita configurations with every column of the spec and refuses values it does not know",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 164 });
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 165 }), [
        [165, "MakitaConfigs"],
      ]);
      const config = (
        id: string,
        over: {
          readonly callersMode?: string;
          readonly capability?: string;
          readonly mayLand?: number;
          readonly pausedReason?: string | null;
        } = {},
      ) => sql`
      INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at, updated_at,
        repos_json, triggers_json, callers_mode, model_selection_json, capability, may_land,
        paused_at, paused_by, paused_reason)
      VALUES (${id}, 'org-acme', 'Bugs', 'grace', '2026-11-24T00:00:00.000Z',
        '2026-11-24T00:00:00.000Z', '{"all":true}',
        '{"label":"makita","assigned":false,"mention":false}', ${over.callersMode ?? "list"},
        '{"instanceId":"claudeAgent","model":"claude-sonnet-5-5"}', ${over.capability ?? "comment"},
        ${over.mayLand ?? 0}, ${over.pausedReason == null ? null : "2026-11-24T00:00:00.000Z"},
        ${over.pausedReason == null ? null : "grace"}, ${over.pausedReason ?? null})
    `;
      yield* config("mk_1");
      yield* config("mk_2", { pausedReason: "permission-revoked" });
      for (const [id, over] of [
        ["mk_3", { callersMode: "everyone" }],
        ["mk_4", { capability: "merge" }],
        // Landing needs pushing.
        ["mk_5", { mayLand: 1 }],
        ["mk_6", { pausedReason: "tired" }],
      ] as const) {
        assert.equal((yield* config(id, over).pipe(Effect.flip))._tag, "SqlError", id);
      }
      yield* config("mk_7", { capability: "push", mayLand: 1 });
      const rows = yield* sql<{
        readonly id: string;
        readonly strangers: string;
        readonly approval: string;
        readonly environment: string | null;
      }>`
      SELECT config_id AS id, strangers, approval, environment_id AS environment
      FROM makita_configs ORDER BY config_id
    `;
      assert.deepEqual(rows, [
        { id: "mk_1", strangers: "ignore", approval: "others", environment: null },
        { id: "mk_2", strangers: "ignore", approval: "others", environment: null },
        { id: "mk_7", strangers: "ignore", approval: "others", environment: null },
      ]);
    }).pipe(Effect.provide(layer)),
);
