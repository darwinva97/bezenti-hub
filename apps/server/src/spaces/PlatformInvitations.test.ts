/**
 * Platform invitations (Keycloak sign-in spec, ticket 04): the Owner's hand-made User, without a
 * Space. Created, listed and revoked by the Owner alone; accepted once, within 7 days, here with
 * local credentials (through Keycloak in KeycloakSignIn.test.ts); never seen by an Organization.
 */
import { UserId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";

const PASSWORD = "correct horse battery";
const PLATFORM = "/api/installation/invitations";

/** The Owner (Ada) with an Organization called Acme, an Admin of it and a Member. */
const hub = Effect.fn(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = (created.body.user as { id: string }).id;
  const acme = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  const acmeId = acme.body.id as string;
  const admin = yield* addMember(server, { id: "admin-1", displayName: "Linus" });
  yield* joinOrganization(server, acmeId, "admin-1", "admin");
  const member = yield* addMember(server, { id: "member-1", displayName: "Margaret" });
  yield* joinOrganization(server, acmeId, "member-1", "member");
  return { server, owner, ownerId, acmeId, admin, member };
});

const createPlatform = Effect.fn(function* (server: Server, cookie: string) {
  const created = yield* server.request(PLATFORM, { body: {}, cookie });
  assert.equal(created.status, 200, created.text);
  return {
    token: created.body.token as string,
    invitationId: (created.body.invitation as { id: string }).id,
    invitation: created.body.invitation as Record<string, unknown>,
  };
});

const listPlatform = (server: Server, cookie: string) =>
  server
    .request(PLATFORM, { cookie })
    .pipe(
      Effect.map(
        (answer) => answer.body.invitations as ReadonlyArray<{ id: string; status: string }>,
      ),
    );

const preview = (server: Server, token: string) =>
  server.request("/api/invitations/preview", { body: { token } });

const acceptWithPassword = (server: Server, token: string, loginName = "grace") =>
  server.request("/api/invitations/accept", {
    body: { token, method: "password", displayName: "Grace Hopper", loginName, password: PASSWORD },
  });

const revoke = (server: Server, cookie: string, invitationId: string) =>
  server.request("/api/invitations/revoke", { body: { invitationId }, cookie });

const acceptedAt = (server: Server, invitationId: string) =>
  server.sql<{ acceptedAt: string | null }>`
    SELECT accepted_at AS "acceptedAt" FROM space_invitations WHERE invitation_id = ${invitationId}
  `.pipe(Effect.map((rows) => rows[0]?.acceptedAt));

interface AuditRow {
  readonly space: unknown;
  readonly actor: { readonly userId: string | null };
  readonly target: { readonly kind: string; readonly id: string };
  readonly detail: Record<string, unknown>;
}

const auditOf = (server: Server, owner: string, action: string) =>
  server
    .request(`/api/installation/audit?action=${action}`, { cookie: owner })
    .pipe(Effect.map((answer) => answer.body.entries as ReadonlyArray<AuditRow>));

it.effect("the Owner creates and lists Platform invitations; an Organization never sees one", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* hub();
    const created = yield* createPlatform(server, owner);
    expect(created.invitation).toMatchObject({
      kind: "platform",
      status: "pending",
      createdByName: "Ada Lovelace",
    });
    expect(created.invitation).not.toHaveProperty("spaceId");
    expect(created.invitation).not.toHaveProperty("role");
    const orgLink = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "member" },
      cookie: owner,
    });

    // The platform list has only the Platform invitation, the Organization's only its own.
    expect((yield* listPlatform(server, owner)).map((i) => i.id)).toEqual([created.invitationId]);
    const orgList = yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: owner });
    expect(
      (orgList.body.invitations as ReadonlyArray<{ id: string }>).map(
        (invitation) => invitation.id,
      ),
    ).toEqual([(orgLink.body.invitation as { id: string }).id]);

    // The invitee is told it is an invitation to the Hub, with no Organization and no Role.
    expect((yield* preview(server, created.token)).body).toEqual({
      status: "valid",
      kind: "platform",
      inviterName: "Ada Lovelace",
      expiresAt: created.invitation.expiresAt,
    });

    const audit = yield* auditOf(server, owner, "invitation.create");
    const platformEntry = audit.find((entry) => entry.target.id === created.invitationId);
    expect(platformEntry).toMatchObject({ space: null, detail: { platform: true } });
  }),
);

it.effect("anyone but the Owner gets the same 403, and the Owner needs the access scope", () =>
  Effect.gen(function* () {
    const { server, owner, ownerId, admin, member } = yield* hub();
    const created = yield* createPlatform(server, owner);
    for (const [who, cookie] of [
      ["an Admin", admin],
      ["a Member", member],
    ] as const) {
      const listed = yield* server.request(PLATFORM, { cookie });
      const made = yield* server.request(PLATFORM, { body: {}, cookie });
      assert.equal(listed.status, 403, who);
      assert.equal(made.status, 403, who);
      assert.deepEqual(made.body, listed.body, who);
      // Revoking answers as for an Invitation that does not exist.
      const revoked = yield* revoke(server, cookie, created.invitationId);
      const missing = yield* revoke(server, cookie, "no-such-invitation");
      assert.equal(revoked.status, 403, who);
      assert.deepEqual(revoked, missing, who);
    }
    assert.equal((yield* listPlatform(server, owner)).length, 1);
    assert.isNull(yield* acceptedAt(server, created.invitationId));

    // A session of the Owner's that only reads: it lists, and neither creates nor revokes.
    const readOnly = yield* server.environmentAuth.issueSession({
      userId: UserId.make(ownerId),
      scopes: ["access:read"],
    });
    const authorization = `Bearer ${readOnly.token}`;
    assert.equal((yield* server.request(PLATFORM, { authorization })).status, 200);
    const refused = yield* server.request(PLATFORM, { authorization, body: {} });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "insufficient_scope");
    const revokeRefused = yield* server.request("/api/invitations/revoke", {
      authorization,
      body: { invitationId: created.invitationId },
    });
    assert.equal(revokeRefused.status, 403);
    assert.equal((yield* listPlatform(server, owner))[0]?.status, "pending");
    // Without a session at all.
    assert.equal((yield* server.request(PLATFORM, {})).status, 401);
  }),
);

it.effect("local credentials accept it once: a User without any Organization", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hub();
    const { token, invitationId } = yield* createPlatform(server, owner);

    const accepted = yield* acceptWithPassword(server, token);
    assert.equal(accepted.status, 200, accepted.text);
    expect(accepted.body).toMatchObject({ spaceId: null, session: { authenticated: true } });
    const userId = accepted.body.userId as string;
    const memberships = yield* server.sql`
      SELECT space_id FROM space_memberships WHERE user_id = ${userId}
    `;
    assert.deepEqual(memberships, []);
    // Nothing on this path makes anyone an Admin, nor needs a second factor.
    const spaces = yield* server.request("/api/spaces", { cookie: accepted.cookie ?? "" });
    expect(spaces.body.spaces).toEqual([expect.objectContaining({ kind: "personal" })]);

    // Single use.
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    assert.equal((yield* acceptWithPassword(server, token, "grace2")).status, 403);
    assert.isString(yield* acceptedAt(server, invitationId));
    expect(yield* listPlatform(server, owner)).toEqual([]);

    const audit = yield* auditOf(server, owner, "invitation.accept");
    assert.equal(audit.length, 1);
    expect(audit[0]).toMatchObject({
      space: null,
      actor: { userId },
      target: { kind: "invitation", id: invitationId },
      detail: { platform: true, newUser: true },
    });
  }),
);

it.effect("lets exactly one of two racing accepts through", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hub();
    const { token } = yield* createPlatform(server, owner);
    const before = yield* server.sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`;
    const results = yield* Effect.all(
      [acceptWithPassword(server, token, "grace"), acceptWithPassword(server, token, "hopper")],
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result.status).toSorted()).toEqual([200, 403]);
    const after = yield* server.sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`;
    assert.equal(after[0]?.n, (before[0]?.n ?? 0) + 1);
  }),
);

it.effect("a signed-in User already has an account: 409, and the link stays for someone else", () =>
  Effect.gen(function* () {
    const { server, owner, member } = yield* hub();
    const { token, invitationId } = yield* createPlatform(server, owner);
    const joined = yield* server.request("/api/invitations/join", {
      body: { token },
      cookie: member,
    });
    assert.equal(joined.status, 409);
    assert.include(joined.body.message as string, "already have an account");
    const ownerJoined = yield* server.request("/api/invitations/join", {
      body: { token },
      cookie: owner,
    });
    assert.equal(ownerJoined.status, 409);
    assert.isNull(yield* acceptedAt(server, invitationId));
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid" });
    assert.equal((yield* acceptWithPassword(server, token)).status, 200);
  }),
);

it.effect("expires after 7 days", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hub();
    const { token } = yield* createPlatform(server, owner);
    yield* TestClock.adjust("6 days");
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid" });
    expect((yield* listPlatform(server, owner)).map((i) => i.status)).toEqual(["pending"]);
    yield* TestClock.adjust("1 day");
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    const refused = yield* acceptWithPassword(server, token);
    assert.equal(refused.status, 403);
    assert.include(refused.body.message as string, "no longer valid");
    // Only pending ones are listed; the audit log keeps the rest.
    expect(yield* listPlatform(server, owner)).toEqual([]);
  }),
);

it.effect("the Owner revokes one: it is no longer valid, audited without a Space", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hub();
    const { token, invitationId } = yield* createPlatform(server, owner);
    const revoked = yield* revoke(server, owner, invitationId);
    assert.equal(revoked.status, 200, revoked.text);
    expect(revoked.body).toMatchObject({ id: invitationId, kind: "platform", status: "revoked" });
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    assert.equal((yield* acceptWithPassword(server, token)).status, 403);
    expect(yield* listPlatform(server, owner)).toEqual([]);
    // Twice is refused.
    assert.equal((yield* revoke(server, owner, invitationId)).status, 403);

    const audit = yield* auditOf(server, owner, "invitation.revoke");
    assert.equal(audit.length, 1);
    expect(audit[0]).toMatchObject({
      space: null,
      target: { kind: "invitation", id: invitationId },
      detail: { platform: true },
    });
  }),
);
