/**
 * Whether «local sign-in for everyone but the Owner» is off (Keycloak sign-in spec, ticket 08):
 * Keycloak on and the setting off. Read from `sign_in_settings` alone, so the doors that issue a
 * session (EnvironmentAuth, which the Hub's shell also builds) need no SignInSettings service.
 * With Keycloak off, local sign-in is always open: it is then the only way in.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const localSignInClosed = (sql: SqlClient.SqlClient) =>
  sql<{ readonly closed: number }>`
    SELECT (keycloak_enabled = 1 AND local_sign_in_for_members = 0) AS closed
    FROM sign_in_settings WHERE id = 1
  `.pipe(Effect.map((rows) => rows[0]?.closed === 1));
