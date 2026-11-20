/**
 * Ticket 08 at the server's edge (real HTTP doors, SQLite in memory, a fake realm): local sign-in
 * off for everyone but the Owner, the sessions it ends (not the shell's), a reset link that binds
 * a Keycloak account, and turning Keycloak off.
 */
import { UserId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { type FakeKeycloak, type FakeSignIn, makeFakeKeycloak } from "./Keycloak.testkit.ts";
import * as UserDirectory from "./UserDirectory.ts";
import {
  addMember,
  type Authenticator,
  bootstrapOwner,
  type CreationOptions,
  isSignedIn,
  makeAuthenticator,
  passkeyReauth,
  type Server,
  serveAuthHttpWith,
  totpCode,
} from "./UserAuth.testkit.ts";

const START = "/api/auth/keycloak/start";
const SETTINGS = "/api/installation/sign-in-settings";
const PASSWORD = "correct horse battery staple";

/** The Owner's Hub with Keycloak on over the fake realm; local sign-in still on. */
const hub = Effect.gen(function* () {
  const realm = yield* makeFakeKeycloak();
  const server = yield* serveAuthHttpWith({ signIn: { keycloakHttp: realm.layer } });
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const on = yield* server.request(SETTINGS, {
    cookie: owner,
    body: {
      keycloakEnabled: true,
      issuer: realm.issuer,
      clientId: realm.clientId,
      clientSecret: realm.clientSecret,
    },
  });
  assert.equal(on.status, 200, on.text);
  const ownerId = (yield* server.request("/api/auth/session", { cookie: owner })).body
    .userId as string;
  return { realm, server, owner, ownerId, authenticator };
});

const flowCookieOf = (setCookies: ReadonlyArray<string>) =>
  setCookies.find((cookie) => /^(__Host-)?t3_keycloak_flow=[^;]/.test(cookie))?.split(";", 1)[0];

const joinCookies = (...cookies: ReadonlyArray<string | undefined>) =>
  cookies.filter((cookie) => cookie !== undefined && cookie !== "").join("; ");

/** A whole round: start, sign in at the realm as `as`, come back with the flow cookie. */
const roundTrip = Effect.fn(function* (
  server: Server,
  realm: FakeKeycloak,
  as: FakeSignIn,
  body: Record<string, unknown> = { intent: "sign-in" },
  sessionCookie?: string,
) {
  const started = yield* server.request(START, {
    body,
    ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }),
  });
  assert.equal(started.status, 200, started.text);
  const back = yield* realm.signIn(started.body.authorizationUrl as string, as);
  const parsed = new URL(back);
  return yield* server.request(`${parsed.pathname}${parsed.search}`, {
    cookie: joinCookies(flowCookieOf(started.setCookies), sessionCookie),
    omitOrigin: true,
  });
});

/** A User besides the Owner, signed in with a password of their own (`id` is the name too). */
const memberWithPassword = Effect.fn(function* (server: Server, id: string) {
  const cookie = yield* addMember(server, { id, displayName: `Member ${id}` });
  const saved = yield* server.request("/api/auth/account/password", {
    cookie,
    body: { loginName: id, password: PASSWORD },
  });
  assert.equal(saved.status, 200, saved.text);
  return { id, cookie };
});

/** A User besides the Owner who signs in only with Keycloak as `sub` (linked, ticket 02). */
const keycloakMember = Effect.fn(function* (server: Server, realm: FakeKeycloak, sub: string) {
  const local = yield* memberWithPassword(server, `member-${sub}`);
  const linked = yield* roundTrip(
    server,
    realm,
    { sub },
    { intent: "link", reauth: { method: "password", password: PASSWORD } },
    local.cookie,
  );
  assert.equal(linked.status, 303, linked.text);
  return { id: local.id, cookie: linked.cookie ?? "" };
});

const passwordSignIn = (server: Server, loginName: string, password = PASSWORD) =>
  server.request("/api/auth/password/sign-in", { body: { loginName, password } });

const passkeySignIn = Effect.fn(function* (server: Server, authenticator: Authenticator) {
  const proof = yield* passkeyReauth(server, authenticator);
  return yield* server.request("/api/auth/passkey/sign-in", {
    body: { ceremonyId: proof.ceremonyId, response: proof.response },
  });
});

/** Saves `change`; a 409 asks first (its message), then the same change confirmed. */
const saveConfirmed = Effect.fn(function* (
  server: Server,
  owner: string,
  change: Record<string, unknown>,
) {
  const first = yield* server.request(SETTINGS, { cookie: owner, body: change });
  if (first.status !== 409) return { asked: undefined, saved: first };
  const saved = yield* server.request(SETTINGS, {
    cookie: owner,
    body: { ...change, endLoginsConfirmed: true },
  });
  return { asked: String(first.body.message), saved };
});

const tokenOf = (cookie: string) => cookie.split("=")[1] ?? "";

/** A socket that waits on the cookie's session until it is revoked. */
const watchSocket = Effect.fn(function* (server: Server, cookie: string) {
  const session = yield* server.sessions.verify(tokenOf(cookie));
  return yield* server.sessions
    .awaitInvalidation(session.sessionId)
    .pipe(Effect.forkScoped({ startImmediately: true }));
});

const userOf = Effect.fn(function* (server: Server, cookie: string | undefined) {
  const session = yield* server.request("/api/auth/session", { cookie: cookie ?? "" });
  return session.body.userId as string | undefined;
});

interface AuditRow {
  readonly target: { readonly kind: string; readonly id: string };
  readonly detail: Record<string, unknown>;
}

const auditOf = (server: Server, owner: string, action: string) =>
  server
    .request(`/api/installation/audit?action=${action}`, { cookie: owner })
    .pipe(Effect.map((answer) => answer.body.entries as ReadonlyArray<AuditRow>));

const issueResetLink = Effect.fn(function* (server: Server, userId: string, ownerId: string) {
  const issued = yield* Context.get(server.services, UserDirectory.UserDirectory).issueResetLink({
    userId: UserId.make(userId),
    createdBy: UserId.make(ownerId),
  });
  assert.isTrue(Option.isSome(issued));
  return Option.isSome(issued) ? issued.value.token : "";
});

const resetStatus = (server: Server, token: string) =>
  server
    .request("/api/auth/reset/status", { body: { token } })
    .pipe(Effect.map((answer) => answer.body));

describe("local sign-in off for everyone but the Owner (ticket 08)", () => {
  it.effect("a Member's right password is refused once checked; the Owner signs in", () =>
    Effect.gen(function* () {
      const { server, owner, authenticator } = yield* hub;
      yield* memberWithPassword(server, "ana");
      const { saved } = yield* saveConfirmed(server, owner, { localSignInForMembers: false });
      assert.equal(saved.status, 200, saved.text);
      assert.isFalse(saved.body.localSignInForMembers);

      // A wrong password learns nothing new; the right one is told why, and gets no session.
      assert.equal((yield* passwordSignIn(server, "ana", "not the password")).status, 401);
      const refused = yield* passwordSignIn(server, "ana");
      assert.equal(refused.status, 403);
      assert.match(String(refused.body.message), /Keycloak/);
      assert.isUndefined(refused.cookie);

      // The Owner's passkey is the break-glass, whatever the switch says.
      const ownerIn = yield* passkeySignIn(server, authenticator);
      assert.equal(ownerIn.status, 200, ownerIn.text);
      assert.isTrue(yield* isSignedIn(server, ownerIn.cookie));
      // The sign-in page folds the local form away.
      const page = yield* server.request("/api/auth/session", {});
      assert.deepEqual(page.body.signInOptions, { keycloak: true, localForMembers: false });
    }).pipe(Effect.scoped),
  );

  it.effect("a Member with an authenticator app is refused at the code step", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hub;
      const ana = yield* memberWithPassword(server, "ana");
      const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
        body: {},
        cookie: ana.cookie,
      });
      const secret = enrollment.body.secret as string;
      const confirmed = yield* server.request("/api/auth/account/totp", {
        body: {
          enrollmentId: enrollment.body.enrollmentId,
          code: yield* totpCode(secret, yield* Clock.currentTimeMillis),
          reauth: { method: "password", password: PASSWORD },
        },
        cookie: ana.cookie,
      });
      assert.equal(confirmed.status, 200, confirmed.text);
      const { saved } = yield* saveConfirmed(server, owner, { localSignInForMembers: false });
      assert.equal(saved.status, 200, saved.text);

      const step = yield* passwordSignIn(server, "ana");
      assert.equal(step.body.secondFactor, "totp");
      yield* TestClock.adjust("30 seconds");
      const refused = yield* server.request("/api/auth/password/totp", {
        body: {
          challengeId: step.body.challengeId,
          code: yield* totpCode(secret, yield* Clock.currentTimeMillis),
        },
      });
      assert.equal(refused.status, 403);
      assert.isUndefined(refused.cookie);
    }).pipe(Effect.scoped),
  );

  it.effect("turning it off closes a local session's socket, not a Keycloak one's", () =>
    Effect.gen(function* () {
      const { server, realm, owner, ownerId } = yield* hub;
      const ana = yield* memberWithPassword(server, "ana");
      const bea = yield* keycloakMember(server, realm, "kc-bea");
      // A pairing link Ana made from her local session, and one the Owner's shell made for her.
      const localLink = yield* server.request("/api/auth/pairing-token", {
        cookie: ana.cookie,
        body: {},
      });
      assert.equal(localLink.status, 200, localLink.text);
      const shellLink = yield* server.environmentAuth.createPairingLink({
        userId: UserId.make(ana.id),
        issuedByShell: true,
      });
      const shellToken = yield* server.environmentAuth.issueSession({
        userId: UserId.make(ana.id),
        audited: true,
      });
      const anaSocket = yield* watchSocket(server, ana.cookie);
      const beaSocket = yield* watchSocket(server, bea.cookie);

      const { asked, saved } = yield* saveConfirmed(server, owner, {
        localSignInForMembers: false,
      });
      // Asked first: Ana has no Keycloak account yet; her session and link end.
      assert.match(asked ?? "", /1 User besides you doesn't sign in with Keycloak/);
      assert.match(asked ?? "", /1 session and 1 pairing link/);
      assert.equal(saved.status, 200, saved.text);

      yield* Fiber.join(anaSocket);
      assert.isFalse(yield* isSignedIn(server, ana.cookie));
      // Bea's socket is still open: her session is born of a Keycloak sign-in.
      assert.isUndefined(beaSocket.pollUnsafe());
      assert.isTrue(yield* isSignedIn(server, bea.cookie));
      assert.isTrue(yield* isSignedIn(server, owner));
      // The shell's token and link are the Owner's own act on the machine: they stay.
      const shellSession = yield* server.request("/api/auth/session", {
        authorization: `Bearer ${shellToken.token}`,
      });
      assert.equal(shellSession.body.userId, ana.id);
      const viaShellLink = yield* server.request("/api/auth/browser-session", {
        body: { credential: shellLink.credential },
      });
      assert.equal(viaShellLink.status, 200, viaShellLink.text);
      const viaLocalLink = yield* server.request("/api/auth/browser-session", {
        body: { credential: localLink.body.credential },
      });
      assert.equal(viaLocalLink.status, 401);

      const entries = yield* auditOf(server, owner, "signIn.settings.update");
      assert.deepInclude(entries[0]?.detail ?? {}, {
        localSignInForMembers: false,
        localSessionsEnded: 1,
        localPairingLinksEnded: 1,
      });
      assert.equal(entries[0]?.target.kind, "sign_in_settings");
      assert.isString(ownerId);
    }).pipe(Effect.scoped),
  );

  it.effect("it can't go off while Keycloak is off", () =>
    Effect.gen(function* () {
      const realm = yield* makeFakeKeycloak();
      const server = yield* serveAuthHttpWith({ signIn: { keycloakHttp: realm.layer } });
      const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
      const refused = yield* server.request(SETTINGS, {
        cookie: created.cookie ?? "",
        body: { localSignInForMembers: false, endLoginsConfirmed: true },
      });
      assert.equal(refused.status, 400);
      const page = yield* server.request("/api/auth/session", {});
      assert.deepEqual(page.body.signInOptions, { keycloak: false, localForMembers: true });
    }).pipe(Effect.scoped),
  );

  it.effect("an Invitation accepted with a new password is refused and stays unused", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hub;
      const acme = yield* server.request("/api/spaces/organizations", {
        body: { name: "Acme" },
        cookie: owner,
      });
      const invited = yield* server.request(`/api/spaces/${String(acme.body.id)}/invitations`, {
        body: { role: "member" },
        cookie: owner,
      });
      const token = invited.body.token as string;
      // Nobody else yet: nothing to confirm.
      const off = yield* server.request(SETTINGS, {
        cookie: owner,
        body: { localSignInForMembers: false },
      });
      assert.equal(off.status, 200, off.text);

      const accepted = yield* server.request("/api/invitations/accept", {
        body: {
          token,
          method: "password",
          displayName: "Grace Hopper",
          loginName: "grace",
          password: PASSWORD,
        },
      });
      assert.equal(accepted.status, 403);
      assert.isUndefined(accepted.cookie);
      const preview = yield* server.request("/api/invitations/preview", { body: { token } });
      assert.equal(preview.body.status, "valid");
      const users = yield* server.sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`;
      assert.equal(users[0]?.n, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a Platform invitation with new local credentials works while open, is refused once closed",
    () =>
      Effect.gen(function* () {
        const { server, owner } = yield* hub;
        const createPlatform = server.request("/api/installation/invitations", {
          body: {},
          cookie: owner,
        });
        // While local sign-in is open, it works: a User with no Membership.
        const open = yield* createPlatform;
        assert.equal(open.status, 200, open.text);
        const joined = yield* server.request("/api/invitations/accept", {
          body: {
            token: open.body.token as string,
            method: "password",
            displayName: "Ada Byron",
            loginName: "ada",
            password: PASSWORD,
          },
        });
        assert.equal(joined.status, 200, joined.text);
        const ada = yield* userOf(server, joined.cookie);
        assert.isString(ada);
        const memberships = yield* server.sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM space_memberships WHERE user_id = ${ada ?? ""}
        `;
        assert.equal(memberships[0]?.n, 0);

        const created = yield* createPlatform;
        assert.equal(created.status, 200, created.text);
        const token = created.body.token as string;
        // Ada has no Keycloak account yet: the Owner confirms first.
        const { saved: off } = yield* saveConfirmed(server, owner, {
          localSignInForMembers: false,
        });
        assert.equal(off.status, 200, off.text);

        const viaPassword = yield* server.request("/api/invitations/accept", {
          body: {
            token,
            method: "password",
            displayName: "Grace Hopper",
            loginName: "grace",
            password: PASSWORD,
          },
        });
        assert.equal(viaPassword.status, 403);
        assert.isUndefined(viaPassword.cookie);

        const ceremony = yield* server.request("/api/invitations/registration", {
          body: { token, displayName: "Grace Hopper" },
        });
        assert.equal(ceremony.status, 200, ceremony.text);
        const authenticator = yield* makeAuthenticator();
        const response = yield* Effect.promise(() =>
          authenticator.create(ceremony.body.options as CreationOptions),
        );
        const viaPasskey = yield* server.request("/api/invitations/accept", {
          body: { token, method: "passkey", ceremonyId: ceremony.body.ceremonyId, response },
        });
        assert.equal(viaPasskey.status, 403);
        assert.isUndefined(viaPasskey.cookie);

        // Nothing was kept: the Invitation is still unused, and no User was made.
        const preview = yield* server.request("/api/invitations/preview", { body: { token } });
        assert.equal(preview.body.status, "valid");
        const accepted = yield* server.sql<{ acceptedAt: string | null }>`
        SELECT accepted_at AS "acceptedAt" FROM space_invitations
        WHERE invitation_id = ${(created.body.invitation as { id: string }).id}
      `;
        assert.deepEqual(accepted, [{ acceptedAt: null }]);
        // The Owner and Ada: no User for the refused accepts.
        const users = yield* server.sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`;
        assert.equal(users[0]?.n, 2);
      }).pipe(Effect.scoped),
  );

  it.effect("an app approved from a local sign-in before the switch gets no session after", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hub;
      const ana = yield* memberWithPassword(server, "ana");
      const verifier = `${"a".repeat(43)}-verifier-for-tests`;
      const approved = yield* server.request("/api/auth/app-sign-in/approve", {
        body: {
          redirectUri: "http://127.0.0.1:53111/callback",
          codeChallenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
          codeChallengeMethod: "S256",
          state: "state-from-the-app-0123",
          clientLabel: "T3 Code desktop",
        },
        cookie: ana.cookie,
      });
      assert.equal(approved.status, 200, approved.text);
      const code = new URL(String(approved.body.redirectTo)).searchParams.get("code") ?? "";
      const { saved } = yield* saveConfirmed(server, owner, { localSignInForMembers: false });
      assert.equal(saved.status, 200, saved.text);
      const exchanged = yield* server.request("/api/auth/app-sign-in/token", {
        form: {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:53111/callback",
          client_label: "T3 Code desktop",
        },
      });
      assert.equal(exchanged.status, 401);
    }).pipe(Effect.scoped),
  );
});

describe("a reset link binds a Keycloak account (ticket 08)", () => {
  it.effect("it re-links a new identity: the old one no longer reaches the User", () =>
    Effect.gen(function* () {
      const { server, realm, owner, ownerId } = yield* hub;
      const ana = yield* keycloakMember(server, realm, "kc-old");
      const socket = yield* watchSocket(server, ana.cookie);
      const token = yield* issueResetLink(server, ana.id, ownerId);
      assert.deepInclude(yield* resetStatus(server, token), {
        status: "valid",
        keycloak: true,
        local: true,
      });

      const reset = yield* roundTrip(
        server,
        realm,
        { sub: "kc-new" },
        { intent: "reset", resetToken: token },
      );
      assert.equal(reset.status, 303, reset.text);
      assert.equal(reset.location, "/");
      assert.equal(yield* userOf(server, reset.cookie), ana.id);
      // Every session of theirs ended, sockets too; the new one is born of this sign-in.
      yield* Fiber.join(socket);
      const session = yield* server.sessions.verify(tokenOf(reset.cookie ?? ""));
      assert.isString(session.identityLoginId);

      // Single use: the link is spent.
      const again = yield* server.request(START, { body: { intent: "reset", resetToken: token } });
      assert.equal(again.status, 400);
      assert.deepEqual(yield* resetStatus(server, token), { status: "invalid" });

      // The old Keycloak account is a stranger now; the new one signs in as Ana.
      const viaOld = yield* roundTrip(server, realm, { sub: "kc-old" });
      assert.equal(viaOld.location, "/sign-in?keycloak=invitation-only");
      const viaNew = yield* roundTrip(server, realm, { sub: "kc-new" });
      assert.equal(yield* userOf(server, viaNew.cookie), ana.id);
      // No local credential is left to sign in with.
      const credentials = yield* server.sql<{ n: number }>`
        SELECT (SELECT COUNT(*) FROM user_passwords WHERE user_id = ${ana.id})
          + (SELECT COUNT(*) FROM user_passkeys WHERE user_id = ${ana.id}) AS n
      `;
      assert.equal(credentials[0]?.n, 0);

      const redeemed = yield* auditOf(server, owner, "resetLink.redeem");
      assert.deepEqual(redeemed[0]?.detail, { method: "keycloak", identityRemoved: true });
      const linked = yield* auditOf(server, owner, "user.identity.link");
      assert.deepEqual(linked[0]?.detail, {
        issuer: realm.issuer,
        credentialsRemoved: true,
        via: "reset",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("another User's identity is refused, and the link stays usable", () =>
    Effect.gen(function* () {
      const { server, realm, ownerId } = yield* hub;
      yield* keycloakMember(server, realm, "kc-bea");
      const ana = yield* memberWithPassword(server, "ana");
      const token = yield* issueResetLink(server, ana.id, ownerId);
      const taken = yield* roundTrip(
        server,
        realm,
        { sub: "kc-bea" },
        { intent: "reset", resetToken: token },
      );
      assert.equal(taken.location, "/reset?keycloak=taken");
      assert.isUndefined(taken.cookie);
      // Nothing changed: her password still works, and the link is still hers to use.
      assert.equal((yield* passwordSignIn(server, "ana")).status, 200);
      assert.equal((yield* resetStatus(server, token)).status, "valid");
      const reset = yield* roundTrip(
        server,
        realm,
        { sub: "kc-ana" },
        { intent: "reset", resetToken: token },
      );
      assert.equal(yield* userOf(server, reset.cookie), ana.id);
      assert.equal((yield* passwordSignIn(server, "ana")).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("the Owner's reset link stays a passkey's; Keycloak off offers none", () =>
    Effect.gen(function* () {
      const { server, owner, ownerId } = yield* hub;
      const ownerLink = yield* server.environmentAuth.issueOwnerResetLink();
      assert.deepInclude(yield* resetStatus(server, ownerLink.token), {
        status: "valid",
        keycloak: false,
        local: true,
      });
      const refused = yield* server.request(START, {
        body: { intent: "reset", resetToken: ownerLink.token },
      });
      assert.equal(refused.status, 400);

      const ana = yield* memberWithPassword(server, "ana");
      const token = yield* issueResetLink(server, ana.id, ownerId);
      const off = yield* server.request(SETTINGS, {
        cookie: owner,
        body: { keycloakEnabled: false },
      });
      assert.equal(off.status, 200, off.text);
      assert.deepInclude(yield* resetStatus(server, token), { keycloak: false, local: true });
      const offRefused = yield* server.request(START, {
        body: { intent: "reset", resetToken: token },
      });
      assert.equal(offRefused.status, 403);
    }).pipe(Effect.scoped),
  );

  it.effect("with local sign-in off, a reset link sets no passkey or password", () =>
    Effect.gen(function* () {
      const { server, owner, ownerId } = yield* hub;
      const ana = yield* memberWithPassword(server, "ana");
      const token = yield* issueResetLink(server, ana.id, ownerId);
      const { saved } = yield* saveConfirmed(server, owner, { localSignInForMembers: false });
      assert.equal(saved.status, 200, saved.text);
      assert.deepInclude(yield* resetStatus(server, token), {
        status: "valid",
        keycloak: true,
        local: false,
        passwordAllowed: false,
      });
      const viaPassword = yield* server.request("/api/auth/reset/password", {
        body: { token, loginName: "ana", password: PASSWORD },
      });
      assert.equal(viaPassword.status, 403);
      const viaPasskey = yield* server.request("/api/auth/reset/registration", {
        body: { token },
      });
      assert.equal(viaPasskey.status, 403);
      assert.equal((yield* resetStatus(server, token)).status, "valid");
    }).pipe(Effect.scoped),
  );
});

describe("turning Keycloak off (ticket 08)", () => {
  it.effect(
    "ends every Keycloak sign-in and its socket, keeps the rest, reopens local sign-in",
    () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub;
        const ana = yield* keycloakMember(server, realm, "kc-ana");
        const socket = yield* watchSocket(server, ana.cookie);
        const localOff = yield* saveConfirmed(server, owner, { localSignInForMembers: false });
        assert.equal(localOff.saved.status, 200, localOff.saved.text);

        const { asked, saved } = yield* saveConfirmed(server, owner, { keycloakEnabled: false });
        assert.match(asked ?? "", /ends 1 Keycloak sign-in and 1 session/);
        assert.equal(saved.status, 200, saved.text);
        assert.isFalse((saved.body.keycloak as { enabled: boolean }).enabled);
        assert.equal((saved.body.keycloak as { issuer: string }).issuer, realm.issuer);
        assert.isTrue(saved.body.localSignInForMembers);

        yield* Fiber.join(socket);
        assert.isFalse(yield* isSignedIn(server, ana.cookie));
        assert.isTrue(yield* isSignedIn(server, owner));
        const identities = yield* server.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ${ana.id}
      `;
        assert.equal(identities[0]?.n, 1);
        const ended = yield* auditOf(server, owner, "keycloak.login.end");
        assert.deepEqual(
          ended.map((row) => [row.target.id, row.detail.reason]),
          [[ana.id, "keycloak-off"]],
        );
        const page = yield* server.request("/api/auth/session", {});
        assert.deepEqual(page.body.signInOptions, { keycloak: false, localForMembers: true });
      }).pipe(Effect.scoped),
  );

  it.effect("a new issuer with identities saved asks first", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub;
      yield* keycloakMember(server, realm, "kc-ana");
      const off = yield* saveConfirmed(server, owner, { keycloakEnabled: false });
      assert.equal(off.saved.status, 200, off.saved.text);
      const { asked, saved } = yield* saveConfirmed(server, owner, {
        issuer: "https://keycloak.example/realms/other",
      });
      assert.match(asked ?? "", /1 User linked to the current realm won't match the new issuer/);
      assert.match(asked ?? "", /reset link/);
      assert.equal(saved.status, 200, saved.text);
      // Saving it again asks nothing: the same issuer.
      const again = yield* server.request(SETTINGS, {
        cookie: owner,
        body: { issuer: "https://keycloak.example/realms/other" },
      });
      assert.equal(again.status, 200, again.text);
    }).pipe(Effect.scoped),
  );
});
