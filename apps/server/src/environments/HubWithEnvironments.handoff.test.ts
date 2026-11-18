// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  MessageId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  UserId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  ProviderTextGeneration,
  ThreadHandoffGenerationInput,
} from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as CommandActor from "../auth/CommandActor.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as Grants from "../grants/Grants.ts";
import { lendVaultGroup } from "../grants/Grants.testkit.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { projectTurnItemForWire } from "../orchestration-v2/WireProjection.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import * as Vaults from "../vaults/Vaults.ts";
import {
  databaseText,
  hubFilesHolding,
  machineFilesHolding,
  processArgsHolding,
} from "./HubWithEnvironments.secretMasking.testkit.ts";
import { type Hub, type TestEnvironment } from "./HubWithEnvironments.testkit.ts";
import {
  CLAUDE,
  dispatchMove,
  settledMove,
  turnOnLaptop,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const EPOCH = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/** Text generation that answers the handoff summary (or fails) and records what it was asked. */
const recordingTextGeneration = (
  asked: Array<ThreadHandoffGenerationInput>,
  answer: { readonly summary: string } | { readonly failure: string },
  /** Whether each folder it was asked to run in was there, when asked. */
  cwdFound: Array<boolean> = [],
): ProviderTextGeneration => {
  const unused = () => Effect.die("only the handoff summary is written in these tests");
  return {
    generateCommitMessage: unused,
    generatePrContent: unused,
    generateBranchName: unused,
    generateThreadTitle: unused,
    generateReviewGuide: unused,
    generateThreadHandoff: (input) =>
      Effect.suspend(() => {
        asked.push(input);
        cwdFound.push(NodeFS.existsSync(input.cwd));
        return "summary" in answer
          ? Effect.succeed({ summary: answer.summary })
          : Effect.fail(
              new TextGenerationError({
                operation: "generateThreadHandoff",
                detail: answer.failure,
              }),
            );
      }),
  };
};

/** A provider that opens sessions and records each turn it is given, without running it. */
const recordingAdapters =
  (turns: Queue.Queue<ProviderAdapter.ProviderAdapterV2TurnInput>) =>
  (instanceId: ProviderInstanceId) =>
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: CLAUDE,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (open) =>
          Effect.succeed({
            instanceId,
            driver: CLAUDE,
            providerSessionId: open.providerSessionId,
            providerSession: {
              id: open.providerSessionId,
              driver: CLAUDE,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: open.runtimePolicy.cwd ?? "/desktop",
              model: null,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: EPOCH,
              updatedAt: EPOCH,
              lastError: null,
            },
            events: Stream.never,
            ensureThread: (thread) =>
              thread.existingProviderThread === undefined
                ? Effect.die("the Hub always passes the provider thread it stored")
                : Effect.succeed({
                    ...thread.existingProviderThread,
                    nativeThreadRef: {
                      driver: CLAUDE,
                      nativeId: `native:desktop:${thread.existingProviderThread.id}`,
                      strength: "strong" as const,
                    },
                  }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) => Queue.offer(turns, turn).pipe(Effect.asVoid),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          }),
      },
    ]);

/** Sends a message after the move and returns the first turn the Desktop's provider got. */
const firstTurnAfterMove = Effect.fn(function* (
  hub: Hub,
  desktop: TestEnvironment,
  threadId: ThreadId,
  turns: Queue.Queue<ProviderAdapter.ProviderAdapterV2TurnInput>,
) {
  const asked = desktop.requests.length;
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:after-move"),
    threadId,
    messageId: MessageId.make("message:after-move"),
    text: "Go on from here",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  yield* desktop.awaitRequest("provider.startTurn", asked);
  return yield* Queue.take(turns);
});

const handoffItemOf = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
  const { turnItems } = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  const item = turnItems.find((candidate) => candidate.type === "environment_handoff");
  assert.isDefined(item, "the timeline has no handoff entry");
  assert(item.type === "environment_handoff");
  return { item, turnItems };
});

describe("Hub con Environments: the agent's memory after a move", () => {
  it.live(
    "the source's provider writes the summary, and the target's first turn starts with it and the recent messages",
    () =>
      Effect.gen(function* () {
        const laptopAsked: Array<ThreadHandoffGenerationInput> = [];
        const hubAsked: Array<ThreadHandoffGenerationInput> = [];
        const turns = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
        const { hub, desktop, threadId, owner } = yield* turnOnLaptop({
          desktop: true,
          laptopTextGeneration: recordingTextGeneration(laptopAsked, {
            summary: "The Laptop wrote notes.md; next, review it.",
          }),
          hubTextGeneration: recordingTextGeneration(hubAsked, { summary: "unused" }),
          desktopAdapters: recordingAdapters(turns),
        });
        assert.isDefined(desktop);
        yield* dispatchMove(hub, {
          commandId: "command:move-with-memory",
          threadId,
          target: desktop.environmentId,
          actor: owner,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);

        // One model call, on the source, with the Thread's provider and its history.
        assert.lengthOf(laptopAsked, 1);
        assert.lengthOf(hubAsked, 0);
        const [asked] = laptopAsked;
        assert.equal(asked?.modelSelection.instanceId, moved.modelSelection.instanceId);
        assert.equal(asked?.sourceEnvironmentName, "Laptop");
        assert.equal(asked?.targetEnvironmentName, "Desktop");
        const { item, turnItems } = yield* handoffItemOf(hub, threadId);
        const lastUserMessage = turnItems.findLast(
          (candidate) => candidate.type === "user_message",
        );
        assert(lastUserMessage?.type === "user_message");
        assert.include(asked?.transcript ?? "", lastUserMessage.text.trim().slice(0, 40));

        // The timeline shows what the new agent is told, and who wrote it.
        assert.equal(item.writtenBy, "source");
        assert.equal(item.writerEnvironmentName, "Laptop");
        assert.equal(item.summary, "The Laptop wrote notes.md; next, review it.");
        assert.include(item.context, "The Laptop wrote notes.md; next, review it.");
        assert.include(item.context, "thread_history");
        assert.isAbove(item.recentMessageCount, 0);

        // The Desktop's new session starts with the summary, then the recent messages.
        const turn = yield* firstTurnAfterMove(hub, desktop, threadId, turns);
        const text = turn.message.text;
        assert.include(text, "This Thread moved from Laptop to Desktop.");
        assert.include(text, "The Laptop wrote notes.md; next, review it.");
        assert.include(text, lastUserMessage.text.trim().slice(0, 40));
        assert.isTrue(text.trimEnd().endsWith("Go on from here"), text.slice(-200));
      }).pipe(Effect.scoped),
  );

  it.live("with the source offline, the Hub machine writes the summary", () =>
    Effect.gen(function* () {
      const laptopAsked: Array<ThreadHandoffGenerationInput> = [];
      const hubAsked: Array<ThreadHandoffGenerationInput> = [];
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
        laptopTextGeneration: recordingTextGeneration(laptopAsked, { summary: "unused" }),
        hubTextGeneration: recordingTextGeneration(hubAsked, {
          summary: "Written on the Hub from the history.",
        }),
      });
      assert.isDefined(desktop);
      yield* laptop.disconnect;
      yield* dispatchMove(hub, {
        commandId: "command:move-offline-memory",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.lengthOf(laptopAsked, 0);
      assert.lengthOf(hubAsked, 1);
      const { item } = yield* handoffItemOf(hub, threadId);
      assert.equal(item.writtenBy, "hub");
      assert.equal(item.summary, "Written on the Hub from the history.");
      assert.equal(moved.move?.handoff?.preview, "Written on the Hub from the history.");
    }).pipe(Effect.scoped),
  );

  it.live("a summary that names a secret value is stored and shown as [NAME] (spec 5)", () =>
    Effect.gen(function* () {
      const value = "handoff-secret-value-7777";
      const laptopAsked: Array<ThreadHandoffGenerationInput> = [];
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
        laptopTextGeneration: recordingTextGeneration(laptopAsked, {
          summary: `The deploy used ${value} from the environment.`,
        }),
        hubTextGeneration: recordingTextGeneration([], { summary: "unused" }),
      });
      assert.isDefined(desktop);
      // A process of the Thread received the value (as SecretDelivery records it).
      yield* hub
        .service(SecretMasker.SecretMasker)
        .remember(threadId, [{ name: "DEPLOY_TOKEN", value, valueId: "value-handoff" }]);
      yield* dispatchMove(hub, {
        commandId: "command:move-secret-summary",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      const { item } = yield* handoffItemOf(hub, threadId);
      assert.equal(item.summary, "The deploy used [DEPLOY_TOKEN] from the environment.");
      assert.notInclude(item.context, value);
      const stored = yield* hub.server.sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_v2_move_handoffs
      `;
      for (const row of stored) assert.notInclude(row.payload, value);
      // Leak smoke (ticket 09): after the handoff, no file of the Hub or of either machine (but
      // the checkouts), no row and no process argument holds it.
      assert.deepEqual(
        {
          hub: yield* hubFilesHolding(hub, value),
          database: (yield* databaseText(hub)).includes(value),
          laptop: yield* machineFilesHolding(laptop, value),
          desktop: yield* machineFilesHolding(desktop, value),
          processes: yield* processArgsHolding(value),
        },
        { hub: [], database: false, laptop: [], desktop: [], processes: [] },
      );
    }).pipe(Effect.scoped),
  );

  // Grants ticket 07: a Secret of Ana's group lent to the Thread's Space reaches the Thread's process
  // by delivery, as any; after the loan ends, a handoff summary that names it is still masked.
  it.live(
    "a lent Secret a Thread received stays masked in the handoff after the loan ends (Grants 07)",
    () =>
      Effect.gen(function* () {
        const value = "ana-lent-handoff-value-0707";
        const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({
          desktop: true,
          laptopTextGeneration: recordingTextGeneration([], {
            summary: `The deploy used ${value} from Ana's keys.`,
          }),
          hubTextGeneration: recordingTextGeneration([], { summary: "unused" }),
        });
        assert.isDefined(desktop);
        const ana = UserId.make("ana");
        yield* addMember(hub.server, { id: "ana", displayName: "Ana" });
        const vaults = hub.service(Vaults.Vaults);
        const group = yield* vaults
          .create({ name: "Ana lends", owner: { kind: "user", userId: ana } })
          .pipe(CommandActor.actAs(ana));
        yield* vaults
          .putEntry({ vaultId: group.id, name: "ANA_LENT_TOKEN", value: Redacted.make(value) })
          .pipe(CommandActor.actAs(ana));
        const placement = yield* hub
          .service(SpaceDirectory.SpaceDirectory)
          .placementOf(threadId)
          .pipe(Effect.orDie);
        assert.isTrue(Option.isSome(placement));
        const spaceId = Option.getOrThrow(placement).space.id;
        const grantId = yield* lendVaultGroup(hub.server.sql, {
          vaultId: group.id,
          spaceId,
          lender: { kind: "user", id: ana },
        });
        yield* vaults
          .setSpaceDefaults({ spaceId, vaultIds: [group.id] })
          .pipe(CommandActor.actAs(owner));
        // A process of the Thread started by its owner on the Laptop (a terminal, a script) receives
        // it, through delivery, which remembers it for masking.
        const delivery = hub.service(SecretDelivery.SecretDelivery);
        const target = {
          environmentId: laptop.environmentId,
          contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
        };
        const startProcess = delivery
          .plan({ threadId, actingUserId: owner, target })
          .pipe(Effect.flatMap(delivery.resolve), Effect.orDie);
        const received = yield* startProcess;
        assert.isTrue(
          received?.variables?.some(
            (variable) => variable.name === "ANA_LENT_TOKEN" && variable.value === value,
          ) === true,
          "the lent Secret reached the Thread's process",
        );

        // Ana takes it back: the next process gets nothing of it.
        yield* hub
          .service(Grants.Grants)
          .end({ grantId })
          .pipe(CommandActor.actAs(ana), Effect.orDie);
        const after = yield* startProcess;
        assert.isFalse(
          after?.variables?.some((variable) => variable.name === "ANA_LENT_TOKEN") === true,
          "a revoked loan reaches no new process",
        );

        // The move's summary names it: stored and shown as [ANA_LENT_TOKEN], nowhere in clear.
        yield* dispatchMove(hub, {
          commandId: "command:move-lent-secret-summary",
          threadId,
          target: desktop.environmentId,
          actor: owner,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        const { item } = yield* handoffItemOf(hub, threadId);
        assert.equal(item.summary, "The deploy used [ANA_LENT_TOKEN] from Ana's keys.");
        assert.isFalse(item.context.includes(value), "the handoff context holds the value");
        const stored = yield* hub.server.sql<{ readonly payload: string }>`
          SELECT payload_json AS payload FROM orchestration_v2_move_handoffs
        `;
        // As the handoff is kept (its row, and every other row of the database, checked below).
        assert.isFalse(
          stored.some((row) => row.payload.includes(value)),
          "a stored handoff holds the value",
        );
        assert.deepEqual(
          {
            hub: yield* hubFilesHolding(hub, value),
            database: (yield* databaseText(hub)).includes(value),
            laptop: yield* machineFilesHolding(laptop, value),
            desktop: yield* machineFilesHolding(desktop, value),
            processes: yield* processArgsHolding(value),
          },
          { hub: [], database: false, laptop: [], desktop: [], processes: [] },
        );
      }).pipe(Effect.scoped),
  );

  it.live("with the source offline and no agents on the Hub, the target writes the summary", () =>
    Effect.gen(function* () {
      const hubAsked: Array<ThreadHandoffGenerationInput> = [];
      const desktopAsked: Array<ThreadHandoffGenerationInput> = [];
      const desktopCwdFound: Array<boolean> = [];
      const { hub, laptop, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
        hubRunsAgents: false,
        hubTextGeneration: recordingTextGeneration(hubAsked, { summary: "Never on the Hub." }),
        desktopTextGeneration: recordingTextGeneration(
          desktopAsked,
          { summary: "Written on the Desktop from the history." },
          desktopCwdFound,
        ),
      });
      assert.isDefined(desktop);
      yield* laptop.disconnect;
      yield* dispatchMove(hub, {
        commandId: "command:move-offline-no-hub",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.lengthOf(hubAsked, 0);
      assert.lengthOf(desktopAsked, 1);
      // In a folder of the Desktop's own that is there (its checkout is not fetched yet), never
      // a path of the Hub's.
      const asked = desktopAsked[0]?.cwd ?? "";
      assert.isTrue(asked.startsWith(desktop.workspaceRoot), asked);
      assert.deepEqual(desktopCwdFound, [true], asked);
      const { item } = yield* handoffItemOf(hub, threadId);
      assert.equal(item.writtenBy, "target");
      assert.equal(item.summary, "Written on the Desktop from the history.");
    }).pipe(Effect.scoped),
  );

  it.live("a failed summary never fails the move: one is assembled and the timeline says so", () =>
    Effect.gen(function* () {
      const laptopAsked: Array<ThreadHandoffGenerationInput> = [];
      const hubAsked: Array<ThreadHandoffGenerationInput> = [];
      const turns = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
      const { hub, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
        laptopTextGeneration: recordingTextGeneration(laptopAsked, {
          failure: "The model is out of quota.",
        }),
        hubTextGeneration: recordingTextGeneration(hubAsked, { summary: "unused" }),
        desktopAdapters: recordingAdapters(turns),
      });
      assert.isDefined(desktop);
      yield* dispatchMove(hub, {
        commandId: "command:move-summary-fails",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      // Still at most one model call: the Hub does not try again.
      assert.lengthOf(laptopAsked, 1);
      assert.lengthOf(hubAsked, 0);
      const { item } = yield* handoffItemOf(hub, threadId);
      assert.equal(item.writtenBy, "fallback");
      assert.isNull(item.writerEnvironmentName);
      assert.include(item.fallbackReason ?? "", "The model is out of quota.");
      assert.include(item.summary, "Files changed: notes.md");
      assert.include(item.context, "assembled from the Thread's history");
      const turn = yield* firstTurnAfterMove(hub, desktop, threadId, turns);
      assert.include(turn.message.text, "Files changed: notes.md");
    }).pipe(Effect.scoped),
  );
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-history-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-history-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** `thread_history` as the Thread's agent calls it, with its per-Thread credential's scope. */
const callThreadHistory = Effect.fn(function* (
  hub: Hub,
  caller: { readonly threadId: ThreadId; readonly userId: UserId },
  args: Record<string, unknown>,
) {
  const services = yield* Layer.build(
    McpHttpServer.layerThreadHistoryToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(Layer.succeedContext(hub.server.services)),
    ),
  );
  const server = Context.get(services, McpServer.McpServer);
  return yield* server.callTool({ name: "thread_history", arguments: args }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-test"),
      requestNamespace: `mcp-thread-history:${caller.threadId}`,
      thread: {
        threadId: caller.threadId,
        providerSessionId: `provider-session:${caller.threadId}`,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      },
      client: undefined,
      capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
      issuedAt: 1,
      userId: caller.userId,
    }),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );
});

describe("Hub con Environments: thread_history", () => {
  it.live("an agent searches and reads its own Thread's history, and never another's", () =>
    Effect.gen(function* () {
      const { hub, laptop, threadId, projectId, owner } = yield* turnOnLaptop({ desktop: false });
      const { turnItems } = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId)
        .pipe(Effect.orDie);
      const firstRequest = turnItems.find((item) => item.type === "user_message");
      assert(firstRequest?.type === "user_message");
      const word = firstRequest.text.trim().split(/\s+/)[0] ?? "";

      // Its own Thread: read in order and search.
      const read = yield* callThreadHistory(hub, { threadId, userId: owner }, { action: "read" });
      assert.isFalse(read.isError, JSON.stringify(read.content));
      const page = read.structuredContent as {
        readonly threadId: string;
        readonly total: number;
        readonly entries: ReadonlyArray<{ readonly itemId: string; readonly text: string }>;
      };
      assert.equal(page.threadId, threadId);
      assert.isAbove(page.total, 0);
      assert.include(page.entries[0]?.text ?? "", firstRequest.text.trim().slice(0, 40));
      const found = yield* callThreadHistory(
        hub,
        { threadId, userId: owner },
        { action: "search", query: word },
      );
      assert.isFalse(found.isError, JSON.stringify(found.content));
      type Page = {
        readonly total: number;
        readonly nextPosition: number | null;
        readonly entries: ReadonlyArray<{ readonly text: string; readonly truncated: boolean }>;
      };
      const matches = found.structuredContent as Page;
      assert.isNotEmpty(matches.entries);
      // Case-insensitive on the text itself: the snippet shows the word as it was written.
      assert.include(matches.entries[0]?.text ?? "", word);
      const upper = (yield* callThreadHistory(
        hub,
        { threadId, userId: owner },
        { action: "search", query: word.toUpperCase(), limit: 1, order: "newest" },
      )).structuredContent as Page;
      assert.equal(upper.total, matches.total);
      assert.include(upper.entries[0]?.text ?? "", word);
      if (upper.total > 1) assert.equal(upper.nextPosition, 0);

      // Another Thread of the same User and Project: refused.
      const other = ThreadId.make("thread:another");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:another-thread"),
        threadId: other,
        projectId,
        title: "Another Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "x" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      const refused = yield* callThreadHistory(
        hub,
        { threadId, userId: owner },
        { action: "read", threadId: other },
      );
      assert.isTrue(refused.isError, JSON.stringify(refused.structuredContent));
    }).pipe(Effect.scoped),
  );
});

/** A command the agent ran on the Laptop that printed a key, as its timeline records it. */
const commandWithSecret = Effect.fn(function* (hub: Hub, threadId: ThreadId, output: string) {
  const { runs } = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  const run = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
  assert.isDefined(run);
  const now = yield* DateTime.now;
  yield* hub
    .service(EventSink.EventSinkV2)
    .write({
      events: [
        {
          id: EventId.make("event:printed-a-key"),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("turn-item:printed-a-key"),
            threadId,
            runId: run.id,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 9_999,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            status: "completed",
            title: "cat .env",
            type: "command_execution",
            input: "cat .env",
            output,
            exitCode: 0,
          },
        },
      ],
    })
    .pipe(Effect.orDie);
});

describe("Hub con Environments: what a handoff may carry", () => {
  it.live(
    "secrets are redacted from what is sent, stored and shown, and clients get a preview",
    () =>
      Effect.gen(function* () {
        const laptopAsked: Array<ThreadHandoffGenerationInput> = [];
        const leakedByModel = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        const fileKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
        const laptopTextGeneration: ProviderTextGeneration = {
          ...recordingTextGeneration(laptopAsked, { summary: "unused" }),
          // A model that repeats what it read, and a token of its own.
          generateThreadHandoff: (input) =>
            Effect.sync(() => {
              laptopAsked.push(input);
              return { summary: `${input.transcript.slice(-300)} and ${leakedByModel}` };
            }),
        };
        const { hub, desktop, threadId, owner } = yield* turnOnLaptop({
          desktop: true,
          laptopTextGeneration,
        });
        assert.isDefined(desktop);
        yield* commandWithSecret(hub, threadId, `OPENAI_API_KEY=${fileKey}\nPORT=3000\n`);
        yield* dispatchMove(hub, {
          commandId: "command:move-with-secret",
          threadId,
          target: desktop.environmentId,
          actor: owner,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.lengthOf(laptopAsked, 1);
        assert.notInclude(laptopAsked[0]?.transcript ?? "", fileKey);
        assert.include(laptopAsked[0]?.transcript ?? "", "PORT=3000");
        const { item } = yield* handoffItemOf(hub, threadId);
        for (const text of [item.summary, item.context, JSON.stringify(moved.move)]) {
          assert.notInclude(text, fileKey);
          assert.notInclude(text, leakedByModel);
        }
        // The Thread's shell (sent to every client) carries a short preview, not the handoff.
        const shellHandoff = moved.move?.handoff as Record<string, unknown> | undefined;
        assert.isDefined(shellHandoff);
        assert.notProperty(shellHandoff, "context");
        assert.notProperty(shellHandoff, "summary");
        assert.isAtMost(String(shellHandoff.preview).length, 300);
        // The timeline item reaches clients without its text; whoever may read it fetches it.
        const wire = projectTurnItemForWire(item);
        assert(wire.type === "environment_handoff");
        assert.equal(wire.context, "");
        assert.isTrue(wire.detailOmitted);
        const detail = yield* hub
          .service(ThreadManagementService.ThreadManagementService)
          .getTurnItem({ threadId, itemId: item.id })
          .pipe(Effect.orDie);
        assert(detail.item?.type === "environment_handoff");
        assert.equal(detail.item.context, item.context);
      }).pipe(Effect.scoped),
  );

  it.live(
    "with the source offline, the Hub never writes a summary from another User's Thread",
    () =>
      Effect.gen(function* () {
        const hubAsked: Array<ThreadHandoffGenerationInput> = [];
        const { hub, laptop, desktop, threadId } = yield* turnOnLaptop({
          desktop: true,
          hubTextGeneration: recordingTextGeneration(hubAsked, { summary: "Owner's account" }),
        });
        assert.isDefined(desktop);
        const member = UserId.make("member-1");
        yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
        yield* hub.server.sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.ownerUserId', ${member})
        WHERE thread_id = ${threadId}
      `;
        yield* laptop.disconnect;
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.move",
          commandId: CommandId.make("command:move-member-thread"),
          threadId,
          targetEnvironmentId: desktop.environmentId,
          ownerUserId: member,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.lengthOf(hubAsked, 0);
        const { item } = yield* handoffItemOf(hub, threadId);
        assert.equal(item.writtenBy, "fallback");
        assert.include(item.fallbackReason ?? "", "another User's history");
      }).pipe(Effect.scoped),
  );

  it.live("a summary that takes too long is cancelled on the source and assembled instead", () =>
    Effect.gen(function* () {
      const previous = process.env.T3CODE_MOVE_HANDOFF_TIMEOUT_MS;
      process.env.T3CODE_MOVE_HANDOFF_TIMEOUT_MS = "1500";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_MOVE_HANDOFF_TIMEOUT_MS;
          else process.env.T3CODE_MOVE_HANDOFF_TIMEOUT_MS = previous;
        }),
      );
      const cancelled = yield* Deferred.make<void>();
      const { hub, desktop, threadId, owner } = yield* turnOnLaptop({
        desktop: true,
        laptopTextGeneration: {
          ...recordingTextGeneration([], { summary: "unused" }),
          generateThreadHandoff: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))),
        },
      });
      assert.isDefined(desktop);
      yield* dispatchMove(hub, {
        commandId: "command:move-slow-summary",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId).pipe(Effect.timeout("60 seconds"));
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      const { item } = yield* handoffItemOf(hub, threadId);
      assert.equal(item.writtenBy, "fallback");
      assert.include(item.fallbackReason ?? "", "too long");
      yield* Deferred.await(cancelled).pipe(Effect.timeout("30 seconds"));
    }).pipe(Effect.scoped),
  );
});
