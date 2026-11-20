import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in, ticket 08: turning local sign-in off ends local sessions, never the shell's.
// The column marks the shell, so a path that forgets it is revoked, not silently kept; only the
// shell's own subjects are backfilled. While it is off, the trigger refuses anyone but the Owner a
// session no Keycloak sign-in vouches for and the shell did not issue.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN issued_by_shell INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN issued_by_shell INTEGER NOT NULL DEFAULT 0`;
  // `cli-issued-session`: `t3 auth session issue` without `--subject`; `t3-shell`: the shell's
  // own commands (`t3 project`, `t3 sandbox`).
  yield* sql`
    UPDATE auth_sessions SET issued_by_shell = 1
    WHERE subject IN ('cli-issued-session', 't3-shell')
  `;
  yield* sql`
    CREATE TRIGGER auth_sessions_local_sign_in_closed
    BEFORE INSERT ON auth_sessions
    WHEN NEW.identity_login_id IS NULL
      AND NEW.issued_by_shell = 0
      AND NEW.user_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sign_in_settings
        WHERE id = 1 AND keycloak_enabled = 1 AND local_sign_in_for_members = 0
      )
      AND NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.user_id AND is_owner = 1)
    BEGIN SELECT RAISE(ABORT, 'local sign-in is off for everyone but the Owner'); END
  `;
});
