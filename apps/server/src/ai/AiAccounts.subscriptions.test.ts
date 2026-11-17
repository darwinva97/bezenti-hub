/**
 * Subscription AI accounts (spec 4 ticket 03) with the fake CLIProxyAPI's OAuth: Owner-only, bound
 * to its session and state, never fetched; tokens sealed, kept newest across refreshes and
 * restarts, and never in the database, an answer, a log or a span.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the store's files and the fake gateway's folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type AiAccountError,
  type AiAccountSummary,
  type AiSubscriptionProvider,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import { newerToken } from "./subscriptionLogin.ts";
import { fakeCliproxyRelease, fakeReleases, pinsOf } from "./AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

const os = HostProcess.Platform.defaultValue();
const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
const posix = os === "linux" || os === "darwin";
const live = it.live.skipIf(!posix || platform === undefined);

const SESSION = "session-of-the-owner";
/** Every token the fake issues starts so: none may show outside the store and the memory folder. */
const mentionsAToken = (text: string) => /fake-(access|refresh)-/u.test(text);

type Server = Effect.Success<typeof serveAuthHttp>;

/**
 * The Hub's gateway (fake CLIProxyAPI) and AI accounts, in a scope of their own so a test can stop
 * them and start them again over the same store and memory folder, as a Hub restart does. The
 * test's end stops whatever it left running.
 */
const startStack = Effect.fn(function* (
  server: Server,
  input: {
    readonly dir: string;
    readonly inMemory?: boolean;
    readonly options?: AiAccounts.AiAccountsOptions;
    readonly ownerPlacement?: boolean;
  },
) {
  const scope = yield* Scope.make();
  // Closed with the test, before the Hub's database: a stack the test leaves running would
  // otherwise keep its CLIProxyAPI and the accounts' background fibers past that database.
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const release = fakeCliproxyRelease(input.dir, "1.0.0");
  const stateDir = NodePath.join(input.dir, "state");
  const memory = NodePath.join(input.dir, "memory");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: input.ownerPlacement
      ? { _tag: "owner", defaultEnabled: true }
      : { _tag: "forced", enabled: true },
    os,
    stateDir,
    platform: platform!,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: memory, inMemory: input.inMemory ?? true },
    restartDelay: { initialMs: 100, maxMs: 200 },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          Context.get(server.services, ServerSecretStore.ServerSecretStore),
        ),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
    Scope.provide(scope),
  );
  yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running"),
    Stream.runHead,
  );
  const context = yield* Layer.buildWithScope(
    AiAccounts.layerWith(input.options ?? { tokenPollMs: 60_000 }).pipe(
      Layer.provide(AuditLog.layer),
      Layer.provide(Layer.succeed(AiGateway.AiGateway, gateway)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeedContext(server.services)),
    ),
    scope,
  );
  return {
    gateway,
    memory,
    authDir: NodePath.join(memory, "auth"),
    accounts: Context.get(context, AiAccounts.AiAccounts),
    stop: Scope.close(scope, Exit.void),
  };
});

const hub = Effect.fn(function* (
  input: {
    readonly inMemory?: boolean;
    readonly options?: AiAccounts.AiAccountsOptions;
    readonly ownerPlacement?: boolean;
  } = {},
) {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const made = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  const acmeId = SpaceId.make(made.body.id as string);
  yield* addMember(server, { id: "grace", displayName: "grace" });
  yield* joinOrganization(server, acmeId, "grace", "member");
  yield* addMember(server, { id: "ada", displayName: "ada" });
  yield* joinOrganization(server, acmeId, "ada", "admin");
  const member = UserId.make("grace");
  const admin = UserId.make("ada");
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
    member,
    admin,
  ]);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-subscriptions-"));
  const stack = yield* startStack(server, { dir, ...input });
  const store = Context.get(server.services, ServerSecretStore.ServerSecretStore);
  const as =
    (userId: UserId, spaceLimit?: SpaceId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      spaceLimit === undefined
        ? CommandActor.actAs(userId)(effect)
        : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit })(effect);
  return {
    server,
    dir,
    stack,
    ownerId,
    member,
    admin,
    acmeId,
    as,
    tokens: Context.get(server.services, ServerSecretStore.AiAccountTokenStore),
    tokensDir: NodePath.join(store.directory ?? "", "ai-account-tokens"),
  };
});

type Hub = Effect.Success<ReturnType<typeof hub>>;
type Stack = Hub["stack"];

const reasonOf = <A, R>(effect: Effect.Effect<A, AiAccountError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

/** The address the provider's page sends the browser back to, as the Owner would paste it. */
const landedOn = (
  url: string,
  change: { readonly code?: string; readonly state?: string } = {},
) => {
  const page = new URL(url);
  const back = new URL(page.searchParams.get("redirect_uri") ?? "");
  back.searchParams.set("state", change.state ?? page.searchParams.get("state") ?? "");
  back.searchParams.set("code", change.code ?? "fake-good-code");
  return back.toString();
};

/** The Owner signs in to a subscription, start to end, from their session. */
const signIn = Effect.fn(function* (
  setup: Hub,
  stack: Stack,
  provider: AiSubscriptionProvider = "antigravity",
  name = "Owner Google",
) {
  const started = yield* stack.accounts
    .loginStart({ provider, name }, SESSION)
    .pipe(setup.as(setup.ownerId));
  const account = yield* stack.accounts
    .loginComplete(
      { loginId: started.loginId, redirectUrl: Redacted.make(landedOn(started.url)) },
      SESSION,
    )
    .pipe(setup.as(setup.ownerId));
  return yield* stack.accounts
    .update({ accountId: account.id, disabled: false })
    .pipe(setup.as(setup.ownerId));
});

/** What the fake gateway was asked about sign-ins: providers, callbacks, files written. */
const oauthSeen = (stack: Stack) => {
  const file = NodePath.join(stack.memory, "fake-oauth.jsonl");
  return NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              route: string;
              provider?: string;
              redirect_url?: string;
              name?: string;
            },
        )
    : [];
};

const filesIn = (folder: string) => (NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder) : []);

const readJson = (file: string) =>
  JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;

/** The sealed token of an account, opened through the Hub's own store. */
const sealedToken = (setup: Hub, tokenId: string) =>
  setup.tokens
    .get(tokenId)
    .pipe(
      Effect.map((value) =>
        Option.isNone(value)
          ? undefined
          : (JSON.parse(new TextDecoder().decode(value.value)) as Record<string, unknown>),
      ),
    );

/** The account's token file in the gateway's memory folder: `acct-<id>-tok-<id>.json`. */
const tokenFileOf = (stack: Stack, accountId: string) =>
  filesIn(stack.authDir).find((name) => name.startsWith(`acct-${accountId}-tok-`));

/** What the Hub does in its own fibers (a restart's sync, a refresh read back), within 10 s. */
const eventually = <A>(read: () => A | Promise<A>, expected: A) =>
  Effect.promise(() => expect.poll(read, { timeout: 10_000, interval: 100 }).toEqual(expected));

const tokenIdOf = (file: string | undefined) => /-(tok-[0-9a-f]{32})\.json$/u.exec(file ?? "")?.[1];

const ownerView = (setup: Hub, stack: Stack, accountId: string) =>
  stack.accounts.list.pipe(
    setup.as(setup.ownerId),
    Effect.map((listed) => listed.accounts.find((account) => account.id === accountId)),
  );

/** A management call to the fake gateway with the Hub's key, as CLIProxyAPI's refresh stands in. */
const refreshInGateway = (stack: Stack, name: string) =>
  Effect.gen(function* () {
    const endpoint = yield* stack.gateway.endpoint;
    if (Option.isNone(endpoint)) return yield* Effect.die("the gateway is not running");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(
        `${endpoint.value.baseUrl}/v8/management/fake/refresh?name=${encodeURIComponent(name)}`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.value(endpoint.value.managementKey))),
    );
    return (yield* response.json) as { readonly refresh_token: string };
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

live(
  "any User signs in to a subscription of their own, from the session that started it; the Owner sees its name, never who it is or its quota",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId, member, admin, acmeId } = setup;
      // The Owner's own agent bound to Acme starts none; a sign-in for someone else neither.
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .loginStart({ provider: "claude", name: "Mine" }, SESSION)
            .pipe(as(ownerId, acmeId)),
        ),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .loginStart(
              { provider: "claude", name: "Hers", owner: { kind: "user", userId: member } },
              SESSION,
            )
            .pipe(as(admin)),
        ),
        "forbidden",
      );
      assert.deepEqual(oauthSeen(stack), [], "a refused caller reached CLIProxyAPI");

      const started = yield* stack.accounts
        .loginStart({ provider: "claude", name: "Grace Claude" }, SESSION)
        .pipe(as(member));
      // One sign-in at a time on the Hub: another User waits rather than replacing hers.
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .loginStart({ provider: "claude", name: "Ada Claude" }, SESSION)
            .pipe(as(admin)),
        ),
        "pending",
      );
      const pasted = Redacted.make(landedOn(started.url));
      // Nobody else completes it, the Owner included.
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, SESSION)
            .pipe(as(ownerId)),
        ),
        "expired",
      );
      const hers = yield* stack.accounts
        .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, SESSION)
        .pipe(as(member));
      assert.deepEqual(hers.owner, { kind: "user", userId: member });
      assert.equal(hers.type, "subscription");
      assert.isString(hers.details?.signedInAs);
      yield* stack.accounts.update({ accountId: hers.id, disabled: false }).pipe(as(member));

      // The Owner: its name, provider, owner and status; never who it signed in as, nor its
      // quota windows, in the list or in the Usage dialog's Hub limits.
      const seen = yield* ownerView(setup, stack, hers.id);
      assert.deepInclude(seen, { name: "Grace Claude", provider: "claude", details: null });
      assert.notInclude(JSON.stringify(seen), "@");
      yield* signIn(setup, stack, "claude", "Owner Claude");
      const limits = yield* stack.accounts.ownerSubscriptionLimits.pipe(as(ownerId));
      assert.deepEqual(
        limits?.accounts.map((account) => account.name),
        ["Owner Claude"],
      );
      // Her own list shows her windows; her limits in the Usage dialog stay the Owner's.
      const own = (yield* stack.accounts.list.pipe(as(member))).accounts.find(
        (account) => account.id === hers.id,
      );
      assert.isDefined(own?.details?.usageLimits ?? undefined);
      assert.isNull(yield* stack.accounts.ownerSubscriptionLimits.pipe(as(member)));
    }),
);

live("only who started it, from the same session, completes a sign-in", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId, member } = setup;

    const started = yield* stack.accounts
      .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
      .pipe(as(ownerId));
    assert.equal(started.flow, "redirect");
    assert.match(started.url, /^https:\/\/fake-provider\.test\/antigravity\/authorize\?/u);
    const pasted = Redacted.make(landedOn(started.url));
    // Nobody else completes it: not a Member with its id, not the Owner from another session.
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, SESSION)
          .pipe(as(member)),
      ),
      "expired",
    );
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, "another-session")
          .pipe(as(ownerId)),
      ),
      "expired",
    );
    assert.isFalse(
      oauthSeen(stack).some((seen) => seen.route === "/oauth/callback"),
      "a refused completion was handed to CLIProxyAPI",
    );
    const account = yield* stack.accounts
      .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, SESSION)
      .pipe(as(ownerId));
    assert.equal(account.type, "subscription");
    assert.equal(account.provider, "antigravity");
    // Once done, the same sign-in cannot be completed again.
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete({ loginId: started.loginId, redirectUrl: pasted }, SESSION)
          .pipe(as(ownerId)),
      ),
      "expired",
    );
  }),
);

live(
  "a pasted address must be this sign-in's own: malformed, foreign, another state, another or an expired sign-in are refused and never fetched",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId } = setup;
      const first = yield* stack.accounts
        .loginStart({ provider: "codex", name: "Owner ChatGPT" }, SESSION)
        .pipe(as(ownerId));
      const complete = (loginId: string, redirectUrl: string) =>
        stack.accounts
          .loginComplete({ loginId, redirectUrl: Redacted.make(redirectUrl) }, SESSION)
          .pipe(as(ownerId));
      const good = landedOn(first.url);
      const goodUrl = new URL(good);
      const refused = [
        yield* reasonOf(complete(first.loginId, "not an address")),
        yield* reasonOf(complete(first.loginId, "")),
        // Another host, scheme, port or path: a foreign page, never fetched by the Hub.
        yield* reasonOf(
          complete(first.loginId, good.replace(goodUrl.origin, "https://evil.example")),
        ),
        yield* reasonOf(
          complete(first.loginId, good.replace(goodUrl.origin, "http://169.254.169.254")),
        ),
        yield* reasonOf(complete(first.loginId, good.replace(goodUrl.port, "9"))),
        yield* reasonOf(complete(first.loginId, good.replace(goodUrl.pathname, "/elsewhere"))),
        yield* reasonOf(complete(first.loginId, good.replace("http://", "http://user:pass@"))),
        // Its state, but someone else's.
        yield* reasonOf(complete(first.loginId, landedOn(first.url, { state: "not-this-one" }))),
        // Two states, or none.
        yield* reasonOf(complete(first.loginId, `${good}&state=another`)),
        yield* reasonOf(complete(first.loginId, good.replace(/state=[^&]+&?/u, ""))),
      ];
      assert.deepEqual(refused, Array(refused.length).fill("invalid"));
      // A newer sign-in replaces it: the first one's id and address are dead.
      const second = yield* stack.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      assert.equal(yield* reasonOf(complete(first.loginId, good)), "expired");
      // The second sign-in's id with the first one's address: another state.
      assert.equal(yield* reasonOf(complete(second.loginId, good)), "invalid");
      assert.deepEqual(
        oauthSeen(stack).filter((seen) => seen.route === "/oauth/callback"),
        [],
        "the Hub handed CLIProxyAPI an address it refused",
      );
      // An address with more in it: CLIProxyAPI gets only the redirect, its code and state.
      const third = yield* stack.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      yield* complete(third.loginId, `${landedOn(third.url)}&next=https://evil.example#frag`);
      const handed = oauthSeen(stack).filter((seen) => seen.route === "/oauth/callback");
      assert.lengthOf(handed, 1);
      const sent = new URL(handed[0]?.redirect_url ?? "");
      assert.deepEqual([...sent.searchParams.keys()].toSorted(), ["code", "state"]);
      assert.equal(sent.hash, "");
      assert.equal(`${sent.origin}${sent.pathname}`, "http://localhost:51121/oauth-callback");
    }),
);

live(
  "a sign-in's token is sealed in its own store and handed to CLIProxyAPI under acct-<id>: never in the database, an answer, a log or a span",
  () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map((part) => {
            try {
              return JSON.stringify(part) ?? String(part);
            } catch {
              return String(part);
            }
          })
          .join(" "),
      );
    });
    return Effect.gen(function* () {
      const setup = yield* hub();
      const { server, stack, tokensDir } = setup;
      const account = yield* signIn(setup, stack);
      const file = tokenFileOf(stack, account.id);
      assert.isDefined(file, "the account's token is not in the gateway");
      const inGateway = readJson(NodePath.join(stack.authDir, file ?? ""));
      assert.equal(inGateway.prefix, `acct-${account.id}`);
      // The file CLIProxyAPI named after the sign-in is gone: one copy, the account's.
      assert.deepEqual(
        filesIn(stack.authDir).filter((name) => name.endsWith(".json")),
        [file],
      );
      const sealed = yield* sealedToken(setup, tokenIdOf(file) ?? "");
      assert.equal(sealed?.refresh_token, inGateway.refresh_token);
      const shown = yield* ownerView(setup, stack, account.id);
      assert.equal(shown?.status, "working");
      assert.equal(shown?.details?.signedInAs, "owner@example.com");
      assert.deepEqual(yield* stack.accounts.modelsOf(account.id), [
        "gemini-3-pro",
        "claude-sonnet-5-5",
      ]);

      assert.isFalse(mentionsAToken(JSON.stringify(account) + JSON.stringify(shown)));
      const tables = yield* server.sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      for (const { name } of tables) {
        const rows = yield* server.sql.unsafe(`SELECT * FROM "${name}"`);
        assert.isFalse(mentionsAToken(JSON.stringify(rows)), `a token is in the table ${name}`);
      }
      const audits = yield* server.sql<{ readonly action: string }>`
        SELECT action FROM audit_log WHERE action LIKE 'ai_account.%'
      `;
      assert.includeMembers(
        audits.map((row) => row.action),
        ["ai_account.create", "ai_account.login"],
      );
      for (const sealedFile of filesIn(tokensDir)) {
        assert.match(sealedFile, /^tok-[0-9a-f]{32}\.sealed$/u);
        const bytes = NodeFS.readFileSync(NodePath.join(tokensDir, sealedFile)).toString("latin1");
        assert.isFalse(mentionsAToken(bytes), `${sealedFile} holds a token in clear`);
      }
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.isAbove(spans.length, 0);
      assert.isFalse(recorded.some(mentionsAToken), "a token reached a log or a span");
      const urls = spans.flatMap((span) =>
        Array.from(span.attributes.entries())
          .filter(([key]) => key.startsWith("url."))
          .map(([, value]) => String(value)),
      );
      assert.isAbove(urls.length, 0);
      assert.isFalse(
        urls.some((url) => /[?&](state|name)=(?!REDACTED|%3Credacted|<redacted)/iu.test(url)),
        `a sign-in state or credential name reached a span: ${urls.find((url) => /[?&](state|name)=/u.test(url))}`,
      );
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

live("a sign-in is over after its time (10 minutes on a Hub; none here)", () =>
  Effect.gen(function* () {
    const setup = yield* hub({ options: { tokenPollMs: 60_000, loginTtlMs: 0 } });
    const { stack, as, ownerId } = setup;
    const started = yield* stack.accounts
      .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
      .pipe(as(ownerId));
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete(
            { loginId: started.loginId, redirectUrl: Redacted.make(landedOn(started.url)) },
            SESSION,
          )
          .pipe(as(ownerId)),
      ),
      "expired",
    );
    assert.deepEqual(
      oauthSeen(stack).filter((seen) => seen.route === "/oauth/callback"),
      [],
    );
  }),
);

live("a token CLIProxyAPI refreshes is sealed again, so a restart keeps the rotated one", () =>
  Effect.gen(function* () {
    const setup = yield* hub({ options: { tokenPollMs: 200 } });
    const { stack } = setup;
    const account = yield* signIn(setup, stack);
    const file = tokenFileOf(stack, account.id) ?? "";
    const tokenId = tokenIdOf(file) ?? "";
    const sealedFile = NodePath.join(setup.tokensDir, `${tokenId}.sealed`);
    const before = NodeFS.readFileSync(sealedFile);
    const refreshed = yield* refreshInGateway(stack, file);
    // Read back and sealed again by the Hub by itself, within a few polls.
    yield* eventually(() => NodeFS.readFileSync(sealedFile).equals(before), false);
    assert.equal((yield* sealedToken(setup, tokenId))?.refresh_token, refreshed.refresh_token);
  }),
);

live(
  "after a restart the account works from the store, the newest token wins wherever it is, and without a memory folder none is loaded",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { server, dir } = setup;
      let stack = setup.stack;
      const account = yield* signIn(setup, stack);
      const file = tokenFileOf(stack, account.id) ?? "";
      const tokenId = tokenIdOf(file) ?? "";

      // A restart with the memory folder gone (a reboot): restored from the store.
      yield* stack.stop;
      NodeFS.rmSync(NodePath.join(dir, "memory"), { recursive: true, force: true });
      stack = yield* startStack(server, { dir });
      const restarted = stack;
      yield* eventually(() => tokenFileOf(restarted, account.id), file);
      assert.equal(tokenFileOf(stack, account.id), file);
      const restored = readJson(NodePath.join(stack.authDir, file));
      assert.equal(restored.refresh_token, (yield* sealedToken(setup, tokenId))?.refresh_token);
      assert.equal((yield* ownerView(setup, stack, account.id))?.status, "working");

      // CLIProxyAPI rotates it, and the Hub stops before reading it back: the next start, which
      // finds that newer file still in memory, seals it rather than overwrite it.
      const rotated = yield* refreshInGateway(stack, file);
      yield* stack.stop;
      stack = yield* startStack(server, { dir });
      yield* stack.accounts.sync;
      assert.equal((yield* sealedToken(setup, tokenId))?.refresh_token, rotated.refresh_token);
      assert.equal(
        readJson(NodePath.join(stack.authDir, file)).refresh_token,
        rotated.refresh_token,
      );

      // A stale copy left in memory (older than the sealed one) is replaced by the sealed one.
      yield* stack.stop;
      const stale = { ...readJson(NodePath.join(dir, "memory", "auth", file)) };
      stale.refresh_token = "fake-refresh-stale";
      stale.expired = "2020-01-01T00:00:00.000Z";
      stale.last_refresh = "2020-01-01T00:00:00.000Z";
      NodeFS.writeFileSync(NodePath.join(dir, "memory", "auth", file), JSON.stringify(stale));
      stack = yield* startStack(server, { dir });
      yield* stack.accounts.sync;
      assert.equal((yield* sealedToken(setup, tokenId))?.refresh_token, rotated.refresh_token);
      assert.equal(
        readJson(NodePath.join(stack.authDir, file)).refresh_token,
        rotated.refresh_token,
      );

      // A token left by a sign-in the Hub never captured goes too.
      yield* stack.stop;
      NodeFS.writeFileSync(
        NodePath.join(dir, "memory", "auth", "claude-stray@example.com.json"),
        JSON.stringify({ type: "claude", refresh_token: "fake-refresh-stray" }),
      );
      stack = yield* startStack(server, { dir });
      yield* stack.accounts.sync;
      assert.notInclude(filesIn(stack.authDir), "claude-stray@example.com.json");

      // No folder in memory: nothing goes to the gateway's folder on the disk, nor signs in.
      yield* stack.stop;
      stack = yield* startStack(server, { dir, inMemory: false });
      yield* stack.accounts.sync;
      assert.isUndefined(tokenFileOf(stack, account.id));
      const shown = yield* ownerView(setup, stack, account.id);
      assert.equal(shown?.status, "error");
      assert.match(shown?.statusMessage ?? "", /no folder in memory/u);
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .loginStart({ provider: "claude", name: "Owner Claude" }, SESSION)
            .pipe(setup.as(setup.ownerId)),
        ),
        "unavailable",
      );
      // Its sealed token is kept for when the Hub has one again.
      assert.isDefined(yield* sealedToken(setup, tokenId));
    }),
);

live(
  "«Sign in again» retires the old token; disabling or deleting takes it out of CLIProxyAPI and deleting out of the store",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId, server } = setup;
      const account = yield* signIn(setup, stack, "claude", "Owner Claude");
      const firstFile = tokenFileOf(stack, account.id) ?? "";
      const firstToken = tokenIdOf(firstFile) ?? "";
      // An API key cannot be put on a subscription.
      assert.equal(
        yield* reasonOf(
          stack.accounts
            .update({ accountId: account.id, apiKey: Redacted.make("sk-ant-0123456789abcdef") })
            .pipe(as(ownerId)),
        ),
        "invalid",
      );

      const again = yield* stack.accounts
        .loginStart({ provider: "claude", accountId: account.id }, SESSION)
        .pipe(as(ownerId));
      yield* stack.accounts
        .loginComplete(
          { loginId: again.loginId, redirectUrl: Redacted.make(landedOn(again.url)) },
          SESSION,
        )
        .pipe(as(ownerId));
      const secondFile = tokenFileOf(stack, account.id) ?? "";
      assert.notEqual(secondFile, firstFile);
      assert.notInclude(filesIn(stack.authDir), firstFile);
      assert.isUndefined(yield* sealedToken(setup, firstToken), "the old token stayed sealed");
      const kinds = yield* server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ai_account.login'
      `;
      assert.equal(kinds[0]?.n, 2);

      yield* stack.accounts.update({ accountId: account.id, disabled: true }).pipe(as(ownerId));
      assert.isUndefined(tokenFileOf(stack, account.id));
      yield* stack.accounts.update({ accountId: account.id, disabled: false }).pipe(as(ownerId));
      assert.equal(tokenFileOf(stack, account.id), secondFile);

      const deleted = yield* stack.accounts.remove({ accountId: account.id }).pipe(as(ownerId));
      assert.deepEqual(deleted, { deleted: true, gateway: "removed" });
      assert.isUndefined(tokenFileOf(stack, account.id));
      assert.isUndefined(yield* sealedToken(setup, tokenIdOf(secondFile) ?? ""));
      assert.deepEqual(filesIn(setup.tokensDir), []);
    }),
);

live("a device sign-in (Kimi) finishes once the Owner approves it on the provider's page", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId } = setup;
    const started = yield* stack.accounts
      .loginStart({ provider: "kimi", name: "Owner Kimi" }, SESSION)
      .pipe(as(ownerId));
    assert.equal(started.flow, "device");
    assert.equal(started.userCode, "FAKE-CODE");
    const complete = stack.accounts
      .loginComplete({ loginId: started.loginId }, SESSION)
      .pipe(as(ownerId));
    assert.equal(yield* reasonOf(complete), "pending");
    NodeFS.writeFileSync(NodePath.join(stack.memory, "fake-device-approve"), "");
    const account = yield* complete;
    assert.equal(account.provider, "kimi");
    yield* stack.accounts.update({ accountId: account.id, disabled: false }).pipe(as(ownerId));
    assert.isDefined(tokenFileOf(stack, account.id));
  }),
);

live("a provider that refuses the sign-in leaves no account, and says so in the audit log", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId, server } = setup;
    const started = yield* stack.accounts
      .loginStart({ provider: "codex", name: "Owner ChatGPT" }, SESSION)
      .pipe(as(ownerId));
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete(
            {
              loginId: started.loginId,
              redirectUrl: Redacted.make(landedOn(started.url, { code: "bad" })),
            },
            SESSION,
          )
          .pipe(as(ownerId)),
      ),
      "sign-in-failed",
    );
    const listed = yield* stack.accounts.list.pipe(as(ownerId));
    assert.deepEqual(listed.accounts, []);
    const failed = yield* server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ai_account.login'
    `;
    assert.equal(failed[0]?.n, 1);
  }),
);

live("a Vertex service account is imported and sealed; anything else is refused", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId, member, server } = setup;
    const key = JSON.stringify({
      type: "service_account",
      project_id: "acme-vertex",
      client_email: "agent@acme-vertex.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nfake-refresh-vertex-private\n-----END PRIVATE KEY-----\n",
    });
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .importVertex({
            name: "Vertex",
            serviceAccount: Redacted.make(key),
            owner: { kind: "user", userId: ownerId },
          })
          .pipe(as(member)),
      ),
      "forbidden",
    );
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .importVertex({ name: "Vertex", serviceAccount: Redacted.make('{"type":"user"}') })
          .pipe(as(ownerId)),
      ),
      "invalid",
    );
    const account = yield* stack.accounts
      .importVertex({ name: "Vertex", serviceAccount: Redacted.make(key) })
      .pipe(as(ownerId));
    assert.equal(account.provider, "vertex");
    assert.equal(account.type, "subscription");
    assert.equal(account.details?.signedInAs, "agent@acme-vertex.iam.gserviceaccount.com");
    yield* stack.accounts.update({ accountId: account.id, disabled: false }).pipe(as(ownerId));
    const file = tokenFileOf(stack, account.id);
    assert.isDefined(file);
    assert.notInclude(filesIn(stack.authDir), "vertex-acme-vertex.json");
    const rows = yield* server.sql.unsafe(`SELECT * FROM ai_accounts`);
    assert.isFalse(mentionsAToken(JSON.stringify(rows) + JSON.stringify(account)));
  }),
);

live(
  "each subscription shows CLIProxyAPI's status (sign in again, quota) and its quota windows",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack } = setup;
      const claude: AiAccountSummary = yield* signIn(setup, stack, "claude", "Owner Claude");
      const shown = yield* ownerView(setup, stack, claude.id);
      const windows = shown?.details?.usageLimits;
      assert.isDefined(windows ?? undefined, "no quota windows for the Claude subscription");
      assert.isFalse(mentionsAToken(JSON.stringify(shown)));

      const file = NodePath.join(stack.authDir, tokenFileOf(stack, claude.id) ?? "");
      NodeFS.writeFileSync(file, JSON.stringify({ ...readJson(file), fake_quota_blocked: true }));
      yield* stack.accounts.sync;
      assert.equal((yield* ownerView(setup, stack, claude.id))?.status, "quota-exhausted");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          ...readJson(file),
          fake_quota_blocked: false,
          fake_requires_sign_in: true,
        }),
      );
      yield* stack.accounts.sync;
      assert.equal((yield* ownerView(setup, stack, claude.id))?.status, "needs-sign-in");
    }),
);

live("the Usage dialog's Hub limits go to the Owner only, by account name (ticket 16)", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack } = setup;
    // No subscription yet: nothing to say, even to the Owner.
    assert.isNull(yield* stack.accounts.ownerSubscriptionLimits.pipe(setup.as(setup.ownerId)));
    yield* signIn(setup, stack, "claude", "Owner Claude");
    const owner = yield* stack.accounts.ownerSubscriptionLimits.pipe(setup.as(setup.ownerId));
    assert.equal(owner?.gatewayRunning, true);
    assert.deepEqual(
      owner?.accounts.map((account) => [account.name, account.provider]),
      [["Owner Claude", "claude"]],
    );
    assert.isAbove(owner?.accounts[0]?.usageLimits.windows.length ?? 0, 0);
    // Nothing of the credential: no e-mail, no token.
    assert.notInclude(JSON.stringify(owner), "@");
    assert.isFalse(mentionsAToken(JSON.stringify(owner)));
    // Anyone else, an Admin included, and the Owner limited to one Space: nothing at all.
    for (const view of [
      setup.as(setup.member),
      setup.as(setup.admin),
      setup.as(setup.ownerId, setup.acmeId),
    ]) {
      assert.isNull(yield* stack.accounts.ownerSubscriptionLimits.pipe(view));
    }
    assert.isNull(yield* stack.accounts.ownerSubscriptionLimits);
  }),
);

it("keeps the newest copy of a token: last refresh first, then access expiry; else the gateway's", () => {
  const sealed = {
    type: "claude",
    refresh_token: "a",
    last_refresh: "2026-11-01T00:00:00Z",
    expired: "2026-11-01T01:00:00Z",
  };
  // A later refresh wins even with an earlier access expiry.
  assert.equal(
    newerToken(sealed, {
      ...sealed,
      refresh_token: "b",
      last_refresh: "2026-11-02T00:00:00Z",
      expired: "2026-10-01T00:00:00Z",
    }),
    "gateway",
  );
  // An older refresh loses whatever else it carries.
  assert.equal(
    newerToken(sealed, {
      ...sealed,
      refresh_token: "c",
      last_refresh: "2026-10-01T00:00:00Z",
      expired: "2030-01-01T00:00:00Z",
    }),
    "sealed",
  );
  // Same times, different contents: CLIProxyAPI is the only writer, its copy wins.
  assert.equal(newerToken(sealed, { ...sealed, refresh_token: "d" }), "gateway");
  assert.equal(newerToken(sealed, { ...sealed, prefix: "acct-x", disabled: false }), "same");
});

live(
  "a new subscription stays disabled, with who it signed in as, until the Owner turns it on",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId } = setup;
      const started = yield* stack.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      const account = yield* stack.accounts
        .loginComplete(
          { loginId: started.loginId, redirectUrl: Redacted.make(landedOn(started.url)) },
          SESSION,
        )
        .pipe(as(ownerId));
      assert.isTrue(account.disabled);
      assert.equal(account.status, "disabled");
      assert.equal(account.details?.signedInAs, "owner@example.com");
      assert.match(account.statusMessage ?? "", /^Signed in as owner@example\.com\./u);
      // Not in the gateway, not used, until confirmed.
      assert.isUndefined(tokenFileOf(stack, account.id));
      assert.deepEqual(yield* stack.accounts.modelsOf(account.id), []);
      yield* stack.accounts.update({ accountId: account.id, disabled: false }).pipe(as(ownerId));
      assert.isDefined(tokenFileOf(stack, account.id));
    }),
);

live(
  "«Sign in again» as another account keeps the old token until the Owner confirms the new identity",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId } = setup;
      const account = yield* signIn(setup, stack, "claude", "Owner Claude");
      const before = tokenFileOf(stack, account.id);
      NodeFS.writeFileSync(NodePath.join(stack.memory, "fake-oauth-email"), "someone@else.test");
      const again = yield* stack.accounts
        .loginStart({ provider: "claude", accountId: account.id }, SESSION)
        .pipe(as(ownerId));
      const complete = (confirmIdentity?: boolean) =>
        stack.accounts
          .loginComplete(
            {
              loginId: again.loginId,
              redirectUrl: Redacted.make(landedOn(again.url)),
              ...(confirmIdentity === undefined ? {} : { confirmIdentity }),
            },
            SESSION,
          )
          .pipe(as(ownerId));
      const refused = yield* Effect.flip(complete());
      assert.equal(refused.reason, "identity-mismatch");
      assert.match(refused.message, /someone@else\.test, not owner@example\.com/u);
      assert.equal(tokenFileOf(stack, account.id), before, "the token was swapped unconfirmed");
      const swapped = yield* complete(true);
      assert.equal(swapped.details?.signedInAs, "someone@else.test");
      assert.notEqual(tokenFileOf(stack, account.id), before);
    }),
);

live("a sign-in that brings back two new files, or another provider's, is refused", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId } = setup;
    NodeFS.writeFileSync(NodePath.join(stack.memory, "fake-oauth-twice"), "");
    const started = yield* stack.accounts
      .loginStart({ provider: "codex", name: "Owner ChatGPT" }, SESSION)
      .pipe(as(ownerId));
    assert.equal(
      yield* reasonOf(
        stack.accounts
          .loginComplete(
            { loginId: started.loginId, redirectUrl: Redacted.make(landedOn(started.url)) },
            SESSION,
          )
          .pipe(as(ownerId)),
      ),
      "sign-in-failed",
    );
    assert.deepEqual(
      filesIn(stack.authDir).filter((name) => name.endsWith(".json")),
      [],
    );
    assert.deepEqual((yield* stack.accounts.list.pipe(as(ownerId))).accounts, []);
  }),
);

live(
  "an open sign-in keeps only its own provider's new file; an expired or replaced one keeps none",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { stack, as, ownerId } = setup;
      const raw = (name: string, type: string) =>
        NodeFS.writeFileSync(
          NodePath.join(stack.authDir, name),
          JSON.stringify({ type, refresh_token: "fake-refresh-raw" }),
        );
      yield* stack.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      raw("antigravity-new@example.com.json", "antigravity");
      raw("claude-stray@example.com.json", "claude");
      yield* stack.accounts.sync;
      assert.deepEqual(
        filesIn(stack.authDir).filter((name) => name.endsWith(".json")),
        ["antigravity-new@example.com.json"],
      );
      // Another sign-in replaces it: that file was there before the new one, so it goes.
      yield* stack.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      yield* stack.accounts.sync;
      assert.deepEqual(
        filesIn(stack.authDir).filter((name) => name.endsWith(".json")),
        [],
      );

      // An expired one (its time is none here) keeps nothing either.
      yield* stack.stop;
      const expiring = yield* startStack(setup.server, {
        dir: setup.dir,
        options: { tokenPollMs: 60_000, loginTtlMs: 0 },
      });
      yield* expiring.accounts
        .loginStart({ provider: "antigravity", name: "Owner Google" }, SESSION)
        .pipe(as(ownerId));
      raw("antigravity-late@example.com.json", "antigravity");
      yield* expiring.accounts.sync;
      assert.deepEqual(
        filesIn(expiring.authDir).filter((name) => name.endsWith(".json")),
        [],
      );
    }),
);

live(
  "with the gateway off, a refreshed token is sealed and disabling or deleting leaves no token in the memory folder",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub({ ownerPlacement: true });
      const { stack, as, ownerId } = setup;
      const account = yield* signIn(setup, stack);
      const file = tokenFileOf(stack, account.id) ?? "";
      const tokenId = tokenIdOf(file) ?? "";
      const rotated = yield* refreshInGateway(stack, file);
      // Off by the Owner: its process goes; the file stays in memory, its newer token is sealed.
      yield* stack.gateway.setEnabled(false).pipe(as(ownerId));
      assert.isTrue(Option.isNone(yield* stack.gateway.endpoint));
      yield* stack.accounts.sync;
      assert.equal((yield* sealedToken(setup, tokenId))?.refresh_token, rotated.refresh_token);
      yield* stack.accounts.update({ accountId: account.id, disabled: true }).pipe(as(ownerId));
      assert.isUndefined(tokenFileOf(stack, account.id), "a disabled account's token stayed");
      assert.equal((yield* sealedToken(setup, tokenId))?.refresh_token, rotated.refresh_token);
      // A stray file and an unknown account's go before the next launch.
      NodeFS.writeFileSync(NodePath.join(stack.authDir, "claude-stray.json"), "{}");
      yield* stack.accounts.update({ accountId: account.id, disabled: false }).pipe(as(ownerId));
      const deleted = yield* stack.accounts.remove({ accountId: account.id }).pipe(as(ownerId));
      assert.equal(deleted.gateway, "not-running");
      assert.deepEqual(
        filesIn(stack.authDir).filter((name) => name.endsWith(".json")),
        [],
      );
      assert.isUndefined(yield* sealedToken(setup, tokenId));
    }),
);

live("at the Hub's stop, a token CLIProxyAPI refreshed since the last look is sealed", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack } = setup;
    const account = yield* signIn(setup, stack);
    const file = tokenFileOf(stack, account.id) ?? "";
    const rotated = yield* refreshInGateway(stack, file);
    // The poll is a minute away here: only the stop reads it back.
    yield* stack.stop;
    assert.equal(
      (yield* sealedToken(setup, tokenIdOf(file) ?? ""))?.refresh_token,
      rotated.refresh_token,
    );
  }),
);

live("a token reconcile that fails leaves the API keys provisioned", () =>
  Effect.gen(function* () {
    const setup = yield* hub();
    const { stack, as, ownerId } = setup;
    NodeFS.writeFileSync(NodePath.join(stack.memory, "fake-credentials-down"), "");
    const made = yield* stack.accounts
      .create({
        name: "Key",
        provider: "claude",
        apiKey: Redacted.make("sk-ant-0123456789abcdef0123"),
      })
      .pipe(as(ownerId));
    const shown = yield* ownerView(setup, stack, made.id);
    assert.equal(shown?.status, "working");
  }),
);
