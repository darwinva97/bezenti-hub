/**
 * Keycloak sign-ins after the callback at the server's edge (Keycloak sign-in spec, «Bajas», ticket
 * 07): the hourly re-check, the back-channel logout, the sessions that inherit a sign-in and
 * «also sign out of Keycloak». The real HTTP doors over SQLite in memory and a fake realm; time is
 * TestClock's, and a background re-check is awaited by its outcome or the revocation it causes.
 */
import { KEYCLOAK_BACKCHANNEL_LOGOUT_PATH } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { isUntracedRequest } from "../http.ts";
import { type FakeKeycloak, type FakeSignIn, makeFakeKeycloak } from "./Keycloak.testkit.ts";
import * as KeycloakLogins from "./KeycloakLogins.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  makeAuthenticator,
  type Server,
  serveAuthHttpWith,
  type TestSignInOptions,
} from "./UserAuth.testkit.ts";

const START = "/api/auth/keycloak/start";
const PASSWORD = "correct horse battery staple";
const STRONG = { amr: ["pwd", "otp"] };

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
        strongAcr: ["critica"],
        strongAmr: ["otp"],
      },
    });
    assert.equal(on.status, 200, on.text);
    return { realm, server, owner };
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

/** A Member who signs in only with Keycloak as `sub` (linked through ticket 02's flow). */
const keycloakMember = Effect.fn(function* (
  server: Server,
  realm: FakeKeycloak,
  sub: string,
  as: Omit<FakeSignIn, "sub"> = {},
) {
  const id = `member-${sub}`;
  const local = yield* addMember(server, { id, displayName: `Member ${sub}` });
  const saved = yield* server.request("/api/auth/account/password", {
    cookie: local,
    body: { loginName: id, password: PASSWORD },
  });
  assert.equal(saved.status, 200, saved.text);
  const linked = yield* roundTrip(
    server,
    realm,
    { sub, ...as },
    { intent: "link", reauth: { method: "password", password: PASSWORD } },
    local,
  );
  assert.equal(linked.status, 303, linked.text);
  return { id, cookie: linked.cookie ?? "" };
});

const tokenOf = (cookie: string) => cookie.split("=")[1] ?? "";

/** The Keycloak sign-in a cookie's session comes from. */
const loginOf = Effect.fn(function* (server: Server, cookie: string) {
  const session = yield* server.sessions.verify(tokenOf(cookie));
  assert.isString(session.identityLoginId);
  return { sessionId: session.sessionId, loginId: session.identityLoginId ?? "" };
});

/** A socket that waits on the cookie's session until it is revoked. */
const watchSocket = Effect.fn(function* (server: Server, cookie: string) {
  const session = yield* server.sessions.verify(tokenOf(cookie));
  return yield* server.sessions
    .awaitInvalidation(session.sessionId)
    .pipe(Effect.forkScoped({ startImmediately: true }));
});

const loginsOf = (server: Server) => Context.get(server.services, KeycloakLogins.KeycloakLogins);

/** The next re-check of `loginId` that did something (`skipped` ones are passed over). */
const nextRecheck = Effect.fn(function* (server: Server, loginId: string) {
  const outcomes = yield* loginsOf(server).recheckOutcomes;
  return yield* outcomes.pipe(
    Stream.filter((outcome) => outcome.loginId === loginId && outcome.outcome !== "skipped"),
    Stream.runHead,
    Effect.map((outcome) => Option.getOrUndefined(outcome)?.outcome),
    Effect.forkScoped({ startImmediately: true }),
  );
});

/** One use of the session: an HTTP request it signs. */
const use = (server: Server, cookie: string) => server.request("/api/auth/session", { cookie });

interface AuditRow {
  readonly actor: { readonly source: string; readonly userId: string | null };
  readonly target: { readonly kind: string; readonly id: string };
  readonly detail: Record<string, unknown>;
}

const auditOf = (server: Server, owner: string, action: string) =>
  server
    .request(`/api/installation/audit?action=${action}`, { cookie: owner })
    .pipe(Effect.map((answer) => answer.body.entries as ReadonlyArray<AuditRow>));

const statusOf = (server: Server, owner: string) =>
  server.request("/api/installation/sign-in-settings", { cookie: owner }).pipe(
    Effect.map(
      (answer) =>
        answer.body.keycloakStatus as {
          unreachableSince: string | null;
          problem: string | null;
          lastLoginOffline: boolean | null;
        },
    ),
  );

const backchannel = (server: Server, form: Record<string, string>) =>
  server.request(KEYCLOAK_BACKCHANNEL_LOGOUT_PATH, { form, omitOrigin: true });

describe("re-checking a Keycloak sign-in in use (ticket 07)", () => {
  it.effect("after an hour, one use re-checks; a refused refresh ends it and its socket", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const socket = yield* watchSocket(server, member.cookie);
      // Disabled in Keycloak: its refresh token is refused from now on.
      realm.refreshAs("kc-ana", { kind: "refused" });

      yield* TestClock.adjust("61 minutes");
      yield* use(server, member.cookie);
      yield* Fiber.join(socket);

      assert.isFalse(yield* isSignedIn(server, member.cookie));
      const ended = yield* auditOf(server, owner, "keycloak.login.end");
      assert.deepEqual(
        ended.map((row) => ({
          source: row.actor.source,
          target: row.target.id,
          detail: row.detail,
        })),
        [
          {
            source: "system",
            target: member.id,
            detail: { reason: "refresh-refused", sessions: 1, pairingLinks: 0 },
          },
        ],
      );
      const rows = yield* server.sql<{ refresh: string | null; id: string | null }>`
        SELECT refresh_token_sealed AS refresh, id_token_sealed AS id FROM identity_logins
        WHERE user_id = ${member.id}
      `;
      // An ended sign-in keeps no token.
      assert.deepEqual(rows, [{ refresh: null, id: null }]);
    }).pipe(Effect.scoped),
  );

  it.effect("under an hour, nothing is asked of Keycloak", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      yield* TestClock.adjust("59 minutes");
      yield* use(server, member.cookie);
      assert.equal(realm.refreshCounts.requests, 0);
      assert.isTrue(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it.effect("an open socket is use: it re-checks on the hour without any request", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const socket = yield* watchSocket(server, member.cookie);
      realm.refreshAs("kc-ana", { kind: "refused" });
      yield* TestClock.adjust("61 minutes");
      yield* Fiber.join(socket);
      assert.isFalse(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it.effect("Keycloak not answering signs nobody out; the Owner sees since when", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const { loginId } = yield* loginOf(server, member.cookie);
      assert.deepEqual(yield* statusOf(server, owner), {
        unreachableSince: null,
        problem: null,
        lastLoginOffline: true,
      });

      realm.refreshAs("kc-ana", { kind: "unavailable" });
      yield* TestClock.adjust("61 minutes");
      const first = yield* nextRecheck(server, loginId);
      yield* use(server, member.cookie);
      assert.equal(yield* Fiber.join(first), "kept");
      assert.isTrue(yield* isSignedIn(server, member.cookie));
      const down = yield* statusOf(server, owner);
      assert.equal(down.problem, "unreachable");
      assert.isString(down.unreachableSince);

      // No connection at all, after the back-off: still nobody out, and still since then.
      realm.refreshAs("kc-ana", { kind: "unreachable" });
      yield* TestClock.adjust("2 minutes");
      const second = yield* nextRecheck(server, loginId);
      yield* use(server, member.cookie);
      assert.equal(yield* Fiber.join(second), "kept");
      assert.isTrue(yield* isSignedIn(server, member.cookie));
      assert.equal((yield* statusOf(server, owner)).unreachableSince, down.unreachableSince);

      // Keycloak answers again: re-checked, and the warning goes.
      realm.refreshAs("kc-ana", { kind: "ok" });
      yield* TestClock.adjust("3 minutes");
      const third = yield* nextRecheck(server, loginId);
      yield* use(server, member.cookie);
      assert.equal(yield* Fiber.join(third), "refreshed");
      assert.deepInclude(yield* statusOf(server, owner), { unreachableSince: null, problem: null });
      assert.isTrue(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it.effect("a realm that rejects the Hub's client keeps everyone in and says why", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const { loginId } = yield* loginOf(server, member.cookie);
      // The Owner saves a client secret the realm does not know.
      const saved = yield* server.request("/api/installation/sign-in-settings", {
        cookie: owner,
        body: { clientSecret: "not-the-realm-secret" },
      });
      assert.equal(saved.status, 200, saved.text);
      yield* TestClock.adjust("61 minutes");
      const done = yield* nextRecheck(server, loginId);
      yield* use(server, member.cookie);
      assert.equal(yield* Fiber.join(done), "kept");
      assert.isTrue(yield* isSignedIn(server, member.cookie));
      assert.equal((yield* statusOf(server, owner)).problem, "rejected");
    }).pipe(Effect.scoped),
  );

  it.effect("one re-check at a time, and the next one uses the rotated refresh token", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const { loginId } = yield* loginOf(server, member.cookie);
      yield* TestClock.adjust("61 minutes");
      const first = yield* nextRecheck(server, loginId);
      yield* Effect.all([use(server, member.cookie), use(server, member.cookie)], {
        concurrency: "unbounded",
      });
      assert.equal(yield* Fiber.join(first), "refreshed");
      assert.equal(realm.refreshCounts.requests, 1);

      yield* TestClock.adjust("61 minutes");
      const second = yield* nextRecheck(server, loginId);
      yield* use(server, member.cookie);
      assert.equal(yield* Fiber.join(second), "refreshed");
      // Keycloak rotates refresh tokens: a reused one would have been refused.
      assert.deepEqual(realm.refreshCounts, { requests: 2, reused: 0 });
      assert.isTrue(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it.effect("a sign-in without a refresh token ends at its first re-check", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana", { noRefreshToken: true });
      // The Owner is told the newest sign-in got no `offline_access`.
      assert.equal((yield* statusOf(server, owner)).lastLoginOffline, false);
      const socket = yield* watchSocket(server, member.cookie);
      yield* TestClock.adjust("61 minutes");
      yield* use(server, member.cookie);
      yield* Fiber.join(socket);
      const ended = yield* auditOf(server, owner, "keycloak.login.end");
      assert.equal(ended[0]?.detail.reason, "no-refresh-token");
    }).pipe(Effect.scoped),
  );
});

/**
 * Bezenti, an Organization of the Owner's, with `bezenti` mapped to Member and `bezenti-admin` to
 * Admin.
 */
const bezentiMapped = Effect.fn(function* (server: Server, owner: string) {
  const bezenti = yield* server.request("/api/spaces/organizations", {
    cookie: owner,
    body: { name: "Bezenti" },
  });
  const bezentiId = bezenti.body.id as string;
  const saved = yield* server.request("/api/installation/sign-in-settings", {
    cookie: owner,
    body: {
      groupMappings: [
        { group: "bezenti", spaceId: bezentiId, role: "member" },
        { group: "bezenti-admin", spaceId: bezentiId, role: "admin" },
      ],
    },
  });
  assert.equal(saved.status, 200, saved.text);
  return bezentiId;
});

const membershipsOf = (server: Server, userId: string) =>
  server.sql<{ spaceId: string; role: string; managed: number }>`
    SELECT space_id AS "spaceId", role, managed_by_keycloak AS managed
    FROM space_memberships WHERE user_id = ${userId}
  `;

describe("a re-check applies Keycloak's groups as a sign-in does (ticket 07)", () => {
  it.effect("leaving the group leaves the Organization within the hour", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const bezentiId = yield* bezentiMapped(server, owner);
      const lin = yield* roundTrip(server, realm, {
        sub: "kc-lin",
        claims: { groups: ["bezenti"] },
      });
      assert.equal(lin.status, 303, lin.text);
      const linId = (yield* server.request("/api/auth/session", { cookie: lin.cookie ?? "" })).body
        .userId as string;
      assert.deepEqual(yield* membershipsOf(server, linId), [
        { spaceId: bezentiId, role: "member", managed: 1 },
      ]);
      const { loginId } = yield* loginOf(server, lin.cookie ?? "");

      realm.refreshAs("kc-lin", { kind: "ok", claims: { groups: [] } });
      yield* TestClock.adjust("61 minutes");
      const done = yield* nextRecheck(server, loginId);
      yield* use(server, lin.cookie ?? "");
      assert.equal(yield* Fiber.join(done), "refreshed");
      assert.deepEqual(yield* membershipsOf(server, linId), []);
      // Audited as at a sign-in: by the server, naming the group.
      const removed = yield* auditOf(server, owner, "membership.remove");
      assert.deepEqual(
        removed.map((row) => ({ source: row.actor.source, detail: row.detail })),
        [{ source: "system", detail: { keycloakGroup: "bezenti" } }],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an Admin group on a weak sign-in makes them Admin and ends that sign-in", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const bezentiId = yield* bezentiMapped(server, owner);
      const lin = yield* roundTrip(server, realm, {
        sub: "kc-lin",
        claims: { groups: ["bezenti"] },
      });
      const linId = (yield* server.request("/api/auth/session", { cookie: lin.cookie ?? "" })).body
        .userId as string;
      const socket = yield* watchSocket(server, lin.cookie ?? "");

      realm.refreshAs("kc-lin", { kind: "ok", claims: { groups: ["bezenti-admin"] } });
      yield* TestClock.adjust("61 minutes");
      yield* use(server, lin.cookie ?? "");
      yield* Fiber.join(socket);
      // Keycloak says Admin, so they are; their weak sign-in can't be one, so it ended.
      assert.deepEqual(yield* membershipsOf(server, linId), [
        { spaceId: bezentiId, role: "admin", managed: 1 },
      ]);
      assert.isFalse(yield* isSignedIn(server, lin.cookie ?? ""));
    }).pipe(Effect.scoped),
  );
});

describe("back-channel logout (ticket 07)", () => {
  it.effect("by `sid` ends only that sign-in; by `sub`, every one of the identity", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const firstSid = realm.sidOf("kc-ana") ?? "";
      const second = yield* roundTrip(server, realm, { sub: "kc-ana" });
      const third = yield* roundTrip(server, realm, { sub: "kc-ana" });
      const firstSocket = yield* watchSocket(server, member.cookie);

      const bySid = yield* backchannel(server, {
        logout_token: yield* realm.logoutToken({ sid: firstSid, sub: "kc-ana" }),
      });
      assert.equal(bySid.status, 200, bySid.text);
      yield* Fiber.join(firstSocket);
      assert.isFalse(yield* isSignedIn(server, member.cookie));
      assert.isTrue(yield* isSignedIn(server, second.cookie ?? ""));
      assert.isTrue(yield* isSignedIn(server, third.cookie ?? ""));

      const bySub = yield* backchannel(server, {
        logout_token: yield* realm.logoutToken({ sub: "kc-ana" }),
      });
      assert.equal(bySub.status, 200, bySub.text);
      assert.isFalse(yield* isSignedIn(server, second.cookie ?? ""));
      assert.isFalse(yield* isSignedIn(server, third.cookie ?? ""));
      const ended = yield* auditOf(server, owner, "keycloak.login.end");
      assert.deepEqual(
        ended.map((row) => row.detail.reason),
        ["backchannel", "backchannel", "backchannel"],
      );
      // Nothing to end answers 200 all the same.
      const nobody = yield* backchannel(server, {
        logout_token: yield* realm.logoutToken({ sub: "kc-nobody" }),
      });
      assert.equal(nobody.status, 200);
    }).pipe(Effect.scoped),
  );

  it.effect("a token seen before, or not a logout token, is a 400 and ends nothing", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const nobody = yield* realm.logoutToken({ sub: "kc-nobody" });
      assert.equal((yield* backchannel(server, { logout_token: nobody })).status, 200);
      // The same `jti` again: a replay.
      assert.equal((yield* backchannel(server, { logout_token: nobody })).status, 400);

      const refused = [
        realm.logoutToken({ sub: "kc-ana", claims: { events: undefined } }),
        realm.logoutToken({ sub: "kc-ana", claims: { events: { other: {} } } }),
        realm.logoutToken({ sub: "kc-ana", claims: { nonce: "an-id-token" } }),
        realm.logoutToken({ sub: "kc-ana", claims: { jti: undefined } }),
        realm.logoutToken({ sub: "kc-ana", claims: { aud: "another-client" } }),
        realm.logoutToken({ sub: "kc-ana", claims: { iss: "https://elsewhere.test/realms/x" } }),
        realm.logoutToken({ sub: "kc-ana", foreignKey: true }),
        realm.logoutToken({}),
      ];
      for (const token of refused) {
        const answer = yield* backchannel(server, { logout_token: yield* token });
        assert.equal(answer.status, 400);
        assert.equal(answer.text, "");
      }
      // Issued three minutes ago: too old to act on.
      const stale = yield* realm.logoutToken({ sub: "kc-ana" });
      yield* TestClock.adjust("3 minutes");
      assert.equal((yield* backchannel(server, { logout_token: stale })).status, 400);
      // No token, two tokens, or not a form.
      assert.equal((yield* backchannel(server, {})).status, 400);
      const json = yield* server.request(KEYCLOAK_BACKCHANNEL_LOGOUT_PATH, {
        body: { logout_token: "x" },
        omitOrigin: true,
      });
      assert.equal(json.status, 400);
      assert.isTrue(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it.effect("a full replay cache refuses instead of forgetting a token", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub({ flows: { maxRememberedJtis: 2 } });
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const first = yield* realm.logoutToken({ sub: "kc-nobody" });
      assert.equal((yield* backchannel(server, { logout_token: first })).status, 200);
      assert.equal(
        (yield* backchannel(server, {
          logout_token: yield* realm.logoutToken({ sub: "kc-nobody" }),
        })).status,
        200,
      );
      // Full: a real logout waits for room rather than push out the first token's `jti`.
      const third = yield* realm.logoutToken({ sub: "kc-ana" });
      assert.equal((yield* backchannel(server, { logout_token: third })).status, 400);
      assert.isTrue(yield* isSignedIn(server, member.cookie));
      assert.equal((yield* backchannel(server, { logout_token: first })).status, 400);
      // Once the remembered ones are past their life, there is room again.
      yield* TestClock.adjust("5 minutes");
      const fresh = yield* realm.logoutToken({ sub: "kc-ana" });
      assert.equal((yield* backchannel(server, { logout_token: fresh })).status, 200);
      assert.isFalse(yield* isSignedIn(server, member.cookie));
    }).pipe(Effect.scoped),
  );

  it("is never traced: the token is in its body", () => {
    assert.isTrue(isUntracedRequest({ url: KEYCLOAK_BACKCHANNEL_LOGOUT_PATH }));
  });
});

const VERIFIER = "v".repeat(43) + "-for-the-tests";
const challengeOf = (verifier: string) =>
  Effect.promise(async () =>
    Buffer.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ).toString("base64url"),
  );
const APP_REDIRECT = "http://127.0.0.1:53111/callback";
const MCP_REDIRECT = "http://localhost:51234/callback";

/** An app approved from `cookie`'s browser session, and its bearer token. */
const approveApp = Effect.fn(function* (server: Server, cookie: string) {
  const approved = yield* server.request("/api/auth/app-sign-in/approve", {
    cookie,
    body: {
      redirectUri: APP_REDIRECT,
      codeChallenge: yield* challengeOf(VERIFIER),
      codeChallengeMethod: "S256",
      state: "state-from-the-app-0123",
      clientLabel: "T3 Code desktop",
    },
  });
  assert.equal(approved.status, 200, approved.text);
  const code = new URL(String(approved.body.redirectTo)).searchParams.get("code") ?? "";
  const issued = yield* server.request("/api/auth/app-sign-in/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: APP_REDIRECT,
      client_label: "T3 Code desktop",
    },
  });
  assert.equal(issued.status, 200, issued.text);
  return issued.body.access_token as string;
});

/** An outside agent (MCP client) approved in one click from `cookie`'s session; its token. */
const approveMcpClient = Effect.fn(function* (server: Server, cookie: string) {
  const registered = yield* server.request("/oauth/mcp/register", {
    body: {
      client_name: "Claude Code",
      redirect_uris: [MCP_REDIRECT],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    },
  });
  assert.include([200, 201], registered.status, registered.text);
  const clientId = registered.body.client_id as string;
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: MCP_REDIRECT,
    code_challenge: yield* challengeOf(VERIFIER),
    code_challenge_method: "S256",
    state: "state-1",
    resource: "http://127.0.0.1/mcp",
  };
  const details = yield* server.request("/oauth/mcp/approval", { cookie, body: authorization });
  assert.equal(details.status, 200, details.text);
  const decided = yield* server.request("/oauth/mcp/decision", {
    cookie,
    body: {
      authorization,
      decision: { _tag: "browser-session", access: "read-only", csrfToken: details.body.csrfToken },
    },
  });
  assert.equal(decided.status, 200, decided.text);
  const code = new URL(String(decided.body.redirectTo)).searchParams.get("code") ?? "";
  const token = yield* server.request("/oauth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: MCP_REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: "http://127.0.0.1/mcp",
    },
  });
  assert.equal(token.status, 200, token.text);
  return token.body.access_token as string;
});

/** A pairing link created from `cookie`'s session, as the account page makes one. */
const pairingLinkFrom = Effect.fn(function* (server: Server, cookie: string) {
  const created = yield* server.request("/api/auth/pairing-token", { cookie, body: {} });
  assert.equal(created.status, 200, created.text);
  return created.body.credential as string;
});

const tokenAlive = (server: Server, token: string) =>
  server.sessions.verify(token).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const linkSpendable = (server: Server, credential: string) =>
  Context.get(server.services, PairingGrantStore.PairingGrantStore)
    .inspect(credential)
    .pipe(Effect.map((link) => Option.isSome(link) && link.value.spendable));

describe("what a Keycloak sign-in approves ends with it (ticket 07)", () => {
  it.effect("an app, an MCP client and a pairing link inherit it and fall with it", () =>
    Effect.gen(function* () {
      const { server, realm } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const { loginId } = yield* loginOf(server, member.cookie);
      const app = yield* approveApp(server, member.cookie);
      const mcp = yield* approveMcpClient(server, member.cookie);
      const link = yield* pairingLinkFrom(server, member.cookie);
      // A device that pairs with the link inherits it too.
      const pairedLink = yield* pairingLinkFrom(server, member.cookie);
      const paired = yield* server.request("/api/auth/browser-session", {
        body: { credential: pairedLink },
      });
      assert.equal(paired.status, 200, paired.text);
      for (const token of [app, mcp, tokenOf(paired.cookie ?? "")]) {
        const session = yield* server.sessions.verify(token);
        assert.equal(session.identityLoginId, loginId);
      }

      const loggedOut = yield* backchannel(server, {
        logout_token: yield* realm.logoutToken({ sid: realm.sidOf("kc-ana") ?? "" }),
      });
      assert.equal(loggedOut.status, 200);
      assert.isFalse(yield* tokenAlive(server, app));
      assert.isFalse(yield* tokenAlive(server, mcp));
      assert.isFalse(yield* tokenAlive(server, tokenOf(paired.cookie ?? "")));
      assert.isFalse(yield* linkSpendable(server, link));
    }).pipe(Effect.scoped),
  );

  it.effect("what a local session approves carries no sign-in", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hub();
      const app = yield* approveApp(server, owner);
      const session = yield* server.sessions.verify(app);
      assert.isUndefined(session.identityLoginId);
    }).pipe(Effect.scoped),
  );

  it.effect("becoming an Admin ends what a weak sign-in approved; a strong one's stays", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const strong = yield* roundTrip(server, realm, { sub: "kc-ana", claims: STRONG });
      const weakApp = yield* approveApp(server, member.cookie);
      const strongApp = yield* approveApp(server, strong.cookie ?? "");
      const strongLink = yield* pairingLinkFrom(server, strong.cookie ?? "");
      const organization = yield* server.request("/api/spaces/organizations", {
        cookie: owner,
        body: { name: "Acme" },
      });
      const spaceId = organization.body.id as string;
      yield* server.sql`
        INSERT INTO space_memberships (space_id, user_id, role, created_at)
        VALUES (${spaceId}, ${member.id}, 'member', '2026-01-01T00:00:00.000Z')
      `;
      const promoted = yield* server.request(`/api/spaces/${spaceId}/members/role`, {
        cookie: owner,
        body: { userId: member.id, role: "admin" },
      });
      assert.equal(promoted.status, 200, promoted.text);
      assert.isFalse(yield* tokenAlive(server, weakApp));
      assert.isTrue(yield* tokenAlive(server, strongApp));
      assert.isTrue(yield* linkSpendable(server, strongLink));
      assert.isTrue(yield* isSignedIn(server, strong.cookie ?? ""));
    }).pipe(Effect.scoped),
  );
});

describe("«also sign out of Keycloak» (ticket 07)", () => {
  it.effect("ends the sign-in with its apps and sends the browser to the realm", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const other = yield* roundTrip(server, realm, { sub: "kc-ana" });
      const app = yield* approveApp(server, member.cookie);

      const signedOut = yield* server.request("/api/auth/sign-out", {
        cookie: member.cookie,
        body: {},
      });
      assert.equal(signedOut.status, 200, signedOut.text);
      const handle = signedOut.body.keycloakSignOutHandle as string;
      assert.isString(handle);
      // Signing out of the Hub alone leaves the apps that sign-in approved.
      assert.isTrue(yield* tokenAlive(server, app));

      const left = yield* server.request("/api/auth/keycloak/sign-out", { body: { handle } });
      assert.equal(left.status, 200, left.text);
      const url = new URL(left.body.endSessionUrl as string);
      assert.equal(
        `${url.origin}${url.pathname}`,
        `${realm.issuer}/protocol/openid-connect/logout`,
      );
      assert.equal(url.searchParams.get("client_id"), realm.clientId);
      assert.equal(url.searchParams.get("post_logout_redirect_uri"), "http://127.0.0.1/sign-in");
      assert.include(realm.idTokens, url.searchParams.get("id_token_hint"));
      assert.isFalse(yield* tokenAlive(server, app));
      // Another sign-in of the same person is not this browser's.
      assert.isTrue(yield* isSignedIn(server, other.cookie ?? ""));
      const ended = yield* auditOf(server, owner, "keycloak.login.end");
      assert.deepEqual(
        ended.map((row) => ({
          source: row.actor.source,
          user: row.actor.userId,
          reason: row.detail.reason,
        })),
        [{ source: "user", user: member.id, reason: "sign-out" }],
      );

      // The handle serves once.
      const again = yield* server.request("/api/auth/keycloak/sign-out", { body: { handle } });
      assert.equal(again.status, 400);
    }).pipe(Effect.scoped),
  );

  it.effect("a local session's sign-out offers nothing, and a handle lasts 10 minutes", () =>
    Effect.gen(function* () {
      const { server, realm, owner } = yield* hub();
      const local = yield* server.request("/api/auth/sign-out", { cookie: owner, body: {} });
      assert.isUndefined(local.body.keycloakSignOutHandle);
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const signedOut = yield* server.request("/api/auth/sign-out", {
        cookie: member.cookie,
        body: {},
      });
      const handle = signedOut.body.keycloakSignOutHandle as string;
      yield* TestClock.adjust("11 minutes");
      const late = yield* server.request("/api/auth/keycloak/sign-out", { body: { handle } });
      assert.equal(late.status, 400);
    }).pipe(Effect.scoped),
  );
});

describe("no token of a sign-in leaks (ticket 07)", () => {
  it.effect("refresh and ID tokens stay sealed, out of logs, spans and answers", () => {
    const recorded: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          recorded.push(
            span.name,
            ...Array.from(span.attributes.values(), (value) => String(value)),
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
      const member = yield* keycloakMember(server, realm, "kc-ana");
      const { loginId } = yield* loginOf(server, member.cookie);
      const answers: Array<string> = [];
      yield* TestClock.adjust("61 minutes");
      const refreshed = yield* nextRecheck(server, loginId);
      answers.push((yield* use(server, member.cookie)).text);
      assert.equal(yield* Fiber.join(refreshed), "refreshed");
      realm.refreshAs("kc-ana", { kind: "unavailable" });
      yield* TestClock.adjust("61 minutes");
      const kept = yield* nextRecheck(server, loginId);
      answers.push((yield* use(server, member.cookie)).text);
      assert.equal(yield* Fiber.join(kept), "kept");
      answers.push(yield* statusOf(server, owner).pipe(Effect.map(JSON.stringify)));
      const signedOut = yield* server.request("/api/auth/sign-out", {
        cookie: member.cookie,
        body: {},
      });
      answers.push(signedOut.text);
      answers.push(
        (yield* backchannel(server, { logout_token: yield* realm.logoutToken({ sub: "kc-x" }) }))
          .text,
      );
      const rows = [
        ...(yield* server.sql`SELECT * FROM identity_logins`),
        ...(yield* server.sql`SELECT * FROM audit_log`),
        ...(yield* server.sql`SELECT * FROM auth_sessions`),
      ];
      const seen = [...answers, ...rows.map((row) => JSON.stringify(row)), ...recorded];
      assert.isAbove(realm.refreshTokens.length, 1);
      for (const secret of [...realm.refreshTokens, ...realm.idTokens, realm.clientSecret]) {
        assert.deepEqual(
          seen.filter((text) => text.includes(secret)),
          [],
          "a token came back out",
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
