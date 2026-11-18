import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 01: the Platform's sign-in settings, one row, and the Keycloak
// group mappings that ticket 05 fills. The client secret is never here: it is in the Hub's
// encrypted store (`keycloak-client-secret`); this row keeps only when it was last saved.
// The defaults are today's behaviour: invitation only, local sign-in for everyone, no Keycloak.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE sign_in_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      registration_mode TEXT NOT NULL DEFAULT 'invitation-only'
        CHECK (registration_mode IN ('open', 'invitation-only', 'closed')),
      local_sign_in_for_members INTEGER NOT NULL DEFAULT 1,
      keycloak_enabled INTEGER NOT NULL DEFAULT 0,
      keycloak_issuer TEXT,
      keycloak_client_id TEXT,
      keycloak_client_secret_updated_at TEXT,
      keycloak_groups_claim TEXT NOT NULL DEFAULT 'groups',
      strong_acr_json TEXT NOT NULL DEFAULT '[]',
      strong_amr_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT,
      updated_by TEXT REFERENCES users(user_id)
    )
  `;
  yield* sql`INSERT INTO sign_in_settings (id) VALUES (1)`;

  // One row per group and Organization; the Role it gives there. Goes with its Organization.
  yield* sql`
    CREATE TABLE keycloak_group_mappings (
      group_name TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(user_id),
      PRIMARY KEY (group_name, space_id)
    )
  `;
  yield* sql`CREATE INDEX keycloak_group_mappings_space_idx ON keycloak_group_mappings(space_id)`;
});
