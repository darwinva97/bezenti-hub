import {
  AuditAction,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  bootstrapOwner,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as AuditLog from "./AuditLog.ts";

const threadCreated = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly spaceId: string;
}) => {
  const id = ThreadId.make(input.id);
  const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make(input.projectId),
    title: `work ${input.id}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    spaceId: SpaceId.make(input.spaceId),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`create-${input.id}`),
    type: "thread.created" as const,
    threadId: id,
    providerInstanceId,
    occurredAt: at,
    payload,
  };
};

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new password";
const REDIRECT = "http://localhost:51234/callback";
const CHALLENGE = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";

interface Entry {
  readonly id: number;
  readonly action: string;
  readonly actor: { source: string; userId: string | null; displayName: string | null };
  readonly space: { id: string; name: string | null } | null;
  readonly target: { kind: string; id: string; name: string | null };
  readonly detail: Record<string, unknown>;
}

const auditOf = (server: Server, cookie: string, query = "") =>
  server.request(`/api/installation/audit${query}`, { cookie });

const entriesOf = Effect.fn(function* (server: Server, cookie: string, query = "?limit=200") {
  const listed = yield* auditOf(server, cookie, query);
  assert.equal(listed.status, 200);
  return listed.body.entries as ReadonlyArray<Entry>;
});

/** The Owner with Acme; `join` invites someone into Acme and returns them signed in. */
const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const invite = Effect.fn(function* (spaceId: string, role = "member") {
    const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
      body: { role },
      cookie: owner,
    });
    assert.equal(invitation.status, 200);
    return {
      token: invitation.body.token as string,
      id: (invitation.body.invitation as { id: string }).id,
    };
  });
  const join = Effect.fn(function* (loginName: string) {
    const invitation = yield* invite(acmeId);
    const accepted = yield* server.request("/api/invitations/accept", {
      body: {
        token: invitation.token,
        method: "password",
        displayName: loginName,
        loginName,
        password: PASSWORD,
      },
    });
    assert.equal(accepted.status, 200);
    return {
      cookie: accepted.cookie ?? "",
      userId: UserId.make(accepted.body.userId as string),
      invitationId: invitation.id,
      invitationToken: invitation.token,
    };
  });
  return { server, owner, ownerId, acmeId, organization, invite, join };
});

it.effect(
  "only an active Owner with the access scope reads the audit log, and nobody learns more",
  () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, acmeId, join } = yield* hub;
      const grace = yield* join("grace");

      const read = yield* auditOf(server, owner);
      assert.equal(read.status, 200);
      // A Member is refused alike whatever the filter names, real or not.
      const refusals = yield* Effect.forEach(
        ["", `?spaceId=${acmeId}`, "?spaceId=no-such-space", `?actorUserId=${ownerId}`],
        (query) => auditOf(server, grace.cookie, query),
      );
      for (const refused of refusals) {
        assert.equal(refused.status, 403);
        assert.deepEqual(refused.body, refusals[0]!.body);
        assert.notProperty(refused.body, "entries");
      }
      assert.equal(refusals[0]!.body.message, "Only the Owner reads the audit log.");
      // No session at all.
      assert.equal((yield* server.request("/api/installation/audit")).status, 401);
      // The Owner's own narrowed session (a read-only client, an outside agent) is refused too.
      const narrow = yield* server.environmentAuth.issueSession({
        userId: ownerId,
        scopes: [AuthOrchestrationReadScope],
      });
      const narrowed = yield* server.request("/api/installation/audit", {
        authorization: `Bearer ${narrow.token}`,
      });
      assert.equal(narrowed.status, 403);
      assert.notProperty(narrowed.body, "entries");
      // A malformed filter says so, to the Owner only.
      assert.equal((yield* auditOf(server, owner, "?from=yesterday")).status, 400);
      assert.equal((yield* auditOf(server, grace.cookie, "?from=yesterday")).status, 403);
    }),
);

it.effect(
  "every audited action of identity and access writes exactly one entry naming who, where and what",
  () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, acmeId, organization, invite, join } = yield* hub;
      const grace = yield* join("grace");
      const linus = yield* join("linus");
      const secrets: Array<string> = [
        PASSWORD,
        NEW_PASSWORD,
        grace.invitationToken,
        linus.invitationToken,
      ];
      const guestInvitation = yield* invite(acmeId, "guest");
      secrets.push(guestInvitation.token);
      const revoked = yield* server.request("/api/invitations/revoke", {
        body: { invitationId: guestInvitation.id },
        cookie: owner,
      });
      assert.equal(revoked.status, 200);

      const role = yield* server.request(`/api/spaces/${acmeId}/members/role`, {
        body: { userId: grace.userId, role: "guest" },
        cookie: owner,
      });
      assert.equal(role.status, 200);
      const reset = yield* server.request(`/api/spaces/${acmeId}/members/reset-link`, {
        body: { userId: grace.userId },
        cookie: owner,
      });
      assert.equal(reset.status, 200);
      secrets.push(reset.body.token as string);
      const redeemed = yield* server.request("/api/auth/reset/password", {
        body: { token: reset.body.token, loginName: "grace", password: NEW_PASSWORD },
      });
      assert.equal(redeemed.status, 200);

      const permission = (granted: boolean) =>
        server.request(`/api/installation/users/${linus.userId}/permissions`, {
          body: { permission: "personalSpace.create", granted },
          cookie: owner,
        });
      assert.equal((yield* permission(true)).status, 200);
      assert.equal((yield* permission(false)).status, 200);

      const left = yield* server.request(`/api/spaces/${acmeId}/leave`, {
        body: {},
        cookie: linus.cookie,
      });
      assert.equal(left.status, 200);
      const removed = yield* server.request(`/api/spaces/${acmeId}/members/remove`, {
        body: { userId: grace.userId },
        cookie: owner,
      });
      assert.equal(removed.status, 200);

      const status = (userId: string, next: string) =>
        server.request(`/api/installation/users/${userId}/status`, {
          body: { status: next },
          cookie: owner,
        });
      assert.equal((yield* status(linus.userId, "disabled")).status, 200);
      assert.equal((yield* status(linus.userId, "active")).status, 200);

      // A Project made in the Owner's Personal space, moved into Acme, then deleted for good.
      const view = yield* server.request("/api/spaces", { cookie: owner });
      const personalId = view.body.personalSpaceId as string;
      const mutate = (body: Record<string, unknown>) =>
        server.request("/api/projects/mutate", { cookie: owner, body });
      assert.equal(
        (yield* mutate({
          type: "project.create",
          commandId: "create-app",
          projectId: "app",
          title: "App",
          workspaceRoot: "/work/app",
          spaceId: personalId,
        })).status,
        200,
      );
      assert.equal(
        (yield* mutate({
          type: "project.move",
          commandId: "move-app",
          projectId: "app",
          spaceId: acmeId,
        })).status,
        200,
      );
      // Deleting it destroys its Thread too, which is named on its own.
      yield* server.eventSink.write({
        events: [threadCreated({ id: "app-thread", projectId: "app", spaceId: acmeId })],
      });
      assert.equal(
        (yield* mutate({
          type: "project.delete",
          commandId: "delete-app",
          projectId: "app",
          force: true,
        })).status,
        200,
      );

      const lifecycle = (spaceId: string, step: string) =>
        server.request(`/api/spaces/${spaceId}/${step}`, { body: {}, cookie: owner });
      assert.equal((yield* lifecycle(acmeId, "archive")).status, 200);
      assert.equal((yield* lifecycle(acmeId, "restore")).status, 200);
      // Archiving again what is already archived changes nothing and records nothing.
      const globexId = yield* organization("Globex");
      assert.equal((yield* lifecycle(globexId, "archive")).status, 200);
      assert.equal((yield* lifecycle(globexId, "archive")).status, 200);
      assert.equal((yield* lifecycle(globexId, "delete")).status, 200);

      // Apps and outside MCP clients the Owner approves in this browser.
      const approved = yield* server.request("/api/auth/app-sign-in/approve", {
        body: {
          redirectUri: "http://127.0.0.1:53111/callback",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          state: "state-from-the-app-0123",
          clientLabel: "T3 Code desktop",
        },
        cookie: owner,
      });
      assert.equal(approved.status, 200);
      secrets.push(new URL(String(approved.body.redirectTo)).searchParams.get("code") ?? "");
      const registered = yield* server.request("/oauth/mcp/register", {
        body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
      });
      const authorization = {
        response_type: "code",
        client_id: registered.body.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: "state-1",
      };
      const details = yield* server.request("/oauth/mcp/approval", {
        body: authorization,
        cookie: owner,
      });
      const decision = yield* server.request("/oauth/mcp/decision", {
        cookie: owner,
        body: {
          authorization,
          decision: {
            _tag: "browser-session",
            access: "full-access",
            csrfToken: details.body.csrfToken,
          },
        },
      });
      assert.equal(decision.status, 200);
      secrets.push(details.body.csrfToken as string);

      // The Hub's shell: `t3 auth session issue --user linus` and `t3 auth owner-reset`.
      const bearer = yield* server.environmentAuth.issueSession({
        audited: true,
        userId: linus.userId,
        label: "deploy bot",
        scopes: AuthStandardClientScopes,
      });
      secrets.push(bearer.token);
      const ownerReset = yield* server.environmentAuth.issueOwnerResetLink();
      secrets.push(ownerReset.token);
      // A shell token for its own use, as `t3 project` takes, is not recorded.
      yield* server.environmentAuth.issueSession({ scopes: AuthStandardClientScopes });

      // Removed last: her entries still name her.
      assert.equal((yield* status(grace.userId, "removed")).status, 200);

      const user = (userId: string) => ({ source: "user", userId });
      const cli = { source: "cli", userId: null };
      const expected: ReadonlyArray<{
        readonly action: AuditAction;
        readonly actor: { source: string; userId: string | null };
        readonly spaceId: string | null;
        readonly target: { kind: string; id: string };
      }> = [
        {
          action: "owner.bootstrap",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: ownerId },
        },
        {
          action: "invitation.create",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "invitation", id: grace.invitationId },
        },
        {
          action: "invitation.accept",
          actor: user(grace.userId),
          spaceId: acmeId,
          target: { kind: "invitation", id: grace.invitationId },
        },
        {
          action: "invitation.create",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "invitation", id: linus.invitationId },
        },
        {
          action: "invitation.accept",
          actor: user(linus.userId),
          spaceId: acmeId,
          target: { kind: "invitation", id: linus.invitationId },
        },
        {
          action: "invitation.create",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "invitation", id: guestInvitation.id },
        },
        {
          action: "invitation.revoke",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "invitation", id: guestInvitation.id },
        },
        {
          action: "membership.changeRole",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "user", id: grace.userId },
        },
        {
          action: "membership.resetLink",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "user", id: grace.userId },
        },
        {
          action: "resetLink.redeem",
          actor: user(grace.userId),
          spaceId: null,
          target: { kind: "user", id: grace.userId },
        },
        {
          action: "installationPermission.grant",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "installationPermission.revoke",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "membership.leave",
          actor: user(linus.userId),
          spaceId: acmeId,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "membership.remove",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "user", id: grace.userId },
        },
        {
          action: "user.disable",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "user.enable",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "project.move",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "project", id: "app" },
        },
        {
          action: "thread.delete",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "thread", id: "app-thread" },
        },
        {
          action: "project.delete",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "project", id: "app" },
        },
        {
          action: "organization.archive",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "space", id: acmeId },
        },
        {
          action: "organization.restore",
          actor: user(ownerId),
          spaceId: acmeId,
          target: { kind: "space", id: acmeId },
        },
        {
          action: "organization.archive",
          actor: user(ownerId),
          spaceId: globexId,
          target: { kind: "space", id: globexId },
        },
        {
          action: "organization.delete",
          actor: user(ownerId),
          spaceId: globexId,
          target: { kind: "space", id: globexId },
        },
        {
          action: "appSignIn.approve",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: ownerId },
        },
        {
          action: "mcpClient.approve",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: ownerId },
        },
        {
          action: "cliSession.issue",
          actor: cli,
          spaceId: null,
          target: { kind: "user", id: linus.userId },
        },
        {
          action: "owner.resetLink",
          actor: cli,
          spaceId: null,
          target: { kind: "user", id: ownerId },
        },
        {
          action: "user.remove",
          actor: user(ownerId),
          spaceId: null,
          target: { kind: "user", id: grace.userId },
        },
      ];

      const entries = yield* entriesOf(server, owner);
      // Newest first, and nothing beyond the table.
      assert.deepEqual(
        entries.map((entry) => ({
          action: entry.action,
          actor: { source: entry.actor.source, userId: entry.actor.userId },
          spaceId: entry.space?.id ?? null,
          target: { kind: entry.target.kind, id: entry.target.id },
        })),
        expected.toReversed(),
      );
      // Names resolve: a removed User's, a deleted Organization's, a deleted Project's.
      const named = (action: string) => entries.find((entry) => entry.action === action)!;
      assert.equal(named("invitation.accept").actor.displayName, "linus");
      assert.equal(
        entries.find((entry) => entry.action === "resetLink.redeem")!.actor.displayName,
        "grace",
      );
      assert.equal(named("organization.delete").space?.name, "Globex");
      assert.equal(named("organization.delete").target.name, "Globex");
      assert.equal(named("project.delete").target.name, "App");
      assert.equal(named("user.remove").target.name, "grace");
      assert.deepEqual(named("project.move").detail, { fromSpaceId: personalId });
      assert.deepEqual(named("thread.delete").detail, { via: "project.delete" });
      // A deleted Organization stays a Space to filter by.
      const listed = yield* auditOf(server, owner, "?limit=1");
      assert.deepInclude(listed.body.spaces as ReadonlyArray<unknown>, {
        id: globexId,
        name: "Globex",
        deleted: true,
      });
      assert.deepInclude(listed.body.spaces as ReadonlyArray<unknown>, {
        id: acmeId,
        name: "Acme",
        deleted: false,
      });
      assert.deepEqual(named("membership.changeRole").detail, { from: "member", to: "guest" });

      // No entry carries a credential, under any name.
      const stored = yield* server.sql<{ readonly detail: string }>`
      SELECT detail_json AS detail FROM audit_log
    `;
      const everything = JSON.stringify({ entries, stored });
      for (const secret of secrets) {
        assert.isTrue(secret.length > 0);
        assert.notInclude(everything, secret);
      }
      for (const entry of entries) {
        for (const key of Object.keys(entry.detail)) {
          assert.notMatch(key, /token|password|code|credential|hash|secret/i);
        }
      }

      // Every action in the closed list is recorded by its flow: here, by the orchestrator's
      // tests (audit/AuditedThreadCommands.test.ts) or the Environments tests
      // (environments/EnvironmentJoin.test.ts, HubWithEnvironments*.test.ts), or by a later spec
      // through the hook.
      const recordedElsewhere = [
        "guestLink.create",
        "environment.register",
        "environment.rename",
        "environment.remove",
        "environment.mode.change",
        "thread.move",
        "sandbox.create",
        "sandbox.start",
        "sandbox.stop",
        "sandbox.delete",
        "sandbox.limits.change",
        // environments/HubWithEnvironments.sandboxImage.test.ts
        "sandbox.image.update",
        // vaults/MasterKeyHttp.test.ts (export); `t3 secrets key rotate` (cli/secrets.ts)
        "secret.master_key.export",
        "secret.master_key.rotate",
        // vaults/Vaults.test.ts
        "secret.reveal",
        "secret.edit",
        "vault.create",
        "vault.update",
        "vault.delete",
        // vaults/EffectiveVaults.test.ts (spec 5 ticket 03)
        "vault.allow",
        "vault.choose",
        // ai/AiGateway.test.ts (spec 4 ticket 01)
        "ai_gateway.update",
        "ai_gateway.rollback",
        "ai_gateway.enable",
        // ai/AiAccounts.test.ts (spec 4 ticket 02)
        "ai_account.create",
        "ai_account.update",
        "ai_account.delete",
        "ai_account.allow",
        // ai/AiAccounts.subscriptions.test.ts (spec 4 ticket 03)
        "ai_account.login",
        // ai/AiGatewayRoute.test.ts (spec 4 ticket 04), ai/AiGatewayKeys.localCli.test.ts
        // (ticket 10: local CLI keys, revoked by their User, the Owner or a lost Space)
        "ai_gateway_key.create",
        "ai_gateway_key.revoke",
        // vaults/SecretProviderScopes.test.ts (Vaults ticket 03)
        "secret_provider.create",
        "secret_provider.update",
        "secret_provider.delete",
        "secret_provider.test",
        "provider_scope.create",
        "provider_scope.update",
        "provider_scope.delete",
        "provider_scope.allow",
        // identity/IdentityTokens.test.ts (Vaults ticket 07)
        "identity.issue",
      ];
      assert.sameMembers(
        [...new Set([...expected.map((row) => row.action), ...recordedElsewhere])],
        [...AuditAction.literals],
      );
    }),
);

it.effect("filters by action, actor, Space and date, and pages newest first", () =>
  Effect.gen(function* () {
    const { server, owner, ownerId, acmeId, join } = yield* hub;
    const grace = yield* join("grace");
    yield* TestClock.adjust("1 day");
    yield* join("linus");

    const all = yield* entriesOf(server, owner);
    assert.lengthOf(all, 5);
    const accepted = yield* entriesOf(server, owner, "?action=invitation.accept");
    assert.deepEqual(
      accepted.map((entry) => entry.actor.displayName),
      ["linus", "grace"],
    );
    const byGrace = yield* entriesOf(server, owner, `?actorUserId=${grace.userId}`);
    assert.deepEqual(
      byGrace.map((entry) => entry.action),
      ["invitation.accept"],
    );
    const inAcme = yield* entriesOf(server, owner, `?spaceId=${acmeId}`);
    assert.lengthOf(inAcme, 4);
    assert.isTrue(inAcme.every((entry) => entry.space?.name === "Acme"));
    const byOwner = yield* entriesOf(server, owner, `?actorUserId=${ownerId}&spaceId=${acmeId}`);
    assert.deepEqual(
      byOwner.map((entry) => entry.action),
      ["invitation.create", "invitation.create"],
    );
    // The test clock starts at the epoch; Linus joined a day later.
    const sinceLinus = yield* entriesOf(server, owner, "?from=1970-01-02T00:00:00Z");
    assert.deepEqual(
      sinceLinus.map((entry) => entry.action),
      ["invitation.accept", "invitation.create"],
    );
    assert.lengthOf(yield* entriesOf(server, owner, "?to=1970-01-02T00:00:00Z"), 3);

    const first = yield* auditOf(server, owner, "?limit=2");
    assert.lengthOf(first.body.entries as ReadonlyArray<Entry>, 2);
    const second = yield* auditOf(server, owner, `?limit=2&before=${first.body.nextCursor}`);
    const third = yield* auditOf(server, owner, `?limit=2&before=${second.body.nextCursor}`);
    assert.isNull(third.body.nextCursor);
    assert.deepEqual(
      [first, second, third].flatMap((page) =>
        (page.body.entries as ReadonlyArray<Entry>).map((entry) => entry.id),
      ),
      all.map((entry) => entry.id),
    );
  }),
);

it.effect(
  "a refused or rolled-back action leaves no entry, and an entry that fails takes its action with it",
  () =>
    Effect.gen(function* () {
      const { server, owner, acmeId, organization, join } = yield* hub;
      const grace = yield* join("grace");
      const before = (yield* entriesOf(server, owner)).length;

      // Refused: nothing happened, so nothing is recorded.
      const byMember = yield* server.request(`/api/spaces/${acmeId}/members/role`, {
        body: { userId: grace.userId, role: "admin" },
        cookie: grace.cookie,
      });
      assert.equal(byMember.status, 403);
      assert.equal(
        (yield* server.request(`/api/spaces/${acmeId}/archive`, { body: {}, cookie: grace.cookie }))
          .status,
        403,
      );
      assert.lengthOf(yield* entriesOf(server, owner), before);

      // The deletion fails after its entry was written: the entry rolls back with it.
      const globexId = yield* organization("Globex");
      assert.equal(
        (yield* server.request(`/api/spaces/${globexId}/archive`, { body: {}, cookie: owner }))
          .status,
        200,
      );
      yield* server.sql`
      CREATE TRIGGER test_spaces_undeletable BEFORE DELETE ON spaces
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END
    `;
      const failed = yield* server.request(`/api/spaces/${globexId}/delete`, {
        body: {},
        cookie: owner,
      });
      assert.notEqual(failed.status, 200);
      assert.deepEqual(
        (yield* entriesOf(server, owner, "?action=organization.delete")).map((entry) => entry.id),
        [],
      );
      yield* server.sql`DROP TRIGGER test_spaces_undeletable`;

      // An entry that cannot be written stops its action: Grace keeps her Role.
      yield* server.sql`
      CREATE TRIGGER test_audit_unwritable BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END
    `;
      const unrecorded = yield* server.request(`/api/spaces/${acmeId}/members/role`, {
        body: { userId: grace.userId, role: "guest" },
        cookie: owner,
      });
      assert.notEqual(unrecorded.status, 200);
      const [membership] = yield* server.sql<{ readonly role: string }>`
      SELECT role FROM space_memberships WHERE space_id = ${acmeId} AND user_id = ${grace.userId}
    `;
      assert.equal(membership?.role, "member");
      yield* server.sql`DROP TRIGGER test_audit_unwritable`;

      // The log itself is append-only.
      const count = server.sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM audit_log`;
      const kept = (yield* count)[0]!.count;
      yield* server.sql`DELETE FROM audit_log`.pipe(Effect.flip);
      yield* server.sql`UPDATE audit_log SET action = 'user.enable'`.pipe(Effect.flip);
      assert.equal((yield* count)[0]!.count, kept);
    }),
);

it.effect(
  "later specs record secret and Environment actions through the same log, never a value",
  () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, acmeId } = yield* hub;
      const audit = Context.get(server.services, AuditLog.AuditLog);
      yield* audit.record({
        actor: AuditLog.userActor(ownerId),
        action: "secret.reveal",
        spaceId: acmeId,
        target: { kind: "secret", id: "secret-1", name: "OPENAI_API_KEY" },
        // A caller that slips past the types still cannot store a value.
        detail: {
          vault: "Acme",
          value: "sk-live-123",
          apiToken: "t-1",
          password: "p",
          note: "whatever the caller typed",
        } as {
          vault: string;
        },
      });
      yield* audit.record({
        actor: AuditLog.userActor(ownerId),
        action: "secret.edit",
        spaceId: acmeId,
        target: { kind: "secret", id: "secret-1" },
      });
      yield* audit.record({
        actor: AuditLog.userActor(ownerId),
        action: "environment.register",
        target: { kind: "environment", id: "environment-2", name: "build box" },
      });
      const [registered, edited, revealed] = yield* entriesOf(server, owner, "?limit=3");
      assert.equal(registered!.target.name, "build box");
      assert.equal(edited!.action, "secret.edit");
      assert.deepEqual(revealed!.detail, { vault: "Acme" });
      assert.equal(revealed!.target.name, "OPENAI_API_KEY");
    }),
);

it.effect("the Hub's shell is named as the shell, even before an Owner exists", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    // `t3 auth session issue` on a Hub nobody has claimed yet.
    const early = yield* server.environmentAuth.issueSession({
      audited: true,
      label: "setup script",
      scopes: AuthStandardClientScopes,
    });
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = created.cookie ?? "";
    const ownerId = (created.body.user as { id: string }).id;
    // `t3 project add` and `t3 project remove` against the running server.
    const shell = yield* server.environmentAuth.issueSession({
      subject: CommandActor.SHELL_SESSION_SUBJECT,
      scopes: AuthStandardClientScopes,
    });
    const mutate = (body: Record<string, unknown>) =>
      server.request("/api/projects/mutate", {
        authorization: `Bearer ${shell.token}`,
        body,
      });
    const view = yield* server.request("/api/spaces", { cookie: owner });
    assert.equal(
      (yield* mutate({
        type: "project.create",
        commandId: "create-tool",
        projectId: "tool",
        title: "Tool",
        workspaceRoot: "/work/tool",
        spaceId: view.body.personalSpaceId,
      })).status,
      200,
    );
    assert.equal(
      (yield* mutate({ type: "project.delete", commandId: "delete-tool", projectId: "tool" }))
        .status,
      200,
    );

    const entries = yield* entriesOf(server, owner);
    const issued = entries.find((entry) => entry.action === "cliSession.issue")!;
    assert.deepEqual(issued.actor, { source: "cli", userId: null, displayName: null });
    assert.deepEqual(issued.target, { kind: "session", id: early.sessionId, name: null });
    const removed = entries.find((entry) => entry.action === "project.delete")!;
    assert.deepEqual(removed.actor, {
      source: "cli",
      userId: ownerId,
      displayName: "Ada Lovelace",
    });
  }),
);

it.effect("an MCP pairing code is spent only when its approval is recorded", () =>
  Effect.gen(function* () {
    const { server, join } = yield* hub;
    const grace = yield* join("grace");
    const code = yield* server.request("/api/auth/pairing-token", {
      body: { label: "Claude Code" },
      cookie: grace.cookie,
    });
    const registered = yield* server.request("/oauth/mcp/register", {
      body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
    });
    const authorization = {
      response_type: "code",
      client_id: registered.body.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    };
    const decide = server.request("/oauth/mcp/decision", {
      body: {
        authorization,
        decision: { _tag: "pairing-code", access: "read-only", code: code.body.credential },
      },
    });
    yield* server.sql`
      CREATE TRIGGER test_audit_unwritable BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END
    `;
    const failed = yield* decide;
    assert.notEqual(failed.status, 500);
    assert.notProperty(failed.body, "redirectTo");
    yield* server.sql`DROP TRIGGER test_audit_unwritable`;
    // The same code still works, and the approval names Grace.
    const approved = yield* decide;
    assert.isString(approved.body.redirectTo);
    const [entry] = yield* server.sql<{ readonly actor: string; readonly action: string }>`
      SELECT actor_user_id AS actor, action FROM audit_log WHERE action = 'mcpClient.approve'
    `;
    assert.deepEqual(entry, { actor: grace.userId, action: "mcpClient.approve" });
  }),
);
