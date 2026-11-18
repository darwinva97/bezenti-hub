// @effect-diagnostics nodeBuiltinImport:off -- holds a git request open over a raw socket.
/**
 * «Hub con Environments», spec 3 ticket 12: a Project moving to another Space stops its Threads,
 * releases those its machine does not serve, and the old Space's machines lose it at once.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  CommandId,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type ModelSelection,
  type OrchestrationV2Command,
  ProjectId,
  type ProjectMovePlan,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  ProviderSessionId,
  sandboxEnvironmentIdOf,
  type SecretEnv,
  SpaceId,
  ThreadId,
  UserId,
  type VaultGroupId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGatewayKeys from "../ai/AiGatewayKeys.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { lendVaultGroup } from "../grants/Grants.testkit.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as AiSessionReach from "../orchestration-v2/AiSessionReach.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { materializeFixtureInput } from "../orchestration-v2/testkit/fixtures/shared.ts";
import {
  findReplayFixture,
  readReplayFixtureTranscript,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectMoveHooks from "../project/ProjectMoveHooks.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "../vaults/EffectiveVaults.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import {
  addDirectAccount,
  addGatewayAccount,
  callGateway,
  eventually,
  fakeGatewayCli,
  GATEWAY_MODEL,
  heldStream,
  type OpenedSession,
} from "./HubWithEnvironments.aiAccounts.testkit.ts";
import {
  type LoadedFixture as ScenarioFixture,
  loadFixture as loadScenario,
  replayOn,
} from "./HubWithEnvironments.scenarios.testkit.ts";
import {
  connectProtocolEnvironment,
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import { orgOwner, userOwner } from "../vaults/VaultGroups.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

type Adapters = Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  McpProviderSessions.McpProviderSessions
>;

const loadFixture = Effect.fn(function* (name: string) {
  const fixture = findReplayFixture(name);
  const variant = fixture?.providers.find((provider) => provider.driver === CLAUDE);
  assert.isDefined(fixture);
  assert.isDefined(variant);
  const recorded = (yield* readReplayFixtureTranscript(
    variant.transcriptFile,
  )) as ProviderReplayTranscript;
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(recorded, {
      driver: CLAUDE,
      model: variant.modelSelection.model,
    }),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: name,
    fixtureInput: fixture.buildInput(),
    driver: CLAUDE,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const adapters: Adapters = ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(
    transcript,
    { replayGate: makeProviderReplayGate([]) },
  ).pipe(Layer.orDie);
  return { variant, materialized, adapters };
});
type LoadedFixture = Effect.Success<ReturnType<typeof loadFixture>>;

/** The machine's agent stops reporting its turn after `afterEvents` events: the turn stays on. */
const holdingEvents = (adapters: Adapters, afterEvents: number) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const layer: Adapters = Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
        ...registry,
        get: (instanceId: Parameters<typeof registry.get>[0]) =>
          registry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
                adapter.openSession(open).pipe(
                  Effect.map((runtime) => {
                    let seen = 0;
                    return {
                      ...runtime,
                      events: runtime.events.pipe(
                        Stream.tap(() =>
                          Effect.suspend(() => {
                            seen += 1;
                            return seen === afterEvents
                              ? Deferred.succeed(reached, undefined).pipe(
                                  Effect.andThen(Effect.never),
                                )
                              : Effect.void;
                          }),
                        ),
                      ),
                    };
                  }),
                ),
            })),
          ),
      })),
    ).pipe(Layer.provide(adapters));
    return { layer, reached };
  });

/** A machine with the provider but no recorded turns, for tests that run none. */
const idleAdapters = (instanceId: ProviderInstanceId) =>
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: CLAUDE,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("no turns run here"),
    },
  ]);

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

const createOrganization = Effect.fn(function* (hub: Hub, name: string) {
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(yield* ownerIdOf(hub), name)
    .pipe(Effect.orDie);
  return created.id;
});

const dispatchAs = (hub: Hub, actor: UserId, command: OrchestrationV2Command) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({ ...command, ownerUserId: actor } as never)
    .pipe(CommandActor.actAs(actor));

/** Starts the Space's Sandbox and waits for it, as the Thread's first work does. */
const startSandbox = (hub: Hub, spaceId: SpaceId) =>
  hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: undefined })
    .pipe(Effect.orDie);

/** The fixture's Thread on the Space's Sandbox, and its first message sent: the turn runs there. */
const runTurnOnSandbox = Effect.fn(function* (hub: Hub, loaded: LoadedFixture, spaceId: SpaceId) {
  const owner = yield* ownerIdOf(hub);
  const [create, ...messages] = loaded.materialized.commands;
  if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
  yield* seedProject(hub.server, {
    projectId: create.projectId,
    title: "Acme web",
    defaultModelSelection: loaded.variant.modelSelection,
    spaceId,
  });
  yield* dispatchAs(hub, owner, {
    ...create,
    activeEnvironmentId: sandboxEnvironmentIdOf(spaceId),
  });
  const message = messages.find((command) => command.type === "message.dispatch");
  if (message === undefined) return yield* Effect.die("no message");
  yield* dispatchAs(hub, owner, message);
  return { threadId: create.threadId, projectId: create.projectId, message };
});

interface Answer<A> {
  readonly status: number;
  readonly body: A & { readonly message?: string; readonly _tag?: string };
}

const movePlan = (hub: Hub, projectId: ProjectId, spaceId: SpaceId, cookie = hub.owner) =>
  hub.server
    .request("/api/projects/move-plan", { cookie, body: { projectId, spaceId } })
    .pipe(Effect.map((response) => response as unknown as Answer<ProjectMovePlan>));

let moves = 0;
const moveProject = (
  hub: Hub,
  projectId: ProjectId,
  spaceId: SpaceId,
  options: { readonly cookie?: string; readonly stopThreads?: boolean } = {},
) =>
  hub.server
    .request("/api/projects/mutate", {
      cookie: options.cookie ?? hub.owner,
      body: {
        type: "project.move",
        commandId: `move:${projectId}:${spaceId}:${(moves += 1)}`,
        projectId,
        spaceId,
        ...(options.stopThreads === undefined ? {} : { stopThreads: options.stopThreads }),
      },
    })
    .pipe(
      Effect.map((response) => response as unknown as Answer<{ readonly spaceId: string | null }>),
    );

/** What a machine's credential gets when it asks for the Project's repository. */
const repositoryStatus = (hub: Hub, projectId: ProjectId, credential: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.get(
          `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/info/refs?service=git-upload-pack`,
        ).pipe(HttpClientRequest.bearerToken(credential)),
      ),
    ),
    Effect.map((response) => response.status),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  );

const threadOf = (hub: Hub, threadId: ThreadId) =>
  hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId).pipe(Effect.orDie);

/** The Thread once `done` holds, re-read after each of its events. */
const awaitThread = Effect.fn(function* (
  hub: Hub,
  threadId: ThreadId,
  done: (projection: Effect.Success<ReturnType<typeof threadOf>>) => boolean,
) {
  const afterSequence = yield* hub
    .service(EventSink.EventSinkV2)
    .latestSequence({ threadId })
    .pipe(Effect.orDie);
  const now = yield* threadOf(hub, threadId);
  if (done(now)) return now;
  const reached = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .streamStoredEventsFrom({ threadId, afterSequence })
    .pipe(
      Stream.mapEffect(() => threadOf(hub, threadId)),
      Stream.filter(done),
      Stream.runHead,
      Effect.orDie,
    );
  return Option.getOrThrow(reached);
});

/**
 * A push from a machine whose ref updates have not all arrived, so the Hub waits for the rest;
 * resolves with its answer (status or error), returned once the route holds the Project's access.
 */
const pushInFlight = Effect.fn(function* (hub: Hub, projectId: ProjectId, credential: string) {
  const url = new URL(
    `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/git-receive-pack`,
  );
  const answered = yield* Deferred.make<number | string>();
  const request = NodeHttp.request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/x-git-receive-pack-request",
      "transfer-encoding": "chunked",
    },
  });
  request.on("response", (response) => {
    response.resume();
    response.on("end", () =>
      Deferred.doneUnsafe(answered, Effect.succeed(response.statusCode ?? 0)),
    );
    response.on("error", (error) => Deferred.doneUnsafe(answered, Effect.succeed(String(error))));
  });
  request.on("error", (error) => Deferred.doneUnsafe(answered, Effect.succeed(String(error))));
  request.write("00");
  yield* Effect.addFinalizer(() => Effect.sync(() => request.destroy()));
  yield* hub.service(SpaceDirectory.SpaceDirectory).projectAccessHeld(projectId);
  return answered;
});

const RUNNING = new Set(["preparing", "starting", "running", "waiting"]);

describe("Hub con Environments: a Project moves to another Space", () => {
  it.live(
    "its running Thread stops and needs an environment, the old Sandbox loses the Project, and one move puts it on the new Sandbox",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const held = yield* holdingEvents(loaded.adapters, 2);
        const hub = yield* makeHub({ sandboxAdapters: held.layer });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const { threadId, projectId, message } = yield* runTurnOnSandbox(hub, loaded, acme);
        yield* Deferred.await(held.reached);
        const acmeSandbox = yield* hub.sandboxOf(acme);
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 200);
        // The agent there reaches the Hub's MCP with a credential issued for the Thread.
        assert.isTrue(acmeSandbox.mcpConfigs.some((config) => config.threadId === threadId));
        const requestsBefore = acmeSandbox.requests.length;

        // Before confirming, the mover sees what the move does to its Threads.
        const plan = yield* movePlan(hub, projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        const entry = {
          threadId,
          title: plan.body.running[0]?.title ?? "",
          environmentId: sandboxEnvironmentIdOf(acme),
        };
        assert.deepEqual(plan.body.running, [entry]);
        assert.deepEqual(plan.body.needsEnvironment, [entry]);
        // Not confirmed: a running Thread refuses it, nothing moved, and what Acme's Sandbox was
        // doing in the repository goes on.
        const inFlight = yield* pushInFlight(hub, projectId, acmeSandbox.credential);
        const refused = yield* moveProject(hub, projectId, globex);
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.isTrue(Option.isNone(yield* Deferred.poll(inFlight)));
        assert.equal(
          (yield* threadOf(hub, threadId)).thread.activeEnvironmentId,
          sandboxEnvironmentIdOf(acme),
        );

        const moved = yield* moveProject(hub, projectId, globex, { stopThreads: true });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(moved.body.spaceId, globex);
        // Once it went ahead, that request ends.
        assert.notEqual(yield* Deferred.await(inFlight), 200);
        const after = yield* threadOf(hub, threadId);
        assert.equal(after.thread.spaceId, globex);
        // «Needs an environment»: its machine does not serve Globex.
        assert.isNull(after.thread.activeEnvironmentId);
        assert.isFalse(after.runs.some((run) => RUNNING.has(run.status)));
        // Acme's Sandbox reaches nothing of it any more: its repository, its MCP credential.
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 403);
        // Its session there is let go (with its MCP credential), on the machine itself.
        yield* acmeSandbox.awaitRequest("provider.detach", requestsBefore);
        // Nor does it take new work there.
        const refusedMessage = yield* dispatchAs(hub, owner, {
          ...message,
          commandId: CommandId.make("message:after-move"),
        }).pipe(Effect.flip);
        assert.include(JSON.stringify(refusedMessage), "needs an environment");

        // One move puts it on Globex's Sandbox (spec 2's move), which gets the repository.
        yield* dispatchAs(hub, owner, {
          type: "thread.move",
          commandId: CommandId.make("move:to-globex"),
          threadId,
          targetEnvironmentId: sandboxEnvironmentIdOf(globex),
          ifRunning: "stop",
        });
        const landed = yield* awaitThread(
          hub,
          threadId,
          (projection) =>
            projection.thread.move?.status !== "running" &&
            projection.thread.activeEnvironmentId === sandboxEnvironmentIdOf(globex),
        );
        assert.equal(landed.thread.move?.status, "switched");
        const globexSandbox = yield* hub.sandboxOf(globex);
        assert.equal(yield* repositoryStatus(hub, projectId, globexSandbox.credential), 200);
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 403);
      }).pipe(Effect.scoped),
  );

  it.live(
    "only the Threads whose machine does not serve the new Space need one; moving back and an empty Project work",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const grace = UserId.make("member-grace");
        const linus = UserId.make("member-linus");
        yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        yield* addMember(hub.server, { id: linus, displayName: "Linus" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, globex, grace, "member");
        // Linus is not in Globex: his machine does not serve it.
        yield* joinOrganization(hub.server, acme, linus, "member");
        // Gus is a Guest of both: his own machine still runs his Threads there.
        const gus = UserId.make("guest-gus");
        yield* addMember(hub.server, { id: gus, displayName: "Gus" });
        yield* joinOrganization(hub.server, acme, gus, "guest");
        yield* joinOrganization(hub.server, globex, gus, "guest");
        // Dana was a Member of both and ran Grace's Thread on her laptop; she is a Guest of Globex
        // now, so her machine serves her own Threads there, never Grace's.
        const dana = UserId.make("demoted-dana");
        yield* addMember(hub.server, { id: dana, displayName: "Dana" });
        yield* joinOrganization(hub.server, acme, dana, "member");
        yield* joinOrganization(hub.server, globex, dana, "guest");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const at = "2026-01-01T00:00:00.000Z";
        const machine = (
          id: string,
          mode: string,
          ownerUserId: string | null,
          spaceId: string | null,
        ) =>
          hub.server.sql`
            INSERT INTO environments (
              environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
              credential_issued_at, registered_at
            ) VALUES (${id}, ${id}, 'external', ${mode}, ${ownerUserId}, ${spaceId},
              ${`hash-${id}`}, ${at}, ${at})
          `;
        yield* machine("env-grace", "personal", grace, null);
        yield* machine("env-linus", "personal", linus, null);
        yield* machine("env-gus", "personal", gus, null);
        yield* machine("env-dana", "personal", dana, null);
        yield* machine("env-acme-vps", "dedicated", null, acme);
        // Dedicated to Globex, but removed from the Hub: it serves nothing.
        yield* machine("env-removed-vps", "dedicated", null, globex);
        yield* hub.server.sql`
          UPDATE environments SET revoked_at = ${at} WHERE environment_id = 'env-removed-vps'
        `;
        const projectId = ProjectId.make("project:acme-web");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* hub.server.sql`
          UPDATE projection_projects SET preferred_environment_id = ${sandboxEnvironmentIdOf(acme)}
          WHERE project_id = ${projectId}
        `;
        const threads: Record<string, EnvironmentId | undefined> = {
          hub: undefined,
          sandbox: sandboxEnvironmentIdOf(acme),
          grace: "env-grace" as EnvironmentId,
          linus: "env-linus" as EnvironmentId,
          gus: "env-gus" as EnvironmentId,
          demoted: "env-dana" as EnvironmentId,
          dedicated: "env-acme-vps" as EnvironmentId,
          removed: "env-removed-vps" as EnvironmentId,
        };
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        for (const [name, environmentId] of Object.entries(threads)) {
          yield* orchestrator
            .dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`create:${name}`),
              threadId: ThreadId.make(`thread:${name}`),
              projectId,
              spaceId: acme,
              title: name,
              modelSelection: { instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              ...(environmentId === undefined ? {} : { activeEnvironmentId: environmentId }),
              // Gus's Thread is his; the one on Dana's laptop is Grace's.
              ...(name === "gus"
                ? { ownerUserId: gus }
                : name === "demoted"
                  ? { ownerUserId: grace }
                  : {}),
            })
            .pipe(Effect.orDie);
        }
        const plan = yield* movePlan(hub, projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.deepEqual(plan.body.running, []);
        assert.deepEqual(
          plan.body.needsEnvironment.map((thread) => [thread.title, thread.environmentId]),
          [
            ["sandbox", sandboxEnvironmentIdOf(acme)],
            ["linus", "env-linus"],
            ["demoted", "env-dana"],
            ["dedicated", "env-acme-vps"],
            ["removed", "env-removed-vps"],
          ],
        );
        // The move answers the Threads it actually released.
        const moved = yield* hub.server
          .request("/api/projects/move", {
            cookie: hub.owner,
            body: { commandId: "move:acme-web:globex", projectId, spaceId: globex },
          })
          .pipe(
            Effect.map(
              (response) =>
                response as unknown as Answer<{
                  readonly released: ReadonlyArray<{ readonly title: string }>;
                }>,
            ),
          );
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.deepEqual(
          moved.body.released.map((thread) => thread.title),
          ["sandbox", "linus", "demoted", "dedicated", "removed"],
        );
        const where = Effect.forEach(Object.keys(threads), (name) =>
          threadOf(hub, ThreadId.make(`thread:${name}`)).pipe(
            Effect.map(({ thread }): ReadonlyArray<unknown> => [
              name,
              thread.spaceId,
              thread.activeEnvironmentId,
            ]),
          ),
        );
        assert.deepEqual(yield* where, [
          ["hub", globex, undefined],
          ["sandbox", globex, null],
          ["grace", globex, "env-grace"],
          ["linus", globex, null],
          ["gus", globex, "env-gus"],
          ["demoted", globex, null],
          ["dedicated", globex, null],
          ["removed", globex, null],
        ]);
        // Acme's Sandbox is no preference in Globex.
        const [project] = yield* hub.server.sql<{ readonly preferred: string | null }>`
          SELECT preferred_environment_id AS preferred FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.isNull(project?.preferred ?? null);

        // Moving back: nothing it left gets a machine back by itself; the rest stay.
        const back = yield* moveProject(hub, projectId, acme);
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.deepEqual(yield* where, [
          ["hub", acme, undefined],
          ["sandbox", acme, null],
          ["grace", acme, "env-grace"],
          ["linus", acme, null],
          ["gus", acme, "env-gus"],
          ["demoted", acme, null],
          ["dedicated", acme, null],
          ["removed", acme, null],
        ]);
        // A Project with no Threads moves too.
        const empty = ProjectId.make("project:empty");
        yield* seedProject(hub.server, {
          projectId: empty,
          title: "Empty",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const emptyPlan = yield* movePlan(hub, empty, globex);
        assert.deepEqual(
          [emptyPlan.status, emptyPlan.body.running, emptyPlan.body.needsEnvironment],
          [200, [], []],
        );
        assert.equal((yield* moveProject(hub, empty, globex)).status, 200);
        assert.isDefined(owner);
      }).pipe(Effect.scoped),
  );

  it.live(
    "the plan is the move's to see: Owner and Admins of both Spaces, never a Member or a Guest",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        // An Admin acts as one only with a strong factor (a passkey).
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada",
          spaceId: acme,
          role: "admin",
        });
        const al = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Al",
          spaceId: acme,
          role: "admin",
        });
        const people = {
          admin: ada.cookie,
          adminOfOne: al.cookie,
          member: yield* addMember(hub.server, { id: "user-member", displayName: "Grace" }),
          guest: yield* addMember(hub.server, { id: "user-guest", displayName: "Linus" }),
        };
        yield* joinOrganization(hub.server, globex, ada.userId, "admin");
        yield* joinOrganization(hub.server, globex, al.userId, "member");
        for (const space of [acme, globex]) {
          yield* joinOrganization(hub.server, space, "user-member", "member");
          yield* joinOrganization(hub.server, space, "user-guest", "guest");
        }
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const projectId = ProjectId.make("project:acme-web");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: null,
          spaceId: acme,
        });
        for (const cookie of [hub.owner, people.admin]) {
          const answer = yield* movePlan(hub, projectId, globex, cookie);
          assert.equal(answer.status, 200, JSON.stringify(answer.body));
        }
        // As the move answers them: refused, or a Project they cannot see.
        for (const cookie of [people.adminOfOne, people.member, people.guest]) {
          const answer = yield* movePlan(hub, projectId, globex, cookie);
          assert.include([400, 403], answer.status, JSON.stringify(answer.body));
          const move = yield* moveProject(hub, projectId, globex, { cookie });
          assert.equal(move.status, answer.status, JSON.stringify(move.body));
        }
      }).pipe(Effect.scoped),
  );

  it.live("a request in flight on the Project's repository ends when the Project moves", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const projectId = ProjectId.make("project:acme-web");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme web",
        defaultModelSelection: null,
        spaceId: acme,
      });
      yield* startSandbox(hub, acme);
      const sandbox = yield* hub.sandboxOf(acme);
      const answered = yield* pushInFlight(hub, projectId, sandbox.credential);
      // It is in flight: the route holds the Project's access, and has not answered.
      yield* hub.service(SpaceDirectory.SpaceDirectory).projectAccessHeld(projectId);
      assert.isTrue(Option.isNone(yield* Deferred.poll(answered)));

      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      // It ends (a hang here is the request still running on old access).
      assert.notEqual(yield* Deferred.await(answered), 200);
      assert.equal(yield* repositoryStatus(hub, projectId, sandbox.credential), 403);
      assert.isDefined(HUB_MACHINE_ENVIRONMENT_ID);
    }).pipe(Effect.scoped),
  );

  it.live("a terminal open on the old Space's Sandbox ends when the Project moves", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const projectId = ProjectId.make("project:acme-web");
      const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
        projectId,
        title: "Acme web",
        defaultModelSelection: null,
        spaceId: acme,
      });
      yield* startSandbox(hub, acme);
      const threadId = ThreadId.make("thread:acme-terminal");
      yield* hub
        .service(Orchestrator.OrchestratorV2)
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acme-terminal"),
          threadId,
          projectId,
          spaceId: acme,
          title: "Terminal",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: sandboxEnvironmentIdOf(acme),
        })
        .pipe(Effect.orDie);
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(sandboxEnvironmentIdOf(acme))
        .pipe(Effect.orDie);
      const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
      yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
      const workspace = (yield* ThreadWorkspace.make.pipe(
        Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
        Effect.provideContext(hub.server.services as never),
      )) as ThreadWorkspace.ThreadWorkspace["Service"];
      const owner = { userId: yield* ownerIdOf(hub) };
      yield* workspace
        .terminalOpen(
          { threadId, terminalId: "term-1", cwd: hubCheckout, cols: 80, rows: 24 },
          owner,
        )
        .pipe(Effect.orDie);
      const attached = yield* Deferred.make<void>();
      const ended = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-1", owner)
        .pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(attached, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped,
        );
      yield* Deferred.await(attached);
      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      // Its stream there ends at once, and nothing can be typed into it any more.
      const exit = yield* Fiber.join(ended);
      assert.isTrue(exit._tag === "Failure" || exit._tag === "Success");
      const typed = yield* workspace
        .terminalWrite({ threadId, terminalId: "term-1", data: "pwd\r" }, owner)
        .pipe(Effect.flip);
      assert.isDefined(typed);
    }).pipe(Effect.scoped),
  );

  it.live("a release a move did not finish is finished by the next move of the Project", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub({ sandboxAdapters: loaded.adapters });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const { threadId, projectId } = yield* runTurnOnSandbox(hub, loaded, acme);
      const done = yield* awaitThread(
        hub,
        threadId,
        (projection) =>
          projection.runs.length > 0 && !projection.runs.some((run) => RUNNING.has(run.status)),
      );
      const sessionIds = done.providerSessions.map((session) => session.id);
      assert.isNotEmpty(sessionIds);
      const acmeSandbox = yield* hub.sandboxOf(acme);
      // What a Hub that stopped right after the move's commit leaves: the Thread released and
      // its release recorded, its machine not cut off yet.
      yield* hub.server.sql`
        UPDATE projection_projects SET space_id = ${globex} WHERE project_id = ${projectId}
      `;
      yield* hub.server.sql`
        UPDATE orchestration_v2_projection_threads
        SET space_id = ${globex}, active_environment_id = NULL WHERE thread_id = ${threadId}
      `;
      yield* hub.server.sql`
        INSERT INTO thread_environment_releases (
          thread_id, environment_id, provider_session_ids_json, released_at
        ) VALUES (${threadId}, ${sandboxEnvironmentIdOf(acme)}, ${JSON.stringify(sessionIds)},
          '2026-01-01T00:00:00.000Z')
      `;
      const requestsBefore = acmeSandbox.requests.length;
      // Moving it again (nothing left to move) cuts that machine off, and the record goes.
      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      yield* acmeSandbox.awaitRequest("provider.detach", requestsBefore);
      const left = yield* hub.server.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_environment_releases
      `;
      assert.equal(left[0]?.count, 0);
    }).pipe(Effect.scoped),
  );
});

// Spec 5 ticket 07: secrets never follow a Project into another Space.
const ACME_TOKEN = "acme-token-value-7001";
const SHARED_TOKEN = "shared-token-value-7002";
const GLOBEX_TOKEN = "globex-token-value-7003";

/** A machine's adapters that note the secrets each provider session opened with, and take them. */
const recordingSecrets = (adapters: Adapters, seen: Array<SecretEnv | undefined>): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: Parameters<typeof registry.get>[0]) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            receivesSecretEnv: true as const,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.suspend(() => {
                seen.push(open.secretEnv);
                return adapter.openSession(open);
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

const namesIn = (variables: ReadonlyArray<{ readonly name: string }> | undefined) =>
  (variables ?? []).map((variable) => variable.name).toSorted();

describe("Hub con Environments: a moved Project's Vaults", () => {
  it.live(
    "the plan names the Vaults it loses; after the move its Threads' next turn, terminal and names have the destination's alone",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const seen: Array<SecretEnv | undefined> = [];
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const asOwner = CommandActor.actAs(owner);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const vaults = hub.service(Vaults.Vaults);
        const vaultWith = Effect.fn(function* (
          name: string,
          spaceId: SpaceId | null,
          variable: string,
          value: string,
        ) {
          const made = yield* vaults
            .create({ name, owner: spaceId === null ? userOwner(owner) : orgOwner(spaceId) })
            .pipe(asOwner);
          yield* vaults
            .putEntry({ vaultId: made.id, name: variable, value: Redacted.make(value) })
            .pipe(asOwner);
          return made.id;
        });
        const acmeVault = yield* vaultWith("Acme keys", acme, "ACME_TOKEN", ACME_TOKEN);
        yield* vaults.setSpaceDefaults({ spaceId: acme, vaultIds: [acmeVault] }).pipe(asOwner);
        const globexVault = yield* vaultWith("Globex keys", globex, "GLOBEX_TOKEN", GLOBEX_TOKEN);
        yield* vaults.setSpaceDefaults({ spaceId: globex, vaultIds: [globexVault] }).pipe(asOwner);
        // One of the Owner's, lent to Acme alone, that the Project added there.
        const shared = yield* vaultWith("Shared tools", null, "SHARED_TOKEN", SHARED_TOKEN);
        const lend = (spaceId: SpaceId) =>
          lendVaultGroup(hub.server.sql, {
            vaultId: shared,
            spaceId,
            lender: { kind: "user", id: owner },
          });
        yield* lend(acme);

        // The Owner's laptop serves every Space the Owner works in: the Thread keeps it.
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: recordingSecrets(loaded.adapters, seen),
        });
        const [create, ...messages] = loaded.materialized.commands;
        if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
        const message = messages.find((command) => command.type === "message.dispatch");
        if (message === undefined) return yield* Effect.die("no message");
        const { projectId, threadId } = create;
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: loaded.variant.modelSelection,
          spaceId: acme,
        });
        yield* vaults.setProjectChoice({ projectId, vaultId: shared, choice: "add" }).pipe(asOwner);
        yield* dispatchAs(hub, owner, { ...create, activeEnvironmentId: laptop.environmentId });
        const executor = yield* hub
          .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
          .get(laptop.environmentId)
          .pipe(Effect.orDie);
        const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
        yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
        const workspace = (yield* ThreadWorkspace.make.pipe(
          Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
          Effect.provideContext(hub.server.services as never),
        )) as ThreadWorkspace.ThreadWorkspace["Service"];
        const openTerminal = (terminalId: string) =>
          workspace
            .terminalOpen({ threadId, terminalId, cwd: workspaceRoot }, { userId: owner })
            .pipe(Effect.orDie);
        const lastShell = () => laptop.ptySpawns.at(-1)?.env ?? {};
        const threadNames = hub
          .service(EffectiveVaults.EffectiveVaults)
          .threadEnvironment({ threadId })
          .pipe(asOwner, Effect.orDie);

        const opened = yield* openTerminal("term-1");
        assert.equal(lastShell().ACME_TOKEN, ACME_TOKEN);
        assert.equal(lastShell().SHARED_TOKEN, SHARED_TOKEN);
        const acmeShell = laptop.ptySpawns.at(-1);
        assert.isDefined(acmeShell);
        // The machine keeps what the shell started with: Acme's set, the Owner's.
        assert.deepEqual(opened.facts, { spaceId: acme, userId: owner });

        // Before confirming, the mover sees which Vaults the Project loses.
        const plan = yield* movePlan(hub, projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.deepEqual(
          (plan.body.vaultsLost ?? []).map((vault) => vault.name),
          ["Shared tools", "Acme keys"],
        );
        // The laptop is away while the Project moves: its terminal cannot be closed yet.
        yield* laptop.disconnect;
        assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
        // Its choice of a Vault that does not reach Globex went with the move.
        const choices = yield* hub.server.sql<{ readonly vaultId: string }>`
          SELECT group_id AS "vaultId" FROM project_vault_choices WHERE project_id = ${projectId}
        `;
        assert.deepEqual(choices, []);
        // Dropped as the mover, audited as a Project's choice gone back to inherit, in Acme: the
        // Space whose Admins already saw that Vault.
        const audited = yield* hub.server.sql<{
          readonly targetName: string;
          readonly detail: string;
          readonly spaceId: string;
        }>`
          SELECT target_name AS "targetName", detail_json AS "detail", space_id AS "spaceId"
          FROM audit_log WHERE action = 'vault.choose' ORDER BY audit_id DESC LIMIT 1
        `;
        assert.equal(audited[0]?.targetName, "Shared tools");
        assert.include(audited[0]?.detail ?? "", '"choice":"inherit"');
        assert.equal(audited[0]?.spaceId, acme);

        // The laptop was away: its shell closes as it connects again (the Hub's word on Spaces).
        assert.isEmpty(acmeShell.signals);
        const sentBefore = laptop.requests.length;
        yield* laptop.connect;
        yield* laptop.awaitAnswered("terminal.reconcile", sentBefore);
        assert.isNotEmpty(acmeShell.signals, "closed once the laptop was back");
        assert.isTrue(acmeShell.sessionEnded, "its background jobs end with it");

        // Opening term-1 again starts a new shell, with Globex's secrets alone.
        const spawnsBefore = laptop.ptySpawns.length;
        const reopened = yield* openTerminal("term-1");
        assert.equal(laptop.ptySpawns.length, spawnsBefore + 1);
        assert.isNotTrue(reopened.secretsStale);
        assert.isUndefined(lastShell().ACME_TOKEN);
        assert.equal(lastShell().GLOBEX_TOKEN, GLOBEX_TOKEN);
        assert.deepEqual(reopened.facts, { spaceId: globex, userId: owner });
        const globexShell = laptop.ptySpawns.at(-1);
        assert.isDefined(globexShell);
        // A reconcile that lands now (one the move fired) leaves the shell reopened in Globex.
        const machine = Option.getOrThrow(
          (yield* hub
            .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
            .get(laptop.environmentId)
            .pipe(Effect.orDie)).workspace.forward,
        );
        yield* machine
          .call("terminal.reconcile", {
            threads: [{ threadId, spaceId: globex }],
            removedUserIds: [],
          })
          .pipe(Effect.orDie);
        assert.isEmpty(globexShell.signals, "the shell opened in Globex stays");
        assert.isFalse(globexShell.sessionEnded);

        // A shell another door started for Acme (a setup script's, one no reconcile reached),
        // with output in its history: typing into it through the Hub is refused...
        yield* machine
          .call("terminal.open", {
            root: checkout,
            input: { threadId, terminalId: "term-3", cwd: "." },
            facts: { spaceId: acme, userId: owner },
          })
          .pipe(Effect.orDie);
        const missed = laptop.ptySpawns.at(-1);
        assert.isDefined(missed);
        yield* machine
          .call("terminal.write", { threadId, terminalId: "term-3", data: "printenv\r" })
          .pipe(Effect.orDie);
        const typed = yield* workspace
          .terminalWrite({ threadId, terminalId: "term-3", data: "printenv\r" }, { userId: owner })
          .pipe(Effect.flip);
        assert.equal(typed._tag, "TerminalEnvironmentUnavailableError");
        // ...and opening that id again closes it with its history, for a new shell in Globex.
        const reused = yield* openTerminal("term-3");
        assert.isNotEmpty(missed.signals, "the shell started for Acme was closed");
        assert.isTrue(missed.sessionEnded, "a stale close ends what its session started");
        assert.equal(reused.history, "", "none of its old output comes back");
        assert.deepEqual(reused.facts, { spaceId: globex, userId: owner });
        assert.equal(lastShell().GLOBEX_TOKEN, GLOBEX_TOKEN);

        // A shell that reports nothing (from before the upgrade): an attach closes it and starts
        // a new one.
        yield* machine
          .call("terminal.open", {
            root: checkout,
            input: { threadId, terminalId: "term-4", cwd: "." },
          })
          .pipe(Effect.orDie);
        const factless = laptop.ptySpawns.at(-1);
        assert.isDefined(factless);
        const attached = yield* workspace
          .terminalAttach({ threadId, terminalId: "term-4", cwd: workspaceRoot }, "viewer-1", {
            userId: owner,
          })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.isNotEmpty(factless.signals, "the shell without facts was closed");
        assert.isTrue(factless.sessionEnded);
        const first = [...attached][0];
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.snapshot.facts, { spaceId: globex, userId: owner });
        }
        // So does any other.
        yield* openTerminal("term-2");
        assert.isUndefined(lastShell().ACME_TOKEN);
        assert.isUndefined(lastShell().SHARED_TOKEN);
        assert.equal(lastShell().GLOBEX_TOKEN, GLOBEX_TOKEN);
        const names = yield* threadNames;
        assert.deepEqual(namesIn(names.variables), ["GLOBEX_TOKEN"]);
        // Globex's own `default` (empty) and its chosen default.
        assert.deepEqual(
          names.vaults.map((vault) => vault.name),
          ["default", "Globex keys"],
        );

        // Lending the Owner's group to Globex later does not bring the old choice back unseen.
        yield* lend(globex);
        assert.deepEqual(namesIn((yield* threadNames).variables), ["GLOBEX_TOKEN"]);

        // A new turn's provider session gets Globex's secrets alone.
        yield* dispatchAs(hub, owner, message);
        yield* awaitThread(
          hub,
          threadId,
          (projection) =>
            projection.runs.length > 0 && !projection.runs.some((run) => RUNNING.has(run.status)),
        );
        assert.isNotEmpty(seen);
        for (const opened of seen) {
          assert.deepEqual(namesIn(opened?.variables), ["GLOBEX_TOKEN"]);
        }
      }).pipe(Effect.scoped),
  );

  it.live("a shell admitted in Acme is refused as soon as the move commits (ticket 07)", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      // The Owner's laptop serves both Spaces: the Thread stays on it through the move.
      const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
      const [create, ...messages] = loaded.materialized.commands;
      if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
      const message = messages.find((command) => command.type === "message.dispatch");
      if (message === undefined) return yield* Effect.die("no message");
      const { projectId, threadId } = create;
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Acme web",
        defaultModelSelection: loaded.variant.modelSelection,
        spaceId: acme,
      });
      yield* dispatchAs(hub, owner, { ...create, activeEnvironmentId: laptop.environmentId });
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(laptop.environmentId)
        .pipe(Effect.orDie);
      const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
      yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
      const workspace = (yield* ThreadWorkspace.make.pipe(
        Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
        Effect.provideContext(hub.server.services as never),
      )) as ThreadWorkspace.ThreadWorkspace["Service"];
      const opened = yield* workspace
        .terminalOpen({ threadId, terminalId: "term-1", cwd: workspaceRoot }, { userId: owner })
        .pipe(Effect.orDie);
      assert.equal(opened.facts?.spaceId, acme);

      // Typing into it while the move still runs (after its commit, before it ends): refused.
      const hooks = hub.service(ProjectMoveHooks.ProjectMoveHooks);
      const work = yield* hooks.current;
      assert.isDefined(work);
      const typed: Array<string> = [];
      yield* hooks.register({
        ...work,
        drainReleases: (threadIds) =>
          workspace
            .terminalWrite({ threadId, terminalId: "term-1", data: "ls\r" }, { userId: owner })
            .pipe(
              Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "typed" }),
              Effect.tap((outcome) => Effect.sync(() => typed.push(outcome))),
              Effect.andThen(work.drainReleases(threadIds)),
            ),
      });
      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      assert.deepEqual(typed, ["TerminalEnvironmentUnavailableError"]);
      // The recorded turn runs, in Globex, as the fixture expects.
      yield* dispatchAs(hub, owner, message);
      yield* awaitThread(
        hub,
        threadId,
        (projection) =>
          projection.runs.length > 0 && !projection.runs.some((run) => RUNNING.has(run.status)),
      );
    }).pipe(Effect.scoped),
  );

  it.live("a plan within the same Space loses no Vault", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      const vaults = hub.service(Vaults.Vaults);
      const acmeVault = yield* vaults
        .create({ name: "Acme keys", owner: orgOwner(acme) })
        .pipe(CommandActor.actAs(owner));
      yield* vaults
        .setSpaceDefaults({ spaceId: acme, vaultIds: [acmeVault.id] })
        .pipe(CommandActor.actAs(owner));
      const projectId = ProjectId.make("project:stays");
      yield* seedProject(hub.server, {
        projectId,
        title: "Stays",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const plan = yield* movePlan(hub, projectId, acme);
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.deepEqual(plan.body.vaultsLost, []);
      assert.deepEqual(plan.body.aiAccountsLost, []);
    }).pipe(Effect.scoped),
  );
});

/** A Thread of the Owner's in a new Project of `spaceId`, on `environmentId`, its checkout made. */
const aiThreadIn = Effect.fn(function* (
  hub: Hub,
  input: {
    readonly id: string;
    readonly spaceId: SpaceId;
    readonly environmentId: EnvironmentId;
    readonly modelSelection: ModelSelection;
  },
) {
  const owner = yield* ownerIdOf(hub);
  const projectId = ProjectId.make(`project:${input.id}`);
  yield* seedProject(hub.server, {
    projectId,
    title: input.id,
    defaultModelSelection: null,
    spaceId: input.spaceId,
  });
  const threadId = ThreadId.make(`thread:${input.id}`);
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${input.id}`),
    threadId,
    projectId,
    title: input.id,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    spaceId: input.spaceId,
    ownerUserId: owner,
    activeEnvironmentId: input.environmentId,
  });
  const executor = yield* hub
    .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
    .get(input.environmentId)
    .pipe(Effect.orDie);
  const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
  yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
  return { projectId, threadId, checkout };
});

/**
 * The fixture's Thread run once on `environment` in `spaceId` (its session stays open after the
 * turn), then given `aiAccountId` as its choice, as the composer's door writes it.
 */
const replayedThread = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  loaded: ScenarioFixture,
  spaceId: SpaceId,
  aiAccountId: AiAccountId,
) {
  const owner = yield* ownerIdOf(hub);
  yield* replayOn(hub, environment, loaded, { spaceId, ownerUserId: owner });
  const create = loaded.materialized.commands.find((command) => command.type === "thread.create");
  if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
  const { threadId, projectId } = create;
  const now = yield* threadOf(hub, threadId);
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.model-selection.set",
    commandId: CommandId.make(`choose:${threadId}`),
    threadId,
    modelSelection: { ...now.thread.modelSelection, aiAccountId },
  } as OrchestrationV2Command);
  const [session] = yield* hub.server.sql<{ readonly id: string }>`
    SELECT provider_session_id AS id FROM orchestration_v2_projection_provider_sessions
    WHERE thread_id = ${threadId}
  `;
  assert.isDefined(session, "the turn's session");
  const executor = yield* hub
    .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
    .get(environment.environmentId)
    .pipe(Effect.orDie);
  const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
  return { threadId, projectId, checkout, providerSessionId: session.id };
});

/** Opens one of the Thread's provider sessions with its selection now, as a turn does. */
const openAiSession = Effect.fn(function* (
  hub: Hub,
  thread: { readonly threadId: ThreadId; readonly checkout: string },
  providerSessionId: string,
) {
  const projection = yield* threadOf(hub, thread.threadId);
  return yield* hub.service(ProviderSessionManagerV2).open({
    threadId: thread.threadId,
    providerSessionId: ProviderSessionId.make(providerSessionId),
    modelSelection: projection.thread.modelSelection,
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: thread.checkout },
  });
});

const isClosed = (hub: Hub, providerSessionId: string) =>
  hub
    .service(ProviderSessionManagerV2)
    .isLive(ProviderSessionId.make(providerSessionId))
    .pipe(Effect.map((live) => !live));

const ACME_CURSOR_KEY = "crsr-acme-move-key-0123456789abcdef";
const GLOBEX_CURSOR_KEY = "crsr-globex-move-key-0123456789abcdef";

const cursorKeyIn = (secretEnv: SecretEnv | undefined) =>
  secretEnv?.variables?.find((variable) => variable.name === "CURSOR_API_KEY")?.value;

/**
 * A machine's adapters as Cursor's: they take a direct `CURSOR_API_KEY`, noted as they open; from
 * the second open on the agent ends there (the transcript replays one session).
 */
const asCursor = (adapters: Adapters, seen: Array<SecretEnv | undefined>): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (id: ProviderInstanceId) =>
        registry.get(id).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            driver: ProviderDriverKind.make("cursor"),
            acceptsAiCredential: ["CURSOR_API_KEY"],
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) => {
              seen.push(input.secretEnv);
              if (seen.length > 1) {
                return Effect.fail(
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: ProviderDriverKind.make("cursor"),
                    providerSessionId: input.providerSessionId,
                    cause: "the fake agent ends here",
                  }),
                );
              }
              const { secretEnv: _secrets, ...recorded } = input;
              // The process is Cursor's, as its session records it.
              const cursor = ProviderDriverKind.make("cursor");
              return adapter.openSession(recorded).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  driver: cursor,
                  providerSession: { ...runtime.providerSession, driver: cursor },
                })),
              );
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

describe("Hub con Environments: a Project moves to another Space, with AI accounts (spec 4 ticket 11)", () => {
  it.live(
    "the plan names the AI accounts its Threads lose; the move revokes the Thread's key (401, a request in flight ends), closes its session, and the next one runs on Globex's account",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadScenario("simple");
        const models = [GATEWAY_MODEL, loaded.variant.modelSelection.model];
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const acmeAccount = yield* addGatewayAccount(
          hub,
          "Acme Claude",
          { spaceIds: [acme] },
          models,
        );
        const globexAccount = yield* addGatewayAccount(
          hub,
          "Globex Claude",
          { spaceIds: [globex] },
          models,
        );
        // Allowed to the Owner wherever they work: it still reaches Globex, so it is never lost.
        yield* addGatewayAccount(hub, "Owner Claude", { userIds: [owner] }, ["other-model"]);
        const opened: Array<OpenedSession> = [];
        // The Owner's laptop serves both Spaces: the Thread stays on it.
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: fakeGatewayCli(loaded.adapters, opened, { failFrom: 1 }),
        });
        const thread = yield* replayedThread(hub, laptop, loaded, acme, acmeAccount);
        const before = opened[0];
        assert.equal(before?.aiGateway?.aiAccountId, acmeAccount);
        assert.equal(before?.answer?.status, 200, before?.answer?.text);
        const baseUrl = before!.aiGateway!.baseUrl!;
        const key = before!.aiGateway!.key;

        const plan = yield* movePlan(hub, thread.projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.deepEqual(plan.body.aiAccountsLost, [
          {
            aiAccountId: acmeAccount,
            provider: "openai-compatible",
            name: "Acme Claude",
            threads: 1,
          },
        ]);

        // A request already streaming when the move commits ends whole.
        const inFlight = yield* heldStream(hub, baseUrl, key);
        assert.equal(inFlight.status, 200);
        const moved = yield* moveProject(hub, thread.projectId, globex);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const ended = yield* inFlight.release;
        assert.equal(ended.status, 200);
        assert.include(ended.text, "message_stop");

        // The old key is revoked with the move (401, not merely refused), recorded as moved.
        const after = yield* callGateway(baseUrl, key);
        assert.equal(after.status, 401, after.text);
        const rows = yield* hub.server.sql<{ readonly reason: string | null }>`
          SELECT revoked_reason AS reason FROM ai_gateway_keys WHERE thread_id = ${thread.threadId}
        `;
        assert.deepEqual(
          rows.map((row) => row.reason),
          ["thread-moved"],
        );
        // The Thread is on Globex's account now, and its old process is closed.
        const projection = yield* threadOf(hub, thread.threadId);
        assert.equal(projection.thread.modelSelection.aiAccountId, globexAccount);
        assert.isTrue(
          yield* eventually(isClosed(hub, thread.providerSessionId)),
          "the session started for Acme is closed",
        );
        // The next session runs on Globex's account with a new key.
        yield* Effect.exit(openAiSession(hub, thread, "ps-globex"));
        const next = opened.at(-1);
        assert.equal(next?.providerSessionId, "ps-globex");
        assert.equal(next?.aiGateway?.aiAccountId, globexAccount);
        assert.notEqual(next?.aiGateway?.key, key);
        assert.equal(next?.answer?.status, 200, next?.answer?.text);
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Thread whose account Globex does not allow, with none there, moves without one and its next turn says why",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ aiAccounts: true });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const acmeAccount = yield* addGatewayAccount(hub, "Acme Claude", { spaceIds: [acme] }, [
          GATEWAY_MODEL,
        ]);
        const opened: Array<OpenedSession> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: fakeGatewayCli(idleAdapters(instanceId), opened, { failFrom: 0 }),
        });
        const thread = yield* aiThreadIn(hub, {
          id: "ai-none",
          spaceId: acme,
          environmentId: laptop.environmentId,
          modelSelection: { instanceId, model: GATEWAY_MODEL, aiAccountId: acmeAccount },
        });
        const plan = yield* movePlan(hub, thread.projectId, globex);
        assert.deepEqual(
          (plan.body.aiAccountsLost ?? []).map((lost) => lost.name),
          ["Acme Claude"],
        );
        const moved = yield* moveProject(hub, thread.projectId, globex);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const projection = yield* threadOf(hub, thread.threadId);
        assert.isUndefined(projection.thread.modelSelection.aiAccountId, "needs an AI account");
        const exit = yield* Effect.exit(openAiSession(hub, thread, "ps-none"));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
          "No AI account is allowed to you in this Space",
        );
        assert.isEmpty(opened, "no process started");
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Cursor session holding Acme's direct key is closed when its Project moves; the next one gets Globex's",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadScenario("simple");
        const hub = yield* makeHub({ aiAccounts: true });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const acmeKey = yield* addDirectAccount(hub, "Acme Cursor", ACME_CURSOR_KEY, {
          spaceIds: [acme],
        });
        const globexKey = yield* addDirectAccount(hub, "Globex Cursor", GLOBEX_CURSOR_KEY, {
          spaceIds: [globex],
        });
        const seen: Array<SecretEnv | undefined> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: asCursor(loaded.adapters, seen),
        });
        const thread = yield* replayedThread(hub, laptop, loaded, acme, acmeKey);
        assert.equal(cursorKeyIn(seen[0]), ACME_CURSOR_KEY);
        const plan = yield* movePlan(hub, thread.projectId, globex);
        assert.deepEqual(
          (plan.body.aiAccountsLost ?? []).map((lost) => lost.name),
          ["Acme Cursor"],
        );
        const moved = yield* moveProject(hub, thread.projectId, globex);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.isTrue(
          yield* eventually(isClosed(hub, thread.providerSessionId)),
          "the process holding Acme's key is closed",
        );
        const projection = yield* threadOf(hub, thread.threadId);
        assert.equal(projection.thread.modelSelection.aiAccountId, globexKey);
        yield* Effect.exit(openAiSession(hub, thread, "ps-cursor-globex"));
        assert.equal(seen.length, 2, "a new process was asked for");
        assert.equal(cursorKeyIn(seen[1]), GLOBEX_CURSOR_KEY);
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: a Project move's AI reach, its edges (spec 4 ticket 11 review)", () => {
  it.live(
    "a session still opening when the move commits is closed once it is live, not left on Acme's account",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const acmeAccount = yield* addGatewayAccount(hub, "Acme Claude", { spaceIds: [acme] }, [
          GATEWAY_MODEL,
        ]);
        yield* addGatewayAccount(hub, "Globex Claude", { spaceIds: [globex] }, [GATEWAY_MODEL]);
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const environmentId = EnvironmentId.make("environment:protocol");
        const machine = yield* connectProtocolEnvironment(hub, {
          environmentId,
          instanceId,
          driver: CLAUDE,
          capabilities: ClaudeProviderCapabilitiesV2,
          executorContractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
        });
        const projectId = ProjectId.make("project:opening");
        yield* seedProject(hub.server, {
          projectId,
          title: "opening",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const threadId = ThreadId.make("thread:opening");
        const modelSelection = { instanceId, model: GATEWAY_MODEL, aiAccountId: acmeAccount };
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:opening"),
          threadId,
          projectId,
          title: "opening",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          spaceId: acme,
          ownerUserId: owner,
          activeEnvironmentId: environmentId,
        });
        const providerSessionId = ProviderSessionId.make("provider-session:opening");
        const opening = yield* hub
          .service(ProviderSessionManagerV2)
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/remote",
            },
          })
          .pipe(Effect.forkScoped);
        // Its plan is made (Acme's account, a key issued): the machine is asked to start it.
        let open = yield* machine.nextFrame;
        while (open.method !== "provider.openSession") open = yield* machine.nextFrame;
        const moved = yield* moveProject(hub, projectId, globex);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        // A check runs while it is still opening: nothing live to close yet.
        assert.deepEqual(yield* hub.service(AiSessionReach.AiSessionReach).reconcile, []);
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
        yield* Effect.exit(Fiber.join(opening));
        assert.isTrue(
          yield* eventually(isClosed(hub, providerSessionId)),
          "the session started for Acme closes once it is live",
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a move that fails part way closes the moved Threads' processes, and a Thread whose move is rejected keeps its keys",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadScenario("simple");
        const models = [GATEWAY_MODEL, loaded.variant.modelSelection.model];
        const hub = yield* makeHub({ aiAccounts: true });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const account = yield* addGatewayAccount(
          hub,
          "Shared Claude",
          { spaceIds: [acme, globex] },
          models,
        );
        const opened: Array<OpenedSession> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: fakeGatewayCli(loaded.adapters, opened, { failFrom: 1 }),
        });
        const first = yield* replayedThread(hub, laptop, loaded, acme, account);
        // A second Thread of the Project, made later, with a live key of its own.
        const second = ThreadId.make("thread:second");
        const now = yield* threadOf(hub, first.threadId);
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:second"),
          threadId: second,
          projectId: first.projectId,
          title: "second",
          modelSelection: now.thread.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          spaceId: acme,
          ownerUserId: yield* ownerIdOf(hub),
          activeEnvironmentId: laptop.environmentId,
        });
        yield* hub
          .service(AiGatewayKeys.AiGatewayKeys)
          .issueForThread(second, { providerSessionId: "ps-second" })
          .pipe(Effect.orDie);
        // Its move was rejected before: this move fails there, after the first Thread moved.
        const commandId = "move:partial";
        yield* hub
          .service(EventSink.EventSinkV2)
          .commitRejectedCommand({
            commandId: CommandId.make(`${commandId}:move-thread:${second}`),
            threadId: second,
            commandType: "thread.space.move",
            rejectedAt: yield* DateTime.now,
            error: "rejected before",
          })
          .pipe(Effect.orDie);
        const moved = yield* hub.server.request("/api/projects/mutate", {
          cookie: hub.owner,
          body: { type: "project.move", commandId, projectId: first.projectId, spaceId: globex },
        });
        assert.notEqual((moved as { status: number }).status, 200, JSON.stringify(moved));
        assert.equal((yield* threadOf(hub, first.threadId)).thread.spaceId, globex);
        const live = yield* hub.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ai_gateway_keys WHERE thread_id = ${second} AND revoked_at IS NULL
        `;
        assert.equal(live[0]?.n, 1, "the rejected Thread's key is not revoked");
        assert.isTrue(
          yield* eventually(isClosed(hub, first.providerSessionId)),
          "the moved Thread's process closes although the move failed after it",
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Thread from before Spaces keeps its keys when its Project's Space does not change",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        yield* addGatewayAccount(hub, "Acme Claude", { spaceIds: [acme] }, [GATEWAY_MODEL]);
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const projectId = ProjectId.make("project:legacy");
        yield* seedProject(hub.server, {
          projectId,
          title: "legacy",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const threadId = ThreadId.make("thread:legacy");
        // No Space of its own: it is its Project's.
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:legacy"),
          threadId,
          projectId,
          title: "legacy",
          modelSelection: { instanceId, model: GATEWAY_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ownerUserId: owner,
          activeEnvironmentId: laptop.environmentId,
        });
        assert.isUndefined((yield* threadOf(hub, threadId)).thread.spaceId ?? undefined);
        yield* hub
          .service(AiGatewayKeys.AiGatewayKeys)
          .issueForThread(threadId, { providerSessionId: "ps-legacy" })
          .pipe(Effect.orDie);
        const moved = yield* moveProject(hub, projectId, acme);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const live = yield* hub.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ai_gateway_keys WHERE thread_id = ${threadId} AND revoked_at IS NULL
      `;
        assert.equal(live[0]?.n, 1, "its key is not revoked: its Space did not change");
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: moving a Project out of a Personal space (owned-resources 10)", () => {
  it.live(
    "the plan names Ana's groups with their owner and her own account; the move drops her choices",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const acme = yield* createOrganization(hub, "Acme");
        // An Admin of Acme (with a passkey, so she acts as one), with no other Organization.
        const joined = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ana",
          spaceId: acme,
          role: "admin",
        });
        const anaCookie = joined.cookie;
        const ana = UserId.make(joined.userId);
        const asAna = CommandActor.actAs(ana);
        const personal = SpaceId.make(`personal:${ana}`);
        const vaults = hub.service(Vaults.Vaults);
        const [own] = yield* hub.server.sql<{ readonly groupId: VaultGroupId }>`
          SELECT group_id AS "groupId" FROM vault_groups
          WHERE owner_kind = 'user' AND owner_id = ${ana} AND is_default = 1
        `;
        assert.isDefined(own);
        yield* vaults
          .putEntry({
            vaultId: own.groupId,
            name: "ANA_TOKEN",
            value: Redacted.make("ana-move-secret-0101"),
          })
          .pipe(asAna, Effect.orDie);
        const tools = yield* vaults
          .create({ name: "Ana tools", owner: userOwner(ana) })
          .pipe(asAna, Effect.orDie);
        yield* vaults
          .putEntry({
            vaultId: tools.id,
            name: "ANA_TOOLS",
            value: Redacted.make("ana-move-tools-0202"),
          })
          .pipe(asAna, Effect.orDie);
        const account = yield* hub
          .service(AiAccounts.AiAccounts)
          .create({
            name: "Ana Claude",
            provider: "openai-compatible",
            apiKey: Redacted.make("sk-test-ana-move-0123456789abcdef"),
            baseUrl: "http://127.0.0.1:9/v1",
            models: [GATEWAY_MODEL],
          } as never)
          .pipe(asAna, Effect.orDie);
        const projectId = ProjectId.make("project:ana-personal");
        yield* seedProject(hub.server, {
          projectId,
          title: "Ana's side project",
          defaultModelSelection: null,
          spaceId: personal,
        });
        yield* vaults
          .setProjectChoice({ projectId, vaultId: tools.id, choice: "add" })
          .pipe(asAna, Effect.orDie);
        const instanceId = ProviderInstanceId.make("claudeAgent");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:ana-personal"),
          threadId: ThreadId.make("thread:ana-personal"),
          projectId,
          title: "Ana's Thread",
          modelSelection: { instanceId, model: GATEWAY_MODEL, aiAccountId: account.id },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          spaceId: personal,
          ownerUserId: ana,
        });

        const plan = yield* movePlan(hub, projectId, acme, anaCookie);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.sameDeepMembers(
          (plan.body.vaultsLost ?? []).map(({ name, owner, ownerName }) => ({
            name,
            owner,
            ownerName,
          })),
          [
            { name: "default", owner: userOwner(ana), ownerName: "Ana" },
            { name: "Ana tools", owner: userOwner(ana), ownerName: "Ana" },
          ],
        );
        // Her own account, seen by her in the Space it leaves: named.
        assert.deepEqual(
          (plan.body.aiAccountsLost ?? []).map((lost) => [lost.aiAccountId, lost.name]),
          [[account.id, "Ana Claude"]],
        );
        const moved = yield* moveProject(hub, projectId, acme, { cookie: anaCookie });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const choices = yield* hub.server.sql<{ readonly vaultId: string }>`
          SELECT group_id AS "vaultId" FROM project_vault_choices WHERE project_id = ${projectId}
        `;
        assert.deepEqual(choices, []);
      }).pipe(Effect.scoped),
  );
});
