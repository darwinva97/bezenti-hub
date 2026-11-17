import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every User has their Personal space, so `personalSpace.create` grants nothing any more. The
// table's CHECK still names it; plans-and-limits drops the whole table later.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM installation_permissions WHERE permission = 'personalSpace.create'`;
});
