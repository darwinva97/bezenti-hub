import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Space's own MCP servers and Skills (.scratch/mcps-and-skills). An MCP's configuration holds
// `${NAME}` references to Vault entries, never a value.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE space_mcps (
      mcp_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (space_id, name)
    )
  `;
  yield* sql`
    CREATE TABLE space_skills (
      skill_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      files_json TEXT NOT NULL,
      expects_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (space_id, name)
    )
  `;
});
