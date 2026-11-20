import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in spec, ticket 02: who a User is in Keycloak (issuer + subject, never the email),
// each sign-in through it, and which sign-in a Hub session comes from. A login's refresh token is
// sealed under a key from the encrypted store, bound to the login's id; ticket 07 re-checks with it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_identities (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      username TEXT,
      email TEXT,
      linked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (issuer, subject)
    )
  `;

  yield* sql`
    CREATE TABLE identity_logins (
      login_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      keycloak_sid TEXT,
      refresh_token_sealed TEXT,
      strong INTEGER NOT NULL DEFAULT 0,
      offline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX identity_logins_live_user_idx ON identity_logins(user_id) WHERE ended_at IS NULL
  `;
  yield* sql`
    CREATE INDEX identity_logins_live_sid_idx ON identity_logins(keycloak_sid)
    WHERE ended_at IS NULL AND keycloak_sid IS NOT NULL
  `;

  yield* sql`
    ALTER TABLE auth_sessions
    ADD COLUMN identity_login_id TEXT REFERENCES identity_logins(login_id)
  `;
  yield* sql`
    CREATE INDEX auth_sessions_identity_login_idx ON auth_sessions(identity_login_id)
    WHERE identity_login_id IS NOT NULL
  `;
});
