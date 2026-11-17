/**
 * Agents on the Hub's AI gateway (spec 4 ticket 06): a provider session gets its Thread's key,
 * for the Thread's owner, through its machine's relay, and loses it when it closes. A machine
 * before contract 11, a Thread without an allowed account, never runs on a login instead.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- a fake CLI on the relay's real port.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiAccountProvider,
  CommandId,
  type EnvironmentId,
  ProjectId,
  type ProviderInstanceId,
  ProviderSessionId,
  type SpaceId,
  ThreadId,
  UserId,
  sandboxEnvironmentIdOf,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGatewayKeys from "../ai/AiGatewayKeys.ts";
import * as AiGatewaySessions from "../ai/AiGatewaySessions.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as AiGatewayActivity from "../ai/AiGatewayActivity.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { type Hub, makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";
import { lendAccount } from "./HubWithEnvironments.aiAccounts.testkit.ts";
import {
  createOrganization,
  idleAdapters,
  loadFixture,
  ownerIdOf,
  replayOn,
  startSandbox,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const instanceId = "claudeAgent" as ProviderInstanceId;
/** A model the fake CLIProxyAPI serves for a Claude account. */
const MODEL = "claude-sonnet-5-5";

/** What a provider process got when its session opened, and what its CLI got from the gateway. */
interface Opened {
  readonly threadId: string;
  readonly aiGateway: ProviderAdapter.AiGatewaySessionInput | undefined;
  readonly answer: { readonly status: number; readonly text: string } | undefined;
}

/** One call to the gateway through the relay, as Claude Code makes it with its key. */
const callGateway = (baseUrl: string, key: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${baseUrl}/api/ai/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    return { status: response.status, text: await response.text() };
  });

/**
 * A machine's adapters behind a fake CLI: each session on the gateway calls it through the relay
 * as soon as it opens, and notes what its process got. `fail`: the CLI ends there.
 */
const fakeCli = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  opened: Array<Opened>,
  options: { readonly fail?: boolean } = {},
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (id: ProviderInstanceId) =>
        registry.get(id).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            usesAiGateway: true as const,
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.gen(function* () {
                const gateway = input.aiGateway;
                const answer =
                  gateway?.baseUrl === undefined
                    ? undefined
                    : yield* callGateway(gateway.baseUrl, gateway.key);
                opened.push({ threadId: input.threadId, aiGateway: gateway, answer });
                if (options.fail === true) {
                  return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: adapter.driver,
                    providerSessionId: input.providerSessionId,
                    cause: "the fake CLI ends here",
                  });
                }
                // The fake CLI is the gateway client; the recorded turn engine runs without it.
                const { aiGateway: _gateway, ...recorded } = input;
                return yield* adapter.openSession(recorded);
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** An AI account of the Owner's, lent to Spaces and Users. */
const addAccount = Effect.fn(function* (
  hub: Hub,
  name: string,
  allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
  provider: AiAccountProvider = "claude",
  /** An OpenAI-compatible account serving these models instead. */
  models?: ReadonlyArray<string>,
) {
  const owner = yield* ownerIdOf(hub);
  const accounts = hub.service(AiAccounts.AiAccounts);
  const made = yield* accounts
    .create({
      name,
      provider: (models === undefined ? provider : "openai-compatible") as never,
      apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      ...(models === undefined ? {} : { baseUrl: "http://127.0.0.1:9/v1", models: [...models] }),
    })
    .pipe(CommandActor.actAs(owner), Effect.orDie);
  yield* lendAccount(hub, made.id, allow);
  return made.id;
});

/** Every request the gateway finished from now on. */
const recordRequests = Effect.fn(function* (hub: Hub) {
  const seen: Array<AiGatewayActivity.GatewayRequestRecord> = [];
  const requests = yield* hub.service(AiGatewayActivity.AiGatewayActivity).subscribeRequests;
  yield* requests.pipe(
    Stream.runForEach((record) => Effect.sync(() => void seen.push(record))),
    Effect.forkScoped,
  );
  return seen;
});

/** A Thread of `ownerUserId` in `spaceId` on `environmentId`, its checkout made on the machine. */
const threadOn = Effect.fn(function* (
  hub: Hub,
  input: {
    readonly id: string;
    readonly spaceId?: SpaceId;
    readonly ownerUserId: UserId;
    readonly environmentId: EnvironmentId;
    readonly aiAccountId?: AiAccountId;
  },
) {
  const projectId = ProjectId.make(`project:${input.id}`);
  yield* seedProject(hub.server, {
    projectId,
    title: input.id,
    defaultModelSelection: null,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
  });
  const threadId = ThreadId.make(`thread:${input.id}`);
  const modelSelection = {
    instanceId,
    model: MODEL,
    ...(input.aiAccountId === undefined ? {} : { aiAccountId: input.aiAccountId }),
  };
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${input.id}`),
    threadId,
    projectId,
    title: input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ownerUserId: input.ownerUserId,
    activeEnvironmentId: input.environmentId,
  });
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const checkout = Option.getOrThrow(
    yield* (yield* registry.get(input.environmentId)).workspace.paths.checkout(projectId),
  );
  yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
  return { threadId, modelSelection, checkout };
});

/** Opens the Thread's provider session, as its first turn does. */
const openSession = (
  hub: Hub,
  thread: Effect.Success<ReturnType<typeof threadOn>>,
  providerSessionId: string,
) =>
  hub.service(ProviderSessionManagerV2).open({
    threadId: thread.threadId,
    providerSessionId: ProviderSessionId.make(providerSessionId),
    modelSelection: thread.modelSelection,
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: thread.checkout },
  });

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

/** Ada and Grace, Members of Acme, sharing Acme's Sandbox; Globex has its own. */
const sharedSandbox = Effect.fn(function* (opened: Array<Opened>) {
  const hub = yield* makeHub({
    aiAccounts: true,
    sandboxAdapters: fakeCli(idleAdapters(instanceId), opened, { fail: true }),
  });
  const acme = yield* createOrganization(hub, "Acme");
  const globex = yield* createOrganization(hub, "Globex");
  for (const id of ["ada", "grace"]) {
    yield* addMember(hub.server, { id, displayName: id });
    yield* joinOrganization(hub.server, acme, id, "member");
  }
  const ada = UserId.make("ada");
  const grace = UserId.make("grace");
  yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada, grace]);
  yield* startSandbox(hub, acme);
  return { hub, acme, globex, ada, grace };
});

describe("Hub con Environments: agents on the Hub's AI gateway", () => {
  it.live(
    "run a turn on a joined machine through its relay and the gateway, shown on the Thread",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        // The fixture's model and the one the fake CLI asks for.
        const accountId = yield* addAccount(hub, "Owner Claude", { userIds: [owner] }, "claude", [
          MODEL,
          loaded.variant.modelSelection.model,
        ]);
        const requests = yield* recordRequests(hub);
        const opened: Array<Opened> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: fakeCli(loaded.adapters, opened),
        });
        yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });

        assert.isNotEmpty(opened);
        const first = opened[0]!;
        const gateway = first.aiGateway;
        assert.isDefined(gateway);
        assert.match(gateway!.key, /^t3gk_/u);
        assert.equal(gateway!.aiAccountId, accountId);
        assert.match(gateway!.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/u, "the machine's relay");
        assert.include(
          gateway!.home ?? "",
          "provider-homes",
          "a provider home of the Thread's own",
        );
        assert.notInclude(gateway!.home ?? "", ".claude");
        assert.equal(first.answer?.status, 200, first.answer?.text);
        assert.include(first.answer?.text ?? "", `Hello from ${MODEL}`);
        assert.notInclude(first.answer?.text ?? "", "acct-", "the account's prefix never shows");
        // The request counted for the Thread's owner, Space and Thread, on its account.
        const counted = requests.find((record) => record.threadId === first.threadId);
        assert.isDefined(counted);
        assert.equal(counted!.userId, owner);
        assert.equal(counted!.accountId, accountId);
        assert.equal(counted!.status, 200);

        // The Thread shows the account its session runs on.
        const rows = yield* hub.server.sql<{ readonly payload: string; readonly id: string }>`
          SELECT payload_json AS payload, provider_session_id AS id
          FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ${first.threadId}
        `;
        assert.isNotEmpty(rows);
        const shown = JSON.parse(rows[0]!.payload) as { aiAccount?: { id: string; name?: string } };
        assert.equal(shown.aiAccount?.id, accountId);
        // Every viewer of the Space reads it: each client names the account (ticket 08).
        assert.isUndefined(shown.aiAccount?.name);

        // Never a key in the event store nor the projections.
        const leaked = yield* hub.server.sql<{ readonly n: number }>`
          SELECT (SELECT COUNT(*) FROM orchestration_v2_events WHERE payload_json LIKE '%t3gk_%')
            + (SELECT COUNT(*) FROM orchestration_v2_projection_provider_sessions
                WHERE payload_json LIKE '%t3gk_%') AS n
        `;
        assert.equal(leaked[0]?.n, 0);

        // Its session closes: the key stops working at once.
        yield* hub
          .service(ProviderSessionManagerV2)
          .close(ProviderSessionId.make(rows[0]!.id))
          .pipe(Effect.orDie);
        const after = yield* callGateway(gateway!.baseUrl!, gateway!.key);
        assert.equal(after.status, 401, "a closed session's key is refused");
      }).pipe(Effect.scoped),
  );

  it.live("give each User's process in a shared Sandbox its own key, never another's", () =>
    Effect.gen(function* () {
      const opened: Array<Opened> = [];
      const s = yield* sharedSandbox(opened);
      const accountId = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const requests = yield* recordRequests(s.hub);
      const sandbox = sandboxEnvironmentIdOf(s.acme);
      const adas = yield* threadOn(s.hub, {
        id: "ada",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandbox,
      });
      const graces = yield* threadOn(s.hub, {
        id: "grace",
        spaceId: s.acme,
        ownerUserId: s.grace,
        environmentId: sandbox,
      });
      yield* Effect.exit(openSession(s.hub, adas, "ps-ada"));
      yield* Effect.exit(openSession(s.hub, graces, "ps-grace"));

      const ada = opened.find((entry) => entry.threadId === adas.threadId);
      const grace = opened.find((entry) => entry.threadId === graces.threadId);
      assert.isDefined(ada?.aiGateway);
      assert.isDefined(grace?.aiGateway);
      assert.equal(ada!.answer?.status, 200);
      assert.equal(grace!.answer?.status, 200);
      const adaKey = ada!.aiGateway!.key;
      assert.notEqual(grace!.aiGateway!.key, adaKey);
      assert.notInclude(JSON.stringify(grace), adaKey, "Ada's key never reached Grace's process");
      assert.notEqual(grace!.aiGateway!.home, ada!.aiGateway!.home, "a provider home per Thread");
      // Each key acted for its own Thread's owner, in Acme, on Acme's account.
      const adaRequest = requests.find((record) => record.threadId === adas.threadId);
      const graceRequest = requests.find((record) => record.threadId === graces.threadId);
      assert.equal(adaRequest?.userId, s.ada);
      assert.equal(graceRequest?.userId, s.grace);
      assert.equal(adaRequest?.spaceId, s.acme);
      assert.equal(adaRequest?.accountId, accountId);
      // Their sessions never opened (the fake CLI ended): their keys no longer work.
      const again = yield* callGateway(ada!.aiGateway!.baseUrl!, adaKey);
      assert.equal(again.status, 401);
    }).pipe(Effect.scoped),
  );

  it.live("refuse a turn without an allowed AI account, never running on a login", () =>
    Effect.gen(function* () {
      const opened: Array<Opened> = [];
      const s = yield* sharedSandbox(opened);
      // An account exists, for Globex only: none is allowed to Ada in Acme.
      yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      const adas = yield* threadOn(s.hub, {
        id: "ada-none",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandboxEnvironmentIdOf(s.acme),
      });
      const exit = yield* Effect.exit(openSession(s.hub, adas, "ps-ada-none"));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(failureText(exit), "No AI account is allowed to you in this Space");
      assert.isEmpty(opened, "no provider process started (its volume's login never used)");
    }).pipe(Effect.scoped),
  );

  it.live("refuse a Thread's chosen account another Space's, never another in its place", () =>
    Effect.gen(function* () {
      const opened: Array<Opened> = [];
      const s = yield* sharedSandbox(opened);
      const acmeAccount = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      yield* startSandbox(s.hub, s.globex);
      const owner = yield* ownerIdOf(s.hub);
      const globexThread = yield* threadOn(s.hub, {
        id: "globex",
        spaceId: s.globex,
        ownerUserId: owner,
        environmentId: sandboxEnvironmentIdOf(s.globex),
        aiAccountId: acmeAccount,
      });
      const exit = yield* Effect.exit(openSession(s.hub, globexThread, "ps-globex"));
      assert.include(failureText(exit), "no longer allowed to you here");
      assert.isEmpty(opened);
    }).pipe(Effect.scoped),
  );

  it.live("never send a key to a machine before contract 11, which says to update", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ aiAccounts: true });
      const owner = yield* ownerIdOf(hub);
      yield* addAccount(hub, "Owner Claude", { userIds: [owner] });
      const opened: Array<Opened> = [];
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: fakeCli(idleAdapters(instanceId), opened, { fail: true }),
        executorContractVersion: 10,
      });
      const thread = yield* threadOn(hub, {
        id: "old",
        ownerUserId: owner,
        environmentId: old.environmentId,
      });
      const exit = yield* Effect.exit(openSession(hub, thread, "ps-old"));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(failureText(exit), "Old laptop needs an update to use the Hub's AI accounts");
      assert.isEmpty(opened);
      assert.isFalse(old.requests.includes("provider.openSession"), "nothing was sent");
      const issued = yield* hub.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_gateway_keys WHERE thread_id = ${thread.threadId}
      `;
      assert.equal(issued[0]?.n, 0, "no key was issued for it");
    }).pipe(Effect.scoped),
  );

  it.live(
    "route the session to the account the gateway picks: the first allowed serving its model",
    () =>
      Effect.gen(function* () {
        const opened: Array<Opened> = [];
        const s = yield* sharedSandbox(opened);
        // Higher priority, but without the Thread's model; then one that serves it.
        yield* addAccount(s.hub, "Acme Other", { spaceIds: [s.acme] }, "claude", ["other-model"]);
        const serving = yield* addAccount(s.hub, "Acme Serving", { spaceIds: [s.acme] }, "claude", [
          MODEL,
        ]);
        const adas = yield* threadOn(s.hub, {
          id: "ada-route",
          spaceId: s.acme,
          ownerUserId: s.ada,
          environmentId: sandboxEnvironmentIdOf(s.acme),
        });
        yield* Effect.exit(openSession(s.hub, adas, "ps-ada-route"));
        assert.equal(opened[0]?.aiGateway?.aiAccountId, serving, "the account its requests go to");
        assert.equal(opened[0]?.aiGateway?.aiAccountName, "Acme Serving");
      }).pipe(Effect.scoped),
  );

  it.live("issue no key for a session refused for a shared process", () =>
    Effect.gen(function* () {
      const opened: Array<Opened> = [];
      const s = yield* sharedSandbox(opened);
      yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const adas = yield* threadOn(s.hub, {
        id: "ada-shared",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandboxEnvironmentIdOf(s.acme),
      });
      // The id every Thread of the instance shares.
      const ids = yield* Effect.service(IdAllocator.IdAllocatorV2).pipe(
        Effect.provide(IdAllocator.layer),
      );
      const sharedId = ids.derive.providerSession({ providerInstanceId: instanceId });
      const exit = yield* Effect.exit(openSession(s.hub, adas, sharedId));
      assert.include(failureText(exit), "shared with other Threads");
      const keys = yield* s.hub.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_gateway_keys WHERE thread_id = ${adas.threadId}
      `;
      assert.equal(keys[0]?.n, 0, "no key issued, none rotated");
      assert.isEmpty(opened);
    }).pipe(Effect.scoped),
  );

  it.live("stay off the gateway on a personal machine when no account is usable", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ aiAccounts: true });
      const owner = yield* ownerIdOf(hub);
      const disabled = yield* addAccount(hub, "Disabled Claude", { userIds: [owner] });
      yield* hub
        .service(AiAccounts.AiAccounts)
        .update({ accountId: disabled, disabled: true })
        .pipe(CommandActor.actAs(owner), Effect.orDie);
      const opened: Array<Opened> = [];
      const laptop = yield* hub.join({
        name: "Laptop",
        adapters: fakeCli(idleAdapters(instanceId), opened, { fail: true }),
      });
      const thread = yield* threadOn(hub, {
        id: "laptop-off",
        ownerUserId: owner,
        environmentId: laptop.environmentId,
      });
      yield* Effect.exit(openSession(hub, thread, "ps-laptop-off"));
      assert.equal(opened.length, 1, "the session opened, on its machine's own configuration");
      assert.isUndefined(opened[0]?.aiGateway, "a disabled account puts nobody on the gateway");
    }).pipe(Effect.scoped),
  );

  it.live(
    "revoke, at a Hub start, every Thread key left live by a session that did not survive",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        yield* addAccount(hub, "Owner Claude", { userIds: [owner] });
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const thread = yield* threadOn(hub, {
          id: "restart",
          ownerUserId: owner,
          environmentId: laptop.environmentId,
        });
        yield* hub
          .service(AiGatewayKeys.AiGatewayKeys)
          .issueForThread(thread.threadId, { providerSessionId: "ps-before-restart" })
          .pipe(Effect.orDie);
        // The rule starts again, as at the next Hub start.
        yield* Layer.build(
          AiGatewaySessions.layer.pipe(
            Layer.provide(Layer.succeedContext(hub.server.services as never)),
          ),
        );
        const live = yield* hub.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_gateway_keys
        WHERE thread_id = ${thread.threadId} AND revoked_at IS NULL
      `;
        assert.equal(live[0]?.n, 0);
      }).pipe(Effect.scoped),
  );
});
