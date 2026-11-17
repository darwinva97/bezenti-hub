/**
 * API-key AI accounts (spec 4 ticket 02) with the Owner, an Admin, a Member and a Guest of Acme
 * and a Member of Globex, over a Hub with the fake CLIProxyAPI: only the Owner manages them, each
 * User lists only what AllowedAiAccounts lets them use, and credentials stay in the encrypted
 * store and CLIProxyAPI's memory, never in the database, an answer, a log or a span.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the store's files and runs the fake gateway.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type AiAccountError,
  type AiAccountId,
  type AiAccountSummary,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
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
import {
  type FakeCliproxyMode,
  fakeCliproxyRelease,
  fakeReleases,
  pinsOf,
} from "./AiGateway.testkit.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

const os = HostProcess.Platform.defaultValue();
const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
const posix = os === "linux" || os === "darwin";

const ACME_KEY = "sk-acme-openai-compatible-0123456789abcdef";
const GLOBEX_KEY = "sk-ant-globex-claude-key-fedcba9876543210";
const GRACE_KEY = "AIzaGraceGeminiKey_0123456789abcdefghij";
const REPLACED_KEY = "sk-acme-replaced-key-aaaabbbbccccdddd";
const KEYS = [ACME_KEY, GLOBEX_KEY, GRACE_KEY, REPLACED_KEY];
const mentionsAKey = (text: string) => KEYS.some((key) => text.includes(key));

/** The fake gateway as the Hub runs it, with the Hub's own encrypted store, in the test's scope. */
const startGateway = Effect.fn(function* (
  services: Context.Context<ServerSecretStore.ServerSecretStore>,
  mode: FakeCliproxyMode = "serve",
  enabled = true,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-accounts-"));
  const release = fakeCliproxyRelease(dir, "1.0.0", mode);
  const stateDir = NodePath.join(dir, "state");
  const memory = NodePath.join(dir, "memory");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: { _tag: "forced", enabled },
    os,
    stateDir,
    platform: platform!,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: memory, inMemory: true },
    restartDelay: { initialMs: 100, maxMs: 200 },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          Context.get(services, ServerSecretStore.ServerSecretStore),
        ),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
  return { gateway, dir, memory, stateDir };
});

const waitRunning = (gateway: AiGateway.AiGateway["Service"]) =>
  gateway.changes.pipe(
    Stream.filter((status) => status.state === "running"),
    Stream.runHead,
  );

/** What the running CLIProxyAPI holds now, read through its Management API with the Hub's key. */
const gatewayConfig = (gateway: AiGateway.AiGateway["Service"]) =>
  Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return yield* Effect.die("the gateway is not running");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${endpoint.value.baseUrl}/v8/management/config`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(endpoint.value.managementKey)),
      ),
    );
    return (yield* response.json) as {
      readonly "api-keys"?: Record<
        string,
        ReadonlyArray<{
          readonly prefix: string;
          readonly keys: ReadonlyArray<{ readonly "api-key": string }>;
        }>
      >;
    };
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

const prefixesIn = (config: Effect.Success<ReturnType<typeof gatewayConfig>>) =>
  Object.values(config["api-keys"] ?? {})
    .flat()
    .map((entry) => entry.prefix)
    .toSorted();

/** While true, the credential store fails every read (an unreadable disk, a busy file). */
const storeFault = { failReads: false };

const hub = (mode: FakeCliproxyMode = "serve", options: { readonly gateway?: boolean } = {}) =>
  Effect.gen(function* () {
    storeFault.failReads = false;
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
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
    const globexId = yield* organization("Globex");
    const person = Effect.fn(function* (
      id: string,
      spaceId: SpaceId,
      role: "admin" | "member" | "guest",
    ) {
      yield* addMember(server, { id, displayName: id });
      yield* joinOrganization(server, spaceId, id, role);
      if (role === "admin") {
        yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
            transports, rp_id, created_at)
          VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
      }
      return UserId.make(id);
    });
    const people = {
      admin: yield* person("ada", acmeId, "admin"),
      member: yield* person("grace", acmeId, "member"),
      guest: yield* person("linus", acmeId, "guest"),
      globexMember: yield* person("gus", globexId, "member"),
    };
    const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
    yield* directory.membershipsChanged(Object.values(people));
    const { gateway, memory } = yield* startGateway(server.services, mode, options.gateway ?? true);
    const realStore = Context.get(server.services, ServerSecretStore.AiAccountCredentialStore);
    const faultyStore = ServerSecretStore.AiAccountCredentialStore.of({
      ...realStore,
      get: (id) =>
        storeFault.failReads
          ? Effect.fail(
              new ServerSecretStore.SecretStoreReadError({
                resource: `credential ${id}`,
                cause: "EIO",
              }),
            )
          : realStore.get(id),
    });
    const context = yield* Layer.build(
      AiAccounts.layer.pipe(
        Layer.provide(AuditLog.layer),
        Layer.provide(Layer.succeed(AiGateway.AiGateway, gateway)),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeedContext(
            Context.add(server.services, ServerSecretStore.AiAccountCredentialStore, faultyStore),
          ),
        ),
      ),
    );
    const accounts = Context.get(context, AiAccounts.AiAccounts);
    const allowed = Context.get(context, AllowedAiAccounts.AllowedAiAccounts);
    const store = Context.get(server.services, ServerSecretStore.ServerSecretStore);
    const credentialsDir = NodePath.join(store.directory ?? "", "ai-accounts");
    const as =
      (userId: UserId, spaceLimit?: SpaceId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        spaceLimit === undefined
          ? CommandActor.actAs(userId)(effect)
          : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit })(effect);
    return {
      server,
      ownerId,
      acmeId,
      globexId,
      people,
      directory,
      gateway,
      memory,
      accounts,
      allowed,
      credentialsDir,
      as,
    };
  });

type Hub = Effect.Success<ReturnType<typeof hub>>;

const reasonOf = <A, R>(effect: Effect.Effect<A, AiAccountError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

/**
 * The Owner's setup: «Acme OpenRouter» (openai-compatible) allowed to Acme, «Globex Claude»
 * allowed to Globex, «Grace Gemini» allowed to the User grace, «Old Acme» allowed to Acme and
 * disabled.
 */
const ownerSetup = Effect.fn(function* (setup: Hub) {
  const { accounts, as, ownerId, acmeId, globexId, people } = setup;
  const acme = yield* accounts
    .create({
      name: "Acme OpenRouter",
      provider: "openai-compatible",
      apiKey: Redacted.make(ACME_KEY),
      baseUrl: "https://openrouter.example/api/v1",
      models: ["deepseek-chat", "deepseek-reasoner"],
    })
    .pipe(as(ownerId));
  const globex = yield* accounts
    .create({ name: "Globex Claude", provider: "claude", apiKey: Redacted.make(GLOBEX_KEY) })
    .pipe(as(ownerId));
  const grace = yield* accounts
    .create({ name: "Grace Gemini", provider: "gemini", apiKey: Redacted.make(GRACE_KEY) })
    .pipe(as(ownerId));
  const old = yield* accounts
    .create({ name: "Old Acme", provider: "codex", apiKey: Redacted.make(`${ACME_KEY}-old`) })
    .pipe(as(ownerId));
  yield* accounts.allow({ accountId: acme.id, spaceIds: [acmeId], userIds: [] }).pipe(as(ownerId));
  yield* accounts
    .allow({ accountId: globex.id, spaceIds: [globexId], userIds: [] })
    .pipe(as(ownerId));
  yield* accounts
    .allow({ accountId: grace.id, spaceIds: [], userIds: [people.member] })
    .pipe(as(ownerId));
  yield* accounts.allow({ accountId: old.id, spaceIds: [acmeId], userIds: [] }).pipe(as(ownerId));
  yield* accounts.update({ accountId: old.id, disabled: true }).pipe(as(ownerId));
  return { acme, globex, grace, old };
});

const namesOf = (accounts: ReadonlyArray<AiAccountSummary>) =>
  accounts.map((account) => account.name).toSorted();

it.live.skipIf(!posix || platform === undefined)(
  "only the Owner creates, changes, allows, orders and deletes AI accounts",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, acmeId, people } = setup;
      const { acme } = yield* ownerSetup(setup);
      // Everyone but the Owner, and the Owner's own agent bound to Acme's Sandbox, which acts
      // on nothing Installation-wide.
      const callers: ReadonlyArray<readonly [UserId, SpaceId | undefined]> = [
        ...Object.values(people).map((userId) => [userId, undefined] as const),
        [ownerId, acmeId],
      ];
      for (const [who, limit] of callers) {
        const run = as(who, limit);
        const refused = [
          yield* reasonOf(
            accounts
              .create({ name: `${who} key`, provider: "xai", apiKey: Redacted.make(ACME_KEY) })
              .pipe(run),
          ),
          yield* reasonOf(accounts.update({ accountId: acme.id, name: "Mine" }).pipe(run)),
          yield* reasonOf(
            accounts.update({ accountId: acme.id, apiKey: Redacted.make(REPLACED_KEY) }).pipe(run),
          ),
          yield* reasonOf(
            accounts
              .allow({ accountId: acme.id, spaceIds: [acmeId], userIds: [UserId.make(who)] })
              .pipe(run),
          ),
          yield* reasonOf(accounts.reorder({ accountIds: [acme.id] }).pipe(run)),
          yield* reasonOf(accounts.remove({ accountId: acme.id }).pipe(run)),
        ];
        assert.deepEqual(refused, Array(6).fill("forbidden"), `${who} managed an AI account`);
      }
      // Nothing changed: still the Owner's four, Acme's first.
      const listed = yield* accounts.list.pipe(as(ownerId));
      assert.isTrue(listed.canManage);
      assert.deepEqual(
        listed.accounts.map((account) => [account.name, account.priority]),
        [
          ["Acme OpenRouter", 1],
          ["Globex Claude", 2],
          ["Grace Gemini", 3],
          ["Old Acme", 4],
        ],
      );
      const reordered = yield* accounts
        .reorder({ accountIds: listed.accounts.map((account) => account.id).toReversed() })
        .pipe(as(ownerId));
      assert.deepEqual(
        reordered.accounts.map((account) => account.name),
        ["Old Acme", "Grace Gemini", "Globex Claude", "Acme OpenRouter"],
      );
      assert.equal(
        yield* reasonOf(accounts.reorder({ accountIds: [acme.id] }).pipe(as(ownerId))),
        "invalid",
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "each User lists only what they may use, by name, provider and status, never a credential",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, acmeId, globexId, people } = setup;
      yield* ownerSetup(setup);
      const seenBy = (userId: UserId, spaceLimit?: SpaceId) =>
        accounts.list.pipe(as(userId, spaceLimit));

      const member = yield* seenBy(people.member);
      assert.isFalse(member.canManage);
      assert.deepEqual(namesOf(member.accounts), ["Acme OpenRouter", "Grace Gemini"]);
      for (const account of member.accounts) {
        assert.isNull(account.details, "a Member got an account's details");
      }
      // Acme's is usable in Acme; the one allowed to her, wherever she works, her Personal space too.
      assert.deepEqual(
        member.accounts.map((account) => [account.name, account.usableIn]),
        [
          ["Acme OpenRouter", [acmeId]],
          ["Grace Gemini", [acmeId, `personal:${people.member}`]],
        ],
      );
      // Same rule for an Admin and a Guest of Acme: Acme's, not Globex's, not grace's own.
      assert.deepEqual(namesOf((yield* seenBy(people.admin)).accounts), ["Acme OpenRouter"]);
      assert.deepEqual(namesOf((yield* seenBy(people.guest)).accounts), ["Acme OpenRouter"]);
      assert.deepEqual(namesOf((yield* seenBy(people.globexMember)).accounts), ["Globex Claude"]);
      // A session limited to one Space sees nothing of another's, the Owner's agent included.
      assert.deepEqual(namesOf((yield* seenBy(people.member, globexId)).accounts), []);
      const ownerInGlobex = yield* seenBy(ownerId, globexId);
      assert.isFalse(ownerInGlobex.canManage);
      assert.deepEqual(namesOf(ownerInGlobex.accounts), ["Globex Claude"]);
      for (const account of ownerInGlobex.accounts) assert.isNull(account.details);

      // The Owner sees everything but the credential: its last four characters at most.
      const full = yield* seenBy(ownerId);
      const acme = full.accounts.find((account) => account.name === "Acme OpenRouter");
      assert.equal(acme?.details?.keyHint, ACME_KEY.slice(-4));
      assert.deepEqual(acme?.details?.allowances, { spaceIds: [acmeId], userIds: [] });
      assert.deepEqual(acme?.details?.models, ["deepseek-chat", "deepseek-reasoner"]);
      const everything = JSON.stringify([
        full,
        member,
        yield* seenBy(people.admin),
        yield* seenBy(people.guest),
        yield* seenBy(people.globexMember),
      ]);
      assert.isFalse(mentionsAKey(everything), "a credential left the Hub in a list");
      assert.notInclude(everything, ACME_KEY.slice(-8));
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "AllowedAiAccounts: the Space's and the User's, only where the User works, none disabled",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, allowed, as, ownerId, acmeId, globexId, people, directory } = setup;
      const { acme, globex, grace, old } = yield* ownerSetup(setup);
      const ids = (userId: UserId, spaceId: SpaceId) =>
        allowed.for(userId, spaceId).pipe(Effect.map((list) => list.map((account) => account.id)));

      // Allowed to Acme: grace in Acme, not gus (who is not in Acme), not grace in Globex.
      assert.deepEqual(yield* ids(people.member, acmeId), [acme.id, grace.id]);
      assert.deepEqual(yield* ids(people.globexMember, acmeId), []);
      assert.deepEqual(yield* ids(people.member, globexId), []);
      assert.deepEqual(yield* ids(people.globexMember, globexId), [globex.id]);
      // Allowed to grace: hers in her Spaces, nobody else's.
      assert.deepEqual(yield* ids(people.admin, acmeId), [acme.id]);
      assert.deepEqual(yield* ids(people.guest, acmeId), [acme.id]);
      assert.deepEqual(yield* ids(ownerId, acmeId), [acme.id]);
      assert.notInclude(yield* ids(ownerId, acmeId), old.id);

      // Changes count from the next call: an allowance gone, an account disabled, a Member out.
      yield* accounts.allow({ accountId: acme.id, spaceIds: [], userIds: [] }).pipe(as(ownerId));
      assert.deepEqual(yield* ids(people.member, acmeId), [grace.id]);
      yield* accounts.update({ accountId: grace.id, disabled: true }).pipe(as(ownerId));
      assert.deepEqual(yield* ids(people.member, acmeId), []);
      yield* accounts.update({ accountId: grace.id, disabled: false }).pipe(as(ownerId));
      assert.deepEqual(yield* ids(people.member, acmeId), [grace.id]);
      yield* directory.removeMembership({ spaceId: acmeId, userId: people.member });
      yield* directory.membershipsChanged([people.member]);
      assert.deepEqual(yield* ids(people.member, acmeId), []);
      // Out of Acme she still works in her Personal space, where the one allowed to her goes on.
      assert.deepEqual(namesOf((yield* accounts.list.pipe(as(people.member))).accounts), [
        "Grace Gemini",
      ]);
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "credentials go to CLIProxyAPI under acct-<id> by its Management API; disable, replace and delete follow",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, gateway, credentialsDir } = setup;
      yield* waitRunning(gateway);
      const { acme, globex, grace, old } = yield* ownerSetup(setup);
      const prefix = (id: AiAccountId) => `acct-${id}`;
      const config = yield* gatewayConfig(gateway);
      // Enabled accounts only, each under its own prefix with its own key.
      assert.deepEqual(prefixesIn(config), [acme.id, globex.id, grace.id].map(prefix).toSorted());
      const compatible = config["api-keys"]?.["openai-compatibility"]?.[0];
      assert.equal(compatible?.prefix, prefix(acme.id));
      assert.equal(compatible?.keys[0]?.["api-key"], ACME_KEY);
      assert.equal(config["api-keys"]?.claude?.[0]?.keys[0]?.["api-key"], GLOBEX_KEY);
      assert.deepEqual(yield* accounts.modelsOf(acme.id), ["deepseek-chat", "deepseek-reasoner"]);
      assert.deepEqual(yield* accounts.modelsOf(old.id), []);
      const listed = yield* accounts.list.pipe(as(ownerId));
      assert.equal(listed.accounts.find((account) => account.id === acme.id)?.status, "working");

      // «Replace credential»: the gateway gets the new key; the old sealed file goes.
      const filesBefore = NodeFS.readdirSync(credentialsDir);
      yield* accounts
        .update({ accountId: acme.id, apiKey: Redacted.make(REPLACED_KEY) })
        .pipe(as(ownerId));
      const replaced = yield* gatewayConfig(gateway);
      assert.equal(
        replaced["api-keys"]?.["openai-compatibility"]?.[0]?.keys[0]?.["api-key"],
        REPLACED_KEY,
      );
      assert.equal(NodeFS.readdirSync(credentialsDir).length, filesBefore.length);
      assert.isFalse(
        NodeFS.readdirSync(credentialsDir).every((file) => filesBefore.includes(file)),
        "the replaced credential kept its file",
      );
      // Disabled: out of the gateway. Deleted: out of the gateway and the store.
      yield* accounts.update({ accountId: globex.id, disabled: true }).pipe(as(ownerId));
      assert.deepEqual(
        prefixesIn(yield* gatewayConfig(gateway)),
        [acme.id, grace.id].map(prefix).toSorted(),
      );
      yield* accounts.remove({ accountId: acme.id }).pipe(as(ownerId));
      yield* accounts.remove({ accountId: old.id }).pipe(as(ownerId));
      assert.deepEqual(prefixesIn(yield* gatewayConfig(gateway)), [prefix(grace.id)]);
      // Grace's and the disabled Globex one remain sealed; the deleted ones' are gone.
      assert.equal(NodeFS.readdirSync(credentialsDir).length, 2);
      assert.equal(yield* reasonOf(accounts.modelsOf(acme.id)), "not-found");
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "a CLIProxyAPI that restarts gets the accounts back from the store before it counts as running",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { gateway, memory } = setup;
      yield* waitRunning(gateway);
      const { acme, grace, globex } = yield* ownerSetup(setup);
      const before = yield* gateway.status;
      const pidFile = NodeFS.readdirSync(memory).find((name) => /^fake-\d+\.json$/u.test(name));
      const pid = Number(/^fake-(\d+)\.json$/u.exec(pidFile ?? "")?.[1]);
      process.kill(pid, "SIGKILL");
      // The new start is provisioned before it is «running», so the first running status after
      // the crash already serves the accounts.
      yield* gateway.changes.pipe(
        Stream.filter(
          (status) => status.state === "running" && status.startedAt !== before.startedAt,
        ),
        Stream.runHead,
      );
      const config = yield* gatewayConfig(gateway);
      assert.deepEqual(
        prefixesIn(config),
        [acme.id, globex.id, grace.id].map((id) => `acct-${id}`).toSorted(),
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "credentials live sealed in their own store folder: not in the database, the audit log, a log or a span",
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
      const { server, accounts, as, ownerId, people, gateway, credentialsDir } = setup;
      yield* waitRunning(gateway);
      const { acme } = yield* ownerSetup(setup);
      yield* accounts
        .update({ accountId: acme.id, apiKey: Redacted.make(REPLACED_KEY) })
        .pipe(as(ownerId));
      // A refused write says why, never what.
      const refused = yield* Effect.flip(
        accounts
          .create({ name: "Mine", provider: "claude", apiKey: Redacted.make(GLOBEX_KEY) })
          .pipe(as(people.admin)),
      );
      assert.isFalse(mentionsAKey(JSON.stringify(refused) + refused.message));
      const invalid = yield* Effect.flip(
        accounts
          .create({ name: "Bad", provider: "claude", apiKey: Redacted.make(`${GLOBEX_KEY} x`) })
          .pipe(as(ownerId)),
      );
      assert.equal(invalid.reason, "invalid");
      assert.isFalse(mentionsAKey(invalid.message));

      const tables = yield* server.sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      for (const { name } of tables) {
        const rows = yield* server.sql.unsafe(`SELECT * FROM "${name}"`);
        const text = JSON.stringify(rows, (_key, value) =>
          value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value,
        );
        assert.isFalse(mentionsAKey(text), `a credential is in the table ${name}`);
      }
      const audits = yield* server.sql<{ readonly action: string }>`
        SELECT action FROM audit_log WHERE action LIKE 'ai_account.%'
      `;
      assert.includeMembers(
        audits.map((row) => row.action),
        ["ai_account.create", "ai_account.update", "ai_account.allow"],
      );
      const files = NodeFS.readdirSync(credentialsDir);
      assert.isAbove(files.length, 0);
      for (const file of files) {
        assert.match(file, /^cred-[0-9a-f]{32}\.sealed$/u);
        const bytes = NodeFS.readFileSync(NodePath.join(credentialsDir, file)).toString("latin1");
        assert.isFalse(mentionsAKey(bytes), `${file} holds a credential in clear`);
      }
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.isAbove(spans.length, 0);
      assert.isFalse(recorded.some(mentionsAKey), "a credential reached a log or a span");
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

it.live.skipIf(!posix || platform === undefined)(
  "a refused write marks the accounts and is tried again; a credential left by a crash goes at the next start",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub("refuse");
      const { server, accounts, as, ownerId, gateway, credentialsDir } = setup;
      yield* waitRunning(gateway);
      const made = yield* accounts
        .create({ name: "Refused", provider: "xai", apiKey: Redacted.make(GRACE_KEY) })
        .pipe(as(ownerId));
      const listed = yield* accounts.list.pipe(as(ownerId));
      const account = listed.accounts.find((candidate) => candidate.id === made.id);
      assert.equal(account?.status, "error");
      assert.match(account?.statusMessage ?? "", /^Not in the AI gateway yet/u);
      assert.isFalse(mentionsAKey(account?.statusMessage ?? ""));

      // A credential no row holds (a Hub stopped between storing it and its row): swept.
      const store = Context.get(server.services, ServerSecretStore.AiAccountCredentialStore);
      yield* store.set("cred-0123456789abcdef0123456789abcdef", new TextEncoder().encode("x"));
      assert.include(
        NodeFS.readdirSync(credentialsDir),
        "cred-0123456789abcdef0123456789abcdef.sealed",
      );
      yield* Layer.build(
        AiAccounts.layer.pipe(
          Layer.provide(AuditLog.layer),
          Layer.provide(Layer.succeed(AiGateway.AiGateway, gateway)),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeedContext(server.services)),
        ),
      );
      const left = NodeFS.readdirSync(credentialsDir);
      assert.notInclude(left, "cred-0123456789abcdef0123456789abcdef.sealed");
      assert.equal(left.length, 1);
    }),
);

/** How many config changes the fake CLIProxyAPI was sent. */
const patchesSent = (memory: string) => {
  const log = NodePath.join(memory, "fake-patches.log");
  return NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").split("\n").length - 1 : 0;
};

const keyOf = (config: Effect.Success<ReturnType<typeof gatewayConfig>>, prefix: string) =>
  Object.values(config["api-keys"] ?? {})
    .flat()
    .find((entry) => entry.prefix === prefix)?.keys[0]?.["api-key"];

it.live.skipIf(!posix || platform === undefined)(
  "a key replaced or an account deleted while the gateway refuses is not a success, and its old key goes once the gateway takes it",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, gateway, memory, credentialsDir, people } = setup;
      yield* waitRunning(gateway);
      const { acme, globex } = yield* ownerSetup(setup);
      const refuseAll = NodePath.join(memory, "fake-refuse-all");
      NodeFS.writeFileSync(refuseAll, "");
      const filesBefore = NodeFS.readdirSync(credentialsDir).toSorted();

      // A leaked key replaced: not reported done while the gateway still serves it.
      const replaced = yield* Effect.flip(
        accounts
          .update({ accountId: acme.id, apiKey: Redacted.make(REPLACED_KEY) })
          .pipe(as(ownerId)),
      );
      assert.equal(replaced.reason, "still-live");
      assert.equal(keyOf(yield* gatewayConfig(gateway), `acct-${acme.id}`), ACME_KEY);
      const listed = yield* accounts.list.pipe(as(ownerId));
      assert.match(
        listed.accounts.find((account) => account.id === acme.id)?.statusMessage ?? "",
        /old key is still live/u,
      );
      // Deleted: gone for everyone at once, but not reported done while the gateway holds it.
      const deleted = yield* Effect.flip(
        accounts.remove({ accountId: globex.id }).pipe(as(ownerId)),
      );
      assert.equal(deleted.reason, "still-live");
      assert.equal(
        (yield* accounts.list.pipe(as(ownerId))).accounts.find(
          (account) => account.id === globex.id,
        )?.status,
        "removing",
      );
      assert.deepEqual(namesOf((yield* accounts.list.pipe(as(people.globexMember))).accounts), []);
      assert.includeMembers(NodeFS.readdirSync(credentialsDir), filesBefore);

      // The gateway takes changes again: the old keys leave it, then the store.
      NodeFS.rmSync(refuseAll);
      yield* accounts.sync;
      const config = yield* gatewayConfig(gateway);
      assert.equal(keyOf(config, `acct-${acme.id}`), REPLACED_KEY);
      assert.notInclude(prefixesIn(config), `acct-${globex.id}`);
      assert.notInclude(JSON.stringify(config), ACME_KEY);
      const after = yield* accounts.list.pipe(as(ownerId));
      assert.notInclude(
        after.accounts.map((account) => account.id),
        globex.id,
      );
      assert.isNull(after.accounts.find((account) => account.id === acme.id)?.statusMessage);
      // Grace's, Old Acme's and Acme's new key: the old Acme key and Globex's are gone.
      assert.equal(NodeFS.readdirSync(credentialsDir).length, 3);
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "with no gateway running a deleted account's key is live nowhere: it goes at once",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub("serve", { gateway: false });
      const { accounts, as, ownerId, credentialsDir } = setup;
      const made = yield* accounts
        .create({ name: "Lonely", provider: "xai", apiKey: Redacted.make(GRACE_KEY) })
        .pipe(as(ownerId));
      assert.equal(NodeFS.readdirSync(credentialsDir).length, 1);
      const result = yield* accounts.remove({ accountId: made.id }).pipe(as(ownerId));
      assert.deepEqual(result, { deleted: true, gateway: "not-running" });
      assert.equal(NodeFS.readdirSync(credentialsDir).length, 0);
      assert.deepEqual((yield* accounts.list.pipe(as(ownerId))).accounts, []);
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key the store cannot read leaves the gateway as it is, rather than dropping the account",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, gateway } = setup;
      yield* waitRunning(gateway);
      const first = yield* accounts
        .create({ name: "First", provider: "claude", apiKey: Redacted.make(GLOBEX_KEY) })
        .pipe(as(ownerId));
      storeFault.failReads = true;
      const second = yield* accounts
        .create({ name: "Second", provider: "xai", apiKey: Redacted.make(GRACE_KEY) })
        .pipe(as(ownerId));
      const held = yield* gatewayConfig(gateway);
      assert.equal(keyOf(held, `acct-${first.id}`), GLOBEX_KEY, "a read error dropped an account");
      assert.notInclude(prefixesIn(held), `acct-${second.id}`);
      storeFault.failReads = false;
      yield* accounts.sync;
      assert.deepEqual(
        prefixesIn(yield* gatewayConfig(gateway)),
        [`acct-${first.id}`, `acct-${second.id}`].toSorted(),
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "one account the gateway refuses stays out alone, with its reason; the others stay live and it is not sent again unchanged",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, gateway, memory } = setup;
      yield* waitRunning(gateway);
      const good = yield* accounts
        .create({
          name: "Good",
          provider: "openai-compatible",
          apiKey: Redacted.make(ACME_KEY),
          baseUrl: "https://good.example/v1",
          models: ["deepseek-chat"],
        })
        .pipe(as(ownerId));
      const bad = yield* accounts
        .create({
          name: "Bad",
          provider: "openai-compatible",
          apiKey: Redacted.make(REPLACED_KEY),
          baseUrl: "https://refuse.invalid/v1",
          models: ["deepseek-chat"],
        })
        .pipe(as(ownerId));
      assert.deepEqual(prefixesIn(yield* gatewayConfig(gateway)), [`acct-${good.id}`]);
      const listed = (yield* accounts.list.pipe(as(ownerId))).accounts;
      assert.equal(listed.find((account) => account.id === good.id)?.status, "working");
      const refused = listed.find((account) => account.id === bad.id);
      assert.equal(refused?.status, "error");
      assert.match(refused?.statusMessage ?? "", /refused it: invalid_config/u);
      assert.isFalse(mentionsAKey(refused?.statusMessage ?? ""), "the reason quoted a key");
      // Unchanged, it is not sent again: one change, the good account alone.
      const before = patchesSent(memory);
      yield* accounts.sync;
      assert.equal(patchesSent(memory) - before, 1);
      assert.deepEqual(prefixesIn(yield* gatewayConfig(gateway)), [`acct-${good.id}`]);
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "renames, allowances and order leave the gateway alone; an unreadable model list is unverified",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub();
      const { accounts, as, ownerId, gateway, memory, acmeId } = setup;
      yield* waitRunning(gateway);
      const { acme, old } = yield* ownerSetup(setup);
      const before = patchesSent(memory);
      yield* accounts.update({ accountId: acme.id, name: "Acme renamed" }).pipe(as(ownerId));
      const allowed = yield* accounts
        .allow({
          accountId: acme.id,
          // A Space deleted meanwhile is dropped, not refused.
          spaceIds: [acmeId, SpaceId.make("space-deleted-meanwhile")],
          userIds: [UserId.make("user-removed-meanwhile")],
        })
        .pipe(as(ownerId));
      assert.deepEqual(allowed.details?.allowances, { spaceIds: [acmeId], userIds: [] });
      const order = (yield* accounts.list.pipe(as(ownerId))).accounts.map((account) => account.id);
      yield* accounts.reorder({ accountIds: order.toReversed() }).pipe(as(ownerId));
      assert.equal(patchesSent(memory), before, "a change the gateway does not hold reached it");
      // A disabled account always says so.
      assert.equal(
        (yield* accounts.list.pipe(as(ownerId))).accounts.find((account) => account.id === old.id)
          ?.status,
        "disabled",
      );
      NodeFS.writeFileSync(NodePath.join(memory, "fake-models-down"), "");
      const added = yield* accounts
        .create({ name: "Unlisted", provider: "meta", apiKey: Redacted.make(GRACE_KEY) })
        .pipe(as(ownerId));
      assert.equal(
        (yield* accounts.list.pipe(as(ownerId))).accounts.find((account) => account.id === added.id)
          ?.status,
        "unverified",
      );
      // A key with an invisible character is refused, saying why.
      const invisible = yield* Effect.flip(
        accounts
          .create({
            name: "Zero width",
            provider: "xai",
            apiKey: Redacted.make(`sk-abc\u200bdef1234567890`),
          })
          .pipe(as(ownerId)),
      );
      assert.equal(invisible.reason, "invalid");
      assert.match(invisible.message, /invisible character/u);
    }),
);
