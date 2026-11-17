import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  type Authenticator,
  bootstrapOwner,
  type CreationOptions,
  joinOrganization,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
  totpCode,
} from "../auth/UserAuth.testkit.ts";

const PASSWORD = "correct horse battery";

/** The Owner (Ada) with an Organization called Acme. */
const ownerWithOrganization = Effect.fn(function* (authenticator?: Authenticator) {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, authenticator ?? (yield* makeAuthenticator()));
  const owner = created.cookie ?? "";
  const acme = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  return { server, owner, acmeId: acme.body.id as string };
});

const invite = Effect.fn(function* (
  server: Server,
  cookie: string,
  spaceId: string,
  role: "admin" | "member" | "guest" = "member",
) {
  const created = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    body: { role },
    cookie,
  });
  return created;
});

const preview = (server: Server, token: string, headers?: Record<string, string>) =>
  server.request("/api/invitations/preview", { body: { token }, ...(headers ? { headers } : {}) });

const acceptWithPassword = (
  server: Server,
  token: string,
  loginName = "grace",
  extra: Record<string, unknown> = {},
) =>
  server.request("/api/invitations/accept", {
    body: {
      token,
      method: "password",
      displayName: "Grace Hopper",
      loginName,
      password: PASSWORD,
      ...extra,
    },
  });

const spacesOf = (server: Server, cookie: string) =>
  server
    .request("/api/spaces", { cookie })
    .pipe(
      Effect.map(
        (response) =>
          response.body.spaces as ReadonlyArray<{ id: string; name: string; role: string | null }>,
      ),
    );

const statuses = (server: Server, cookie: string, spaceId: string) =>
  server
    .request(`/api/spaces/${spaceId}/invitations`, { cookie })
    .pipe(
      Effect.map((response) =>
        (response.body.invitations as ReadonlyArray<{ status: string }>).map((i) => i.status),
      ),
    );

it.effect(
  "the Owner invites; the invitee sees the Organization, creates a password User and lands in it",
  () =>
    Effect.gen(function* () {
      const { server, owner, acmeId } = yield* ownerWithOrganization();
      const created = yield* invite(server, owner, acmeId, "member");
      expect(created.status).toBe(200);
      const token = created.body.token as string;
      expect(created.body.invitation).toMatchObject({ role: "member", status: "pending" });

      const shown = yield* preview(server, token);
      expect(shown.body).toMatchObject({
        status: "valid",
        organizationName: "Acme",
        role: "member",
        inviterName: "Ada Lovelace",
      });

      const accepted = yield* acceptWithPassword(server, token);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ spaceId: acmeId, session: { authenticated: true } });
      const grace = accepted.cookie ?? "";
      // She joins Acme and has her own Personal space from the start, with nothing to grant.
      expect(yield* spacesOf(server, grace)).toEqual([
        expect.objectContaining({ kind: "personal", isOwn: true, canCreateThreads: true }),
        expect.objectContaining({ id: acmeId, name: "Acme", role: "member" }),
      ]);
      // The new User signs in again with what they chose.
      const signIn = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: PASSWORD },
      });
      expect(signIn.body).toMatchObject({ authenticated: true });

      const list = yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: owner });
      expect(list.body.invitations).toEqual([
        expect.objectContaining({
          status: "accepted",
          createdByName: "Ada Lovelace",
          acceptedByName: "Grace Hopper",
        }),
      ]);
      // The link is single use and says nothing more once spent.
      expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
      expect((yield* acceptWithPassword(server, token, "grace2")).status).toBe(403);
    }),
);

it.effect("lets exactly one of two racing accepts through", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId)).body.token as string;

    const results = yield* Effect.all(
      [acceptWithPassword(server, token, "grace"), acceptWithPassword(server, token, "hopper")],
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result.status).toSorted()).toEqual([200, 403]);
    const users = yield* server.sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`;
    expect(users[0]?.n).toBe(2);
  }),
);

it.effect("expires an Invitation after 7 days", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId)).body.token as string;

    yield* TestClock.adjust("6 days");
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid" });
    yield* TestClock.adjust("1 day");
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    const refused = yield* acceptWithPassword(server, token);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain("no longer valid");
    expect(yield* statuses(server, owner, acmeId)).toEqual(["expired"]);
  }),
);

it.effect("refuses a revoked Invitation, and only the Owner lists or revokes them", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const created = yield* invite(server, owner, acmeId);
    const token = created.body.token as string;
    const invitationId = (created.body.invitation as { id: string }).id;
    const member = yield* addMember(server, { id: "member-1", displayName: "Linus" });
    yield* joinOrganization(server, acmeId, "member-1", "member");

    expect((yield* invite(server, member, acmeId)).status).toBe(403);
    expect(
      (yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: member })).status,
    ).toBe(403);
    const memberRevoke = yield* server.request("/api/invitations/revoke", {
      body: { invitationId },
      cookie: member,
    });
    expect(memberRevoke.status).toBe(403);
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid" });

    const revoked = yield* server.request("/api/invitations/revoke", {
      body: { invitationId },
      cookie: owner,
    });
    expect(revoked.body).toMatchObject({ status: "revoked" });
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    expect((yield* acceptWithPassword(server, token)).status).toBe(403);
    expect(yield* statuses(server, owner, acmeId)).toEqual(["revoked"]);
  }),
);

it.effect("refuses Invitations into an archived Organization or a Personal space", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId)).body.token as string;
    const ownerView = yield* server.request("/api/spaces", { cookie: owner });
    expect((yield* invite(server, owner, ownerView.body.personalSpaceId as string)).status).toBe(
      403,
    );

    // Archiving comes with ticket 11; until then the row is what archives it.
    yield* server.sql`UPDATE spaces SET archived_at = '2026-01-02T00:00:00.000Z' WHERE space_id = ${acmeId}`;
    expect((yield* preview(server, token)).body).toEqual({ status: "invalid" });
    expect((yield* acceptWithPassword(server, token)).status).toBe(403);
    expect((yield* invite(server, owner, acmeId)).status).toBe(403);
  }),
);

it.effect("asks an Admin invitee for a passkey or a password with TOTP", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId, "admin")).body.token as string;

    const passwordOnly = yield* acceptWithPassword(server, token);
    expect(passwordOnly.status).toBe(403);
    // The refusal left the link unspent.
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid", role: "admin" });

    const enrollment = yield* server.request("/api/invitations/totp-enrollment", {
      body: { token },
    });
    const { enrollmentId, secret } = enrollment.body as { enrollmentId: string; secret: string };
    const wrongCode = yield* acceptWithPassword(server, token, "grace", {
      totp: { enrollmentId, code: "000000" },
    });
    expect(wrongCode.status).toBe(403);
    const code = yield* totpCode(secret, yield* Clock.currentTimeMillis);
    const accepted = yield* acceptWithPassword(server, token, "grace", {
      totp: { enrollmentId, code },
    });
    expect(accepted.status).toBe(200);
    expect(yield* spacesOf(server, accepted.cookie ?? "")).toContainEqual(
      expect.objectContaining({ id: acmeId, role: "admin" }),
    );

    // The code that confirmed the enrollment does not sign in a second time.
    const signIn = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    const replay = yield* server.request("/api/auth/password/totp", {
      body: { challengeId: signIn.body.challengeId, code },
    });
    expect(replay.status).toBe(401);
  }),
);

it.effect("checks an Admin invitee's code before saying whether a sign-in name is taken", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const grace = yield* addMember(server);
    yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: PASSWORD },
      cookie: grace,
    });
    const token = (yield* invite(server, owner, acmeId, "admin")).body.token as string;
    const enrollment = yield* server.request("/api/invitations/totp-enrollment", {
      body: { token },
    });
    const { enrollmentId } = enrollment.body as { enrollmentId: string };

    const taken = yield* acceptWithPassword(server, token, "grace", {
      totp: { enrollmentId, code: "000000" },
    });
    expect(taken.status).toBe(403);
  }),
);

it.effect("creates a User with a passkey from an Invitation", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId, "admin")).body.token as string;
    const authenticator = yield* makeAuthenticator();

    const ceremony = yield* server.request("/api/invitations/registration", {
      body: { token, displayName: "Grace Hopper" },
    });
    const response = yield* Effect.promise(() =>
      authenticator.create(ceremony.body.options as CreationOptions),
    );
    const accepted = yield* server.request("/api/invitations/accept", {
      body: { token, method: "passkey", ceremonyId: ceremony.body.ceremonyId, response },
    });
    expect(accepted.status).toBe(200);
    expect(yield* spacesOf(server, accepted.cookie ?? "")).toContainEqual(
      expect.objectContaining({ id: acmeId, role: "admin" }),
    );
  }),
);

it.effect("adds the Organization to a signed-in User who accepts", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const grace = yield* addMember(server);
    const token = (yield* invite(server, owner, acmeId, "guest")).body.token as string;

    const joined = yield* server.request("/api/invitations/join", {
      body: { token },
      cookie: grace,
    });
    expect(joined.body).toEqual({ userId: "member-1", spaceId: acmeId });
    expect(yield* spacesOf(server, grace)).toContainEqual(
      expect.objectContaining({ id: acmeId, role: "guest" }),
    );
    // A second link to the same Organization stays unspent for someone else.
    const again = (yield* invite(server, owner, acmeId)).body.token as string;
    const twice = yield* server.request("/api/invitations/join", {
      body: { token: again },
      cookie: grace,
    });
    expect(twice.status).toBe(409);
    expect((yield* preview(server, again)).body).toMatchObject({ status: "valid" });

    // A password-only User cannot become an Admin that way.
    const beta = yield* server.request("/api/spaces/organizations", {
      body: { name: "Beta" },
      cookie: owner,
    });
    yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: PASSWORD },
      cookie: grace,
    });
    const adminToken = (yield* invite(server, owner, beta.body.id as string, "admin")).body
      .token as string;
    const asAdmin = yield* server.request("/api/invitations/join", {
      body: { token: adminToken },
      cookie: grace,
    });
    expect(asAdmin.status).toBe(403);
  }),
);

it.effect("backs off repeated failed accepts of one link", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId, "admin")).body.token as string;
    const enrollment = yield* server.request("/api/invitations/totp-enrollment", {
      body: { token },
    });
    const { enrollmentId, secret } = enrollment.body as { enrollmentId: string; secret: string };
    const withCode = (code: string) =>
      acceptWithPassword(server, token, "grace", {
        totp: { enrollmentId, code },
      });

    for (let failure = 0; failure < 5; failure += 1) {
      expect((yield* withCode("000000")).status).toBe(403);
    }
    expect((yield* withCode(yield* totpCode(secret, yield* Clock.currentTimeMillis))).status).toBe(
      429,
    );
    yield* TestClock.adjust("31 seconds");
    expect((yield* withCode(yield* totpCode(secret, yield* Clock.currentTimeMillis))).status).toBe(
      200,
    );
  }),
);

it.effect("does not let one client behind the proxy lock out invitees elsewhere", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const token = (yield* invite(server, owner, acmeId)).body.token as string;

    // Behind a proxy every request comes from its address; guesses count per forwarded client.
    const guesser = { "x-forwarded-for": "198.51.100.7" };
    for (let failure = 0; failure < 5; failure += 1) {
      expect((yield* preview(server, `guess-${failure}`, guesser)).body).toEqual({
        status: "invalid",
      });
    }
    expect((yield* preview(server, token, guesser)).status).toBe(429);
    expect((yield* preview(server, token)).body).toMatchObject({ status: "valid" });
    expect((yield* acceptWithPassword(server, token)).status).toBe(200);
  }),
);

it.effect("answers a revoke the same whether or not the Invitation exists", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization();
    const created = yield* invite(server, owner, acmeId);
    const invitationId = (created.body.invitation as { id: string }).id;
    const member = yield* addMember(server);

    const real = yield* server.request("/api/invitations/revoke", {
      body: { invitationId },
      cookie: member,
    });
    const missing = yield* server.request("/api/invitations/revoke", {
      body: { invitationId: "no-such-invitation" },
      cookie: member,
    });
    expect(real.status).toBe(403);
    expect(missing).toEqual(real);
  }),
);
