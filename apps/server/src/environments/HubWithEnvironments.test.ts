// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  MessageId,
  NodeId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { connectProtocolEnvironment, makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import {
  CLAUDE,
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  moveThread,
  openProtocolSession,
} from "./HubWithEnvironments.scenarios.testkit.ts";

describe("Hub con Environments", () => {
  it.live("a turn on a joined Environment runs there and is visible on the Hub", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
      const result = yield* replayOn(hub, laptop, loaded);

      loaded.variant.assertOutput(result, loaded.transcript);
      const [threadId] = loaded.materialized.projectionThreadIds;
      const projection = result.projections.get(threadId!);
      assert.equal(projection?.thread.activeEnvironmentId, laptop.environmentId);
      // The checkpoints were taken in the Laptop's own checkout, cloned from the Project.
      assert.isNotEmpty(projection?.checkpointScopes);
      for (const scope of projection?.checkpointScopes ?? []) {
        assert.isTrue(scope.cwd.startsWith(laptop.workspaceRoot), scope.cwd);
      }
      // The agent there reaches the Hub's MCP with the credential the Hub issued for the Thread.
      const [mcp] = laptop.mcpConfigs;
      assert.equal(mcp?.endpoint, `${hub.server.url}/mcp`);
      assert.equal(mcp?.threadId, threadId);
      assert.match(mcp?.authorizationHeader ?? "", /^Bearer \S+$/);
    }).pipe(Effect.scoped),
  );

  it.live.each(["turn_interrupt", "message_steering", "tool_call_read_only_on_request"])(
    "%s works on a joined Environment as on the Hub machine",
    (name) =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture(name);
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
        const result = yield* replayOn(hub, laptop, loaded);
        loaded.variant.assertOutput(result, loaded.transcript);
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps each event once and in order, and refuses one from a machine the Thread is not on",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const environmentId = EnvironmentId.make("environment:protocol");
        const machine = yield* connectProtocolEnvironment(hub, {
          environmentId,
          instanceId,
          driver: CLAUDE,
          capabilities: ClaudeProviderCapabilitiesV2,
        });
        const threadId = ThreadId.make("thread:protocol");
        const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:protocol-thread"),
          threadId,
          projectId: ProjectId.make("project:protocol"),
          title: "Protocol",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: environmentId,
        });
        const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
        const adapter = yield* (yield* registry.get(environmentId)).provider.adapters.get(
          instanceId,
        );
        const providerSessionId = ProviderSessionId.make("provider-session:protocol");
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/remote",
            },
          })
          .pipe(Effect.provideService(Scope.Scope, yield* Effect.scope), Effect.forkScoped);
        const open = yield* machine.nextFrame;
        assert.equal(open.method, "provider.openSession");
        yield* machine.connection.receive({
          type: "response",
          requestId: open.requestId,
          result: {
            _tag: "success",
            value: {
              providerSession: machine.providerSession(providerSessionId, "/remote"),
              features: {
                injectHistory: false,
                compactThread: false,
                stopTask: false,
                unloadThread: false,
                hasPendingBackgroundWork: false,
                backgroundTasksEndWithProcess: false,
              },
            },
          },
        });
        const runtime = yield* Fiber.join(opening);

        const encodeEvent = Schema.encodeEffect(
          Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event),
        );
        const send = (seq: number, turn: string) =>
          encodeEvent({
            type: "background_work.updated",
            driver: CLAUDE,
            providerTurnId: ProviderTurnId.make(turn),
            pending: true,
          }).pipe(
            Effect.flatMap((event) =>
              machine.connection.receive({
                type: "event",
                method: "provider.event",
                payload: { providerSessionId, seq, event },
              }),
            ),
          );
        yield* send(1, "turn-1");
        // A reconnect resends what the Hub had not acknowledged yet.
        yield* send(1, "turn-1");
        yield* send(2, "turn-2");
        yield* machine.connection.flushAcks;
        assert.deepEqual(yield* machine.nextFrame, {
          type: "event",
          method: "provider.ack",
          payload: { acks: [{ providerSessionId, seq: 2 }] },
        });

        // The Thread runs elsewhere now: what this machine still sends must not reach it.
        yield* moveThread(hub, threadId, HUB_MACHINE_ENVIRONMENT_ID);
        yield* send(3, "turn-from-the-old-machine");
        yield* moveThread(hub, threadId, environmentId);
        yield* send(4, "turn-4");

        const received = yield* runtime.events.pipe(Stream.take(3), Stream.runCollect);
        assert.deepEqual(
          [...received].map((event) =>
            event.type === "background_work.updated" ? event.providerTurnId : event.type,
          ),
          ["turn-1", "turn-2", "turn-4"],
        );
      }).pipe(Effect.scoped),
  );

  it.live("a new Thread runs only where its User may, on a machine online with its provider", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const desktop = yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(instanceId),
        connect: false,
      });
      const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
      const owner = yield* ownerIdOf(hub);
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const projectId = ProjectId.make("project:choice");
      const choose = (
        userId: UserId,
        requested: EnvironmentId | undefined,
        providerInstanceId = instanceId,
      ) => registry.chooseForThread({ userId, requested, projectId, providerInstanceId });
      const refusal = (userId: UserId, requested: EnvironmentId, providerInstanceId = instanceId) =>
        choose(userId, requested, providerInstanceId).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
          ),
        );

      assert.equal(yield* choose(owner, laptop.environmentId), laptop.environmentId);
      assert.equal(yield* choose(owner, undefined), HUB_MACHINE_ENVIRONMENT_ID);
      assert.equal(yield* choose(member, undefined), HUB_MACHINE_ENVIRONMENT_ID);
      // The Owner's personal machine is theirs alone, even for a Member who names it.
      assert.equal(yield* refusal(member, laptop.environmentId), "not-usable");
      assert.equal(yield* refusal(owner, desktop.environmentId), "offline");
      assert.equal(
        yield* refusal(owner, laptop.environmentId, ProviderInstanceId.make("codex")),
        "provider-missing",
      );
    }).pipe(Effect.scoped),
  );
  it.live(
    "a Member's own machine runs their Threads in any of their Spaces, and nobody else's",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub();
        const grace = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Grace Hopper",
        });
        const linus = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Linus",
          spaceId: grace.spaceId,
        });
        const laptop = yield* hub.join({
          name: "Grace's laptop",
          adapters: idleAdapters(instanceId),
          as: grace,
        });
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const graceId = UserId.make(grace.userId);
        const choose = (userId: UserId, projectId: ProjectId) =>
          registry.chooseForThread({
            userId,
            requested: laptop.environmentId,
            projectId,
            providerInstanceId: instanceId,
          });
        const refusal = (userId: UserId) =>
          choose(userId, ProjectId.make("project:acme")).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
            ),
          );

        // In the Organization and in her Personal space alike.
        yield* seedProject(hub.server, {
          projectId: ProjectId.make("project:acme"),
          title: "Acme",
          defaultModelSelection: null,
          spaceId: SpaceId.make(grace.spaceId),
        });
        yield* seedProject(hub.server, {
          projectId: ProjectId.make("project:grace-notes"),
          title: "Notes",
          defaultModelSelection: null,
          spaceId: SpaceId.make(`personal:${grace.userId}`),
        });
        assert.equal(yield* choose(graceId, ProjectId.make("project:acme")), laptop.environmentId);
        assert.equal(
          yield* choose(graceId, ProjectId.make("project:grace-notes")),
          laptop.environmentId,
        );
        // The Owner sees it but runs nothing there; another Member of her Space neither.
        assert.equal(yield* refusal(yield* ownerIdOf(hub)), "not-usable");
        assert.equal(yield* refusal(UserId.make(linus.userId)), "not-usable");
        assert.isTrue(
          Option.isNone(
            yield* registry.usableBy({
              userId: UserId.make(linus.userId),
              environmentId: laptop.environmentId,
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );
  it.live("an effect's call resends on the next socket with the same key, and once only", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const environmentId = EnvironmentId.make("environment:protocol");
      const fake = () =>
        connectProtocolEnvironment(hub, {
          environmentId,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: CLAUDE,
          capabilities: ClaudeProviderCapabilitiesV2,
        });
      const first = yield* fake();
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const checkpoints = (yield* registry.get(environmentId)).workspace.checkpoints;
      const call = (attempt: number) => {
        const effect = { effectId: "effect:protocol", attempt };
        return checkpoints
          .isGitRepository("/remote/projects/web")
          .pipe(EnvironmentExecutor.withEffectAttempt(effect), Effect.forkScoped);
      };

      // The socket drops after the request left: the call waits and resends on the next one.
      const dropped = yield* call(1);
      const sent = yield* first.nextFrame;
      yield* first.disconnect;
      const second = yield* fake();
      const resent = yield* second.nextFrame;
      assert.equal(resent.idempotencyKey, sent.idempotencyKey);
      yield* second.connection.receive({
        type: "response",
        requestId: resent.requestId,
        result: { _tag: "success", value: true },
      });
      assert.isTrue(yield* Fiber.join(dropped));

      // A newer socket replaces this one while a call waits: it resends there at once.
      const replaced = yield* call(2);
      const before = yield* second.nextFrame;
      const third = yield* fake();
      const after = yield* third.nextFrame;
      // The effect's next attempt asks under the same key, so the machine does not run it again.
      assert.equal(after.idempotencyKey, sent.idempotencyKey);
      assert.equal(before.idempotencyKey, sent.idempotencyKey);
      yield* third.connection.receive({
        type: "response",
        requestId: after.requestId,
        result: { _tag: "success", value: true },
      });
      assert.isTrue(yield* Fiber.join(replaced));
    }).pipe(Effect.scoped),
  );

  it.live("acknowledgements never move back, and a reconnect ends sessions the machine lost", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      yield* opened.send(5, "turn-5");
      yield* opened.send(3, "turn-3");
      yield* opened.machine.connection.flushAcks;
      assert.deepEqual(yield* opened.machine.nextFrame, {
        type: "event",
        method: "provider.ack",
        payload: { acks: [{ providerSessionId: opened.providerSessionId, seq: 5 }] },
      });
      // The machine comes back without the session: the Hub's side of it ends.
      yield* opened.machine.disconnect;
      yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      const ended = yield* opened.runtime.events.pipe(Stream.runCollect, Effect.flip);
      assert.equal(ended._tag, "ProviderAdapterEventStreamError");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a machine reads a turn's attachment only while its session lives and the Thread is there",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const opened = yield* openProtocolSession(hub);
        const attachment = {
          type: "image" as const,
          id: "protocol-attachment-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const config = hub.service(ServerConfig.ServerConfig);
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        assert.isNotNull(path);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
          await NodeFSP.writeFile(path!, Buffer.from([1, 2, 3, 4]));
        });
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(opened.threadId);
        const starting = yield* opened.runtime
          .startTurn({
            appThread: projection.thread,
            threadId: opened.threadId,
            runId: RunId.make("run:protocol"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt:protocol"),
            rootNodeId: NodeId.make("node:protocol"),
            providerThread: {
              id: ProviderThreadId.make("provider-thread:protocol"),
              driver: CLAUDE,
              providerInstanceId: opened.instanceId,
              providerSessionId: opened.providerSessionId,
              appThreadId: opened.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              goal: null,
              createdAt: projection.thread.createdAt,
              updatedAt: projection.thread.createdAt,
            },
            message: {
              messageId: MessageId.make("message:protocol"),
              text: "Look at this",
              attachments: [attachment],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection: opened.modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/remote",
            },
          })
          .pipe(Effect.forkScoped);
        const start = yield* opened.machine.nextFrame;
        const [ref] = (
          start.payload as { attachments: ReadonlyArray<{ id: string; sha256: string }> }
        ).attachments;
        assert.isDefined(ref);
        let reads = 0;
        const read = Effect.gen(function* () {
          reads += 1;
          yield* opened.machine.connection.receive({
            type: "request",
            requestId: `read-${reads}`,
            method: "attachment.read",
            payload: { threadId: opened.threadId, attachmentId: ref.id, sha256: ref.sha256 },
          });
          const answer = (yield* opened.machine.nextFrame) as { result: { _tag: string } };
          return answer.result._tag;
        });
        assert.equal(yield* read, "success");
        yield* opened.machine.connection.receive({
          type: "response",
          requestId: start.requestId,
          result: { _tag: "success", value: null },
        });
        yield* Fiber.join(starting);

        // The Thread left this machine: its attachments did too.
        yield* opened.moveTo(HUB_MACHINE_ENVIRONMENT_ID);
        assert.equal(yield* read, "failure");
        yield* opened.moveTo(opened.environmentId);
        assert.equal(yield* read, "success");
        // The session ended: nothing it carried is readable any more.
        yield* opened.machine.connection.receive({
          type: "event",
          method: "provider.sessionEnded",
          payload: { providerSessionId: opened.providerSessionId },
        });
        assert.equal(yield* read, "failure");
      }).pipe(Effect.scoped),
  );
});
