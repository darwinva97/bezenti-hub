// @effect-diagnostics nodeBuiltinImport:off -- the leak smoke reads the Hub's files and /proc.
/**
 * Keycloak ticket 11 over a fake realm: one walk calls every `IDENTITY_DOORS` door. No answer may
 * carry the client secret, a code, a PKCE verifier or an ID, access, refresh or logout token, nor
 * may a log, span, process, clear database row or Hub file outside the encrypted store. Counts only.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  KEYCLOAK_BACKCHANNEL_LOGOUT_PATH,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Fiber from "effect/Fiber";

import * as ServerConfig from "../config.ts";
import { isUntracedRequest } from "../http.ts";
import { IDENTITY_DOORS } from "./DoorRules.ts";
import { type FakeKeycloak, type FakeSignIn, makeFakeKeycloak } from "./Keycloak.testkit.ts";
import * as KeycloakLogins from "./KeycloakLogins.ts";
import {
  addMember,
  bootstrapOwner,
  makeAuthenticator,
  passkeyReauth,
  type Server,
  serveAuthHttpWith,
} from "./UserAuth.testkit.ts";

const START = "/api/auth/keycloak/start";
const PASSWORD = "correct horse battery staple";
const STRONG = { amr: ["pwd", "otp"] };
const VERIFIER = "v".repeat(43) + "-for-the-tests";
const APP_REDIRECT = "http://127.0.0.1:53111/callback";
const MCP_REDIRECT = "http://localhost:51234/callback";

type Answer = Effect.Success<ReturnType<Server["request"]>>;

/** What every door answered, by door. */
interface Walk {
  readonly realm: FakeKeycloak;
  readonly server: Server;
  readonly answers: ReadonlyArray<{ readonly door: string; readonly answer: Answer }>;
}

const flowCookieOf = (setCookies: ReadonlyArray<string>) =>
  setCookies.find((cookie) => /^(__Host-)?t3_keycloak_flow=[^;]/.test(cookie))?.split(";", 1)[0];

const joinCookies = (...cookies: ReadonlyArray<string | undefined>) =>
  cookies.filter((cookie) => cookie !== undefined && cookie !== "").join("; ");

const challengeOf = (verifier: string) =>
  Effect.promise(async () =>
    Buffer.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ).toString("base64url"),
  );

/** The walk: every identity door, called at least once, through the spec's flows. */
const walk = Effect.fn(function* () {
  const realm = yield* makeFakeKeycloak();
  const server = yield* serveAuthHttpWith({ signIn: { keycloakHttp: realm.layer } });
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const recoveryCodes = created.body.recoveryCodes as ReadonlyArray<string>;
  const answers: Array<{ door: string; answer: Answer }> = [];

  /** One request to `door`, kept. */
  const call = Effect.fn(function* (
    door: string,
    path: string,
    init: Parameters<Server["request"]>[1] = {},
  ) {
    assert.isDefined(IDENTITY_DOORS[door], `${door} is an identity door`);
    const answer = yield* server.request(path, init);
    answers.push({ door, answer });
    return answer;
  });

  /** A whole Keycloak round: `start`, the realm, the callback. */
  const round = Effect.fn(function* (
    as: FakeSignIn,
    body: Record<string, unknown> = { intent: "sign-in" },
    sessionCookie?: string,
  ) {
    const started = yield* call("keycloakSignIn.start", START, {
      body,
      ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }),
    });
    assert.equal(started.status, 200, started.text);
    const back = new URL(yield* realm.signIn(started.body.authorizationUrl as string, as));
    return yield* call(
      "auth/keycloakSignInHttp.ts: GET KEYCLOAK_CALLBACK_PATH",
      `${back.pathname}${back.search}`,
      {
        cookie: joinCookies(flowCookieOf(started.setCookies), sessionCookie),
        omitOrigin: true,
      },
    );
  });

  // The Owner's settings (the secret goes in, never out), Check, and open registration.
  const settings = yield* call("signInSettings.update", "/api/installation/sign-in-settings", {
    cookie: owner,
    body: {
      keycloakEnabled: true,
      issuer: realm.issuer,
      clientId: realm.clientId,
      clientSecret: realm.clientSecret,
      strongAcr: ["critica"],
      strongAmr: ["otp"],
      registrationMode: "open",
    },
  });
  assert.equal(settings.status, 200, settings.text);
  yield* call("signInSettings.get", "/api/installation/sign-in-settings", { cookie: owner });
  yield* call("signInSettings.check", "/api/installation/sign-in-settings/check", {
    cookie: owner,
    body: {},
  });

  // Open registration: a newcomer gets a User.
  const ana = yield* round({ sub: "kc-ana", claims: STRONG });
  assert.equal(ana.status, 303, ana.text);
  const anaCookie = ana.cookie ?? "";
  const anaId = (yield* server.request("/api/auth/session", { cookie: anaCookie })).body
    .userId as string;

  // An Organization, its Invitation, joined by the Keycloak User.
  const organization = yield* call("spaces.createOrganization", "/api/spaces/organizations", {
    cookie: owner,
    body: { name: "Acme" },
  });
  const spaceId = organization.body.id as string;
  const invitation = yield* call("invitations.create", `/api/spaces/${spaceId}/invitations`, {
    cookie: owner,
    body: { role: "member" },
  });
  const invitationToken = invitation.body.token as string;
  yield* call("invitations.list", `/api/spaces/${spaceId}/invitations`, { cookie: owner });
  yield* call("invitations.preview", "/api/invitations/preview", {
    body: { token: invitationToken },
  });
  const joined = yield* call("invitations.join", "/api/invitations/join", {
    cookie: anaCookie,
    body: { token: invitationToken },
  });
  assert.equal(joined.status, 200, joined.text);
  yield* call("spaces.changeMemberRole", `/api/spaces/${spaceId}/members/role`, {
    cookie: owner,
    body: { userId: anaId, role: "guest" },
  });
  // A new local User through an Invitation, by its local doors (refused or not, answered).
  const local = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    cookie: owner,
    body: { role: "member" },
  });
  const localToken = local.body.token as string;
  yield* call("invitations.registration", "/api/invitations/registration", {
    body: { token: localToken },
  });
  yield* call("invitations.totpEnrollment", "/api/invitations/totp-enrollment", {
    body: { token: localToken },
  });
  yield* call("invitations.accept", "/api/invitations/accept", { body: { token: localToken } });
  yield* call("invitations.revoke", "/api/invitations/revoke", {
    cookie: owner,
    body: { invitationId: (local.body.invitation as { id: string }).id },
  });

  // A Platform invitation, accepted by signing up at Keycloak.
  const platform = yield* call("platformInvitations.create", "/api/installation/invitations", {
    cookie: owner,
    body: {},
  });
  yield* call("platformInvitations.list", "/api/installation/invitations", { cookie: owner });
  const bob = yield* round(
    { sub: "kc-bob" },
    { intent: "invitation", invitationToken: platform.body.token as string },
  );
  assert.equal(bob.status, 303, bob.text);
  const bobCookie = bob.cookie ?? "";
  const bobId = (yield* server.request("/api/auth/session", { cookie: bobCookie })).body
    .userId as string;

  // A local User links their account, after their own local doors.
  const graceCookie = yield* addMember(server, { id: "grace", displayName: "Grace" });
  yield* call("auth.setPassword", "/api/auth/account/password", {
    cookie: graceCookie,
    body: { loginName: "grace", password: PASSWORD },
  });
  yield* call("auth.passwordSignIn", "/api/auth/password/sign-in", {
    body: { loginName: "grace", password: PASSWORD },
  });
  const linked = yield* round(
    { sub: "kc-grace" },
    { intent: "link", reauth: { method: "password", password: PASSWORD } },
    graceCookie,
  );
  assert.equal(linked.status, 303, linked.text);
  const grace = linked.cookie ?? "";
  // Her local credentials are gone, and a Keycloak User adds none.
  yield* call("auth.setPassword", "/api/auth/account/password", {
    cookie: grace,
    body: { loginName: "grace", password: PASSWORD },
  });
  yield* call("auth.startTotpEnrollment", "/api/auth/account/totp/enrollment", {
    cookie: grace,
    body: {},
  });
  yield* call("auth.confirmTotpEnrollment", "/api/auth/account/totp", {
    cookie: grace,
    body: { enrollmentId: "x", code: "123456" },
  });
  yield* call("auth.removePassword", "/api/auth/account/password/remove", {
    cookie: grace,
    body: {},
  });
  yield* call("auth.removeTotp", "/api/auth/account/totp/remove", { cookie: grace, body: {} });
  yield* call("auth.totpSignIn", "/api/auth/password/totp", {
    body: { challengeId: "x", code: "123456" },
  });

  // A reset link binds a Keycloak identity again; its local doors answer too.
  const reset = yield* call(
    "spaces.issueMemberResetLink",
    `/api/spaces/${spaceId}/members/reset-link`,
    { cookie: owner, body: { userId: anaId } },
  );
  const resetToken = (reset.body.token ?? "") as string;
  yield* call("auth.resetLinkStatus", "/api/auth/reset/status", { body: { token: resetToken } });
  yield* call("auth.resetLinkRegistration", "/api/auth/reset/registration", {
    body: { token: resetToken },
  });
  yield* call("auth.redeemResetLinkWithPassword", "/api/auth/reset/password", {
    body: { token: "not-a-link", loginName: "ana", password: PASSWORD },
  });
  yield* call("auth.redeemResetLink", "/api/auth/reset", {
    body: { token: "not-a-link", ceremonyId: "x", response: {} },
  });
  const rebound = yield* round({ sub: "kc-ana", claims: STRONG }, { intent: "reset", resetToken });
  const anaAgain = rebound.cookie ?? anaCookie;

  // A step-up proof, then a machine's approval that takes it.
  const stepUp = yield* round(
    { sub: "kc-ana", claims: STRONG },
    { intent: "step-up", returnTo: "/register-environment?request=abc" },
    anaAgain,
  );
  const proofId =
    new URLSearchParams(new URL(stepUp.location ?? "/", "http://hub.invalid").hash.slice(1)).get(
      "keycloakProof",
    ) ?? "";
  yield* call("environments.approveJoin", "/api/environments/join/approve", {
    cookie: anaAgain,
    body: { requestId: "abc", name: "laptop", reauth: { method: "keycloak", proofId } },
  });

  // Apps through the Keycloak browser session (desktop and mobile).
  const approved = yield* call("appSignIn.approve", "/api/auth/app-sign-in/approve", {
    cookie: anaAgain,
    body: {
      redirectUri: APP_REDIRECT,
      codeChallenge: yield* challengeOf(VERIFIER),
      codeChallengeMethod: "S256",
      state: "state-from-the-app-0123",
      clientLabel: "T3 Code desktop",
    },
  });
  const appCode = new URL(String(approved.body.redirectTo)).searchParams.get("code") ?? "";
  const app = yield* call("appSignIn.token", "/api/auth/app-sign-in/token", {
    form: {
      grant_type: "authorization_code",
      code: appCode,
      code_verifier: VERIFIER,
      redirect_uri: APP_REDIRECT,
      client_label: "T3 Code desktop",
    },
  });
  assert.equal(app.status, 200, app.text);
  const appBearer = `Bearer ${app.body.access_token as string}`;

  // An MCP client approved in one click.
  for (const [door, path] of [
    ["mcpOAuth.protectedResource", "/.well-known/oauth-protected-resource"],
    ["mcpOAuth.mcpProtectedResource", "/.well-known/oauth-protected-resource/mcp"],
    ["mcpOAuth.authorizationServer", "/.well-known/oauth-authorization-server"],
  ] as const) {
    yield* call(door, path);
  }
  const registered = yield* call("mcpOAuth.register", "/oauth/mcp/register", {
    body: {
      client_name: "Claude Code",
      redirect_uris: [MCP_REDIRECT],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    },
  });
  const authorization = {
    response_type: "code",
    client_id: registered.body.client_id as string,
    redirect_uri: MCP_REDIRECT,
    code_challenge: yield* challengeOf(VERIFIER),
    code_challenge_method: "S256",
    state: "state-1",
    resource: "http://127.0.0.1/mcp",
  };
  yield* call("mcpOAuth.authorize", `/oauth/mcp/authorize?${new URLSearchParams(authorization)}`, {
    cookie: anaAgain,
  });
  const details = yield* call("mcpOAuth.approval", "/oauth/mcp/approval", {
    cookie: anaAgain,
    body: authorization,
  });
  const decided = yield* call("mcpOAuth.decision", "/oauth/mcp/decision", {
    cookie: anaAgain,
    body: {
      authorization,
      decision: { _tag: "browser-session", access: "read-only", csrfToken: details.body.csrfToken },
    },
  });
  const mcpCode = new URL(String(decided.body.redirectTo)).searchParams.get("code") ?? "";
  const mcp = yield* call("mcpOAuth.token", "/oauth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code: mcpCode,
      redirect_uri: MCP_REDIRECT,
      client_id: authorization.client_id,
      code_verifier: VERIFIER,
      resource: "http://127.0.0.1/mcp",
    },
  });
  assert.equal(mcp.status, 200, mcp.text);

  // Pairing links from the Keycloak session, redeemed into a browser and a bearer session.
  const pairing = yield* call("auth.pairingCredential", "/api/auth/pairing-token", {
    cookie: anaAgain,
    body: {},
  });
  yield* call("auth.browserSession", "/api/auth/browser-session", {
    body: { credential: pairing.body.credential as string },
  });
  const another = yield* server.request("/api/auth/pairing-token", {
    cookie: anaAgain,
    body: {},
  });
  yield* call("auth.token", "/oauth/token", {
    form: {
      grant_type: AuthTokenExchangeGrantType,
      subject_token: another.body.credential as string,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    },
  });
  const spare = yield* server.request("/api/auth/pairing-token", {
    cookie: anaAgain,
    body: {},
  });
  yield* call("auth.revokePairingLink", "/api/auth/pairing-links/revoke", {
    cookie: anaAgain,
    body: { id: spare.body.id as string },
  });

  // What a session reads about itself, by cookie and by bearer.
  for (const credential of [{ cookie: anaAgain }, { authorization: appBearer }]) {
    yield* call("auth.session", "/api/auth/session", credential);
    yield* call("auth.account", "/api/auth/account", credential);
    yield* call("auth.webSocketTicket", "/api/auth/websocket-ticket", {
      ...credential,
      body: {},
    });
    yield* call("auth.webSocketTicketFor", "/api/auth/websocket-ticket/media", {
      ...credential,
      body: {},
    });
  }
  yield* call('ws.ts: GET "/ws"', "/ws", { cookie: anaAgain });

  // The local doors: the Owner's passkey and code, and a stranger's tries.
  const passkey = yield* passkeyReauth(server, authenticator);
  answers.push({
    door: "auth.passkeyChallenge",
    answer: yield* server.request("/api/auth/passkey/challenge", { body: {} }),
  });
  yield* call("auth.passkeySignIn", "/api/auth/passkey/sign-in", {
    body: { ceremonyId: passkey.ceremonyId, response: passkey.response },
  });
  yield* call("auth.recoveryCodeSignIn", "/api/auth/recovery-code/sign-in", {
    body: { code: recoveryCodes[0] ?? "" },
  });
  yield* call("auth.ownerBootstrapStatus", "/api/auth/owner/status", { body: {} });
  yield* call("auth.ownerRegistration", "/api/auth/owner/registration", { body: {} });
  yield* call("auth.ownerBootstrap", "/api/auth/owner", { body: {} });

  // A re-check an hour on: the realm hands out a new refresh token and ID token.
  const logins = Context.get(server.services, KeycloakLogins.KeycloakLogins);
  const outcomes = yield* logins.recheckOutcomes;
  const refreshed = yield* outcomes.pipe(
    Stream.filter((outcome) => outcome.outcome !== "skipped"),
    Stream.runHead,
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* TestClock.adjust("61 minutes");
  yield* server.request("/api/auth/session", { cookie: bobCookie });
  assert.equal(Option.getOrUndefined(yield* Fiber.join(refreshed))?.outcome, "refreshed");

  // The realm's back-channel logout ends Bob's sign-in.
  yield* call(
    "auth/keycloakSignInHttp.ts: POST KEYCLOAK_BACKCHANNEL_LOGOUT_PATH",
    KEYCLOAK_BACKCHANNEL_LOGOUT_PATH,
    {
      form: { logout_token: yield* realm.logoutToken({ sub: "kc-bob" }) },
      omitOrigin: true,
    },
  );

  // Sessions ended by their own User, then «also sign out of Keycloak».
  yield* call("auth.revokeClient", "/api/auth/clients/revoke", {
    cookie: grace,
    body: { sessionId: "not-a-session" },
  });
  yield* call("auth.revokeOtherClients", "/api/auth/clients/revoke-others", {
    cookie: grace,
    body: {},
  });
  const signedOut = yield* call("auth.signOut", "/api/auth/sign-out", {
    cookie: anaAgain,
    body: {},
  });
  const left = yield* call("keycloakSignIn.signOut", "/api/auth/keycloak/sign-out", {
    body: { handle: signedOut.body.keycloakSignOutHandle as string },
  });
  assert.equal(left.status, 200, left.text);

  // The Owner's list of Users, and a User disabled with their sign-ins.
  yield* call("installationUsers.list", "/api/installation/users", { cookie: owner });
  yield* call("installationUsers.setStatus", `/api/installation/users/${bobId}/status`, {
    cookie: owner,
    body: { status: "disabled" },
  });

  return { realm, server, answers } satisfies Walk;
});

describe("no door hands out a Keycloak secret or token (ticket 11)", () => {
  it.effect("every identity door, called: no secret, code or token in any answer", () =>
    Effect.gen(function* () {
      const { realm, answers } = yield* walk();
      // Every door was called.
      const called = new Set(answers.map(({ door }) => door));
      assert.deepEqual(
        Object.keys(IDENTITY_DOORS).filter((door) => !called.has(door)),
        [],
        "an identity door the walk never called",
      );
      const secrets = realm.secretsHandedOut();
      // The walk handed out each kind at least once.
      // Five rounds (open sign-up, Platform invitation, link, reset, step-up) and a re-check.
      assert.equal(realm.authorizationCodes.length, 5);
      assert.equal(realm.refreshTokens.length, 6);
      assert.equal(realm.idTokens.length, 6);
      assert.equal(realm.accessTokens.length, 6);
      assert.isAbove(realm.logoutTokens.length, 0);
      const leaks = answers.flatMap(({ door, answer }) => {
        const seen = [answer.text, answer.headerText, answer.location ?? "", ...answer.setCookies];
        const count = secrets.filter((secret) => seen.some((text) => text.includes(secret))).length;
        return count === 0 ? [] : [`${door}: ${count}`];
      });
      assert.deepEqual(leaks, [], "doors that answered a secret value (how many)");
    }).pipe(Effect.scoped),
  );
});

/** Every file under `root` but `skip` holding any of `values`: paths and counts only. */
const filesHolding = (root: string, values: ReadonlyArray<string>, skip: string) =>
  Effect.promise(async () => {
    const needles = values.map((value) => Buffer.from(value));
    const found: Array<string> = [];
    let files = 0;
    const walkDirectory = async (directory: string): Promise<void> => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (full === skip) continue;
        if (entry.isDirectory()) await walkDirectory(full);
        else if (entry.isFile()) {
          files += 1;
          const bytes = await NodeFSP.readFile(full);
          const count = needles.filter((needle) => bytes.includes(needle)).length;
          if (count > 0) found.push(`${NodePath.relative(root, full)}: ${count}`);
        }
      }
    };
    await walkDirectory(root);
    return { files, found };
  });

/** This host's processes whose arguments, or this process's environment, hold any of `values`. */
const processesHolding = (values: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    // Hosts without /proc (macOS, Windows) have nothing to read here.
    if (!NodeFS.existsSync("/proc/self/cmdline")) return { read: 0, found: [] as Array<string> };
    const needles = values.map((value) => Buffer.from(value));
    const found: Array<string> = [];
    let read = 0;
    for (const pid of await NodeFSP.readdir("/proc")) {
      if (!/^\d+$/u.test(pid)) continue;
      const args = await NodeFSP.readFile(`/proc/${pid}/cmdline`).catch(() => undefined);
      if (args === undefined) continue;
      read += 1;
      const count = needles.filter((needle) => args.includes(needle)).length;
      if (count > 0) found.push(`pid ${pid} arguments: ${count}`);
    }
    const environment = await NodeFSP.readFile("/proc/self/environ");
    const count = needles.filter((needle) => environment.includes(needle)).length;
    if (count > 0) found.push(`this process's environment: ${count}`);
    return { read, found };
  });

describe("no Keycloak secret or token leaks out of the Hub (ticket 11, leak smoke)", () => {
  it.effect(
    "the walk leaves none in logs, spans, process arguments, the database in clear or the Hub's files",
    () => {
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
        const { realm, server } = yield* walk();
        const secrets = realm.secretsHandedOut();
        assert.isAbove(recorded.length, 100, "the logger and tracer recorded the walk");

        // Logs and spans.
        assert.equal(
          secrets.filter((secret) => recorded.some((text) => text.includes(secret))).length,
          0,
          "secret values in logs or spans",
        );

        // Every row of every table, in clear: a sealed refresh token is ciphertext.
        const tables = yield* server.sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table'
        `;
        assert.isAbove(tables.length, 20);
        let database = "";
        for (const { name } of tables) {
          database += JSON.stringify(yield* server.sql.unsafe(`SELECT * FROM "${name}"`));
        }
        const sealed = yield* server.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM identity_logins WHERE refresh_token_sealed IS NOT NULL
        `;
        assert.isAbove(sealed[0]?.count ?? 0, 0, "live sign-ins keep their refresh token sealed");
        assert.equal(
          secrets.filter((secret) => database.includes(secret)).length,
          0,
          "secret values in clear in the database",
        );

        // The Hub's files, but its encrypted store.
        const config = Context.get(server.services, ServerConfig.ServerConfig);
        const files = yield* filesHolding(config.baseDir, secrets, config.secretsDir);
        assert.isAbove(files.files, 0, "the Hub wrote files");
        assert.deepEqual(files.found, [], "Hub files holding secret values (how many)");

        // Process arguments on this host, and the Hub's own environment.
        const processes = yield* processesHolding(secrets);
        assert.deepEqual(processes.found, [], "processes holding secret values (how many)");
      }).pipe(
        Effect.scoped,
        Effect.withTracer(tracer),
        // As the server serves its routes (http.ts): the callback and back-channel are untraced.
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, isUntracedRequest),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
    },
  );
});
