import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-16T00:00:00.000Z";
const later = "2026-12-16T00:00:00.000Z";

it.effect(
  "only the shell's own subjects are marked shell-issued; anything else may be revoked",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 155 });
      yield* sql`
        INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
          ('owner', 'Owner', 1, ${at}), ('ana', 'Ana', 0, ${at})
      `;
      const session = (id: string, subject: string, method = "bearer-access-token") => sql`
        INSERT INTO auth_sessions (session_id, subject, user_id, method, scopes, issued_at,
          expires_at)
        VALUES (${id}, ${subject}, 'ana', ${method}, '[]', ${at}, ${later})
      `;
      yield* session("cli", "cli-issued-session");
      yield* session("shell", "t3-shell");
      yield* session("browser", "user-sign-in", "browser-session-cookie");
      yield* session("paired", "one-time-token", "browser-session-cookie");
      // `t3 auth session issue --subject anything`: nothing says it was the shell's.
      yield* session("unknown", "some-custom-subject");
      yield* sql`
        INSERT INTO auth_pairing_links (id, credential, method, subject, scopes, user_id,
          created_at, expires_at)
        VALUES ('link', 'CRED', 'one-time-token', 'one-time-token', '[]', 'ana', ${at},
          ${later})
      `;

      yield* runMigrations({ toMigrationInclusive: 157 });

      const sessions = yield* sql<{ readonly id: string; readonly shell: number }>`
        SELECT session_id AS id, issued_by_shell AS shell FROM auth_sessions ORDER BY session_id
      `;
      assert.deepEqual(
        sessions.map((row) => [row.id, row.shell]),
        [
          ["browser", 0],
          ["cli", 1],
          ["paired", 0],
          ["shell", 1],
          ["unknown", 0],
        ],
      );
      const links = yield* sql<{ readonly shell: number }>`
        SELECT issued_by_shell AS shell FROM auth_pairing_links
      `;
      assert.deepEqual(
        links.map((row) => row.shell),
        [0],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("with local sign-in off, only the Owner, Keycloak and the shell get a session", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 157 });
    yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
        ('owner', 'Owner', 1, ${at}), ('ana', 'Ana', 0, ${at})
    `;
    yield* sql`
      INSERT INTO identity_logins (login_id, user_id, issuer, subject, strong, offline,
        created_at, checked_at)
      VALUES ('login', 'ana', 'https://keycloak.test', 'kc-ana', 0, 1, ${at}, ${at})
    `;
    let n = 0;
    const session = (
      userId: string,
      options: { readonly login?: string; readonly shell?: boolean } = {},
    ) => {
      n += 1;
      return sql`
        INSERT INTO auth_sessions (session_id, subject, user_id, method, scopes, issued_at,
          expires_at, identity_login_id, issued_by_shell)
        VALUES (${`s${n}`}, 'user-sign-in', ${userId}, 'browser-session-cookie', '[]',
          ${at}, ${later}, ${options.login ?? null}, ${options.shell === true ? 1 : 0})
      `;
    };
    // On: anyone signs in.
    yield* session("ana");
    yield* sql`
      UPDATE sign_in_settings SET keycloak_enabled = 1, local_sign_in_for_members = 0 WHERE id = 1
    `;
    const refused = yield* session("ana").pipe(Effect.flip);
    assert.equal(refused._tag, "SqlError");
    yield* session("owner");
    yield* session("ana", { login: "login" });
    yield* session("ana", { shell: true });
    // Keycloak off reopens it, whatever the other column says.
    yield* sql`UPDATE sign_in_settings SET keycloak_enabled = 0 WHERE id = 1`;
    yield* session("ana");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

/** How the sign-in settings read before the upgrade; `no-row` deletes the row. */
type Before = "closed" | "open" | "keycloak-off" | "no-row";

/** A Hub at 155 with the Owner, a Member's local, Keycloak and shell sessions, and three links. */
const upgradeFrom = (before: Before) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 155 });
    yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
        ('owner', 'Owner', 1, ${at}), ('ana', 'Ana', 0, ${at})
    `;
    yield* sql`
      INSERT INTO identity_logins (login_id, user_id, issuer, subject, strong, offline,
        created_at, checked_at)
      VALUES ('login', 'ana', 'https://keycloak.test', 'kc-ana', 0, 1, ${at}, ${at})
    `;
    const session = (id: string, userId: string, subject: string, login: string | null = null) =>
      sql`
        INSERT INTO auth_sessions (session_id, subject, user_id, method, scopes, issued_at,
          expires_at, identity_login_id)
        VALUES (${id}, ${subject}, ${userId}, 'browser-session-cookie', '[]', ${at}, ${later},
          ${login})
      `;
    yield* session("ana-local", "ana", "user-sign-in");
    yield* session("ana-app", "ana", "app-sign-in");
    yield* session("ana-keycloak", "ana", "user-sign-in", "login");
    yield* session("ana-shell", "ana", "cli-issued-session");
    yield* session("owner-local", "owner", "user-sign-in");
    const link = (id: string, userId: string, login: string | null = null) => sql`
      INSERT INTO auth_pairing_links (id, credential, method, subject, scopes, user_id,
        created_at, expires_at, identity_login_id)
      VALUES (${id}, ${`CRED-${id}`}, 'one-time-token', 'one-time-token', '[]', ${userId}, ${at},
        ${later}, ${login})
    `;
    yield* link("ana-link", "ana");
    yield* link("ana-keycloak-link", "ana", "login");
    yield* link("owner-link", "owner");
    if (before === "no-row") {
      yield* sql`DELETE FROM sign_in_settings`;
    } else {
      // Ticket 01's guard refuses local off with Keycloak off; the row may still read so.
      yield* sql`
        UPDATE sign_in_settings
        SET keycloak_enabled = ${before === "keycloak-off" ? 0 : 1},
          local_sign_in_for_members = ${before === "open" ? 1 : 0}
        WHERE id = 1
      `;
    }

    yield* runMigrations({ toMigrationInclusive: 157 });

    const sessions = yield* sql<{ readonly id: string }>`
      SELECT session_id AS id FROM auth_sessions WHERE revoked_at IS NOT NULL ORDER BY session_id
    `;
    const links = yield* sql<{ readonly id: string }>`
      SELECT id FROM auth_pairing_links WHERE revoked_at IS NOT NULL ORDER BY id
    `;
    const audit = yield* sql<{ readonly actor: string; readonly detail: string }>`
      SELECT actor_source AS actor, detail_json AS detail FROM audit_log
      WHERE action = 'signIn.settings.update'
    `;
    return {
      revokedSessions: sessions.map((row) => row.id),
      revokedLinks: links.map((row) => row.id),
      audit: audit.map((row) => ({
        actor: row.actor,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      })),
    };
  });

const nothingEnded = { revokedSessions: [], revokedLinks: [], audit: [] };

it.effect("an upgrade with local sign-in already off ends the local sessions and links", () =>
  Effect.gen(function* () {
    const after = yield* upgradeFrom("closed");
    // The Owner's, Keycloak's and the shell's stay.
    assert.deepEqual(after.revokedSessions, ["ana-app", "ana-local"]);
    assert.deepEqual(after.revokedLinks, ["ana-link"]);
    assert.deepEqual(after.audit, [
      {
        actor: "system",
        detail: {
          changed: "localSignInForMembers",
          localSignInForMembers: false,
          localSessionsEnded: 2,
          localPairingLinksEnded: 1,
        },
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("an upgrade with local sign-in on ends nothing", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* upgradeFrom("open"), nothingEnded);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("an upgrade with Keycloak off ends nothing, whatever the other column says", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* upgradeFrom("keycloak-off"), nothingEnded);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("an upgrade with no sign-in settings row ends nothing", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* upgradeFrom("no-row"), nothingEnded);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
