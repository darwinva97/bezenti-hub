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
