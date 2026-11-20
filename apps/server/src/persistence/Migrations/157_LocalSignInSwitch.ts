import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keycloak sign-in, ticket 08: turning local sign-in off ends local sessions, never the shell's.
// The column marks the shell, so a path that forgets it is revoked, not silently kept; only the
// shell's own subjects are backfilled. While it is off, the trigger refuses anyone but the Owner a
// session no Keycloak sign-in vouches for and the shell did not issue.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

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

  // Ticket 01 could already save it off: end now what turning it off ends (endLocalSignIns), so
  // no local session outlives the upgrade. No socket is open while migrations run.
  const closed = yield* sql<{ readonly closed: number }>`
    SELECT (keycloak_enabled = 1 AND local_sign_in_for_members = 0) AS closed
    FROM sign_in_settings WHERE id = 1
  `;
  if (closed[0]?.closed !== 1) return;
  const sessions = yield* sql<{ readonly id: string }>`
    UPDATE auth_sessions SET revoked_at = ${sql.literal(NOW)}
    WHERE revoked_at IS NULL AND identity_login_id IS NULL AND issued_by_shell = 0
      AND user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM users WHERE is_owner = 1)
    RETURNING session_id AS id
  `;
  const links = yield* sql<{ readonly id: string }>`
    UPDATE auth_pairing_links SET revoked_at = ${sql.literal(NOW)}
    WHERE revoked_at IS NULL AND consumed_at IS NULL
      AND identity_login_id IS NULL AND issued_by_shell = 0
      AND user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM users WHERE is_owner = 1)
    RETURNING id
  `;
  yield* sql`
    INSERT INTO audit_log (at, actor_source, actor_user_id, action, target_kind, target_id,
      target_name, detail_json)
    VALUES (${sql.literal(NOW)}, 'system', NULL, 'signIn.settings.update', 'sign_in_settings',
      'sign-in', 'Sign-in settings',
      json_object('changed', 'localSignInForMembers', 'localSignInForMembers', json('false'),
        'localSessionsEnded', ${sessions.length}, 'localPairingLinksEnded', ${links.length}))
  `;
});
