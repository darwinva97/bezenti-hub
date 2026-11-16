/**
 * SecretDelivery (spec 5 ticket 04): what one process of a Thread receives, read as it starts.
 * Whose secrets a turn gets comes from the Hub (its Thread owner), never from the caller.
 */
import {
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  MAIN_VAULT_ID,
  ThreadId,
  UserId,
  SecretDeliveryError,
  type SecretEnv,
  type VaultEntryId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { readError, readValue } from "@t3tools/secret-provider-core/server/driver";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a plain sha256, to show the fingerprint is not one.
import * as NodeCrypto from "node:crypto";

import * as CommandActor from "../auth/CommandActor.ts";
import { bootstrapOwner, makeAuthenticator, serveAuthHttpWith } from "../auth/UserAuth.testkit.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DeliveredValues from "./DeliveredValues.ts";
import {
  FAKE_PROVIDER_ID,
  FAKE_PROVIDER_LABEL,
  makeFakeSecretProvider,
} from "./ProviderReads.testkit.ts";
import * as SecretDelivery from "./SecretDelivery.ts";
import * as SecretMasker from "./SecretMasker.ts";
import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import * as Vaults from "./Vaults.ts";

const HUB = {
  environmentId: HUB_MACHINE_ENVIRONMENT_ID,
  contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
};

const ownersThreadWith = (
  secretFiles?: Layer.Layer<ThreadSecretFiles.ThreadSecretFiles>,
  identityIssuer?: string,
) =>
  Effect.gen(function* () {
    const provider = makeFakeSecretProvider();
    const server = yield* serveAuthHttpWith({
      providerReads: provider.options,
      ...(secretFiles === undefined ? {} : { secretFiles }),
      ...(identityIssuer === undefined ? {} : { identityIssuer }),
    });
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = UserId.make((created.body.user as { id: string }).id);
    const vaults = Context.get(server.services, Vaults.Vaults);
    const delivery = Context.get(server.services, SecretDelivery.SecretDelivery);
    const entries = new Map<string, VaultEntryId>();
    const put = (
      name: string,
      value: string,
      confirmDangerous?: boolean,
      entryClass?: "secret" | "variable",
    ) =>
      vaults
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name,
          value: Redacted.make(value),
          ...(entries.has(name) ? { entryId: entries.get(name)! } : {}),
          ...(confirmDangerous === undefined ? {} : { confirmDangerous }),
          ...(entryClass === undefined ? {} : { class: entryClass }),
        })
        .pipe(
          CommandActor.actAs(owner),
          Effect.tap((result) => Effect.sync(() => void entries.set(name, result.entry.id))),
        );
    const thread = Effect.fn(function* (id: string, rootThreadId?: string) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, space_id, owner_user_id
      ) VALUES (
        ${id}, 'project:none', ${id}, 'codex', 'full-access', 'default', ${now}, ${now},
        ${JSON.stringify(rootThreadId === undefined ? {} : { lineage: { rootThreadId } })},
        ${`personal:${owner}`}, ${rootThreadId === undefined ? owner : null}
      )
    `;
      return ThreadId.make(id);
    });
    // A process starting: the plan, then its values.
    const forTurn = (input: Parameters<typeof delivery.planTurn>[0]) =>
      delivery.planTurn(input).pipe(Effect.flatMap(delivery.resolve));
    const forProcess = (input: Parameters<typeof delivery.plan>[0]) =>
      delivery.plan(input).pipe(Effect.flatMap(delivery.resolve));
    // Ticket 02: a Provider entry of the Main vault, read from the fake provider.
    const putProvider = (name: string, reference: string) =>
      vaults
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name,
          provider: { providerId: FAKE_PROVIDER_ID, reference },
        })
        .pipe(CommandActor.actAs(owner));
    return {
      server,
      owner,
      vaults,
      put,
      putProvider,
      provider,
      thread,
      delivery,
      forTurn,
      forProcess,
    };
  });

const ownersThread = ownersThreadWith();

const valueOf = (secretEnv: SecretEnv | undefined, name: string) =>
  secretEnv?.variables?.find((variable) => variable.name === name)?.value;

it.effect("a turn gets its Thread owner's secrets, a child Thread its root's", () =>
  Effect.gen(function* () {
    const { owner, put, thread, delivery, forTurn, forProcess } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    const root = yield* thread("thread:root");
    const child = yield* thread("thread:child", root);
    const turn = yield* forTurn({ threadId: root, target: HUB });
    assert.equal(valueOf(turn, "OWNER_TOKEN"), "owner-token-value");
    const childTurn = yield* forTurn({ threadId: child, target: HUB });
    assert.equal(valueOf(childTurn, "OWNER_TOKEN"), "owner-token-value");
    assert.equal(turn?.fingerprint, childTurn?.fingerprint);
    // A process nobody starts gets nothing.
    assert.deepEqual(yield* forProcess({ threadId: root, actingUserId: undefined, target: HUB }), {
      fingerprint: "none",
      variables: [],
    });
    assert.isTrue(yield* delivery.mayReceiveSecrets(root));
    assert.deepEqual(yield* delivery.turnOwner(child), yield* delivery.turnOwner(root));
    assert.deepEqual(yield* delivery.turnOwner(root), Option.some(owner));
  }).pipe(Effect.scoped),
);

it.effect("a rotation changes what the next process gets, and its fingerprint", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "first-value");
    const threadId = yield* thread("thread:rotate");
    const before = yield* forTurn({ threadId, target: HUB });
    yield* put("OWNER_TOKEN", "rotated-value");
    const after = yield* forTurn({ threadId, target: HUB });
    assert.equal(valueOf(after, "OWNER_TOKEN"), "rotated-value");
    assert.notEqual(before?.fingerprint, after?.fingerprint);
    assert.notInclude(after?.fingerprint ?? "", "rotated-value");
  }).pipe(Effect.scoped),
);

it.effect("a machine before executor contract 10 gets a refusal, not a process without them", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    const threadId = yield* thread("thread:old");
    const old = { environmentId: HUB_MACHINE_ENVIRONMENT_ID, contractVersion: 9 };
    // Without secrets, an old machine works as before.
    assert.deepEqual(yield* forTurn({ threadId, target: old }), {
      fingerprint: "none",
      variables: [],
    });
    yield* put("OWNER_TOKEN", "owner-token-value");
    const refused = yield* Effect.exit(forTurn({ threadId, target: old }));
    assert.isTrue(Exit.isFailure(refused));
    assert.include(JSON.stringify(refused), "outdated-machine");
  }).pipe(Effect.scoped),
);

it.effect("a machine that does not serve the Thread's Space gets nothing", () =>
  Effect.gen(function* () {
    const { put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    const threadId = yield* thread("thread:elsewhere");
    const unknown = {
      environmentId: EnvironmentId.make("environment:unknown"),
      contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
    };
    assert.deepEqual(yield* forTurn({ threadId, target: unknown }), {
      fingerprint: "none",
      variables: [],
    });
  }).pipe(Effect.scoped),
);

it.effect("a Variable is delivered plain: never remembered for masking, never masked", () =>
  Effect.gen(function* () {
    const { server, put, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    yield* put("AWS_REGION", "eu-central-1", undefined, "variable");
    const threadId = yield* thread("thread:variables");
    const before = yield* forTurn({ threadId, target: HUB });
    assert.deepEqual(
      before?.variables?.map((variable) => ({ ...variable })),
      [
        { name: "AWS_REGION", value: "eu-central-1", plain: true },
        { name: "OWNER_TOKEN", value: "owner-token-value" },
      ],
    );
    // Only the Secret is recorded as delivered for the Thread's masking.
    const remembered = yield* server.sql<{ readonly name: string }>`
      SELECT name FROM thread_secret_values WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(
      remembered.map((row) => row.name),
      ["OWNER_TOKEN"],
    );
    const masker = yield* Context.get(server.services, SecretMasker.SecretMasker).forThread(
      threadId,
    );
    assert.equal(
      masker.mask("region eu-central-1, token owner-token-value"),
      "region eu-central-1, token [OWNER_TOKEN]",
    );
    // Turned into a Secret, it goes as one: a new set, so a new fingerprint.
    yield* put("AWS_REGION", "eu-central-1-secret", undefined, "secret");
    const after = yield* forTurn({ threadId, target: HUB });
    assert.notEqual(before?.fingerprint, after?.fingerprint);
    assert.isUndefined(after?.variables?.find((variable) => variable.name === "AWS_REGION")?.plain);
  }).pipe(Effect.scoped),
);

it.effect("a name that changes how tools run goes only as the Owner set it", () =>
  Effect.gen(function* () {
    const { server, put, thread, forTurn } = yield* ownersThread;
    yield* put("LD_PRELOAD_LIBS", "/owner/lib.so", true);
    const threadId = yield* thread("thread:dangerous");
    assert.equal(
      valueOf(yield* forTurn({ threadId, target: HUB }), "LD_PRELOAD_LIBS"),
      "/owner/lib.so",
    );
    // Written by anyone else (a write the Owner did not make), it is never delivered.
    yield* server.sql`UPDATE vault_entries SET updated_by = 'someone-else' WHERE name = 'LD_PRELOAD_LIBS'`;
    assert.isUndefined(valueOf(yield* forTurn({ threadId, target: HUB }), "LD_PRELOAD_LIBS"));
  }).pipe(Effect.scoped),
);

// Ticket 02 of «Variables, Secretos sellados y Secret providers»: Provider entries.

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

it.effect(
  "a Provider entry is read as its process starts; a rotation changes the HMAC fingerprint",
  () =>
    Effect.gen(function* () {
      const { server, putProvider, provider, thread, forTurn } = yield* ownersThread;
      let current = "kube-token-first-0001";
      provider.state.answer = () => readValue(current);
      yield* putProvider("KUBE_TOKEN", "kv/acme/kube#token");
      const threadId = yield* thread("thread:provider");
      const before = yield* forTurn({ threadId, target: HUB });
      assert.equal(valueOf(before, "KUBE_TOKEN"), current);
      for (const leak of [current, sha256(current)]) {
        assert.notInclude(before?.fingerprint ?? "", leak);
      }
      // Held by the cache: the next turn asks the provider nothing.
      yield* forTurn({ threadId, target: HUB });
      assert.lengthOf(provider.state.batches, 1);
      // Rotated in the provider: the next read after the refresh interval changes the set.
      const first = current;
      current = "kube-token-rotated-0002";
      yield* TestClock.adjust("6 minutes");
      const after = yield* forTurn({ threadId, target: HUB });
      assert.equal(valueOf(after, "KUBE_TOKEN"), current);
      assert.notEqual(before?.fingerprint, after?.fingerprint);
      // Both are masked in the Thread, the old one too; the rows name an HMAC, never the value.
      const masker = yield* Context.get(server.services, SecretMasker.SecretMasker).forThread(
        threadId,
      );
      assert.equal(masker.mask(`${first} ${current}`), "[KUBE_TOKEN] [KUBE_TOKEN]");
      const rows = yield* server.sql<{ readonly valueId: string }>`
      SELECT value_id AS "valueId" FROM thread_secret_values WHERE thread_id = ${threadId}
    `;
      assert.lengthOf(rows, 2);
      for (const row of rows) {
        assert.match(row.valueId, /^delivered:[0-9a-f]{64}$/);
        assert.notInclude(row.valueId, sha256(first));
        assert.notInclude(row.valueId, sha256(current));
      }
    }).pipe(Effect.scoped),
);

it.effect("a provider that does not answer fails the start whole; nothing of the set goes", () =>
  Effect.gen(function* () {
    const { server, put, putProvider, provider, thread, delivery } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    yield* putProvider("KUBE_TOKEN", "kv/acme/kube#token");
    yield* putProvider("DB_URL", "kv/acme/db#url");
    provider.state.gate = Effect.never;
    const threadId = yield* thread("thread:hangs");
    const starting = yield* delivery
      .planTurn({ threadId, target: HUB })
      .pipe(Effect.flatMap(delivery.resolve), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    const failure = yield* Fiber.join(starting);
    assert.equal(failure._tag, "SecretProviderReadError");
    assert.deepEqual(
      failure._tag === "SecretProviderReadError"
        ? {
            reason: failure.reason,
            provider: failure.provider,
            scope: failure.scope,
            entries: [...failure.entries].sort(),
          }
        : failure,
      {
        reason: "unavailable",
        provider: FAKE_PROVIDER_LABEL,
        scope: null,
        entries: ["DB_URL", "KUBE_TOKEN"],
      },
    );
    assert.equal(failure.message.startsWith(`${FAKE_PROVIDER_LABEL} didn't answer for`), true);
    // Nothing was delivered, so nothing was remembered for the Thread.
    const remembered = yield* server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM thread_secret_values WHERE thread_id = ${threadId}
    `;
    assert.equal(remembered[0]?.n, 0);
  }).pipe(Effect.scoped),
);

it.effect("a refusal and a missing reference have their own codes, and never a value", () =>
  Effect.gen(function* () {
    const { putProvider, provider, thread, forTurn } = yield* ownersThread;
    yield* putProvider("KUBE_TOKEN", "kv/acme/kube#token");
    const threadId = yield* thread("thread:refused");
    for (const [error, code] of [
      ["forbidden", "secret_provider_forbidden"],
      ["not-found", "secret_provider_not_found"],
    ] as const) {
      provider.state.answer = () => readError(error);
      const failure = yield* Effect.flip(forTurn({ threadId, target: HUB }));
      assert.equal(failure._tag, "SecretProviderReadError");
      assert.equal(failure._tag === "SecretProviderReadError" ? failure.code : null, code);
    }
    // A driver that dies with the value in its defect: unavailable, the value nowhere.
    provider.state.gate = Effect.die(new Error("kube-token-in-a-defect-0003"));
    const died = yield* Effect.flip(forTurn({ threadId, target: HUB }));
    assert.equal(died._tag === "SecretProviderReadError" ? died.reason : died._tag, "unavailable");
    assert.notInclude(JSON.stringify(died) + died.message, "kube-token-in-a-defect-0003");
  }).pipe(Effect.scoped),
);

it.effect("a Provider entry whose provider is gone is left out; the start goes on", () =>
  Effect.gen(function* () {
    const { put, putProvider, provider, thread, forTurn } = yield* ownersThread;
    yield* put("OWNER_TOKEN", "owner-token-value");
    yield* putProvider("KUBE_TOKEN", "kv/acme/kube#token");
    provider.state.providers = {};
    const threadId = yield* thread("thread:broken");
    const env = yield* forTurn({ threadId, target: HUB });
    assert.deepEqual(
      env?.variables?.map((variable) => variable.name),
      ["OWNER_TOKEN"],
    );
    assert.lengthOf(provider.state.batches, 0);
  }).pipe(Effect.scoped),
);

it.effect("a deleted Thread takes its delivered values with it, but not another Thread's", () =>
  Effect.gen(function* () {
    const { server, putProvider, provider, thread, forTurn } = yield* ownersThread;
    provider.state.answer = () => readValue("kube-token-shared-0004");
    yield* putProvider("KUBE_TOKEN", "kv/acme/kube#token");
    const gone = yield* thread("thread:gone");
    const kept = yield* thread("thread:kept");
    yield* forTurn({ threadId: gone, target: HUB });
    yield* forTurn({ threadId: kept, target: HUB });
    const store = Context.get(server.services, ServerSecretStore.DeliveredValueStore);
    assert.lengthOf(yield* store.list, 1);
    const forget = (threadId: string) =>
      server.sql`
        UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-17T00:00:00.000Z'
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.andThen(DeliveredValues.forgetThread(threadId)),
        Effect.provideService(SqlClient.SqlClient, server.sql),
        Effect.provideService(ServerSecretStore.DeliveredValueStore, store),
      );
    yield* forget(gone);
    // The other Thread still holds the value: it stays, masked there.
    assert.lengthOf(yield* store.list, 1);
    yield* forget(kept);
    assert.deepEqual(yield* store.list, []);
    const rows = yield* server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM thread_secret_values WHERE value_id LIKE 'delivered:%'
    `;
    assert.equal(rows[0]?.n, 0);
    // The start's sweep removes a value no Thread holds (one a stop left behind).
    yield* store.set("left-behind", new TextEncoder().encode("left-behind-0005"));
    yield* DeliveredValues.sweep.pipe(
      Effect.provideService(SqlClient.SqlClient, server.sql),
      Effect.provideService(ServerSecretStore.DeliveredValueStore, store),
    );
    assert.deepEqual(yield* store.list, []);
  }).pipe(Effect.scoped),
);

// Ticket 05: Secret files and Template entries.

const isDeliveryError = Schema.is(SecretDeliveryError);

/** The Hub machine's root in memory, as its ThreadSecretFiles found it (nothing is written here). */
const HUB_FILES_ROOT = "/dev/shm/t3code-thread-files-test";
const hubFilesInMemory = Layer.effect(
  ThreadSecretFiles.ThreadSecretFiles,
  ThreadSecretFiles.make({ path: HUB_FILES_ROOT, inMemory: true }),
);
const CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUQ2xpZW50Q0FfZm9yX3QzY29kZV90ZXN0",
  "-----END CERTIFICATE-----",
].join("\n");
const KUBE_TEMPLATE = [
  "server: {{ KUBE_SERVER }}",
  "certificate-authority-data: {{ KUBE_CA | base64 }}",
  "tokenFile: {{ KUBE_TOKEN | path }}",
  "",
].join("\n");

/** KUBE_SERVER (a Variable), KUBE_CA (only the template's), KUBE_TOKEN (a file), KUBECONFIG. */
const kubeconfigSet = Effect.fn(function* (
  setup: Effect.Success<ReturnType<typeof ownersThreadWith>>,
) {
  const { vaults, owner } = setup;
  const put = (input: Omit<Parameters<typeof vaults.putEntry>[0], "vaultId">) =>
    vaults.putEntry({ vaultId: MAIN_VAULT_ID, ...input }).pipe(CommandActor.actAs(owner));
  yield* put({
    name: "KUBE_SERVER",
    value: Redacted.make("https://k3s.internal:6443"),
    class: "variable",
  });
  yield* put({ name: "KUBE_CA", value: Redacted.make(CA), delivery: "none" });
  yield* put({
    name: "KUBE_TOKEN",
    value: Redacted.make("kube-token-secret-0001"),
    delivery: "file",
  });
  return yield* put({ name: "KUBECONFIG", template: { text: KUBE_TEMPLATE }, delivery: "file" });
});

it.effect(
  "a template is rendered as a process starts, files go in memory with their paths, all masked",
  () =>
    Effect.gen(function* () {
      const setup = yield* ownersThreadWith(hubFilesInMemory);
      const { server, thread, forTurn } = setup;
      yield* kubeconfigSet(setup);
      const threadId = yield* thread("thread:kube");
      const env = yield* forTurn({ threadId, target: HUB });
      const folder = env?.filesFolder ?? "";
      assert.match(folder, /^[0-9a-f]{32}$/);
      const tokenPath = `${HUB_FILES_ROOT}/${folder}/KUBE_TOKEN`;
      // Only what goes by environment is a variable; `none` never goes; files carry contents.
      assert.deepEqual(env?.variables, [
        { name: "KUBE_SERVER", value: "https://k3s.internal:6443", plain: true },
      ]);
      const rendered = [
        "server: https://k3s.internal:6443",
        `certificate-authority-data: ${btoa(CA)}`,
        `tokenFile: ${tokenPath}`,
        "",
      ].join("\n");
      assert.deepEqual(env?.files, [
        { name: "KUBECONFIG", content: rendered, mode: 0o600 },
        { name: "KUBE_TOKEN", content: "kube-token-secret-0001", mode: 0o600 },
      ]);
      // The same Thread root and User keep one folder: the child Thread's process shares it.
      const child = yield* thread("thread:kube-child", threadId);
      assert.equal((yield* forTurn({ threadId: child, target: HUB }))?.filesFolder, folder);
      // Masked in the Thread: the rendered file, the template's own entries (the one never
      // delivered by itself too), and each long line of the multiline CA; the Variable never.
      const masker = yield* Context.get(server.services, SecretMasker.SecretMasker).forThread(
        threadId,
      );
      assert.equal(masker.mask(rendered), "[KUBECONFIG]");
      assert.equal(
        masker.mask("MIIBszCCAVmgAwIBAgIUQ2xpZW50Q0FfZm9yX3QzY29kZV90ZXN0 kube-token-secret-0001"),
        "[KUBE_CA] [KUBE_TOKEN]",
      );
      assert.equal(masker.mask("https://k3s.internal:6443"), "https://k3s.internal:6443");
    }).pipe(Effect.scoped),
);

it.effect("a machine before contract 16 or without memory gets no file, and nothing instead", () =>
  Effect.gen(function* () {
    const setup = yield* ownersThreadWith();
    const { thread, delivery, forTurn, server } = setup;
    yield* kubeconfigSet(setup);
    const threadId = yield* thread("thread:kube-refused");
    // The Hub machine here has no folder in memory: refused, never written to a disk or sent as
    // variables.
    const notInMemory = yield* Effect.flip(forTurn({ threadId, target: HUB }));
    assert.instanceOf(notInMemory, SecretDeliveryError);
    assert.deepEqual(
      isDeliveryError(notInMemory) ? [notInMemory.reason, ...(notInMemory.entries ?? [])] : [],
      ["files-not-in-memory", "KUBECONFIG", "KUBE_TOKEN"],
    );
    // A machine before contract 16 (15 included): refused before anything is read.
    for (const contractVersion of [13, 14, 15]) {
      const old = yield* delivery.planTurn({
        threadId,
        target: { environmentId: HUB_MACHINE_ENVIRONMENT_ID, contractVersion },
      });
      assert.equal(
        isDeliveryError(old.failure) ? old.failure.reason : undefined,
        "outdated-machine-files",
        `contract ${contractVersion}`,
      );
      const refused = yield* Effect.flip(delivery.resolve(old));
      assert.match(refused.message, /needs an update to receive this Thread's secret files/);
    }
    // Nothing of the set was delivered: nothing is recorded for the Thread's masking.
    const remembered =
      yield* server.sql`SELECT 1 FROM thread_secret_values WHERE thread_id = ${threadId}`;
    assert.lengthOf(remembered, 0);
    // The Owner switches them to the environment: delivered as variables, on any machine.
    const { vaults, owner } = setup;
    const listed = yield* vaults
      .listEntries({ vaultId: MAIN_VAULT_ID })
      .pipe(CommandActor.actAs(owner));
    const idOf = (name: string) => listed.entries.find((entry) => entry.name === name)!.id;
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        entryId: idOf("KUBECONFIG"),
        name: "KUBECONFIG",
        template: { text: "server: {{ KUBE_SERVER }}" },
        delivery: "env",
      })
      .pipe(CommandActor.actAs(owner));
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        entryId: idOf("KUBE_TOKEN"),
        name: "KUBE_TOKEN",
        delivery: "env",
      })
      .pipe(CommandActor.actAs(owner));
    const asVariables = yield* forTurn({ threadId, target: HUB });
    assert.equal(valueOf(asVariables, "KUBE_TOKEN"), "kube-token-secret-0001");
    assert.equal(valueOf(asVariables, "KUBECONFIG"), "server: https://k3s.internal:6443");
    assert.isUndefined(asVariables?.files);
  }).pipe(Effect.scoped),
);

it.effect("a template fails whole with one of its entries: nothing of the set goes", () =>
  Effect.gen(function* () {
    const setup = yield* ownersThreadWith(hubFilesInMemory);
    const { thread, forTurn, provider, putProvider, vaults, owner, server } = setup;
    yield* putProvider("DB_PASSWORD", "kv/acme/db#password");
    yield* setup.put("DB_USER", "app-user-value");
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        name: "DATABASE_URL",
        template: { text: "postgres://{{ DB_USER }}:{{ DB_PASSWORD | urlencode }}@db/app" },
      })
      .pipe(CommandActor.actAs(owner));
    const threadId = yield* thread("thread:db");
    provider.state.answer = () => readValue("p@ss/w0rd!");
    const env = yield* forTurn({ threadId, target: HUB });
    assert.equal(valueOf(env, "DATABASE_URL"), "postgres://app-user-value:p%40ss%2Fw0rd!@db/app");
    // The provider stops answering: the start fails with its error, the template included.
    const otherThread = yield* thread("thread:db-down");
    provider.state.answer = () => readError("unavailable");
    yield* TestClock.adjust("6 minutes");
    const failed = yield* Effect.flip(forTurn({ threadId: otherThread, target: HUB }));
    assert.equal(failed._tag, "SecretProviderReadError");
    const remembered =
      yield* server.sql`SELECT 1 FROM thread_secret_values WHERE thread_id = ${otherThread}`;
    assert.lengthOf(remembered, 0);
    // A value a filter cannot take fails the template by name, never showing the value.
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        name: "DECODED",
        template: { text: "{{ DB_USER | base64decode }}" },
      })
      .pipe(CommandActor.actAs(owner));
    provider.state.answer = () => readValue("p@ss/w0rd!");
    yield* TestClock.adjust("6 minutes");
    const bad = yield* Effect.flip(forTurn({ threadId, target: HUB }));
    assert.equal(
      bad.message,
      "DECODED could not be composed: DB_USER is not what its filter takes.",
    );
  }).pipe(Effect.scoped),
);

// Ticket 07: workload identity entries, a token signed for the Thread, refreshed in its file.

/** KUBE_TOKEN: a token for the cluster, in a file KUBECONFIG names by its path. */
const identitySet = Effect.fn(function* (
  setup: Effect.Success<ReturnType<typeof ownersThreadWith>>,
) {
  const { vaults, owner } = setup;
  const put = (input: Omit<Parameters<typeof vaults.putEntry>[0], "vaultId">) =>
    vaults.putEntry({ vaultId: MAIN_VAULT_ID, ...input }).pipe(CommandActor.actAs(owner));
  const token = yield* put({ name: "KUBE_TOKEN", identity: { audience: "kubernetes" } });
  yield* put({
    name: "KUBECONFIG",
    template: { text: "tokenFile: {{ KUBE_TOKEN | path }}\n" },
    delivery: "file",
  });
  return token.entry;
});

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

it.effect("an identity entry goes as a sealed file: a token for the Thread, masked there", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-17T00:00:00.000Z"));
    const setup = yield* ownersThreadWith(hubFilesInMemory, "https://hub.example.com");
    const { server, thread, forTurn, delivery, owner } = setup;
    yield* identitySet(setup);
    const threadId = yield* thread("thread:identity");
    const env = yield* forTurn({ threadId, target: HUB });
    const folder = env?.filesFolder ?? "";
    const token = env?.files?.find((file) => file.name === "KUBE_TOKEN")?.content ?? "";
    assert.lengthOf(token.split("."), 3);
    assert.deepInclude(claimsOf(token), {
      iss: "https://hub.example.com",
      aud: "kubernetes",
      thread_id: threadId,
      user_id: owner,
    });
    assert.deepEqual(
      env?.files?.find((file) => file.name === "KUBECONFIG"),
      {
        name: "KUBECONFIG",
        content: `tokenFile: ${HUB_FILES_ROOT}/${folder}/KUBE_TOKEN\n`,
        mode: 0o600,
      },
    );
    // Never an environment variable.
    assert.deepEqual(env?.variables, []);
    // Masked in the Thread.
    const masker = yield* Context.get(server.services, SecretMasker.SecretMasker).forThread(
      threadId,
    );
    assert.equal(
      masker.mask(`Authorization: Bearer ${token}`),
      "Authorization: Bearer [KUBE_TOKEN]",
    );
    // A new token does not change what the set is: the session is not reopened for it.
    const plan = yield* delivery.planTurn({ threadId, target: HUB });
    yield* TestClock.adjust("401 seconds");
    const again = yield* delivery.planTurn({ threadId, target: HUB });
    assert.equal(again.fingerprint, plan.fingerprint);
    const later = yield* delivery.resolve(again);
    assert.notEqual(later.files?.find((file) => file.name === "KUBE_TOKEN")?.content, token);
    // The token is only in the file: not in the plan, the audit log, nor the Thread's records.
    const audit = yield* server.sql<{ readonly text: string }>`
      SELECT action || ' ' || COALESCE(detail_json, '') AS "text" FROM audit_log
    `;
    const recorded = yield* server.sql<{ readonly text: string }>`
      SELECT value_id || ' ' || name AS "text" FROM thread_secret_values
      WHERE thread_id = ${threadId}
    `;
    const seen = JSON.stringify([plan, again, audit, recorded]);
    assert.notInclude(seen, token);
    assert.notInclude(seen, token.split(".")[2]!);
    assert.isTrue(audit.some((row) => row.text.startsWith("identity.issue")));
  }).pipe(Effect.scoped),
);

it.effect("refreshes the held file at two thirds of its life; stops when no process holds it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-17T00:00:00.000Z"));
    const setup = yield* ownersThreadWith(hubFilesInMemory, "https://hub.example.com");
    const { thread, forTurn, delivery } = setup;
    yield* identitySet(setup);
    const threadId = yield* thread("thread:refresh");
    const env = yield* forTurn({ threadId, target: HUB });
    const first = env?.files?.find((file) => file.name === "KUBE_TOKEN")?.content;
    const sent: Array<{
      readonly environmentId: string;
      readonly folder: string;
      readonly files: ReadonlyArray<{ readonly name: string; readonly content: string }>;
    }> = [];
    let answer: "refreshed" | "not-held" = "refreshed";
    const send: SecretDelivery.SendSecretFiles = (environmentId, input) =>
      Effect.sync(() => {
        sent.push({ environmentId, folder: input.filesFolder, files: input.files });
        return answer;
      });
    yield* TestClock.adjust("399 seconds");
    yield* delivery.refreshIdentityFiles(send);
    assert.lengthOf(sent, 0);
    yield* TestClock.adjust("2 seconds");
    yield* delivery.refreshIdentityFiles(send);
    assert.lengthOf(sent, 1);
    assert.equal(sent[0]!.environmentId, HUB_MACHINE_ENVIRONMENT_ID);
    assert.equal(sent[0]!.folder, env?.filesFolder);
    // Only the token's file: the template names its path, which does not change.
    assert.deepEqual(
      sent[0]!.files.map((file) => file.name),
      ["KUBE_TOKEN"],
    );
    assert.notEqual(sent[0]!.files[0]!.content, first);
    // No process holds the folder any more: the refreshing stops there.
    answer = "not-held";
    yield* TestClock.adjust("401 seconds");
    yield* delivery.refreshIdentityFiles(send);
    assert.lengthOf(sent, 2);
    yield* TestClock.adjust("401 seconds");
    yield* delivery.refreshIdentityFiles(send);
    assert.lengthOf(sent, 2);
  }).pipe(Effect.scoped),
);

it.effect("an identity entry deleted, or out of reach, is no longer refreshed", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-17T00:00:00.000Z"));
    const setup = yield* ownersThreadWith(hubFilesInMemory, "https://hub.example.com");
    const { thread, forTurn, delivery, vaults, owner } = setup;
    const entry = yield* identitySet(setup);
    const threadId = yield* thread("thread:gone");
    yield* forTurn({ threadId, target: HUB });
    const listed = yield* vaults
      .listEntries({ vaultId: MAIN_VAULT_ID })
      .pipe(CommandActor.actAs(owner));
    const kubeconfig = listed.entries.find((found) => found.name === "KUBECONFIG")!;
    yield* vaults
      .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: kubeconfig.id })
      .pipe(
        Effect.andThen(vaults.deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: entry.id })),
        CommandActor.actAs(owner),
      );
    const sent: Array<unknown> = [];
    yield* TestClock.adjust("401 seconds");
    yield* delivery.refreshIdentityFiles((_, input) =>
      Effect.sync(() => {
        sent.push(input);
        return "refreshed" as const;
      }),
    );
    assert.lengthOf(sent, 0);
  }).pipe(Effect.scoped),
);
