import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 06: what a Keycloak sign-in's ID token said about how the person
// authenticated (`acr`, and `amr` as a JSON array), kept so a change to the Owner's strong-factor
// lists can tell which live sign-ins stop being strong. Neither is a secret.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE identity_logins ADD COLUMN acr TEXT`;
  yield* sql`ALTER TABLE identity_logins ADD COLUMN amr_json TEXT NOT NULL DEFAULT '[]'`;
});
