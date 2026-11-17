import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  bootstrapOwner,
  type CreationOptions,
  isSignedIn,
  makeAuthenticator,
  passkeyReauth,
  type RequestOptions,
  type Server,
  serveAuthHttp,
  totpCode,
} from "../auth/UserAuth.testkit.ts";

const PASSWORD = "correct horse battery";

/** The Owner (Ada) with an Organization called Acme. */
const ownerWithOrganization = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const acme = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  return { server, owner, acmeId: acme.body.id as string };
});

/** A User who accepted an Invitation with a password, signed in in one browser. */
const invited = Effect.fn(function* (
  server: Server,
  inviter: string,
  spaceId: string,
  loginName: string,
  role: "member" | "guest" = "member",
) {
  const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    body: { role },
    cookie: inviter,
  });
  expect(invitation.status).toBe(200);
  const accepted = yield* server.request("/api/invitations/accept", {
    body: {
      token: invitation.body.token,
      method: "password",
      displayName: loginName,
      loginName,
      password: PASSWORD,
    },
  });
  expect(accepted.status).toBe(200);
  return { cookie: accepted.cookie ?? "", userId: accepted.body.userId as string, loginName };
});

const roleChange = (
  server: Server,
  cookie: string,
  spaceId: string,
  userId: string,
  role: "admin" | "member" | "guest",
) => server.request(`/api/spaces/${spaceId}/members/role`, { body: { userId, role }, cookie });

const removal = (server: Server, cookie: string, spaceId: string, userId: string) =>
  server.request(`/api/spaces/${spaceId}/members/remove`, { body: { userId }, cookie });

const resetLink = (server: Server, cookie: string, spaceId: string, userId: string) =>
  server.request(`/api/spaces/${spaceId}/members/reset-link`, { body: { userId }, cookie });

const membersOf = (server: Server, cookie: string, spaceId: string) =>
  server
    .request(`/api/spaces/${spaceId}/members`, { cookie })
    .pipe(
      Effect.map((response) =>
        (response.body.members as ReadonlyArray<{ displayName: string; role: string }>).map(
          (member) => `${member.displayName}:${member.role}`,
        ),
      ),
    );

/** Adds an authenticator app from a signed-in session, proving the password first. */
const enrollTotp = Effect.fn(function* (server: Server, cookie: string) {
  const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
    body: {},
    cookie,
  });
  const confirmed = yield* server.request("/api/auth/account/totp", {
    body: {
      enrollmentId: enrollment.body.enrollmentId,
      code: yield* totpCode(enrollment.body.secret as string, yield* Clock.currentTimeMillis),
      reauth: { method: "password", password: PASSWORD },
    },
    cookie,
  });
  expect(confirmed.body).toMatchObject({ totpEnrolled: true });
});

/** A password-only User made Admin by the Owner, who then adds an authenticator app. */
const promotedAdmin = Effect.fn(function* (
  server: Server,
  owner: string,
  spaceId: string,
  member: { readonly cookie: string; readonly userId: string },
) {
  expect((yield* roleChange(server, owner, spaceId, member.userId, "admin")).status).toBe(200);
  yield* enrollTotp(server, member.cookie);
  return member.cookie;
});

it.effect("an Admin invites Members and Guests and manages them, but never an Admin", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const ada = yield* invited(server, owner, acmeId, "ada");
    const hedy = yield* invited(server, owner, acmeId, "hedy");
    const admin = yield* promotedAdmin(server, owner, acmeId, ada);
    yield* promotedAdmin(server, owner, acmeId, hedy);

    const grace = yield* invited(server, admin, acmeId, "grace");
    const linus = yield* invited(server, admin, acmeId, "linus", "guest");
    const asAdmin = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "admin" },
      cookie: admin,
    });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.message).toBe("Only the Owner invites Admins.");
    // Invitations the Owner made for an Admin are not an Admin's to revoke.
    const ownersAdminInvite = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "admin" },
      cookie: owner,
    });
    const revoke = (cookie: string) =>
      server.request("/api/invitations/revoke", {
        body: { invitationId: (ownersAdminInvite.body.invitation as { id: string }).id },
        cookie,
      });
    expect((yield* revoke(admin)).status).toBe(403);
    expect((yield* revoke(owner)).status).toBe(200);
    const listed = yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: admin });
    expect(listed.status).toBe(200);
    expect(
      (yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: grace.cookie })).status,
    ).toBe(403);

    // Another Admin is the Owner's alone.
    expect((yield* roleChange(server, admin, acmeId, hedy.userId, "member")).status).toBe(403);
    expect((yield* removal(server, admin, acmeId, hedy.userId)).status).toBe(403);
    expect((yield* resetLink(server, admin, acmeId, hedy.userId)).status).toBe(403);
    expect((yield* roleChange(server, admin, acmeId, grace.userId, "admin")).status).toBe(403);
    // Members and Guests are the Admin's to change.
    expect((yield* roleChange(server, admin, acmeId, grace.userId, "guest")).status).toBe(200);
    expect((yield* roleChange(server, admin, acmeId, linus.userId, "member")).status).toBe(200);
    expect((yield* removal(server, admin, acmeId, linus.userId)).status).toBe(200);
    // A Member changes nobody.
    expect((yield* roleChange(server, grace.cookie, acmeId, ada.userId, "guest")).status).toBe(403);
    expect(yield* membersOf(server, owner, acmeId)).toEqual([
      "ada:admin",
      "hedy:admin",
      "grace:guest",
    ]);

    // The Owner names and removes Admins, both ways.
    expect((yield* roleChange(server, owner, acmeId, hedy.userId, "member")).status).toBe(200);
    expect((yield* removal(server, owner, acmeId, ada.userId)).status).toBe(200);
    expect(yield* membersOf(server, owner, acmeId)).toEqual(["hedy:member", "grace:guest"]);

    // Someone outside the Organization learns nothing about it, not even that it exists.
    const outsider = yield* server.request("/api/spaces/organizations", {
      body: { name: "Globex" },
      cookie: owner,
    });
    const globexId = outsider.body.id as string;
    const linusInGlobex = yield* invited(server, owner, globexId, "linus2");
    const hidden = yield* server.request(`/api/spaces/${acmeId}/members`, {
      cookie: linusInGlobex.cookie,
    });
    const missing = yield* server.request("/api/spaces/no-such-space/members", {
      cookie: linusInGlobex.cookie,
    });
    expect(hidden.status).toBe(403);
    expect(hidden.body).toEqual(missing.body);
  }),
);

it.effect("a password-only User becomes Admin only once they add an authenticator app", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const grace = yield* invited(server, owner, acmeId, "grace");
    const linus = yield* invited(server, owner, acmeId, "linus");

    const promoted = yield* roleChange(server, owner, acmeId, grace.userId, "admin");
    expect(promoted.body).toMatchObject({
      member: { role: "admin", pendingAdmin: true },
      pendingAdmin: true,
    });
    // Until then she keeps a Member's rights and her session, and her password alone signs in.
    expect(yield* isSignedIn(server, grace.cookie)).toBe(true);
    expect((yield* removal(server, grace.cookie, acmeId, linus.userId)).status).toBe(403);
    const spaces = yield* server.request("/api/spaces", { cookie: grace.cookie });
    expect(spaces.body.spaces).toContainEqual(
      expect.objectContaining({ id: acmeId, role: "member", pendingAdmin: true }),
    );
    // Signing in never sets an app up: a stolen password alone makes no Admin.
    const passwordOnly = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    expect(passwordOnly.status).toBe(200);
    expect(passwordOnly.body).not.toHaveProperty("secondFactor");

    // From her signed-in session, proving her password, she adds the app and is an Admin.
    yield* enrollTotp(server, grace.cookie);
    expect((yield* removal(server, grace.cookie, acmeId, linus.userId)).status).toBe(200);
    const again = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    expect(again.body).toMatchObject({ authenticated: false, secondFactor: "totp" });
  }),
);

it.effect("a User with a passkey is an Admin at once, and their password then needs a code", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const linus = yield* invited(server, owner, acmeId, "linus");
    const invitation = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "member" },
      cookie: owner,
    });
    const token = invitation.body.token as string;
    const authenticator = yield* makeAuthenticator();
    const ceremony = yield* server.request("/api/invitations/registration", {
      body: { token, displayName: "Grace" },
    });
    const accepted = yield* server.request("/api/invitations/accept", {
      body: {
        token,
        method: "passkey",
        ceremonyId: ceremony.body.ceremonyId,
        response: yield* Effect.promise(() =>
          authenticator.create(ceremony.body.options as CreationOptions),
        ),
      },
    });
    const userId = accepted.body.userId as string;
    const withPassword = yield* server.request("/api/auth/account/password", {
      body: {
        loginName: "grace",
        password: PASSWORD,
        reauth: yield* passkeyReauth(server, authenticator),
      },
      cookie: accepted.cookie ?? "",
    });
    expect(withPassword.status).toBe(200);

    const promoted = yield* roleChange(server, owner, acmeId, userId, "admin");
    expect(promoted.body).toMatchObject({ member: { pendingAdmin: false }, pendingAdmin: false });
    // Her sessions may have come from the password alone, so they end; the passkey signs in.
    expect(yield* isSignedIn(server, accepted.cookie)).toBe(false);
    const passwordAlone = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    expect(passwordAlone.status).toBe(403);
    expect(passwordAlone.body.message).toContain("authenticator app");
    const challenge = yield* server.request("/api/auth/passkey/challenge", { body: {} });
    const signedIn = yield* server.request("/api/auth/passkey/sign-in", {
      body: {
        ceremonyId: challenge.body.ceremonyId,
        response: yield* Effect.promise(() =>
          authenticator.get(challenge.body.options as RequestOptions),
        ),
      },
    });
    expect(signedIn.status).toBe(200);
    expect((yield* removal(server, signedIn.cookie ?? "", acmeId, linus.userId)).status).toBe(200);
  }),
);

it.effect("changing someone to the Role they have changes nothing", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const grace = yield* invited(server, owner, acmeId, "grace");
    expect((yield* roleChange(server, owner, acmeId, grace.userId, "member")).status).toBe(200);
    expect(yield* isSignedIn(server, grace.cookie)).toBe(true);
  }),
);

it.effect("removing an Admin revokes the Invitations they made there", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const ada = yield* invited(server, owner, acmeId, "ada");
    const admin = yield* promotedAdmin(server, owner, acmeId, ada);
    const adasInvite = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "member" },
      cookie: admin,
    });
    const ownersInvite = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "guest" },
      cookie: owner,
    });
    expect((yield* removal(server, owner, acmeId, ada.userId)).status).toBe(200);
    const preview = (token: unknown) =>
      server
        .request("/api/invitations/preview", { body: { token } })
        .pipe(Effect.map((response) => response.body.status));
    expect(yield* preview(adasInvite.body.token)).toBe("invalid");
    expect(yield* preview(ownersInvite.body.token)).toBe("valid");
  }),
);

it.effect(
  "leaving or being removed keeps what you made in the Organization; re-invited, you're back",
  () =>
    Effect.gen(function* () {
      const { server, owner, acmeId } = yield* ownerWithOrganization;
      const grace = yield* invited(server, owner, acmeId, "grace");
      const linus = yield* invited(server, owner, acmeId, "linus");
      const created = yield* server.request("/api/projects/mutate", {
        cookie: grace.cookie,
        body: {
          type: "project.create",
          commandId: "create-graces-app",
          projectId: "graces-app",
          title: "Grace's app",
          workspaceRoot: server.newProjectFolder("graces-app"),
          spaceId: acmeId,
        },
      });
      expect(created.status).toBe(200);
      const projectIds = (cookie: string) =>
        server
          .request("/api/projects", { cookie })
          .pipe(
            Effect.map((response) =>
              (response.body.projects as ReadonlyArray<{ id: string }>).map(
                (project) => project.id,
              ),
            ),
          );

      const left = yield* server.request(`/api/spaces/${acmeId}/leave`, {
        body: {},
        cookie: grace.cookie,
      });
      expect(left.status).toBe(200);
      // Out of her only Organization, she still has her Personal space to work in.
      expect((left.body.spaces as ReadonlyArray<{ id: string }>).map((space) => space.id)).toEqual([
        `personal:${grace.userId}`,
      ]);
      expect(yield* projectIds(grace.cookie)).toEqual([]);
      expect(yield* projectIds(linus.cookie)).toEqual(["graces-app"]);
      expect(yield* projectIds(owner)).toEqual(["graces-app"]);
      // Leaving twice, or leaving as the Owner, has nothing to leave.
      expect(
        (yield* server.request(`/api/spaces/${acmeId}/leave`, { body: {}, cookie: grace.cookie }))
          .status,
      ).toBe(403);
      expect(
        (yield* server.request(`/api/spaces/${acmeId}/leave`, { body: {}, cookie: owner })).status,
      ).toBe(403);

      // The way back in is a new Invitation, joined from her existing account.
      const invitation = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
        body: { role: "member" },
        cookie: owner,
      });
      const joined = yield* server.request("/api/invitations/join", {
        body: { token: invitation.body.token },
        cookie: grace.cookie,
      });
      expect(joined.status).toBe(200);
      expect(yield* projectIds(grace.cookie)).toEqual(["graces-app"]);

      expect((yield* removal(server, owner, acmeId, grace.userId)).status).toBe(200);
      expect(yield* projectIds(grace.cookie)).toEqual([]);
      expect(yield* projectIds(linus.cookie)).toEqual(["graces-app"]);
    }),
);

it.effect(
  "only the Owner issues reset links; one works once, expires and resets every way in",
  () =>
    Effect.gen(function* () {
      const { server, owner, acmeId } = yield* ownerWithOrganization;
      const grace = yield* invited(server, owner, acmeId, "grace");
      const ada = yield* invited(server, owner, acmeId, "ada");
      const admin = yield* promotedAdmin(server, owner, acmeId, ada);
      // A reset link takes the account over, so no Admin issues one, nor any Member.
      expect((yield* resetLink(server, admin, acmeId, grace.userId)).status).toBe(403);
      expect((yield* resetLink(server, grace.cookie, acmeId, ada.userId)).status).toBe(403);
      yield* enrollTotp(server, grace.cookie);

      const issued = yield* resetLink(server, owner, acmeId, grace.userId);
      expect(issued.status).toBe(200);
      const token = issued.body.token as string;
      const status = yield* server.request("/api/auth/reset/status", { body: { token } });
      expect(status.body).toEqual({
        status: "valid",
        displayName: "grace",
        loginName: "grace",
        passwordAllowed: true,
      });
      // A password-only Member recovers by setting a new password.
      const redeemed = yield* server.request("/api/auth/reset/password", {
        body: { token, loginName: "grace", password: "a brand new password" },
      });
      expect(redeemed.status).toBe(200);
      const session = yield* server.request("/api/auth/session", { cookie: redeemed.cookie ?? "" });
      expect(session.body).toMatchObject({
        authenticated: true,
        userId: grace.userId,
        isOwner: false,
      });
      // Her old sessions, password and authenticator app all stop working.
      expect(yield* isSignedIn(server, grace.cookie)).toBe(false);
      const oldPassword = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: PASSWORD },
      });
      expect(oldPassword.status).toBe(401);
      const newPassword = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: "a brand new password" },
      });
      expect(newPassword.status).toBe(200);
      expect(newPassword.body).not.toHaveProperty("secondFactor");
      const reused = yield* server.request("/api/auth/reset/password", {
        body: { token, loginName: "grace", password: "yet another password" },
      });
      expect(reused.status).toBe(401);

      // Or with a passkey, which ends her password too.
      const second = (yield* resetLink(server, owner, acmeId, grace.userId)).body.token as string;
      const authenticator = yield* makeAuthenticator();
      const ceremony = yield* server.request("/api/auth/reset/registration", {
        body: { token: second },
      });
      const withPasskey = yield* server.request("/api/auth/reset", {
        body: {
          token: second,
          ceremonyId: ceremony.body.ceremonyId,
          response: yield* Effect.promise(() =>
            authenticator.create(ceremony.body.options as CreationOptions),
          ),
        },
      });
      expect(withPasskey.status).toBe(200);
      const afterPasskey = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: "a brand new password" },
      });
      expect(afterPasskey.status).toBe(401);

      const expiring = yield* resetLink(server, owner, acmeId, grace.userId);
      yield* TestClock.adjust("61 minutes");
      const expired = yield* server.request("/api/auth/reset/status", {
        body: { token: expiring.body.token },
      });
      expect(expired.body).toEqual({ status: "invalid" });
    }),
);
