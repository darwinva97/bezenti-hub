import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 06: every active User joins their own machines, so `environments.registerOwn`
// grants nothing any more. It was the last Installation permission; the table stays until
// plans-and-limits drops it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM installation_permissions WHERE permission = 'environments.registerOwn'`;
});
