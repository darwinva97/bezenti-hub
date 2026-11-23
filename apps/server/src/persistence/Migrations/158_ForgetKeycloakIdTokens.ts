import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in, ticket 11: «also sign out of Keycloak» no longer sends an `id_token_hint`, so
// the Hub keeps no ID token. The ones sealed until now are dropped; the column stays, always NULL.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE identity_logins SET id_token_sealed = NULL WHERE id_token_sealed IS NOT NULL`;
});
