import { AuthSessionId, UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as InactiveUserTurns from "../orchestration-v2/InactiveUserTurns.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  bootstrapOwner,
  isSignedIn,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
  totpCode,
} from "../auth/UserAuth.testkit.ts";
import { connectionEnds } from "../ws.ts";

const PASSWORD = "correct horse battery";

/** The Owner with Acme, where Grace and Linus are Members who joined by Invitation. */
const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const acme = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  const acmeId = acme.body.id as string;
  const member = Effect.fn(function* (loginName: string) {
    const invitation = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "member" },
      cookie: owner,
    });
    const accepted = yield* server.request("/api/invitations/accept", {
      body: {
        token: invitation.body.token,
        method: "password",
        displayName: loginName,
        loginName,
        password: PASSWORD,
      },
    });
    assert.equal(accepted.status, 200);
    return { cookie: accepted.cookie ?? "", userId: UserId.make(accepted.body.userId as string) };
  });
  const grace = yield* member("grace");
  const linus = yield* member("linus");
  return { server, owner, ownerId, acmeId, grace, linus };
});

const setStatus = (server: Server, cookie: string, userId: string, status: string) =>
  server.request(`/api/installation/users/${userId}/status`, { body: { status }, cookie });

const signIn = (server: Server, loginName: string) =>
  server.request("/api/auth/password/sign-in", { body: { loginName, password: PASSWORD } });

/** Completes when the production socket of this session would close. */
const socketEnds = Effect.fn(function* (server: Server, sessionId: AuthSessionId, userId: UserId) {
  const ends = yield* connectionEnds({
    sessionId,
    subject: "user-sign-in",
    userId,
    method: "browser-session-cookie",
    scopes: [],
  }).pipe(Effect.provide(Layer.succeedContext(server.services)));
  return yield* Effect.forkScoped(ends);
});

const mcpUser = (server: Server, token: string) =>
  Context.get(server.services, McpHttpServer.McpClientAuthenticator)
    .authenticate(
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }),
      ),
    )
    .pipe(Effect.map((scope) => (scope === undefined ? "refused" : scope.userId)));

const liveSessions = (server: Server, userId: UserId) =>
  server.sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ${userId} AND revoked_at IS NULL
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

it.effect(
  "disabling a User ends every session and link of theirs at once; re-enabling lets them sign in again",
  () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, grace, linus } = yield* hub;
      const [browser] = yield* server.sql<{ sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
        WHERE user_id = ${grace.userId} AND revoked_at IS NULL LIMIT 1
      `;
      const socket = yield* socketEnds(
        server,
        AuthSessionId.make(browser!.sessionId),
        grace.userId,
      );
      const linusSocket = yield* socketEnds(
        server,
        AuthSessionId.make(
          (yield* server.sql<{ sessionId: string }>`
            SELECT session_id AS "sessionId" FROM auth_sessions WHERE user_id = ${linus.userId} LIMIT 1
          `)[0]!.sessionId,
        ),
        linus.userId,
      );
      // `t3 ... --user grace`: a bearer for scripts and an outside MCP client acting as Grace.
      const bearer = yield* server.environmentAuth.issueSession({ userId: grace.userId });
      const mcp = yield* server.environmentAuth.issueMcpClientSession({
        label: "Claude Code",
        userId: grace.userId,
        access: "full-access",
        client: { deviceType: "bot", ipAddress: "127.0.0.1" },
      });
      assert.equal(yield* mcpUser(server, mcp.token), grace.userId);
      // Links still waiting: a pairing code she made and a reset link the Owner gave her.
      const pairing = yield* server.request("/api/auth/pairing-token", {
        body: {},
        cookie: grace.cookie,
      });
      const [membership] = yield* server.sql<{ spaceId: string }>`
        SELECT space_id AS "spaceId" FROM space_memberships WHERE user_id = ${grace.userId}
      `;
      const reset = yield* server.request(`/api/spaces/${membership!.spaceId}/members/reset-link`, {
        body: { userId: grace.userId },
        cookie: owner,
      });
      assert.equal(reset.status, 200);

      // Only the Owner disables, and nobody disables the Owner.
      const byMember = yield* setStatus(server, linus.cookie, grace.userId, "disabled");
      assert.equal(byMember.status, 403);
      assert.equal(byMember.body.message, "Only the Owner disables or removes Users.");
      const ownerSelf = yield* setStatus(server, owner, ownerId, "disabled");
      assert.equal(ownerSelf.status, 403);
      assert.equal(ownerSelf.body.message, "The Owner can't be disabled or removed.");

      const disabled = yield* setStatus(server, owner, grace.userId, "disabled");
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.status, "disabled");
      // Her open socket closes; Linus's stays open.
      yield* Fiber.join(socket);
      assert.isUndefined(linusSocket.pollUnsafe());
      assert.equal(yield* liveSessions(server, grace.userId), 0);
      assert.isFalse(yield* isSignedIn(server, grace.cookie));
      const bearerSession = yield* server.request("/api/auth/session", {
        authorization: `Bearer ${bearer.token}`,
      });
      assert.notEqual(bearerSession.body.authenticated, true);
      assert.equal(yield* mcpUser(server, mcp.token), "refused");
      const redeemed = yield* server.request("/api/auth/browser-session", {
        body: { credential: pairing.body.credential },
      });
      assert.equal(redeemed.status, 401);
      const resetStatus = yield* server.request("/api/auth/reset/status", {
        body: { token: reset.body.token },
      });
      assert.notEqual(resetStatus.body.status, "valid");
      // No new session either: sign-in says why, and no token is issued for her.
      const refused = yield* signIn(server, "grace");
      assert.equal(refused.status, 403);
      assert.equal(
        refused.body.message,
        "The Owner disabled this account. Ask them to turn it back on.",
      );
      const token = yield* server.environmentAuth
        .issueSession({ userId: grace.userId })
        .pipe(Effect.flip);
      assert.equal(token._tag, "ServerAuthInvalidCredentialError");
      // A wrong password still says nothing about the account.
      const wrong = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: "not her password" },
      });
      assert.equal(wrong.status, 401);
      // Her Memberships stay for when she comes back.
      const users = yield* server.request("/api/installation/users", { cookie: owner });
      assert.deepInclude(users.body.users as ReadonlyArray<unknown>, {
        id: grace.userId,
        displayName: "grace",
        loginName: "grace",
        isOwner: false,
        status: "disabled",
        installationPermissions: [],
      });

      const enabled = yield* setStatus(server, owner, grace.userId, "active");
      assert.equal(enabled.status, 200);
      assert.equal(enabled.body.status, "active");
      const back = yield* signIn(server, "grace");
      assert.equal(back.status, 200);
      assert.isTrue(yield* isSignedIn(server, back.cookie));
      // Old sessions stay ended.
      assert.isFalse(yield* isSignedIn(server, grace.cookie));
      const spaces = yield* server.request("/api/spaces", { cookie: back.cookie ?? "" });
      assert.include(
        (spaces.body.spaces as ReadonlyArray<{ id: string }>).map((space) => space.id),
        membership!.spaceId,
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "removing a User ends their Memberships and hands their Personal space, frozen, to the Owner",
  () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, acmeId, grace, linus } = yield* hub;
      const granted = yield* server.request(`/api/installation/users/${grace.userId}/permissions`, {
        cookie: owner,
        body: { permission: "environments.registerOwn", granted: true },
      });
      assert.equal(granted.status, 200);
      const project = (cookie: string, id: string, type = "project.create") =>
        server.request("/api/projects/mutate", {
          cookie,
          body: {
            type,
            commandId: `${type}-${id}`,
            projectId: id,
            title: id,
            workspaceRoot: server.newProjectFolder(id),
            ...(type === "project.update" ? { archived: true } : {}),
          },
        });
      assert.equal((yield* project(grace.cookie, "notes")).status, 200);
      assert.equal((yield* project(grace.cookie, "drafts")).status, 200);
      const [browser] = yield* server.sql<{ sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
        WHERE user_id = ${grace.userId} AND revoked_at IS NULL LIMIT 1
      `;
      const socket = yield* socketEnds(
        server,
        AuthSessionId.make(browser!.sessionId),
        grace.userId,
      );

      assert.equal((yield* setStatus(server, linus.cookie, grace.userId, "removed")).status, 403);
      assert.equal((yield* setStatus(server, owner, ownerId, "removed")).status, 403);
      const removed = yield* setStatus(server, owner, grace.userId, "removed");
      assert.equal(removed.status, 200);
      assert.equal(removed.body.status, "removed");
      yield* Fiber.join(socket);
      assert.isFalse(yield* isSignedIn(server, grace.cookie));
      const refused = yield* signIn(server, "grace");
      assert.equal(refused.status, 403);
      assert.equal(refused.body.message, "This account was removed from this Hub.");

      // Her Memberships end; Acme keeps what she made and no longer lists her.
      const members = yield* server.request(`/api/spaces/${acmeId}/members`, { cookie: owner });
      assert.notInclude(
        (members.body.members as ReadonlyArray<{ userId: string }>).map((row) => row.userId),
        grace.userId,
      );
      assert.equal(
        (yield* server.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM space_memberships WHERE user_id = ${grace.userId}
        `)[0]?.count,
        0,
      );

      // Her Personal space is the Owner's alone to read, frozen.
      const personal = `personal:${grace.userId}`;
      const ownerSpaces = yield* server.request("/api/spaces", { cookie: owner });
      assert.deepInclude(ownerSpaces.body.spaces as ReadonlyArray<unknown>, {
        id: personal,
        kind: "personal",
        name: "grace (removed)",
        role: null,
        isOwn: false,
        canCreateThreads: false,
        canInvite: false,
        frozen: true,
        canMoveProjectsOut: true,
        canMoveProjectsIn: false,
      });
      const projectIds = (cookie: string) =>
        server
          .request("/api/projects", { cookie })
          .pipe(
            Effect.map((response) =>
              (response.body.projects as ReadonlyArray<{ id: string }>).map((row) => row.id),
            ),
          );
      assert.include(yield* projectIds(owner), "notes");
      assert.notInclude(yield* projectIds(linus.cookie), "notes");
      // The Owner may move what is in it into an Organization.
      const moved = yield* server.request("/api/projects/mutate", {
        cookie: owner,
        body: {
          type: "project.move",
          commandId: "move-drafts",
          projectId: "drafts",
          spaceId: acmeId,
        },
      });
      assert.equal(moved.status, 200);
      assert.include(yield* projectIds(linus.cookie), "drafts");
      // Otherwise read-only, even for the Owner, who may only delete what is in it.
      assert.equal((yield* project(owner, "notes", "project.update")).status, 403);
      const deleted = yield* server.request("/api/projects/mutate", {
        cookie: owner,
        body: { type: "project.delete", commandId: "delete-notes", projectId: "notes" },
      });
      assert.equal(deleted.status, 200);
      assert.notInclude(yield* projectIds(owner), "notes");

      // Removal is for good, and her name still resolves for what she did.
      const again = yield* setStatus(server, owner, grace.userId, "active");
      assert.equal(again.status, 403);
      assert.equal(again.body.message, "A removed User stays removed.");
      const users = yield* server.request("/api/installation/users", { cookie: owner });
      assert.deepInclude(users.body.users as ReadonlyArray<unknown>, {
        id: grace.userId,
        displayName: "grace",
        loginName: "grace",
        isOwner: false,
        status: "removed",
        installationPermissions: ["environments.registerOwn"],
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "a disabled User's leftover session is refused, and disabling again revokes it for good",
  () =>
    Effect.gen(function* () {
      const { server, owner, grace } = yield* hub;
      assert.equal((yield* setStatus(server, owner, grace.userId, "disabled")).status, 200);
      // As if the revocation after the status change had not happened.
      yield* server.sql`UPDATE auth_sessions SET revoked_at = NULL WHERE user_id = ${grace.userId}`;
      assert.isFalse(yield* isSignedIn(server, grace.cookie));
      const again = yield* setStatus(server, owner, grace.userId, "disabled");
      assert.equal(again.status, 200);
      assert.equal(yield* liveSessions(server, grace.userId), 0);
    }).pipe(Effect.scoped),
);

it.effect("a disabled User's recovery code says why and stays unspent", () =>
  Effect.gen(function* () {
    const { server, owner, grace } = yield* hub;
    const code = "ABCDEFGHJK";
    // SHA-256 of the code, as the server stores it.
    const hash = "f57cbf1e3e471b25db4b8ad0844df41b2dae9c7d1944944d128e49294d412f66";
    yield* server.sql`
      INSERT INTO user_recovery_codes (code_hash, user_id, created_at)
      VALUES (${hash}, ${grace.userId}, '2026-01-01T00:00:00.000Z')
    `;
    assert.equal((yield* setStatus(server, owner, grace.userId, "disabled")).status, 200);
    const refused = yield* server.request("/api/auth/recovery-code/sign-in", { body: { code } });
    assert.equal(refused.status, 403);
    assert.equal(
      refused.body.message,
      "The Owner disabled this account. Ask them to turn it back on.",
    );
    const [row] = yield* server.sql<{ usedAt: string | null }>`
      SELECT used_at AS "usedAt" FROM user_recovery_codes WHERE code_hash = ${hash}
    `;
    assert.isNull(row!.usedAt);
  }).pipe(Effect.scoped),
);

it.effect("disabled between the password and the code step, sign-in says why", () =>
  Effect.gen(function* () {
    const { server, owner, grace } = yield* hub;
    const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
      body: {},
      cookie: grace.cookie,
    });
    const secret = enrollment.body.secret as string;
    const confirmed = yield* server.request("/api/auth/account/totp", {
      body: {
        enrollmentId: enrollment.body.enrollmentId,
        code: yield* totpCode(secret, yield* Clock.currentTimeMillis),
        reauth: { method: "password", password: PASSWORD },
      },
      cookie: grace.cookie,
    });
    assert.equal(confirmed.status, 200);
    const step = yield* signIn(server, "grace");
    assert.equal(step.body.secondFactor, "totp");
    assert.equal((yield* setStatus(server, owner, grace.userId, "disabled")).status, 200);
    yield* TestClock.adjust("30 seconds");
    const refused = yield* server.request("/api/auth/password/totp", {
      body: {
        challengeId: step.body.challengeId,
        code: yield* totpCode(secret, yield* Clock.currentTimeMillis),
      },
    });
    assert.equal(refused.status, 403);
    assert.equal(
      refused.body.message,
      "The Owner disabled this account. Ask them to turn it back on.",
    );
  }).pipe(Effect.scoped),
);

it.effect("disabling a User stops their running turns, and only theirs", () =>
  Effect.gen(function* () {
    const { server, owner, grace, linus } = yield* hub;
    const at = "2026-11-01T00:00:00.000Z";
    for (const [threadId, ownerUserId, status] of [
      ["grace-running", grace.userId, "running"],
      ["grace-done", grace.userId, "completed"],
      ["linus-running", linus.userId, "running"],
    ] as const) {
      yield* server.sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json, owner_user_id
        ) VALUES (
          ${threadId}, 'acme-app', ${threadId}, 'codex', 'full-access', 'default', ${at}, ${at},
          ${JSON.stringify({ lineage: { rootThreadId: threadId } })}, ${ownerUserId}
        )
      `;
      yield* server.sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        ) VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${status}, ${at}, '{}')
      `;
    }
    const stopped = yield* Queue.unbounded<string>();
    yield* Layer.build(
      InactiveUserTurns.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            interruptThread: (input) =>
              Queue.offer(stopped, input.threadId).pipe(Effect.as({ type: "no_active_run" })),
          }),
        ),
        Layer.provide(Layer.succeedContext(server.services)),
      ),
    );
    assert.equal((yield* setStatus(server, owner, grace.userId, "disabled")).status, 200);
    assert.equal(yield* Queue.take(stopped), "grace-running");
    assert.equal(yield* Queue.size(stopped), 0);
  }).pipe(Effect.scoped),
);
