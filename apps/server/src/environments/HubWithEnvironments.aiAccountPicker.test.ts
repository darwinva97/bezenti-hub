/**
 * The AI account of a Thread (spec 4 ticket 08): its default, the door's refusals, a switch that
 * routes the next request, and the account in use shown after a failover, never by name.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- the gateway's real route.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  CommandId,
  type ModelSelection,
  ProjectId,
  type ProviderInstanceId,
  type SpaceId,
  ThreadId,
  UserId,
  sandboxEnvironmentIdOf,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as AiAccountChoice from "../ai/AiAccountChoice.ts";
import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGatewayActivity from "../ai/AiGatewayActivity.ts";
import * as AiGatewayKeys from "../ai/AiGatewayKeys.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
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

/** An AI account of the Owner's, lent to Spaces and Users; first made is first by priority. */
const addAccount = Effect.fn(function* (
  hub: Hub,
  name: string,
  allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
  /** An OpenAI-compatible account serving these models instead of a Claude API key. */
  models?: ReadonlyArray<string>,
) {
  const owner = yield* ownerIdOf(hub);
  const accounts = hub.service(AiAccounts.AiAccounts);
  const made = yield* accounts
    .create({
      name,
      provider: models === undefined ? "claude" : "openai-compatible",
      apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      ...(models === undefined ? {} : { baseUrl: "http://127.0.0.1:9/v1", models: [...models] }),
    })
    .pipe(CommandActor.actAs(owner), Effect.orDie);
  yield* lendAccount(hub, made.id, allow);
  return made.id;
});

/** Ada and Grace, Members of Acme, with Acme's Sandbox; Globex has none of them. */
const acmeHub = Effect.fn(function* (sandboxInstance: ProviderInstanceId = instanceId) {
  const hub = yield* makeHub({
    aiAccounts: true,
    sandboxAdapters: idleAdapters(sandboxInstance),
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

type Setup = Effect.Success<ReturnType<typeof acmeHub>>;

const threads = (hub: Hub) => hub.service(ThreadManagementService.ThreadManagementService);

/** Ada (or `as`) creates a Thread in Acme's Sandbox through the Thread door, as WS does. */
const createThread = (s: Setup, id: string, modelSelection: ModelSelection, as: UserId = s.ada) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project:${id}`);
    yield* seedProject(s.hub.server, {
      projectId,
      title: id,
      defaultModelSelection: null,
      spaceId: s.acme,
    });
    const threadId = ThreadId.make(`thread:${id}`);
    const exit = yield* threads(s.hub)
      .dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:${id}`),
        threadId,
        projectId,
        title: id,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spaceId: s.acme,
        ownerUserId: as,
        activeEnvironmentId: sandboxEnvironmentIdOf(s.acme),
      })
      .pipe(CommandActor.actAs(as), Effect.exit);
    return { threadId, projectId, exit };
  });

const selectionOf = (hub: Hub, threadId: ThreadId) =>
  threads(hub)
    .getThreadRecords(threadId, [])
    .pipe(
      Effect.map((projection) => projection.thread.modelSelection),
      Effect.orDie,
    );

const setSelection = (hub: Hub, threadId: ThreadId, modelSelection: ModelSelection, as: UserId) =>
  threads(hub)
    .dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`set:${threadId}:${modelSelection.aiAccountId ?? "none"}:${as}`),
      threadId,
      modelSelection,
    })
    .pipe(CommandActor.actAs(as), Effect.exit);

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

/** One Claude Code request to the Hub's gateway route with a Thread key. */
const callGateway = (baseUrl: string, key: string, model: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${baseUrl}/api/ai/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    return { status: response.status, text: await response.text() };
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

describe("Hub con Environments: the AI account of a Thread", () => {
  it.live("start a new Thread on the highest-priority account allowed there, never another", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      // First by priority, but Globex's: never Ada's default in Acme.
      yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      const acmeFirst = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      yield* addAccount(s.hub, "Acme Claude 2", { spaceIds: [s.acme] });

      const made = yield* createThread(s, "default", { instanceId, model: MODEL });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      const selection = yield* selectionOf(s.hub, made.threadId);
      assert.equal(selection.aiAccountId, acmeFirst);

      // A client that names none later (an old one, an agent) keeps the Thread's account.
      const kept = yield* setSelection(s.hub, made.threadId, { instanceId, model: MODEL }, s.ada);
      assert.isTrue(Exit.isSuccess(kept), failureText(kept));
      assert.equal((yield* selectionOf(s.hub, made.threadId)).aiAccountId, acmeFirst);
    }).pipe(Effect.scoped),
  );

  it.live("refuse a hand-made account the Thread's owner may not use, at every door", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      const globexAccount = yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      const acmeAccount = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      // Allowed to Grace alone: not Ada's, even in the same Space.
      const gracesAccount = yield* addAccount(s.hub, "Grace Claude", { userIds: [s.grace] });

      const refused = yield* createThread(s, "globex", {
        instanceId,
        model: MODEL,
        aiAccountId: globexAccount,
      });
      assert.isTrue(Exit.isFailure(refused.exit));
      assert.include(failureText(refused.exit), "not allowed for this Thread");

      const made = yield* createThread(s, "acme", {
        instanceId,
        model: MODEL,
        aiAccountId: acmeAccount,
      });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      for (const aiAccountId of [globexAccount, gracesAccount]) {
        const switched = yield* setSelection(
          s.hub,
          made.threadId,
          { instanceId, model: MODEL, aiAccountId },
          s.ada,
        );
        assert.isTrue(Exit.isFailure(switched), `${aiAccountId} was refused`);
        assert.include(failureText(switched), "not allowed for this Thread");
      }
      // The provider switch (another instance) goes through the same door.
      const switchedProvider = yield* threads(s.hub)
        .dispatch({
          type: "provider.switch",
          commandId: CommandId.make("switch:globex"),
          threadId: made.threadId,
          modelSelection: { instanceId, model: MODEL, aiAccountId: globexAccount },
        })
        .pipe(CommandActor.actAs(s.ada), Effect.exit);
      assert.isTrue(Exit.isFailure(switchedProvider));
      assert.equal((yield* selectionOf(s.hub, made.threadId)).aiAccountId, acmeAccount);

      // An agent's `t3_thread_launch` (ThreadLaunchService dispatches its `thread.create` through
      // the same door): the same check.
      const launched = yield* threads(s.hub)
        .dispatch({
          type: "thread.create",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("launch:globex"),
          threadId: ThreadId.make("thread:launched"),
          projectId: made.projectId,
          title: "From an agent",
          modelSelection: { instanceId, model: MODEL, aiAccountId: globexAccount },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          spaceId: s.acme,
          ownerUserId: s.ada,
          activeEnvironmentId: sandboxEnvironmentIdOf(s.acme),
        })
        .pipe(CommandActor.actAs(s.ada), Effect.exit);
      assert.isTrue(Exit.isFailure(launched));
      assert.include(failureText(launched), "not allowed for this Thread");
    }).pipe(Effect.scoped),
  );

  it.live("never switch another User's Thread, whatever account is named", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      const first = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const second = yield* addAccount(s.hub, "Acme Claude 2", { spaceIds: [s.acme] });
      const made = yield* createThread(s, "adas", { instanceId, model: MODEL });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      const byGrace = yield* setSelection(
        s.hub,
        made.threadId,
        { instanceId, model: MODEL, aiAccountId: second },
        s.grace,
      );
      assert.isTrue(Exit.isFailure(byGrace));
      assert.equal((yield* selectionOf(s.hub, made.threadId)).aiAccountId, first);
    }).pipe(Effect.scoped),
  );

  it.live("tell another User's viewer nothing about accounts: the role check comes first", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      const globexAccount = yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const made = yield* createThread(s, "adas-private", { instanceId, model: MODEL });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      const byGrace = yield* setSelection(
        s.hub,
        made.threadId,
        { instanceId, model: MODEL, aiAccountId: globexAccount },
        s.grace,
      );
      assert.isTrue(Exit.isFailure(byGrace));
      const said = failureText(byGrace);
      assert.notInclude(said, "AiAccountChoiceError", "refused for the role, before any account");
      assert.notInclude(said, "Globex Claude");
    }).pipe(Effect.scoped),
  );

  it.live("check a Sandbox-only provider instance's account like any other", () =>
    Effect.gen(function* () {
      // An instance only Acme's Sandbox has (not configured on the Hub): its driver is still known.
      const sandboxOnly = "claude-work" as ProviderInstanceId;
      const s = yield* acmeHub(sandboxOnly);
      const globexAccount = yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      const acmeAccount = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const refused = yield* createThread(s, "sandbox-only", {
        instanceId: sandboxOnly,
        model: MODEL,
        aiAccountId: globexAccount,
      });
      assert.isTrue(Exit.isFailure(refused.exit), "Globex's account refused");
      assert.include(failureText(refused.exit), "not allowed for this Thread");
      const made = yield* createThread(s, "sandbox-only-default", {
        instanceId: sandboxOnly,
        model: MODEL,
      });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      assert.equal((yield* selectionOf(s.hub, made.threadId)).aiAccountId, acmeAccount);
    }).pipe(Effect.scoped),
  );

  it.live("route the next request to the account a same-provider switch names", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      const first = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const second = yield* addAccount(s.hub, "Acme Claude 2", { spaceIds: [s.acme] });
      const made = yield* createThread(s, "switch", { instanceId, model: MODEL });
      assert.isTrue(Exit.isSuccess(made.exit), failureText(made.exit));
      const requests = yield* recordRequests(s.hub);
      const issued = yield* s.hub
        .service(AiGatewayKeys.AiGatewayKeys)
        .issueForThread(made.threadId, { providerSessionId: "ps-switch" })
        .pipe(Effect.orDie);
      const key = Redacted.value(issued.key);

      const before = yield* callGateway(s.hub.server.url, key, MODEL);
      assert.equal(before.status, 200, before.text);
      const switched = yield* setSelection(
        s.hub,
        made.threadId,
        { instanceId, model: MODEL, aiAccountId: second },
        s.ada,
      );
      assert.isTrue(Exit.isSuccess(switched), failureText(switched));
      const after = yield* callGateway(s.hub.server.url, key, MODEL);
      assert.equal(after.status, 200, after.text);
      const accountsUsed = requests
        .filter((record) => record.threadId === made.threadId)
        .map((record) => record.accountId);
      assert.deepEqual(accountsUsed, [first, second], "the same key, routed to the new account");
    }).pipe(Effect.scoped),
  );

  it.live(
    "show the account in use on the Thread after a failover and after a switch, never its name",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const models = [MODEL, loaded.variant.modelSelection.model];
        const first = yield* addAccount(hub, "Router A", { userIds: [owner] }, models);
        const second = yield* addAccount(hub, "Router B", { userIds: [owner] }, models);
        const opened: Array<{ threadId: string; key: string; baseUrl: string }> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: keepGatewayAccess(loaded.adapters, opened),
        });
        yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
        assert.isNotEmpty(opened);
        const session = opened[0]!;
        const threadId = ThreadId.make(session.threadId);
        const shown = Effect.fn(function* () {
          const rows = yield* hub.server.sql<{ readonly payload: string }>`
            SELECT payload_json AS payload FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id = ${threadId} ORDER BY updated_at DESC
          `;
          return rows.map((row) => {
            const payload = JSON.parse(row.payload) as {
              status: string;
              aiAccount?: { id: string; name?: string };
            };
            return payload.aiAccount === undefined
              ? undefined
              : { ...payload.aiAccount, status: payload.status };
          });
        });
        /** Resolves once the Thread's session shows `accountId`, as clients see its events. */
        const awaitShown = Effect.fn(function* (accountId: AiAccountId, afterSequence: number) {
          if ((yield* shown())[0]?.id === accountId) return;
          yield* hub
            .service(Orchestrator.OrchestratorV2)
            .streamStoredEventsFrom({ threadId, afterSequence })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "provider-session.updated" &&
                  event.payload.aiAccount?.id === accountId,
              ),
              Stream.runHead,
              Effect.orDie,
            );
        });
        const sequenceNow = hub
          .service(EventSink.EventSinkV2)
          .latestSequence({ threadId })
          .pipe(Effect.orDie);
        yield* awaitShown(first, 0);
        for (const account of yield* shown()) {
          assert.isUndefined(account?.name, "no viewer reads the account's name from the Thread");
        }

        // Router A runs out of quota: the gateway fails over to B and the Thread shows B.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(hub.aiGatewayDir!, "memory", `fake-quota-${first}`), ""),
        );
        const beforeFailover = yield* sequenceNow;
        const failedOver = yield* callGateway(session.baseUrl, session.key, MODEL);
        assert.equal(failedOver.status, 200, failedOver.text);
        yield* awaitShown(second, beforeFailover);

        // The Owner switches back to A (its quota is back): shown at its next request.
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(hub.aiGatewayDir!, "memory", `fake-quota-${first}`)),
        );
        const current = yield* selectionOf(hub, threadId);
        const switched = yield* setSelection(
          hub,
          threadId,
          { ...current, aiAccountId: first },
          owner,
        );
        assert.isTrue(Exit.isSuccess(switched), failureText(switched));
        const beforeSwitch = yield* sequenceNow;
        const again = yield* callGateway(session.baseUrl, session.key, MODEL);
        assert.equal(again.status, 200, again.text);
        yield* awaitShown(first, beforeSwitch);
        assert.equal((yield* shown())[0]?.id, first);
      }).pipe(Effect.scoped),
  );

  it.live("pick only from the accounts allowed to the User in that Space, with their models", () =>
    Effect.gen(function* () {
      const s = yield* acmeHub();
      yield* addAccount(s.hub, "Globex Claude", { spaceIds: [s.globex] });
      const acmeAccount = yield* addAccount(s.hub, "Acme Claude", { spaceIds: [s.acme] });
      const picker = s.hub.service(AiAccountChoice.AiAccountChoice);
      const inAcme = yield* picker.picker({ spaceId: s.acme }).pipe(CommandActor.actAs(s.ada));
      assert.isTrue(inAcme.applies);
      assert.equal(inAcme.spaceName, "Acme");
      assert.deepEqual(
        inAcme.accounts.map((account) => [account.id, account.name, account.models]),
        [[acmeAccount, "Acme Claude", [MODEL]]],
      );
      // Globex is not Ada's: nothing, not even names.
      const inGlobex = yield* picker.picker({ spaceId: s.globex }).pipe(CommandActor.actAs(s.ada));
      assert.deepEqual(inGlobex.accounts, []);
      assert.isNull(inGlobex.spaceName);
    }).pipe(Effect.scoped),
  );
});

/** A machine's adapters that note each gateway session's key and relay, and run the fixture. */
const keepGatewayAccess = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  opened: Array<{ threadId: string; key: string; baseUrl: string }>,
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
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) => {
              const gateway = input.aiGateway;
              if (gateway?.baseUrl !== undefined) {
                opened.push({
                  threadId: input.threadId,
                  key: gateway.key,
                  baseUrl: gateway.baseUrl,
                });
              }
              const { aiGateway: _gateway, ...recorded } = input;
              return adapter.openSession(recorded);
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));
