/**
 * Signing in and linking an account through Keycloak at the server's edge (Keycloak sign-in spec,
 * ticket 02): the real HTTP doors over SQLite in memory and a fake realm, never the network.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  KEYCLOAK_BACKCHANNEL_LOGOUT_PATH,
  KEYCLOAK_CALLBACK_PATH,
  KEYCLOAK_POST_LOGOUT_PATH,
  keycloakClientUrls,
  UserId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { joinMachine, memberWithPasskey } from "../environments/environments.testkit.ts";
import { isUntracedRequest } from "../http.ts";
import * as AccountCredentials from "./AccountCredentials.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  type FakeKeycloak,
  type FakeSignIn,
  makeFakeKeycloak,
  TEST_ISSUER,
} from "./Keycloak.testkit.ts";
import * as KeycloakClient from "./KeycloakClient.ts";
import * as KeycloakSignIn from "./KeycloakSignIn.ts";
import * as UserDirectory from "./UserDirectory.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  makeAuthenticator,
  passkeyReauth,
  type Server,
  serveAuthHttpWith,
  type TestSignInOptions,
} from "./UserAuth.testkit.ts";

const START = "/api/auth/keycloak/start";
const PASSWORD = "correct horse battery staple";

/** The Owner's Hub with Keycloak on over the fake realm. */
const hub = (options: { readonly flows?: TestSignInOptions["flows"] } = {}) =>
  Effect.gen(function* () {
    const realm = yield* makeFakeKeycloak();
    const server = yield* serveAuthHttpWith({
      signIn: {
        keycloakHttp: realm.layer,
        ...(options.flows === undefined ? {} : { flows: options.flows }),
      },
    });
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    const owner = created.cookie ?? "";
    const on = yield* server.request("/api/installation/sign-in-settings", {
      cookie: owner,
      body: {
        keycloakEnabled: true,
        issuer: realm.issuer,
        clientId: realm.clientId,
        clientSecret: realm.clientSecret,
      },
    });
    assert.equal(on.status, 200);
    return {
      realm,
      server,
      authenticator,
      owner,
      ownerId: (created.body.user as { id: string }).id,
      recoveryCodes: created.body.recoveryCodes as ReadonlyArray<string>,
    };
  });

/** A User other than the Owner, signed in, with a password of their own. */
const memberWithPassword = Effect.fn(function* (server: Server, id = "member-1") {
  const cookie = yield* addMember(server, { id, displayName: `Member ${id}` });
  const saved = yield* server.request("/api/auth/account/password", {
    cookie,
    body: { loginName: id, password: PASSWORD },
  });
  assert.equal(saved.status, 200);
  return { cookie, id };
});

const flowCookieOf = (setCookies: ReadonlyArray<string>) =>
  setCookies.find((cookie) => /^(__Host-)?t3_keycloak_flow=[^;]/.test(cookie))?.split(";", 1)[0];

const joinCookies = (...cookies: ReadonlyArray<string | undefined>) =>
  cookies.filter((cookie) => cookie !== undefined && cookie !== "").join("; ");

/** `start`, as the page posts it: the realm's sign-in address and the flow cookie. */
const start = Effect.fn(function* (
  server: Server,
  body: Record<string, unknown>,
  init: {
    readonly cookie?: string;
    readonly peer?: string;
    readonly headers?: Record<string, string>;
  } = {},
) {
  const started = yield* server.request(START, { body, ...init });
  return {
    status: started.status,
    body: started.body,
    authorizationUrl: started.body?.authorizationUrl as string,
    flowCookie: flowCookieOf(started.setCookies),
    setCookies: started.setCookies,
    text: started.text,
  };
});

/** The browser coming back from the realm to the callback, with the cookies it holds. */
const callback = (
  server: Server,
  url: string,
  cookie: string,
  init: { readonly peer?: string; readonly headers?: Record<string, string> } = {},
) => {
  const parsed = new URL(url);
  return server.request(`${parsed.pathname}${parsed.search}`, {
    cookie,
    omitOrigin: true,
    ...init,
  });
};

/** A client elsewhere, as the Hub's trusted proxy on loopback forwards it over HTTPS. */
const remoteClient = (address: string) => ({
  "x-forwarded-for": address,
  "x-forwarded-proto": "https",
});

/** `start` from such a client: its page is the Hub's own HTTPS origin. */
const remoteStart = (address: string) => ({
  ...remoteClient(address),
  origin: "https://127.0.0.1",
});

/** A whole round: start, sign in at the realm as `as`, come back with the flow cookie. */
const roundTrip = Effect.fn(function* (
  server: Server,
  realm: FakeKeycloak,
  as: FakeSignIn,
  body: Record<string, unknown> = { intent: "sign-in" },
  sessionCookie?: string,
) {
  const started = yield* start(
    server,
    body,
    sessionCookie === undefined ? {} : { cookie: sessionCookie },
  );
  assert.equal(started.status, 200, started.text);
  const back = yield* realm.signIn(started.authorizationUrl, as);
  return yield* callback(server, back, joinCookies(started.flowCookie, sessionCookie));
});

const resultOf = (location: string | undefined) =>
  new URL(location ?? "/", "http://hub.invalid").searchParams.get("keycloak");

const userOf = (server: Server, cookie: string | undefined) =>
  server
    .request("/api/auth/session", { cookie: cookie ?? "" })
    .pipe(Effect.map((session) => session.body.userId as string | undefined));

interface Account {
  readonly hasPasskey: boolean;
  readonly hasPassword: boolean;
  readonly totpEnrolled: boolean;
  readonly keycloakLink?: string;
  readonly identity?: {
    readonly username: string | null;
    readonly email: string | null;
    readonly accountUrl: string;
  };
}

const account = (server: Server, cookie: string) =>
  server
    .request("/api/auth/account", { cookie })
    .pipe(Effect.map((answer) => answer.body as unknown as Account));

describe("Keycloak sign-in (ticket 02)", () => {
  it.effect("the sign-in page offers Keycloak while it is on", () =>
    Effect.gen(function* () {
      const { server } = yield* hub();
      const session = yield* server.request("/api/auth/session");
      assert.deepEqual(session.body.signInOptions, { keycloak: true });
    }),
  );

  it.effect("a Member links their account, loses local credentials and signs in again", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* memberWithPassword(server);
      assert.equal((yield* account(server, member.cookie)).keycloakLink, "allowed");
      const otherSession = yield* server.sessions.issue({
        method: "browser-session-cookie",
        subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
        userId: UserId.make(member.id),
      });

      const linked = yield* roundTrip(
        server,
        realm,
        { sub: "kc-grace", username: "grace", email: "grace@example.test" },
        { intent: "link", reauth: { method: "password", password: PASSWORD } },
        member.cookie,
      );
      assert.equal(linked.status, 303);
      assert.equal(linked.location, KeycloakSignIn.ACCOUNT_PATH);
      assert.isDefined(linked.cookie);
      assert.equal(yield* userOf(server, linked.cookie), member.id);
      // Every session they had ends, the one that linked too; the new one comes from Keycloak.
      assert.isFalse(yield* isSignedIn(server, member.cookie));
      assert.isFalse(
        yield* isSignedIn(server, `${server.sessions.cookieName}=${otherSession.token}`),
      );
      const after = yield* account(server, linked.cookie ?? "");
      assert.deepInclude(after, { hasPasskey: false, hasPassword: false, totpEnrolled: false });
      assert.deepEqual(after.identity, {
        username: "grace",
        email: "grace@example.test",
        accountUrl: `${realm.issuer}/account`,
      });
      const sessionRows = yield* server.sql<{ identityLoginId: string | null }>`
        SELECT identity_login_id AS "identityLoginId" FROM auth_sessions
        WHERE user_id = ${member.id} AND revoked_at IS NULL
      `;
      assert.equal(sessionRows.length, 1);
      assert.isString(sessionRows[0]?.identityLoginId);

      // Local credentials can't come back for them.
      const password = yield* server.request("/api/auth/account/password", {
        cookie: linked.cookie ?? "",
        body: { loginName: "grace", password: PASSWORD },
      });
      assert.equal(password.status, 403);
      const totp = yield* server.request("/api/auth/account/totp/enrollment", {
        cookie: linked.cookie ?? "",
        body: {},
      });
      assert.equal(totp.status, 403);

      // Audited, with the issuer and never the subject or the email.
      const audit = yield* server.request("/api/installation/audit?action=user.identity.link", {
        cookie: owner,
      });
      const entries = audit.body.entries as ReadonlyArray<{ detail: Record<string, unknown> }>;
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0]?.detail, { issuer: realm.issuer, credentialsRemoved: true });

      // From now on, «Sign in with Keycloak» signs them in.
      const again = yield* roundTrip(server, realm, { sub: "kc-grace", username: "grace2" });
      assert.equal(again.status, 303);
      assert.equal(again.location, "/");
      assert.equal(yield* userOf(server, again.cookie), member.id);
      assert.equal((yield* account(server, again.cookie ?? "")).identity?.username, "grace2");
    }).pipe(Effect.scoped),
  );

  it.effect("the Owner links, keeps passkey and codes, and every old session and socket ends", () =>
    Effect.gen(function* () {
      const { server, realm, owner, authenticator, recoveryCodes } = yield* hub();
      // A machine the Owner registered depends on its own credential, not on a session.
      const machine = yield* joinMachine(server, authenticator, owner);
      const ownerSession = yield* server.sessions.verify(owner.split("=")[1] ?? "");
      const socket = yield* server.sessions
        .awaitInvalidation(ownerSession.sessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const reauth = yield* passkeyReauth(server, authenticator);

      const linked = yield* roundTrip(
        server,
        realm,
        { sub: "kc-ada" },
        { intent: "link", reauth },
        owner,
      );
      assert.equal(linked.status, 303);
      yield* Fiber.join(socket);
      assert.isFalse(yield* isSignedIn(server, owner));
      const after = yield* account(server, linked.cookie ?? "");
      assert.isTrue(after.hasPasskey);
      assert.isDefined(after.identity);

      // The break-glass still works: a recovery code signs the Owner in.
      const recovered = yield* server.request("/api/auth/recovery-code/sign-in", {
        body: { code: recoveryCodes[0] },
      });
      assert.equal(recovered.status, 200);
      // The machine is still connected: its credential is not a session.
      const self = yield* server.request("/api/environments/self", {
        body: {},
        authorization: `Bearer ${machine.credential}`,
      });
      assert.equal(self.status, 200);

      const audit = yield* server.request("/api/installation/audit?action=user.identity.link", {
        cookie: recovered.cookie ?? "",
      });
      const entries = audit.body.entries as ReadonlyArray<{ detail: Record<string, unknown> }>;
      assert.deepEqual(entries[0]?.detail, { issuer: realm.issuer, credentialsRemoved: false });
    }).pipe(Effect.scoped),
  );

  it.effect("linking needs a fresh proof of the current credential", () =>
    Effect.gen(function* () {
      const { server } = yield* hub();
      const member = yield* memberWithPassword(server);
      const without = yield* start(server, { intent: "link" }, { cookie: member.cookie });
      assert.equal(without.status, 403);
      const wrong = yield* start(
        server,
        { intent: "link", reauth: { method: "password", password: "not the password" } },
        { cookie: member.cookie },
      );
      assert.equal(wrong.status, 403);
      assert.isUndefined(wrong.flowCookie);
      // Without a browser session there is nothing to link.
      const signedOut = yield* start(server, {
        intent: "link",
        reauth: { method: "password", password: PASSWORD },
      });
      assert.equal(signedOut.status, 401);
      // An account with nothing to confirm with gets a reset link from the Owner instead.
      const bare = yield* addMember(server, { id: "bare", displayName: "Bare" });
      assert.equal((yield* account(server, bare)).keycloakLink, "needs-reset");
      assert.equal((yield* start(server, { intent: "link" }, { cookie: bare })).status, 403);
    }),
  );

  it.effect("an Admin other than the Owner can't link yet, and is told why", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hub();
      const admin = yield* memberWithPasskey(server, owner, { displayName: "Ada", role: "admin" });
      assert.equal((yield* account(server, admin.cookie)).keycloakLink, "admins-later");
      const refused = yield* start(
        server,
        { intent: "link", reauth: yield* passkeyReauth(server, admin.authenticator) },
        { cookie: admin.cookie },
      );
      assert.equal(refused.status, 403);
      assert.include(String(refused.body.message), "Admins");
    }),
  );

  it.effect("an identity linked to another User is refused, and nothing changes", () =>
    Effect.gen(function* () {
      const { server, realm, owner, authenticator } = yield* hub();
      const owned = yield* roundTrip(
        server,
        realm,
        { sub: "kc-shared" },
        { intent: "link", reauth: yield* passkeyReauth(server, authenticator) },
        owner,
      );
      assert.equal(owned.status, 303);
      const member = yield* memberWithPassword(server);
      const taken = yield* roundTrip(
        server,
        realm,
        { sub: "kc-shared" },
        { intent: "link", reauth: { method: "password", password: PASSWORD } },
        member.cookie,
      );
      assert.equal(taken.status, 303);
      assert.equal(resultOf(taken.location), "taken");
      assert.isUndefined(taken.cookie);
      assert.isTrue(yield* isSignedIn(server, member.cookie));
      assert.deepInclude(yield* account(server, member.cookie), { hasPassword: true });
      assert.isUndefined((yield* account(server, member.cookie)).identity);
    }),
  );

  it.effect("a link comes back only to the very session that started it", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* memberWithPassword(server);
      const body = { intent: "link", reauth: { method: "password", password: PASSWORD } };

      const noSession = yield* start(server, body, { cookie: member.cookie });
      const back = yield* realm.signIn(noSession.authorizationUrl, { sub: "kc-grace" });
      const refused = yield* callback(server, back, joinCookies(noSession.flowCookie));
      assert.equal(resultOf(refused.location), "failed");
      assert.isUndefined(refused.cookie);

      const other = yield* server.sessions.issue({
        method: "browser-session-cookie",
        subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
        userId: UserId.make(member.id),
      });
      const elsewhere = yield* start(server, body, { cookie: member.cookie });
      const backAgain = yield* realm.signIn(elsewhere.authorizationUrl, { sub: "kc-grace" });
      const fromOther = yield* callback(
        server,
        backAgain,
        joinCookies(elsewhere.flowCookie, `${server.sessions.cookieName}=${other.token}`),
      );
      assert.equal(resultOf(fromOther.location), "failed");
      assert.isUndefined((yield* account(server, member.cookie)).identity);
    }),
  );

  it.effect(
    "an identity the Hub doesn't know is refused on an invitation-only Hub, and nothing is kept",
    () =>
      Effect.gen(function* () {
        const { server, realm } = yield* hub();
        const refused = yield* roundTrip(server, realm, { sub: "kc-stranger" });
        assert.equal(refused.status, 303);
        assert.equal(refused.location, "/sign-in?keycloak=invitation-only");
        assert.isUndefined(refused.cookie);
        assert.deepEqual(yield* server.sql`SELECT * FROM user_identities`, []);
        assert.deepEqual(yield* server.sql`SELECT * FROM identity_logins`, []);
      }),
  );

  it.effect("a disabled User gets today's refusal", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* memberWithPassword(server);
      const linked = yield* roundTrip(
        server,
        realm,
        { sub: "kc-grace" },
        { intent: "link", reauth: { method: "password", password: PASSWORD } },
        member.cookie,
      );
      assert.equal(linked.status, 303);
      yield* server.sql`
        UPDATE users SET disabled_at = '2026-01-02T00:00:00.000Z' WHERE user_id = ${member.id}
      `;
      const refused = yield* roundTrip(server, realm, { sub: "kc-grace" });
      assert.equal(refused.location, "/sign-in?keycloak=disabled");
      assert.isUndefined(refused.cookie);
    }),
  );

  describe("a callback that fails a check signs nobody in and counts against the client", () => {
    const tampered: ReadonlyArray<{
      readonly name: string;
      readonly as?: Partial<FakeSignIn>;
      readonly bend?: (url: URL) => void;
      readonly cookie?: (flowCookie: string | undefined) => string;
    }> = [
      { name: "a state it never issued", bend: (url) => url.searchParams.set("state", "forged") },
      { name: "no flow cookie", cookie: () => "" },
      {
        name: "another browser's flow cookie",
        cookie: (flowCookie) => `${flowCookie?.split("=")[0] ?? ""}=someone-else`,
      },
      { name: "another nonce", as: { claims: { nonce: "replayed-nonce" } } },
      {
        name: "another issuer in the response",
        as: { responseIss: "https://evil.test/realms/hub" },
      },
      { name: "no issuer in the response", as: { responseIss: null } },
      {
        name: "an ID token for another client",
        as: { claims: { aud: "other-client", azp: "other-client" } },
      },
      {
        name: "an ID token from another issuer",
        as: { claims: { iss: "https://evil.test/realms/hub" } },
      },
      { name: "an expired ID token", as: { claims: { exp: -3600 } } },
      { name: "an ID token issued long before the flow", as: { claims: { iat: -3600 } } },
      { name: "an ID token signed by another key", as: { foreignKey: true } },
    ];

    it.effect.each(tampered)("$name", (testCase) =>
      Effect.gen(function* () {
        const { server, realm, ownerId } = yield* hub();
        // Linked first, so only the check under test stands between them and a session.
        yield* server.sql`
          INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
          VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
        `;
        const started = yield* start(server, { intent: "sign-in" });
        const back = new URL(
          yield* realm.signIn(started.authorizationUrl, { sub: "kc-ada", ...testCase.as }),
        );
        testCase.bend?.(back);
        const answer = yield* callback(
          server,
          back.href,
          testCase.cookie?.(started.flowCookie) ?? joinCookies(started.flowCookie),
        );
        assert.equal(answer.status, 303);
        assert.equal(answer.location, "/sign-in?keycloak=failed");
        assert.isUndefined(answer.cookie);
        // The flow is spent: the same answer again is refused too.
        const replay = yield* callback(server, back.href, joinCookies(started.flowCookie));
        assert.equal(resultOf(replay.location), "failed");
      }),
    );

    it.effect("a code exchanged with another verifier is refused by the realm", () =>
      Effect.gen(function* () {
        const { server, realm, ownerId } = yield* hub();
        yield* server.sql`
          INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
          VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
        `;
        const started = yield* start(server, { intent: "sign-in" });
        // The realm binds the code to another challenge: the Hub's verifier no longer matches.
        const bent = new URL(started.authorizationUrl);
        bent.searchParams.set("code_challenge", "A".repeat(43));
        const back = yield* realm.signIn(bent.href, { sub: "kc-ada" });
        const answer = yield* callback(server, back, joinCookies(started.flowCookie));
        assert.equal(answer.location, "/sign-in?keycloak=failed");
        assert.isUndefined(answer.cookie);
      }),
    );

    it.effect("five failures lock the client out of the callback for a while", () =>
      Effect.gen(function* () {
        const { server, realm, ownerId } = yield* hub();
        yield* server.sql`
          INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
          VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
        `;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const answer = yield* callback(
            server,
            `http://127.0.0.1${KEYCLOAK_CALLBACK_PATH}?state=guess-${attempt}&code=x`,
            "",
          );
          assert.equal(resultOf(answer.location), "failed");
        }
        // Even a good answer waits now; another client does not.
        const good = yield* roundTrip(server, realm, { sub: "kc-ada" });
        assert.equal(resultOf(good.location), "throttled");
        const headers = { ...remoteClient("198.51.100.7"), origin: "https://127.0.0.1" };
        const started = yield* start(server, { intent: "sign-in" }, { headers });
        const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-ada" });
        const elsewhere = yield* callback(server, back, joinCookies(started.flowCookie), {
          headers: remoteClient("198.51.100.7"),
        });
        assert.equal(elsewhere.location, "/");
        assert.isDefined(elsewhere.cookie);
      }),
    );

    it.effect("a flow older than 10 minutes is gone", () =>
      Effect.gen(function* () {
        const { server, realm, ownerId } = yield* hub();
        yield* server.sql`
          INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
          VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
        `;
        const started = yield* start(server, { intent: "sign-in" });
        yield* TestClock.adjust("11 minutes");
        const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-ada" });
        const answer = yield* callback(server, back, joinCookies(started.flowCookie));
        assert.equal(resultOf(answer.location), "failed");
      }),
    );
  });

  describe("start", () => {
    it.effect("takes only a path on this Hub to come back to", () =>
      Effect.gen(function* () {
        const { server, realm, ownerId } = yield* hub();
        for (const returnTo of [
          "//evil.test/x",
          "/\\evil.test",
          "\\\\evil.test",
          "https://evil.test/",
          "javascript:alert(1)",
          "relative/path",
          "/\u0000x",
          "",
        ]) {
          const refused = yield* start(server, { intent: "sign-in", returnTo });
          assert.equal(refused.status, 400, returnTo);
          assert.equal(refused.body.reason, "invalid_return_to", returnTo);
          assert.isUndefined(refused.flowCookie);
        }
        yield* server.sql`
          INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
          VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
        `;
        const back = yield* roundTrip(
          server,
          realm,
          { sub: "kc-ada" },
          {
            intent: "sign-in",
            returnTo: "/app-sign-in?redirect_uri=x&state=y",
          },
        );
        assert.equal(back.location, "/app-sign-in?redirect_uri=x&state=y");
      }),
    );

    it.effect("sends the realm back to the Hub's own origin, never one a request names", () =>
      Effect.gen(function* () {
        const { server } = yield* hub();
        const started = yield* start(server, { intent: "sign-in" });
        const url = new URL(started.authorizationUrl);
        assert.equal(
          url.searchParams.get("redirect_uri"),
          `http://127.0.0.1${KEYCLOAK_CALLBACK_PATH}`,
        );
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
        assert.isNull(url.searchParams.get("prompt"));
        assert.match(started.setCookies.join("\n"), /t3_keycloak_flow=[^;]+;.*HttpOnly/i);

        // Another page's origin, or a host a client that is not a trusted proxy forwards: refused.
        const foreign = yield* start(
          server,
          { intent: "sign-in" },
          { headers: { origin: "https://evil.test" } },
        );
        assert.equal(foreign.status, 400);
        const forwarded = yield* start(
          server,
          { intent: "sign-in" },
          {
            peer: "203.0.113.9",
            headers: {
              origin: "https://evil.test",
              "x-forwarded-host": "evil.test",
              "x-forwarded-proto": "https",
            },
          },
        );
        assert.equal(forwarded.status, 400);
        // Behind a trusted proxy (loopback), its host and scheme are the Hub's, and the cookie
        // is `__Host-` and Secure.
        const proxied = yield* start(
          server,
          { intent: "sign-in" },
          {
            headers: {
              origin: "https://hub.example",
              "x-forwarded-host": "hub.example",
              "x-forwarded-proto": "https",
              "x-forwarded-for": "198.51.100.20",
            },
          },
        );
        assert.equal(proxied.status, 200, proxied.text);
        assert.equal(
          new URL(proxied.authorizationUrl).searchParams.get("redirect_uri"),
          `https://hub.example${KEYCLOAK_CALLBACK_PATH}`,
        );
        const secureCookie = proxied.setCookies.find((cookie) =>
          cookie.startsWith("__Host-t3_keycloak_flow="),
        );
        assert.isDefined(secureCookie);
        assert.match(secureCookie ?? "", /;\s*Secure/i);
        assert.match(secureCookie ?? "", /;\s*Path=\//i);
        assert.notMatch(secureCookie ?? "", /Domain=/i);
      }),
    );

    it.effect("a client gets a few starts a minute; another client is not held back", () =>
      Effect.gen(function* () {
        const { server } = yield* hub({ flows: { startsPerMinute: 3 } });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assert.equal((yield* start(server, { intent: "sign-in" })).status, 200);
        }
        assert.equal((yield* start(server, { intent: "sign-in" })).status, 429);
        assert.equal(
          (yield* start(server, { intent: "sign-in" }, { headers: remoteStart("198.51.100.8") }))
            .status,
          200,
        );
        yield* TestClock.adjust("1 minute");
        assert.equal((yield* start(server, { intent: "sign-in" })).status, 200);
      }),
    );

    it.effect("addresses in one IPv6 /64 are one client", () =>
      Effect.gen(function* () {
        const { server } = yield* hub({ flows: { startsPerMinute: 2 } });
        const from = (address: string) =>
          start(server, { intent: "sign-in" }, { headers: remoteStart(address) }).pipe(
            Effect.map((started) => started.status),
          );
        assert.equal(yield* from("2001:db8:1:2::1"), 200);
        assert.equal(yield* from("2001:db8:1:2::abcd"), 200);
        assert.equal(yield* from("2001:db8:1:2:ffff::9"), 429);
        assert.equal(yield* from("2001:db8:1:3::1"), 200);
      }),
    );

    it.effect("a client's many starts drop only its own oldest flow, never another's", () =>
      Effect.gen(function* () {
        const { server, realm } = yield* hub();
        const other = yield* start(
          server,
          { intent: "sign-in" },
          { headers: remoteStart("198.51.100.30") },
        );
        const flood: Array<Effect.Success<ReturnType<typeof start>>> = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const started = yield* start(
            server,
            { intent: "sign-in" },
            { headers: remoteStart("198.51.100.31") },
          );
          assert.equal(started.status, 200);
          flood.push(started);
        }
        const comeBack = (started: Effect.Success<ReturnType<typeof start>>, address: string) =>
          Effect.flatMap(realm.signIn(started.authorizationUrl, { sub: "kc-nobody" }), (back) =>
            callback(server, back, joinCookies(started.flowCookie), {
              headers: remoteClient(address),
            }),
          ).pipe(Effect.map((answer) => resultOf(answer.location)));
        // Past 5 pending flows, the flooding client lost its own first one...
        assert.equal(yield* comeBack(flood[0]!, "198.51.100.31"), "failed");
        assert.equal(yield* comeBack(flood[5]!, "198.51.100.31"), "invitation-only");
        // ...and the other client's flow is still there.
        assert.equal(yield* comeBack(other, "198.51.100.30"), "invitation-only");
      }),
    );

    it.effect("a full store refuses new starts instead of dropping anyone's flow", () =>
      Effect.gen(function* () {
        const { server, realm } = yield* hub({ flows: { maxPendingFlows: 2 } });
        const first = yield* start(
          server,
          { intent: "sign-in" },
          { headers: remoteStart("198.51.100.40") },
        );
        yield* start(server, { intent: "sign-in" }, { headers: remoteStart("198.51.100.41") });
        const refused = yield* start(
          server,
          { intent: "sign-in" },
          { headers: remoteStart("198.51.100.42") },
        );
        assert.equal(refused.status, 503);
        assert.isUndefined(refused.flowCookie);
        const back = yield* realm.signIn(first.authorizationUrl, { sub: "kc-nobody" });
        const answer = yield* callback(server, back, joinCookies(first.flowCookie), {
          headers: remoteClient("198.51.100.40"),
        });
        assert.equal(resultOf(answer.location), "invitation-only");
      }),
    );

    it.effect("is refused while Keycloak is off", () =>
      Effect.gen(function* () {
        const { server, owner } = yield* hub();
        yield* server.request("/api/installation/sign-in-settings", {
          cookie: owner,
          body: { keycloakEnabled: false },
        });
        assert.equal((yield* start(server, { intent: "sign-in" })).status, 403);
        const session = yield* server.request("/api/auth/session");
        assert.deepEqual(session.body.signInOptions, { keycloak: false });
      }),
    );
  });

  it.effect("over HTTPS only the `__Host-` flow cookie binds the flow", () =>
    Effect.gen(function* () {
      const { server, realm, ownerId } = yield* hub();
      yield* server.sql`
        INSERT INTO user_identities (user_id, issuer, subject, linked_at, updated_at)
        VALUES (${ownerId}, ${realm.issuer}, 'kc-ada', '2026-01-01', '2026-01-01')
      `;
      const started = yield* start(
        server,
        { intent: "sign-in" },
        { headers: remoteStart("198.51.100.50") },
      );
      assert.match(started.flowCookie ?? "", /^__Host-t3_keycloak_flow=/);
      // The same value under the bare name, as a sibling host could toss it: refused.
      const tossed = `t3_keycloak_flow=${started.flowCookie?.split("=")[1] ?? ""}`;
      const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-ada" });
      const answer = yield* callback(server, back, tossed, {
        headers: remoteClient("198.51.100.50"),
      });
      assert.equal(resultOf(answer.location), "failed");
      assert.isUndefined(answer.cookie);
    }),
  );

  it.effect("a reset link replaces Keycloak too: the old identity no longer signs in", () =>
    Effect.gen(function* () {
      const { server, realm, owner, ownerId } = yield* hub();
      const member = yield* memberWithPassword(server);
      const linked = yield* roundTrip(
        server,
        realm,
        { sub: "kc-grace" },
        { intent: "link", reauth: { method: "password", password: PASSWORD } },
        member.cookie,
      );
      assert.equal(linked.status, 303);
      const issued = yield* Context.get(
        server.services,
        UserDirectory.UserDirectory,
      ).issueResetLink({ userId: UserId.make(member.id), createdBy: UserId.make(ownerId) });
      assert.isTrue(Option.isSome(issued));
      const token = Option.isSome(issued) ? issued.value.token : "";
      const redeemed = yield* server.request("/api/auth/reset/password", {
        body: { token, loginName: "grace", password: PASSWORD },
      });
      assert.equal(redeemed.status, 200, redeemed.text);

      // Only the new password lets them in now; their Keycloak account is a stranger.
      const viaKeycloak = yield* roundTrip(server, realm, { sub: "kc-grace" });
      assert.equal(viaKeycloak.location, "/sign-in?keycloak=invitation-only");
      const viaPassword = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: PASSWORD },
      });
      assert.equal(viaPassword.status, 200);
      assert.equal(yield* userOf(server, viaPassword.cookie), member.id);
      assert.isUndefined((yield* account(server, viaPassword.cookie ?? "")).identity);
      const live = yield* server.sql`
        SELECT login_id FROM identity_logins WHERE user_id = ${member.id} AND ended_at IS NULL
      `;
      assert.deepEqual(live, []);
      const audit = yield* server.request("/api/installation/audit?action=resetLink.redeem", {
        cookie: owner,
      });
      const entries = audit.body.entries as ReadonlyArray<{ detail: Record<string, unknown> }>;
      assert.deepEqual(entries[0]?.detail, { method: "password", identityRemoved: true });
    }),
  );

  it.effect("the refresh token is sealed to its login, and no secret or token leaks", () => {
    const recorded: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          recorded.push(
            span.name,
            ...Array.from(span.attributes.values(), (value) => String(value)),
            ...span.events.map((event) =>
              JSON.stringify(event, (_key, value) =>
                typeof value === "bigint" ? String(value) : value,
              ),
            ),
            String(exit),
          );
          end(endTime, exit);
        };
        return span;
      },
    });
    const logged: Array<string> = [];
    const logger = Logger.make((options) => {
      logged.push(
        String(options.message),
        JSON.stringify(options.fiber.getRef(References.CurrentLogAnnotations)),
      );
      recorded.push(
        String(options.message),
        String(options.cause),
        JSON.stringify(options.fiber.getRef(References.CurrentLogAnnotations)),
      );
    });
    return Effect.gen(function* () {
      const { server, realm, owner, authenticator } = yield* hub();
      const answers: Array<{
        readonly text: string;
        readonly setCookies: ReadonlyArray<string>;
        readonly location?: string | undefined;
      }> = [];
      const started = yield* start(
        server,
        {
          intent: "link",
          reauth: yield* passkeyReauth(server, authenticator),
        },
        { cookie: owner },
      );
      answers.push(started);
      const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-ada" });
      const code = new URL(back).searchParams.get("code") ?? "";
      const linked = yield* callback(server, back, joinCookies(started.flowCookie, owner));
      answers.push(linked);
      const again = yield* roundTrip(server, realm, { sub: "kc-ada" });
      answers.push(again);
      answers.push(yield* roundTrip(server, realm, { sub: "kc-stranger" }));
      answers.push(yield* roundTrip(server, realm, { sub: "kc-ada", claims: { nonce: "x" } }));
      answers.push(yield* server.request("/api/auth/account", { cookie: again.cookie ?? "" }));
      answers.push(
        yield* server.request("/api/installation/audit", { cookie: again.cookie ?? "" }),
      );

      const logins = yield* server.sql<{ loginId: string; sealed: string | null; offline: number }>`
        SELECT login_id AS "loginId", refresh_token_sealed AS "sealed", offline FROM identity_logins
      `;
      // The link and the sign-in after it; the stranger and the bad nonce kept nothing.
      assert.equal(logins.length, 2);
      assert.equal(realm.refreshTokens.length, 4);
      // Sealed under the login's id: it opens there, and a row copied to another login does not.
      const key = yield* Context.get(
        server.services,
        ServerSecretStore.ServerSecretStore,
      ).getOrCreateRandom(KeycloakSignIn.REFRESH_TOKEN_KEY_NAME, 32);
      const [first, second] = logins;
      assert.equal(first?.offline, 1);
      const opened = yield* AccountCredentials.open(
        key,
        first?.sealed ?? "",
        KeycloakSignIn.refreshTokenContext(first?.loginId ?? ""),
      ).pipe(Effect.provide(NodeCrypto.layer));
      assert.include(realm.refreshTokens, new TextDecoder().decode(opened));
      const moved = yield* AccountCredentials.open(
        key,
        first?.sealed ?? "",
        KeycloakSignIn.refreshTokenContext(second?.loginId ?? ""),
      ).pipe(Effect.provide(NodeCrypto.layer), Effect.exit);
      assert.equal(moved._tag, "Failure");

      // The client secret went to the realm only in the Basic header.
      assert.isAbove(realm.tokenRequests.length, 0);
      for (const request of realm.tokenRequests) {
        assert.notInclude(request.body, realm.clientSecret);
        assert.match(request.authorization ?? "", /^Basic /);
      }

      const rows = [
        ...(yield* server.sql`SELECT * FROM audit_log`),
        ...(yield* server.sql`SELECT * FROM identity_logins`),
        ...(yield* server.sql`SELECT * FROM user_identities`),
        ...(yield* server.sql`SELECT * FROM auth_sessions`),
      ];
      const seen = [
        ...answers.flatMap((answer) => [answer.text, answer.location ?? "", ...answer.setCookies]),
        ...rows.map((row) => JSON.stringify(row)),
        ...recorded,
      ];
      assert.isAbove(recorded.length, 10, "the logger and tracer recorded the requests");
      for (const secret of [realm.clientSecret, code, ...realm.refreshTokens]) {
        assert.deepEqual(
          seen.filter((text) => text.includes(secret)),
          [],
          "a secret or token came back out",
        );
      }
      // Nothing logs who the stranger was.
      assert.deepEqual(
        logged.filter((text) => text.includes("kc-stranger")),
        [],
      );
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      // As the server serves its routes: the callback's address (code, state) is never traced.
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, isUntracedRequest),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});

describe("KeycloakSignIn.safeReturnTo", () => {
  it("keeps a path on this Hub and refuses anything a browser could read as another host", () => {
    assert.equal(KeycloakSignIn.safeReturnTo("/settings/user/account"), "/settings/user/account");
    assert.equal(KeycloakSignIn.safeReturnTo("/connect-agent?a=1#b"), "/connect-agent?a=1#b");
    for (const value of [
      "//x.test",
      "/\\x.test",
      "x.test",
      "https://x.test",
      "/\tx",
      "",
      // Dot segments that a browser would fold into `//x.test`.
      "/..//x.test",
      "/.//x.test",
      "/a/../..//x.test",
      "/%2e%2e//x.test",
    ]) {
      assert.isUndefined(KeycloakSignIn.safeReturnTo(value), value);
    }
  });
});

describe("what later tickets build on", () => {
  it("the URLs the Owner gives Keycloak are the doors this ticket serves", () => {
    assert.deepEqual(keycloakClientUrls("https://hub.example/x"), {
      redirect: `https://hub.example${KEYCLOAK_CALLBACK_PATH}`,
      backchannelLogout: `https://hub.example${KEYCLOAK_BACKCHANNEL_LOGOUT_PATH}`,
      postLogout: `https://hub.example${KEYCLOAK_POST_LOGOUT_PATH}`,
    });
  });

  it.effect("the fake realm's issuer never resolves", () =>
    Effect.gen(function* () {
      assert.equal((yield* makeFakeKeycloak()).issuer, TEST_ISSUER);
      assert.match(new URL(TEST_ISSUER).hostname, /\.test$/);
    }),
  );

  it("verifies only the spec's algorithms", () => {
    assert.deepEqual([...KeycloakClient.ID_TOKEN_ALGORITHMS], ["RS256", "PS256", "ES256", "EdDSA"]);
    assert.equal(KeycloakClient.usableKeys({ keys: [] }).length, 0);
  });
});

/** An Organization of the Owner's and a link into it, as the Owner makes one. */
const organizationInvite = Effect.fn(function* (
  server: Server,
  owner: string,
  role: "admin" | "member" | "guest" = "member",
  name = "Acme",
) {
  const organization = yield* server.request("/api/spaces/organizations", {
    body: { name },
    cookie: owner,
  });
  assert.equal(organization.status, 200, organization.text);
  return yield* anotherInvite(server, owner, organization.body.id as string, role);
});

/** Another link into an Organization that exists. */
const anotherInvite = Effect.fn(function* (
  server: Server,
  owner: string,
  spaceId: string,
  role: "admin" | "member" | "guest" = "member",
) {
  const created = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    body: { role },
    cookie: owner,
  });
  assert.equal(created.status, 200, created.text);
  return {
    spaceId,
    token: created.body.token as string,
    invitationId: (created.body.invitation as { id: string }).id,
  };
});

const setMode = Effect.fn(function* (
  server: Server,
  owner: string,
  registrationMode: "open" | "invitation-only" | "closed",
) {
  const saved = yield* server.request("/api/installation/sign-in-settings", {
    cookie: owner,
    body: { registrationMode },
  });
  assert.equal(saved.status, 200, saved.text);
});

const invitationStart = (token: string) => ({ intent: "invitation", invitationToken: token });

const invitationRow = (server: Server, invitationId: string) =>
  server.sql<{ acceptedBy: string | null; acceptedAt: string | null }>`
      SELECT accepted_by AS "acceptedBy", accepted_at AS "acceptedAt" FROM space_invitations
      WHERE invitation_id = ${invitationId}
    `.pipe(Effect.map((rows) => rows[0]));

const userCount = (server: Server) =>
  server.sql<{ count: number }>`SELECT COUNT(*) AS count FROM users`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

const membershipsOf = (server: Server, userId: string) =>
  server.sql<{ spaceId: string; role: string }>`
    SELECT space_id AS "spaceId", role FROM space_memberships WHERE user_id = ${userId}
  `;

interface AuditRow {
  readonly actor: { readonly userId: string | null };
  readonly target: { readonly kind: string; readonly id: string; readonly name: string | null };
  readonly detail: Record<string, unknown>;
}

const auditOf = (server: Server, owner: string, action: string) =>
  server
    .request(`/api/installation/audit?action=${action}`, { cookie: owner })
    .pipe(Effect.map((answer) => answer.body.entries as ReadonlyArray<AuditRow>));

/** A Member whose sign-in is a Keycloak identity (`sub`), linked through ticket 02's flow. */
const linkedMember = Effect.fn(function* (
  server: Server,
  realm: FakeKeycloak,
  sub: string,
  email?: string,
) {
  const member = yield* memberWithPassword(server);
  const linked = yield* roundTrip(
    server,
    realm,
    { sub, ...(email === undefined ? {} : { email }) },
    { intent: "link", reauth: { method: "password", password: PASSWORD } },
    member.cookie,
  );
  assert.equal(linked.status, 303);
  return { id: member.id, cookie: linked.cookie ?? "" };
});

describe("Keycloak admission (ticket 03)", () => {
  describe("a new identity without an Invitation", () => {
    it.effect("open: gets a User of its own, without Organizations, audited `user.register`", () =>
      Effect.gen(function* () {
        const { server, realm, owner, ownerId } = yield* hub();
        yield* setMode(server, owner, "open");
        const signedIn = yield* roundTrip(server, realm, {
          sub: "kc-lin",
          username: "lin",
          email: "lin@example.test",
          claims: { name: "  Lin‮ \u0007Lee " },
        });
        assert.equal(signedIn.status, 303);
        assert.equal(signedIn.location, "/");
        const userId = (yield* userOf(server, signedIn.cookie)) ?? "";
        assert.notEqual(userId, "");
        assert.notEqual(userId, ownerId);

        const users = yield* server.sql<{ displayName: string; loginName: string | null }>`
          SELECT display_name AS "displayName", login_name AS "loginName" FROM users
          WHERE user_id = ${userId}
        `;
        assert.deepEqual(users, [{ displayName: "Lin Lee", loginName: null }]);
        assert.deepEqual(yield* membershipsOf(server, userId), []);
        const identity = yield* server.sql<{ subject: string; username: string | null }>`
          SELECT subject, username FROM user_identities WHERE user_id = ${userId}
        `;
        assert.deepEqual(identity, [{ subject: "kc-lin", username: "lin" }]);
        const sessions = yield* server.sql<{ identityLoginId: string | null }>`
          SELECT identity_login_id AS "identityLoginId" FROM auth_sessions
          WHERE user_id = ${userId} AND revoked_at IS NULL
        `;
        assert.equal(sessions.length, 1);
        assert.isString(sessions[0]?.identityLoginId);

        const registered = yield* auditOf(server, owner, "user.register");
        assert.equal(registered.length, 1);
        assert.equal(registered[0]?.actor.userId, userId);
        assert.deepInclude(registered[0]?.target, { kind: "user", id: userId });
        assert.deepEqual(registered[0]?.detail, { via: "open", issuer: realm.issuer });

        // The next time, the same identity simply signs in.
        const again = yield* roundTrip(server, realm, { sub: "kc-lin" });
        assert.equal(yield* userOf(server, again.cookie), userId);
        assert.equal((yield* auditOf(server, owner, "user.register")).length, 1);
      }),
    );

    it.effect("a label refreshed at sign-in is cleaned as a new name is", () =>
      Effect.gen(function* () {
        const { server, realm } = yield* hub();
        const member = yield* linkedMember(server, realm, "kc-grace");
        const again = yield* roundTrip(server, realm, {
          sub: "kc-grace",
          username: "gra‮ce\u0000",
        });
        assert.equal(yield* userOf(server, again.cookie), member.id);
        assert.equal((yield* account(server, again.cookie ?? "")).identity?.username, "grace");
      }),
    );

    it.effect.each([
      { mode: "invitation-only", reason: "invitation-only" },
      { mode: "closed", reason: "registration-closed" },
    ] as const)("$mode: is refused with «$reason», and nothing is kept", ({ mode, reason }) =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        yield* setMode(server, owner, mode);
        const before = yield* userCount(server);
        const refused = yield* roundTrip(server, realm, { sub: "kc-lin" });
        assert.equal(refused.location, `/sign-in?keycloak=${reason}`);
        assert.isUndefined(refused.cookie);
        assert.equal(yield* userCount(server), before);
        assert.deepEqual(yield* server.sql`SELECT * FROM user_identities`, []);
        assert.deepEqual(yield* server.sql`SELECT * FROM identity_logins`, []);
      }),
    );
  });

  describe("a new identity with an Organization Invitation", () => {
    it.effect.each([{ mode: "open" }, { mode: "invitation-only" }] as const)(
      "$mode: becomes a User and a Member in one go, spending the Invitation",
      ({ mode }) =>
        Effect.gen(function* () {
          const { server, realm, owner } = yield* hub();
          yield* setMode(server, owner, mode);
          const invitation = yield* organizationInvite(server, owner, "guest");
          const accepted = yield* roundTrip(
            server,
            realm,
            { sub: "kc-lin", username: "lin" },
            invitationStart(invitation.token),
          );
          assert.equal(accepted.status, 303);
          assert.equal(accepted.location, "/");
          const userId = (yield* userOf(server, accepted.cookie)) ?? "";
          assert.notEqual(userId, "");
          // The Role comes from the Invitation, never from a claim.
          assert.deepEqual(yield* membershipsOf(server, userId), [
            { spaceId: invitation.spaceId, role: "guest" },
          ]);
          assert.equal((yield* invitationRow(server, invitation.invitationId))?.acceptedBy, userId);
          const users = yield* server.sql<{ displayName: string; loginName: string | null }>`
            SELECT display_name AS "displayName", login_name AS "loginName" FROM users
            WHERE user_id = ${userId}
          `;
          assert.deepEqual(users, [{ displayName: "lin", loginName: null }]);

          const acceptance = yield* auditOf(server, owner, "invitation.accept");
          assert.equal(acceptance.length, 1);
          assert.equal(acceptance[0]?.actor.userId, userId);
          assert.deepEqual(acceptance[0]?.detail, { role: "guest", newUser: true });
          // Created through an Invitation: not a registration.
          assert.deepEqual(yield* auditOf(server, owner, "user.register"), []);
        }),
    );

    it.effect("closed: is refused, the Invitation stays unspent and nothing is created", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        yield* setMode(server, owner, "closed");
        const invitation = yield* organizationInvite(server, owner);
        const before = yield* userCount(server);
        const refused = yield* roundTrip(
          server,
          realm,
          { sub: "kc-lin" },
          invitationStart(invitation.token),
        );
        assert.equal(refused.location, "/invite?keycloak=registration-closed");
        assert.isUndefined(refused.cookie);
        assert.equal(yield* userCount(server), before);
        assert.isNull((yield* invitationRow(server, invitation.invitationId))?.acceptedAt);
        assert.deepEqual(yield* server.sql`SELECT * FROM user_identities`, []);
      }),
    );

    it.effect("an Admin Invitation needs a strong sign-in: refused, unspent", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        const invitation = yield* organizationInvite(server, owner, "admin");
        const before = yield* userCount(server);
        const refused = yield* roundTrip(
          server,
          realm,
          { sub: "kc-lin" },
          invitationStart(invitation.token),
        );
        assert.equal(refused.location, "/invite?keycloak=strong-factor-required");
        assert.equal(yield* userCount(server), before);
        assert.isNull((yield* invitationRow(server, invitation.invitationId))?.acceptedAt);
      }),
    );

    it.effect("an Invitation that expires while the person is at Keycloak is refused", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        const invitation = yield* organizationInvite(server, owner);
        yield* TestClock.adjust("6 days");
        yield* TestClock.adjust("23 hours");
        yield* TestClock.adjust("55 minutes");
        const started = yield* start(server, invitationStart(invitation.token));
        assert.equal(started.status, 200, started.text);
        const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-lin" });
        // Seven days have passed; the flow itself (10 minutes) is still alive.
        yield* TestClock.adjust("6 minutes");
        const before = yield* userCount(server);
        const refused = yield* callback(server, back, joinCookies(started.flowCookie));
        assert.equal(refused.location, "/invite?keycloak=invitation-invalid");
        assert.isUndefined(refused.cookie);
        assert.equal(yield* userCount(server), before);
      }),
    );

    it.effect("an Invitation revoked while the person is at Keycloak is refused", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        yield* setMode(server, owner, "open");
        const invitation = yield* organizationInvite(server, owner);
        const started = yield* start(server, invitationStart(invitation.token));
        assert.equal(started.status, 200, started.text);
        const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-lin" });
        const revoked = yield* server.request("/api/invitations/revoke", {
          body: { invitationId: invitation.invitationId },
          cookie: owner,
        });
        assert.equal(revoked.status, 200, revoked.text);
        const before = yield* userCount(server);
        const refused = yield* callback(server, back, joinCookies(started.flowCookie));
        // Even with registration open: who came to accept an Invitation gets no empty User.
        assert.equal(refused.location, "/invite?keycloak=invitation-invalid");
        assert.isUndefined(refused.cookie);
        assert.equal(yield* userCount(server), before);
      }),
    );

    it.effect("two people racing for one Invitation: exactly one gets it", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        const invitation = yield* organizationInvite(server, owner);
        const racers = yield* Effect.forEach(["kc-lin", "kc-max"], (sub, index) =>
          Effect.gen(function* () {
            const address = `198.51.100.${60 + index}`;
            const started = yield* start(server, invitationStart(invitation.token), {
              headers: remoteStart(address),
            });
            assert.equal(started.status, 200, started.text);
            const back = yield* realm.signIn(started.authorizationUrl, { sub });
            return { back, started, address };
          }),
        );
        const before = yield* userCount(server);
        const answers = yield* Effect.forEach(
          racers,
          ({ back, started, address }) =>
            callback(server, back, joinCookies(started.flowCookie), {
              headers: remoteClient(address),
            }),
          { concurrency: "unbounded" },
        );
        assert.equal(answers.filter((answer) => answer.cookie !== undefined).length, 1);
        assert.deepEqual(
          answers.filter((answer) => answer.cookie === undefined).map((answer) => answer.location),
          ["/invite?keycloak=invitation-invalid"],
        );
        assert.equal(yield* userCount(server), before + 1);
        const members = yield* server.sql`
          SELECT user_id FROM space_memberships WHERE space_id = ${invitation.spaceId}
        `;
        assert.equal(members.length, 1);
        assert.equal((yield* server.sql`SELECT * FROM user_identities`).length, 1);
        assert.equal((yield* auditOf(server, owner, "invitation.accept")).length, 1);
      }),
    );
  });

  describe("an Invitation token at `start`", () => {
    it.effect("is checked before leaving for Keycloak, and only `invitation` takes one", () =>
      Effect.gen(function* () {
        const { server, owner } = yield* hub();
        const invitation = yield* organizationInvite(server, owner);
        const bad = yield* start(server, invitationStart("not-a-token"));
        assert.equal(bad.status, 400);
        assert.isUndefined(bad.flowCookie);
        assert.isUndefined(bad.authorizationUrl);
        // Today's preview says no more: one message for unknown, used, expired or revoked.
        assert.include(bad.text, "no longer valid");
        assert.equal((yield* start(server, { intent: "invitation" })).status, 400);
        assert.equal(
          (yield* start(server, { intent: "sign-in", invitationToken: invitation.token })).status,
          400,
        );
        // Checking it spends nothing.
        const ok = yield* start(server, invitationStart(invitation.token));
        assert.equal(ok.status, 200);
        assert.isNull((yield* invitationRow(server, invitation.invitationId))?.acceptedAt);
      }),
    );
  });

  describe("an existing User accepting through Keycloak", () => {
    it.effect("joins the Organization as `/api/invitations/join` does, even when closed", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        yield* setMode(server, owner, "closed");
        const member = yield* linkedMember(server, realm, "kc-grace");
        const invitation = yield* organizationInvite(server, owner);
        const joined = yield* roundTrip(
          server,
          realm,
          { sub: "kc-grace" },
          invitationStart(invitation.token),
        );
        assert.equal(joined.status, 303);
        assert.equal(joined.location, "/");
        assert.equal(yield* userOf(server, joined.cookie), member.id);
        assert.deepEqual(yield* membershipsOf(server, member.id), [
          { spaceId: invitation.spaceId, role: "member" },
        ]);
        const acceptance = yield* auditOf(server, owner, "invitation.accept");
        assert.deepEqual(acceptance[0]?.detail, { role: "member", newUser: false });
      }),
    );

    it.effect("gets join's refusals, signed in, and the Invitation stays unspent", () =>
      Effect.gen(function* () {
        const { server, realm, owner, authenticator } = yield* hub();
        const member = yield* linkedMember(server, realm, "kc-grace");
        const first = yield* organizationInvite(server, owner);
        const joined = yield* roundTrip(
          server,
          realm,
          { sub: "kc-grace" },
          invitationStart(first.token),
        );
        assert.equal(joined.location, "/");
        const acceptWith = (token: string, sub = "kc-grace") =>
          roundTrip(server, realm, { sub }, invitationStart(token));

        // Already in it.
        const again = yield* anotherInvite(server, owner, first.spaceId);
        const already = yield* acceptWith(again.token);
        assert.equal(already.location, "/invite?keycloak=already-member");
        assert.equal(yield* userOf(server, already.cookie), member.id);
        assert.isNull((yield* invitationRow(server, again.invitationId))?.acceptedAt);

        // An Admin's Role needs a strong sign-in, which a Keycloak login is not yet.
        const admin = yield* organizationInvite(server, owner, "admin", "Beta");
        const weak = yield* acceptWith(admin.token);
        assert.equal(weak.location, "/invite?keycloak=strong-factor-required");
        assert.isNull((yield* invitationRow(server, admin.invitationId))?.acceptedAt);

        // Revoked while at Keycloak: still signed in, told the link is no longer valid.
        const doomed = yield* organizationInvite(server, owner, "member", "Gamma");
        const started = yield* start(server, invitationStart(doomed.token));
        const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-grace" });
        yield* server.request("/api/invitations/revoke", {
          body: { invitationId: doomed.invitationId },
          cookie: owner,
        });
        const dead = yield* callback(server, back, joinCookies(started.flowCookie));
        assert.equal(dead.location, "/invite?keycloak=invitation-invalid");
        assert.equal(yield* userOf(server, dead.cookie), member.id);

        // The Owner sees every Organization already.
        const reauth = yield* passkeyReauth(server, authenticator);
        const ownerLinked = yield* roundTrip(
          server,
          realm,
          { sub: "kc-ada" },
          { intent: "link", reauth },
          owner,
        );
        assert.equal(ownerLinked.status, 303);
        const forOwner = yield* anotherInvite(server, ownerLinked.cookie ?? "", first.spaceId);
        const ownerAnswer = yield* acceptWith(forOwner.token, "kc-ada");
        assert.equal(ownerAnswer.location, "/invite?keycloak=owner");
        assert.isNull((yield* invitationRow(server, forOwner.invitationId))?.acceptedAt);
      }),
    );
  });

  describe("an identity is its issuer and subject, never its email", () => {
    it.effect("a stranger with a User's email gets a new User when open, never that one", () =>
      Effect.gen(function* () {
        const { server, realm, owner } = yield* hub();
        yield* setMode(server, owner, "open");
        const member = yield* linkedMember(server, realm, "kc-grace", "grace@example.test");
        const stranger = yield* roundTrip(server, realm, {
          sub: "kc-impostor",
          email: "grace@example.test",
          username: "grace",
        });
        const strangerId = (yield* userOf(server, stranger.cookie)) ?? "";
        assert.notEqual(strangerId, "");
        assert.notEqual(strangerId, member.id);
        const identities = yield* server.sql<{ userId: string; subject: string }>`
          SELECT user_id AS "userId", subject FROM user_identities ORDER BY subject
        `;
        assert.deepEqual(identities, [
          { userId: member.id, subject: "kc-grace" },
          { userId: strangerId, subject: "kc-impostor" },
        ]);
      }),
    );

    it.effect("and is refused when invitation only, saying nothing about that account", () =>
      Effect.gen(function* () {
        const { server, realm } = yield* hub();
        yield* linkedMember(server, realm, "kc-grace", "grace@example.test");
        const before = yield* userCount(server);
        const stranger = yield* roundTrip(server, realm, {
          sub: "kc-impostor",
          email: "grace@example.test",
        });
        assert.equal(stranger.location, "/sign-in?keycloak=invitation-only");
        assert.isUndefined(stranger.cookie);
        assert.equal(yield* userCount(server), before);
        assert.equal((yield* server.sql`SELECT * FROM user_identities`).length, 1);
      }),
    );
  });

  it.effect("the Invitation token never leaves the Hub's side of the flow", () => {
    const recorded: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          recorded.push(
            span.name,
            ...Array.from(span.attributes.values(), (value) => String(value)),
            ...span.events.map((event) =>
              JSON.stringify(event, (_key, value) =>
                typeof value === "bigint" ? String(value) : value,
              ),
            ),
            String(exit),
          );
          end(endTime, exit);
        };
        return span;
      },
    });
    const logger = Logger.make((options) => {
      recorded.push(
        String(options.message),
        String(options.cause),
        JSON.stringify(options.fiber.getRef(References.CurrentLogAnnotations)),
      );
    });
    return Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const accepted = yield* organizationInvite(server, owner);
      const refused = yield* organizationInvite(server, owner, "admin", "Beta");
      // Making a link answers its token to the Owner; from here on it is the invitee's flow.
      recorded.length = 0;
      const started = yield* start(server, invitationStart(accepted.token));
      const back = yield* realm.signIn(started.authorizationUrl, { sub: "kc-lin" });
      const answer = yield* callback(server, back, joinCookies(started.flowCookie));
      assert.equal(answer.location, "/");
      const refusedAnswer = yield* roundTrip(
        server,
        realm,
        { sub: "kc-max" },
        invitationStart(refused.token),
      );
      const rows = [
        ...(yield* server.sql`SELECT * FROM audit_log`),
        ...(yield* server.sql`SELECT * FROM identity_logins`),
        ...(yield* server.sql`SELECT * FROM user_identities`),
        ...(yield* server.sql`SELECT * FROM auth_sessions`),
      ];
      const seen = [
        started.authorizationUrl,
        started.text,
        ...started.setCookies,
        back,
        ...realm.tokenRequests.map((request) => request.body),
        answer.location ?? "",
        refusedAnswer.location ?? "",
        ...rows.map((row) => JSON.stringify(row)),
        ...recorded,
      ];
      assert.isAbove(recorded.length, 10, "the logger and tracer recorded the requests");
      for (const token of [accepted.token, refused.token]) {
        assert.deepEqual(
          seen.filter((text) => text.includes(token)).map((text) => text.slice(0, 400)),
          [],
          "an Invitation token came back out",
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, isUntracedRequest),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});
