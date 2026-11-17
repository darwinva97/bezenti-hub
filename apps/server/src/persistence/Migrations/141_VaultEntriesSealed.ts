import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Owned-resources 01 (ADR 0012): nobody reveals a Secret any more, the Owner included, so every
// revealable one is sealed. The column stays for the CHECKs of 119–123; nothing reads it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE vault_entries SET revealable = 0 WHERE revealable = 1`;
});
