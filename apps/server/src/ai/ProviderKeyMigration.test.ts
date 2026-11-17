/**
 * Spec 4 ticket 09: over an earlier version's state, each provider key becomes an AI account of the
 * Owner's and leaves no copy in settings.json, the secret store, the database, the logs or an
 * answer; twice is once. A server without AI accounts in use (a desktop) keeps and saves its keys.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test runs the fake gateway and reads its files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type SecretReference,
  SecretProviderId,
  UserId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { bootstrapOwner, makeAuthenticator, serveAuthHttp } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import { fakeCliproxyRelease, fakeReleases, pinsOf } from "./AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";
import * as ProviderKeyMigration from "./ProviderKeyMigration.ts";

const os = HostProcess.Platform.defaultValue();
const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
const posix = os === "linux" || os === "darwin";

const CLAUDE_KEY = "sk-ant-api03-migrated-claude-0123456789abcdef";
const OPENAI_KEY = "sk-proj-migrated-openai-plain-0123456789abcd";
const AGY_KEY = "AIzaMigratedAntigravityKey_0123456789abcdefgh";
const CURSOR_KEY = "key_migrated_cursor_from_1password_0123456789";
const UNREADABLE = "op://Private/Gemini/credential";
const KEYS = [CLAUDE_KEY, OPENAI_KEY, AGY_KEY, CURSOR_KEY];
const mentionsAKey = (text: string) => KEYS.some((key) => text.includes(key));

const onePassword = SecretProviderId.make("onepassword");
const reference = (path: string): SecretReference => ({ provider: onePassword, reference: path });

/** 1Password as the Hub reads it: one item it can read, anything else unreadable. */
const resolver = SecretResolver.SecretResolver.of({
  read: (references) =>
    Effect.succeed(
      references.map((entry) =>
        entry.reference === "op://Private/Cursor/credential" ? CURSOR_KEY : undefined,
      ),
    ),
  invalidate: () => Effect.void,
});

const driver = ProviderDriverKind.make;
const id = ProviderInstanceId.make;

const startGateway = Effect.fn(function* (
  services: Context.Context<ServerSecretStore.ServerSecretStore>,
  enabled: boolean,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-key-migration-"));
  const release = fakeCliproxyRelease(dir, "1.0.0", "serve");
  const stateDir = NodePath.join(dir, "state");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return yield* AiGateway.make({
    placement: { _tag: "forced", enabled },
    os,
    stateDir,
    platform: platform!,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: NodePath.join(dir, "memory"), inMemory: true },
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
});

/** A Hub with its Owner, its settings service and AI accounts, the gateway on or off. */
const hub = (options: { readonly gateway: boolean; readonly withOwner?: boolean }) =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const ownerId =
      options.withOwner === false
        ? undefined
        : UserId.make(
            (
              (yield* bootstrapOwner(server, yield* makeAuthenticator())).created.body.user as {
                id: string;
              }
            ).id,
          );
    const gateway = yield* startGateway(server.services, options.gateway);
    const context = yield* Layer.build(
      Layer.mergeAll(
        AiAccounts.layer.pipe(Layer.provide(AuditLog.layer)),
        ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layerTest())),
      ).pipe(
        Layer.provideMerge(Layer.succeed(AiGateway.AiGateway, gateway)),
        Layer.provideMerge(Layer.succeed(SecretResolver.SecretResolver, resolver)),
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(Layer.succeedContext(server.services)),
      ),
    );
    const settings = Context.get(context, ServerSettings.ServerSettingsService);
    const sql = Context.get(context, SqlClient.SqlClient);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideContext(effect, context as unknown as Context.Context<R>);
    return { server, ownerId, settings, sql, run, context };
  });

/**
 * What an earlier version saved: a sealed Claude key on two instances, a plain OpenAI key in
 * settings.json, Antigravity's key, Cursor's from 1Password, an unreadable Gemini reference, and
 * an unrelated secret that stays.
 */
const earlierState = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  Effect.gen(function* () {
    const save = (instanceId: string, instance: object) =>
      settings.updateProviderInstance({
        operation: "upsert",
        instanceId: id(instanceId),
        instance: instance as never,
      });
    yield* save("claudeAgent", {
      driver: driver("claudeAgent"),
      environment: [
        { name: "ANTHROPIC_API_KEY", value: CLAUDE_KEY, sensitive: true },
        { name: "HTTPS_PROXY_TOKEN", value: "proxy-stays", sensitive: true },
      ],
    });
    yield* save("claude_work", {
      driver: driver("claudeAgent"),
      displayName: "Claude work",
      environment: [{ name: "ANTHROPIC_API_KEY", value: CLAUDE_KEY, sensitive: true }],
    });
    yield* save("codex", {
      driver: driver("codex"),
      environment: [{ name: "OPENAI_API_KEY", value: OPENAI_KEY, sensitive: false }],
    });
    yield* save("antigravity", {
      driver: driver("antigravity"),
      config: { authMethod: "gemini-api-key", apiKey: AGY_KEY },
    });
    yield* save("cursor", {
      driver: driver("cursor"),
      environment: [
        {
          name: "CURSOR_API_KEY",
          value: reference("op://Private/Cursor/credential"),
          sensitive: true,
        },
      ],
    });
    yield* save("opencode", {
      driver: driver("opencode"),
      environment: [{ name: "GEMINI_API_KEY", value: reference(UNREADABLE), sensitive: true }],
    });
  });

interface AccountRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: string;
  readonly provider: string;
  readonly createdBy: string;
}

const accountsOf = (sql: SqlClient.SqlClient) =>
  sql<AccountRow>`
    SELECT account_id AS "accountId", name, type, provider, created_by AS "createdBy"
    FROM ai_accounts ORDER BY name
  `;

/** Every row of every table, as text: the database holds no key. */
const databaseText = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    const parts: string[] = [];
    for (const table of tables) {
      const rows = yield* sql.unsafe(`SELECT * FROM "${table.name}"`);
      parts.push(JSON.stringify(rows));
    }
    return parts.join("\n");
  });

const captureLogs = (logs: string[]) =>
  Logger.layer(
    [
      Logger.make((options) => {
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
      }),
    ],
    { mergeWithExisting: false },
  );

it.live.skipIf(!posix || platform === undefined)(
  "moves today's provider keys into the Owner's AI accounts once, and leaves no copy",
  () => {
    const logs: string[] = [];
    return Effect.gen(function* () {
      const { ownerId, settings, sql, run } = yield* hub({ gateway: true });
      yield* earlierState(settings);

      const first = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(first.created, 4);
      assert.deepEqual([...first.left], ["opencode:GEMINI_API_KEY"]);

      const accounts = yield* accountsOf(sql);
      assert.deepEqual(
        accounts.map(({ name, type, provider }) => ({ name, type, provider })),
        [
          { name: "Claude (migrated)", type: "api-key", provider: "claude" },
          { name: "Cursor (migrated)", type: "direct", provider: "cursor" },
          { name: "Gemini (migrated)", type: "direct", provider: "gemini" },
          { name: "OpenAI (migrated)", type: "api-key", provider: "codex" },
        ],
      );
      for (const account of accounts) assert.equal(account.createdBy, ownerId);
      // The Owner's own, so usable in their Personal space with no loan (Grants ticket 02).
      const lent = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM grants`;
      assert.equal(lent[0]?.n, 0);
      const audit = yield* sql<{ readonly source: string; readonly detail: string }>`
        SELECT actor_source AS source, detail_json AS detail FROM audit_log
        WHERE action = 'ai_account.create'
      `;
      assert.equal(audit.length, 4);
      for (const entry of audit) {
        assert.equal(entry.source, "system");
        assert.equal(JSON.parse(entry.detail).via, "migration");
      }

      // The instances no longer hold them; the rest stays, the unreadable reference included.
      const after = yield* settings.getSettings;
      const environmentOf = (instanceId: string) =>
        (after.providerInstances[id(instanceId)]?.environment ?? []).map((v) => v.name);
      assert.deepEqual(environmentOf("claudeAgent"), ["HTTPS_PROXY_TOKEN"]);
      assert.deepEqual(environmentOf("claude_work"), []);
      assert.deepEqual(environmentOf("codex"), []);
      assert.deepEqual(environmentOf("cursor"), []);
      assert.deepEqual(environmentOf("opencode"), ["GEMINI_API_KEY"]);
      assert.notProperty(after.providerInstances[id("antigravity")]?.config ?? {}, "apiKey");
      assert.equal(
        after.providerInstances[id("claudeAgent")]?.environment?.[0]?.value,
        "proxy-stays",
      );

      // No copy left: the settings file, the secret store's other entries, the database, the
      // answers and the logs.
      const config = yield* run(ServerConfig.ServerConfig);
      const fs = yield* run(FileSystem.FileSystem);
      assert.isFalse(mentionsAKey(yield* fs.readFileString(config.settingsPath)));
      const store = yield* run(ServerSecretStore.ServerSecretStore);
      const providerSecrets: string[] = [];
      for (const entry of NodeFS.readdirSync(store.directory ?? "", { recursive: true })) {
        const name = String(entry);
        if (!name.endsWith(".sealed") || name.startsWith("ai-accounts")) continue;
        const secretName = name.replace(/\.sealed$/u, "");
        if (secretName.startsWith("provider-")) providerSecrets.push(secretName);
        const value = yield* store.get(secretName);
        if (value._tag === "Some") {
          assert.isFalse(mentionsAKey(new TextDecoder().decode(value.value)), name);
        }
      }
      const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
      // Only the secret that stays on its instance is left among the provider secrets.
      assert.deepEqual(providerSecrets, [
        `provider-env-${b64("claudeAgent")}-${b64("HTTPS_PROXY_TOKEN")}`,
      ]);
      assert.isFalse(mentionsAKey(yield* databaseText(sql)));
      assert.isFalse(
        mentionsAKey(
          JSON.stringify(
            ServerSettings.redactServerSettingsForClient(after, { secretReferences: true }),
          ),
        ),
      );
      assert.isFalse(mentionsAKey(JSON.stringify(after)));

      // Twice is once.
      const second = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(second.created, 0);
      assert.equal((yield* accountsOf(sql)).length, 4);
      assert.isFalse(logs.some(mentionsAKey));
      assert.isTrue(logs.some((line) => line.includes("Provider keys moved into AI accounts")));
    }).pipe(
      Effect.provide(captureLogs(logs)),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

it.live.skipIf(!posix || platform === undefined)(
  "a stop between the account and the removal leaves the key owned; the next start only removes it",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run } = yield* hub({ gateway: true });
      yield* earlierState(settings);
      // The account is made, then the removal fails (the Hub stops before its write).
      const failingRemoval = ServerSettings.ServerSettingsService.of({
        ...settings,
        removeProviderCredentials: () =>
          Effect.die("the Hub stopped before removing the keys from the instances"),
      });
      const stopped = yield* run(
        ProviderKeyMigration.migrateProviderKeys.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, failingRemoval),
          Effect.exit,
        ),
      );
      assert.equal(stopped._tag, "Failure");
      assert.equal((yield* accountsOf(sql)).length, 4);
      const halfway = yield* settings.getSettings;
      assert.equal(
        halfway.providerInstances[id("codex")]?.environment?.[0]?.name,
        "OPENAI_API_KEY",
      );
      const next = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(next.created, 0);
      assert.equal((yield* accountsOf(sql)).length, 4);
      assert.deepEqual(
        (yield* settings.getSettings).providerInstances[id("codex")]?.environment,
        [],
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "a desktop without AI accounts keeps its keys, saves new ones and moves nothing",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run, context } = yield* hub({ gateway: false });
      yield* earlierState(settings);
      yield* Layer.build(
        ProviderKeyMigration.layer.pipe(Layer.provide(Layer.succeedContext(context))),
      );
      const pass = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(pass.created, 0);
      assert.equal((yield* accountsOf(sql)).length, 0);
      const saved = yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex_two"),
        instance: {
          driver: driver("codex"),
          environment: [
            { name: "OPENAI_API_KEY", value: "sk-desktop-new-0123456789", sensitive: true },
          ],
        },
      });
      assert.equal(
        saved.providerInstances[id("codex_two")]?.environment?.[0]?.value,
        "sk-desktop-new-0123456789",
      );
      assert.equal(
        (yield* settings.getSettings).providerInstances[id("claudeAgent")]?.environment?.[0]?.value,
        CLAUDE_KEY,
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "on a Hub with the gateway on, the start moves the keys and settings refuse new ones",
  () =>
    Effect.gen(function* () {
      const { settings, sql, context } = yield* hub({ gateway: true });
      yield* earlierState(settings);
      // The start's pass runs beside the Hub's start; it says when it is done.
      const done = yield* Deferred.make<void>();
      const logger = Logger.make((options) => {
        if (JSON.stringify(options.message).includes("Provider keys moved into AI accounts")) {
          Deferred.doneUnsafe(done, Effect.void);
        }
      });
      yield* Layer.build(
        ProviderKeyMigration.layer.pipe(
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(Logger.layer([logger])),
        ),
      );
      yield* Deferred.await(done);
      assert.equal((yield* accountsOf(sql)).length, 4);
      const refused = yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId: id("codex"),
          instance: {
            driver: driver("codex"),
            environment: [
              { name: "OPENAI_API_KEY", value: "sk-back-again-0123456789", sensitive: true },
            ],
          },
        })
        .pipe(Effect.flip);
      assert.equal(refused.operation, "write-ai-credential");
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "without an Owner nothing moves; the keys wait for one",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run } = yield* hub({ gateway: true, withOwner: false });
      yield* earlierState(settings);
      const pass = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(pass.created, 0);
      assert.equal((yield* accountsOf(sql)).length, 0);
      assert.equal(
        (yield* settings.getSettings).providerInstances[id("codex")]?.environment?.[0]?.value,
        OPENAI_KEY,
      );
    }),
);

// The gateway's state is all the condition reads besides the accounts.
it.effect("AI accounts are in use once the gateway is on or an account exists", () =>
  Effect.gen(function* () {
    const states = ["off", "unsupported", "running", "failed"] as const;
    const inUse: boolean[] = [];
    for (const state of states) {
      const gateway = AiGateway.AiGateway.of({
        status: Effect.succeed({ state } as never),
      } as never);
      const sql = (() => Effect.succeed([{ found: 0 }])) as unknown as SqlClient.SqlClient;
      inUse.push(
        yield* ProviderKeyMigration.aiAccountsInUse.pipe(
          Effect.provideService(AiGateway.AiGateway, gateway),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
    }
    assert.deepEqual(inUse, [false, false, true, true]);
  }),
);

it.effect("each key becomes the account its variable and driver say", () =>
  Effect.sync(() => {
    const of = (kind: "environment" | "field", name: string, on: string, authMethod?: string) =>
      ProviderKeyMigration.accountFor({ kind, name, driver: driver(on), authMethod });
    assert.deepEqual(of("field", "apiKey", "antigravity", "agent-platform"), {
      provider: "vertex",
      type: "direct",
    });
    assert.deepEqual(of("field", "apiKey", "antigravity", "gemini-api-key"), {
      provider: "gemini",
      type: "direct",
    });
    assert.deepEqual(of("environment", "GEMINI_API_KEY", "opencode"), {
      provider: "gemini",
      type: "api-key",
    });
    assert.deepEqual(of("environment", "XAI_API_KEY", "grok"), { provider: "xai", type: "direct" });
    assert.deepEqual(of("environment", "ANTHROPIC_AUTH_TOKEN", "claudeAgent"), {
      provider: "claude",
      type: "api-key",
    });
    assert.deepEqual(of("environment", "DEVIN_TOKEN", "acpRegistry"), {
      provider: "devin",
      type: "direct",
    });
    assert.deepEqual(of("environment", "AI_GATEWAY_API_KEY", "fx"), {
      provider: "fx",
      type: "direct",
    });
  }),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key saved again after its moved account was deleted becomes an account, never lost",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run } = yield* hub({ gateway: true });
      yield* earlierState(settings);
      yield* run(ProviderKeyMigration.migrateProviderKeys);
      // The Owner deleted every account: with none usable, the instance takes a key again.
      yield* sql`UPDATE ai_accounts SET deleted_at = '2026-11-13T00:00:00.000Z'`;
      const newKey = "sk-proj-saved-again-after-delete-0123456789";
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex"),
        instance: {
          driver: driver("codex"),
          environment: [{ name: "OPENAI_API_KEY", value: newKey, sensitive: true }],
        },
      });
      const pass = yield* run(ProviderKeyMigration.migrateProviderKeys);
      assert.equal(pass.created, 1);
      const live = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_accounts WHERE provider = 'codex' AND deleted_at IS NULL
      `;
      assert.equal(live[0]?.n, 1);
      assert.deepEqual(
        (yield* settings.getSettings).providerInstances[id("codex")]?.environment,
        [],
      );
    }),
);

it.live.skipIf(!posix || platform === undefined)(
  "deleting a moved account forgets its ledger rows",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run, ownerId } = yield* hub({ gateway: true });
      yield* earlierState(settings);
      yield* run(ProviderKeyMigration.migrateProviderKeys);
      const openAi = (yield* accountsOf(sql)).find((row) => row.provider === "codex");
      const accounts = yield* run(AiAccounts.AiAccounts);
      yield* accounts
        .remove({ accountId: openAi!.accountId as never })
        .pipe(CommandActor.actAs(ownerId!), Effect.exit);
      const ledger = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_account_migrated_keys WHERE account_id = ${openAi!.accountId}
      `;
      assert.equal(ledger[0]?.n, 0);
    }),
);

it.effect("a read error of the accounts never counts as AI accounts in use", () =>
  Effect.gen(function* () {
    const gateway = AiGateway.AiGateway.of({
      status: Effect.succeed({ state: "off" } as never),
    } as never);
    const failing = (() => Effect.fail("unreadable")) as unknown as SqlClient.SqlClient;
    const inUse = yield* ProviderKeyMigration.aiAccountsInUse.pipe(
      Effect.provideService(AiGateway.AiGateway, gateway),
      Effect.provideService(SqlClient.SqlClient, failing),
    );
    assert.isFalse(inUse);
  }),
);

it.live.skipIf(!posix || platform === undefined)(
  "an account deleted between its making and the removal keeps the key on the instance",
  () =>
    Effect.gen(function* () {
      const { settings, sql, run } = yield* hub({ gateway: true });
      yield* earlierState(settings);
      // The Owner deletes every new account just before the removal's write.
      const racing = ServerSettings.ServerSettingsService.of({
        ...settings,
        removeProviderCredentials: (items, stillOwned) =>
          sql`UPDATE ai_accounts SET deleted_at = '2026-11-13T00:00:00.000Z'`.pipe(
            Effect.orDie,
            Effect.andThen(settings.removeProviderCredentials!(items, stillOwned)),
          ),
      });
      const pass = yield* run(
        ProviderKeyMigration.migrateProviderKeys.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, racing),
        ),
      );
      assert.equal(pass.removed, 0);
      assert.equal(
        (yield* settings.getSettings).providerInstances[id("codex")]?.environment?.[0]?.value,
        OPENAI_KEY,
      );
    }),
);
