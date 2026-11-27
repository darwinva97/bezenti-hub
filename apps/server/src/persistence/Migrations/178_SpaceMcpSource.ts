import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Where a Space MCP added from a registry search came from (registry, id, version), as JSON.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE space_mcps ADD COLUMN source_json TEXT`;
});
