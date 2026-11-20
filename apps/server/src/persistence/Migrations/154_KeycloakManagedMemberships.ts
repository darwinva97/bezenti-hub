import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 05: a Membership a mapped Keycloak group gave (or took over) is
// managed by Keycloak: each sign-in sets its Role from the groups, and nobody changes, removes or
// leaves it in the Hub. `keycloak_group` names the group that decided it, for «Managed by
// Keycloak (group X)»; NULL on a manual Membership.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE space_memberships ADD COLUMN managed_by_keycloak INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`ALTER TABLE space_memberships ADD COLUMN keycloak_group TEXT`;
});
