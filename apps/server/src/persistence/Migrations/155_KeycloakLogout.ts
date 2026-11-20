import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 07: a pairing link created from a Keycloak session carries its
// sign-in, so it ends with it; a sign-in keeps its latest ID token (sealed like the refresh token,
// for the `id_token_hint` of «also sign out of Keycloak»); back-channel logout finds a person's
// live sign-ins by issuer and subject. An ended sign-in keeps no token.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE auth_pairing_links
    ADD COLUMN identity_login_id TEXT REFERENCES identity_logins(login_id)
  `;
  yield* sql`
    CREATE INDEX auth_pairing_links_identity_login_idx ON auth_pairing_links(identity_login_id)
    WHERE identity_login_id IS NOT NULL
  `;
  yield* sql`ALTER TABLE identity_logins ADD COLUMN id_token_sealed TEXT`;
  yield* sql`
    CREATE INDEX identity_logins_live_subject_idx ON identity_logins(issuer, subject)
    WHERE ended_at IS NULL
  `;
  yield* sql`
    UPDATE identity_logins SET refresh_token_sealed = NULL WHERE ended_at IS NOT NULL
  `;
});
