// @effect-diagnostics nodeBuiltinImport:off -- reads the credential a Podman container mounts.
/**
 * «Hub con Environments», spec 3 ticket 09: machines the Owner dedicates to an Organization. Its
 * joined server runs one Sandbox (process runtime here) whose server connects as the machine; only
 * that Space uses it, and its mode or Space changes only once no Thread is on it.
 */
import * as NodeFS from "node:fs";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization, passkeyReauth } from "../auth/UserAuth.testkit.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PodmanSandboxRuntime from "../sandboxes/PodmanSandboxRuntime.ts";
import {
  ensureDevImage,
  makeTestRun,
  podmanResult,
  removeTestRunContainers,
  rootlessPodmanAvailable,
} from "../sandboxes/PodmanSandboxRuntime.testkit.ts";
import { devCodeMounts } from "../sandboxes/sandboxRuntimeFromConfig.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { dedicatedSandboxIdOf } from "./DedicatedHost.ts";
import * as EnvironmentConnections from "./EnvironmentConnections.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  approveJoin,
  confirmJoin,
  joinMachine,
  joinStatus,
  listEnvironments,
  memberWithPasskey,
  startJoin,
} from "./environments.testkit.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claudeAgent");

/** The provider, with no recorded turns: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: INSTANCE,
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

/** A client's command, through the Hub's placement, as `actor`. */
const dispatchAs = (hub: Hub, actor: UserId, command: unknown) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({ ...(command as object), ownerUserId: actor } as never)
    .pipe(CommandActor.actAs(actor));

const createThread = (
  hub: Hub,
  actor: UserId,
  input: {
    readonly threadId: string;
    readonly projectId: ProjectId;
    readonly spaceId: SpaceId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
  },
) =>
  dispatchAs(hub, actor, {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${input.threadId}`),
    threadId: ThreadId.make(input.threadId),
    projectId: input.projectId,
    spaceId: input.spaceId,
    title: input.title,
    modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: input.environmentId,
  });

/** Completes once the Thread's Active environment changed, as its next event says. */
const threadEnvironmentChanged = Effect.fn(function* (hub: Hub, threadId: string) {
  const orchestrator = hub.service(Orchestrator.OrchestratorV2);
  const id = ThreadId.make(threadId);
  const afterSequence = yield* hub
    .service(EventSink.EventSinkV2)
    .latestSequence({ threadId: id })
    .pipe(Effect.orDie);
  return yield* orchestrator.streamStoredEventsFrom({ threadId: id, afterSequence }).pipe(
    Stream.filter(({ event }) => {
      const payload = (event as { readonly payload?: { readonly activeEnvironmentId?: unknown } })
        .payload;
      return event.type === "thread.metadata-updated" && payload?.activeEnvironmentId === null;
    }),
    Stream.runHead,
    Effect.timeout("60 seconds"),
    Effect.orDie,
    Effect.forkScoped,
    Effect.map(Fiber.join),
  );
});

const listedIds = (hub: Hub, cookie: string) =>
  listEnvironments(hub.server, cookie).pipe(Effect.map((listed) => listed.map(({ id }) => id)));

/** What the Hub's git route answers `credential` for the Project's repository. */
const gitStatus = (hub: Hub, projectId: ProjectId, credential: string) =>
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

/** Why the Hub refuses `credential` at connect, or "valid". */
const refusalOf = (hub: Hub, credential: string) =>
  hub
    .service(EnvironmentRegistry.EnvironmentRegistry)
    .checkCredential(credential)
    .pipe(
      Effect.orDie,
      Effect.map((check) => (check._tag === "refused" ? check.reason : "valid")),
    );

/** The Hub sees the machine online: its Sandbox's server was welcomed before this is asked. */
const assertOnline = (hub: Hub, environmentId: string) =>
  listEnvironments(hub.server, hub.owner).pipe(
    Effect.map((listed) => {
      assert.equal(listed.find((entry) => entry.id === environmentId)?.status, "online");
    }),
  );

describe("Hub con Environments: a machine dedicated to a Space", () => {
  it.live(
    "only the Owner dedicates one, choosing its Space on the page, and `t3 join` confirms it as dedicated",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const acme = yield* createOrganization(hub, "Acme");
        yield* createOrganization(hub, "Globex");
        const grace = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Grace Hopper",
          spaceId: acme,
        });

        const { requestId } = yield* startJoin(hub.server, { dedicatedSpace: "acme" });
        // The Owner is offered every Organization, the one `--dedicated` named first.
        const ownersView = yield* hub.server.request("/api/environments/join/request", {
          cookie: hub.owner,
          body: { requestId },
        });
        assert.equal(ownersView.status, 200);
        assert.equal(ownersView.body.requestedDedicatedSpace, "acme");
        assert.deepEqual(
          (ownersView.body.dedicatedSpaces as ReadonlyArray<{ name: string }>).map(
            ({ name }) => name,
          ),
          ["Acme", "Globex"],
        );
        // A User who registers their own machines is offered none, and dedicates nothing.
        const gracesView = yield* hub.server.request("/api/environments/join/request", {
          cookie: grace.cookie,
          body: { requestId },
        });
        assert.equal(gracesView.body.viewerMayApprove, true);
        assert.isUndefined(gracesView.body.dedicatedSpaces);
        const refused = yield* approveJoin(hub.server, grace.cookie, requestId, {
          name: "Acme VPS",
          dedicatedSpaceId: acme,
          reauth: yield* passkeyReauth(hub.server, grace.authenticator),
        });
        assert.equal(refused.status, 403);
        assert.equal((yield* joinStatus(hub.server, requestId)).body.status, "pending");

        // The Owner dedicates it to Acme; the machine is told so before anything is registered.
        const approved = yield* approveJoin(hub.server, hub.owner, requestId, {
          name: "Acme VPS",
          dedicatedSpaceId: acme,
          reauth: yield* passkeyReauth(hub.server, hub.authenticator),
        });
        assert.equal(approved.status, 200);
        const awaiting = (yield* joinStatus(hub.server, requestId)).body;
        assert.equal(awaiting.status, "awaiting-confirmation");
        assert.deepEqual(awaiting.dedicatedSpace, { id: acme, name: "Acme" });
        const confirmed = yield* confirmJoin(hub.server, requestId, true);
        assert.equal(confirmed.status, 200);
        assert.equal(confirmed.body.status, "approved");
        assert.deepEqual(confirmed.body.dedicatedSpace, { id: acme, name: "Acme" });

        const vps = (yield* listEnvironments(hub.server, hub.owner)).find(
          (entry) => entry.name === "Acme VPS",
        );
        assert.isDefined(vps);
        assert.equal(vps.mode, "dedicated");
        assert.equal(vps.spaceId, acme);
        // Its Space's, not the Owner's who dedicated it.
        assert.isNull(vps.ownerUserId);
        const entries = yield* hub
          .service(AuditLog.AuditLog)
          .list({ viewer: yield* ownerIdOf(hub), query: { action: "environment.register" } })
          .pipe(Effect.orDie);
        assert.deepInclude(entries.entries[0]?.detail, {
          mode: "dedicated",
          spaceId: acme,
          via: "join",
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "its Space's Members see and use it for their Space's Threads; other Spaces neither see nor use it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const grace = UserId.make("member-1");
        const linus = UserId.make("guest-1");
        const hedy = UserId.make("member-2");
        const graceCookie = yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        const linusCookie = yield* addMember(hub.server, { id: linus, displayName: "Linus" });
        const hedyCookie = yield* addMember(hub.server, { id: hedy, displayName: "Hedy" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, acme, linus, "guest");
        yield* joinOrganization(hub.server, globex, hedy, "member");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const acmeProject = ProjectId.make("project:acme");
        const globexProject = ProjectId.make("project:globex");
        yield* seedProject(hub.server, {
          projectId: acmeProject,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* seedProject(hub.server, {
          projectId: globexProject,
          title: "Globex",
          defaultModelSelection: null,
          spaceId: globex,
        });

        const dedicated = yield* hub.joinDedicated({
          name: "Acme VPS",
          spaceId: acme,
          adapters: idleAdapters,
        });
        const vps = dedicated.environmentId;
        yield* assertOnline(hub, vps);
        // The machine's server ran no work itself: one Sandbox, with a credential the Hub issued
        // it for Acme (never the machine's own, which stays with its host), whose server is the
        // Environment the Hub sees.
        assert.equal(dedicated.launches.length, 1);
        const [launch] = dedicated.launches;
        assert.isDefined(launch);
        assert.equal(launch.joined.environmentId, vps);
        assert.isTrue(launch.joined.sandboxed);
        assert.equal(launch.joined.hubUrl, hub.server.url);
        assert.notEqual(launch.credential, dedicated.credential);
        assert.equal((yield* dedicated.hostState)._tag, "sandbox");

        // Acme's Member and Guest see it; Globex's Member does not.
        assert.include(yield* listedIds(hub, graceCookie), vps);
        assert.include(yield* listedIds(hub, linusCookie), vps);
        assert.notInclude(yield* listedIds(hub, hedyCookie), vps);

        const choose = (userId: UserId, projectId: ProjectId) =>
          registry.chooseForThread({
            userId,
            requested: vps,
            projectId,
            providerInstanceId: INSTANCE,
          });
        const refusal = (userId: UserId, projectId: ProjectId) =>
          choose(userId, projectId).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
            ),
          );
        assert.equal(yield* choose(grace, acmeProject), vps);
        assert.equal(yield* refusal(linus, acmeProject), "not-usable");
        assert.equal(yield* refusal(hedy, globexProject), "not-usable");
        // Not for another Space's Thread, though the Owner works in both.
        assert.equal(yield* choose(owner, acmeProject), vps);
        assert.equal(yield* refusal(owner, globexProject), "not-usable");

        // A Member's Thread runs there; a Globex Member gets no way onto it through a Thread.
        yield* createThread(hub, grace, {
          threadId: "thread:acme-vps",
          projectId: acmeProject,
          spaceId: acme,
          environmentId: vps,
          title: "Acme on the VPS",
        });
        const placed = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(ThreadId.make("thread:acme-vps"))
          .pipe(Effect.orDie);
        assert.equal(placed.thread.activeEnvironmentId, vps);
        const globexRefused = yield* createThread(hub, hedy, {
          threadId: "thread:globex-vps",
          projectId: globexProject,
          spaceId: globex,
          environmentId: vps,
          title: "Globex on the VPS",
        }).pipe(Effect.flip);
        assert.equal(
          EnvironmentRegistry.environmentRefusalMessage(globexRefused),
          "You can't run Threads on this Environment.",
        );
        assert.isTrue(
          Option.isNone(
            yield* registry.usableBy({
              userId: hedy,
              environmentId: vps,
              threadId: ThreadId.make("thread:acme-vps"),
            }),
          ),
        );

        // Its Sandbox's credential reaches its Space's repositories and no other's; the
        // machine's own reaches none.
        const advertised = (projectId: ProjectId, credential = launch.credential) =>
          gitStatus(hub, projectId, credential);
        assert.equal(yield* advertised(acmeProject), 200);
        assert.equal(yield* advertised(globexProject), 403);
        assert.equal(yield* advertised(acmeProject, dedicated.credential), 401);
      }).pipe(Effect.scoped),
  );

  it.live(
    "its mode or Space changes only once no Thread is on it, naming those that are, and is audited",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const grace = UserId.make("member-1");
        const graceCookie = yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        yield* joinOrganization(hub.server, acme, grace, "admin");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const acmeProject = ProjectId.make("project:acme");
        yield* seedProject(hub.server, {
          projectId: acmeProject,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const dedicated = yield* hub.joinDedicated({
          name: "Acme VPS",
          spaceId: acme,
          adapters: idleAdapters,
        });
        const vps = dedicated.environmentId;
        yield* assertOnline(hub, vps);
        yield* createThread(hub, grace, {
          threadId: "thread:busy",
          projectId: acmeProject,
          spaceId: acme,
          environmentId: vps,
          title: "Busy on the VPS",
        });
        // An archived Thread there too: it blocks nothing, and needs an environment afterwards.
        yield* createThread(hub, grace, {
          threadId: "thread:shelved",
          projectId: acmeProject,
          spaceId: acme,
          environmentId: vps,
          title: "Shelved on the VPS",
        });
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        yield* orchestrator
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("command:archive-shelved"),
            threadId: ThreadId.make("thread:shelved"),
          })
          .pipe(CommandActor.actAs(owner), Effect.orDie);

        const changeMode = (cookie: string, body: Record<string, unknown>) =>
          hub.server.request("/api/environments/mode", {
            cookie,
            body: { environmentId: vps, ...body },
          });
        // Moving it takes running both ends: Acme's Admin does not run Globex.
        const notGlobex = yield* changeMode(graceCookie, { mode: "dedicated", spaceId: globex });
        assert.equal(notGlobex.status, 403);
        // Refused while a Thread is on it, naming it.
        const busy = yield* changeMode(hub.owner, { mode: "personal" });
        assert.equal(busy.status, 409);
        assert.deepEqual(busy.body.threads, [
          { threadId: "thread:busy", title: "Busy on the VPS" },
        ]);
        assert.include(busy.body.message, "«Busy on the VPS»");
        assert.equal(
          (yield* changeMode(hub.owner, { mode: "dedicated", spaceId: globex })).status,
          409,
        );
        const stillAcme = (yield* listEnvironments(hub.server, hub.owner)).find(
          (entry) => entry.id === vps,
        );
        assert.equal(stillAcme?.mode, "dedicated");
        assert.equal(stillAcme?.spaceId, acme);

        // Once the active Thread is gone it moves to Globex: the archived one needs an
        // environment from then on, and unarchiving it does not put it back on the machine.
        yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("command:delete-busy"),
            threadId: ThreadId.make("thread:busy"),
          })
          .pipe(CommandActor.actAs(owner), Effect.orDie);
        const shelvedReleased = yield* threadEnvironmentChanged(hub, "thread:shelved");
        const toGlobex = yield* changeMode(hub.owner, { mode: "dedicated", spaceId: globex });
        assert.equal(toGlobex.status, 200);
        assert.equal(toGlobex.body.spaceId, globex);
        assert.isNull(toGlobex.body.ownerUserId);
        yield* shelvedReleased;
        yield* orchestrator
          .dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("command:unarchive-shelved"),
            threadId: ThreadId.make("thread:shelved"),
          })
          .pipe(CommandActor.actAs(owner), Effect.orDie);
        const unarchived = yield* orchestrator
          .getThreadProjection(ThreadId.make("thread:shelved"))
          .pipe(Effect.orDie);
        assert.isNull(unarchived.thread.activeEnvironmentId);
        assert.notInclude(
          (yield* listEnvironments(hub.server, graceCookie)).map(({ id }) => id),
          vps,
        );

        // What Acme's Sandbox holds reaches nothing from the change on: neither its socket nor
        // the git route, whoever copied it out of the container.
        const acmeCredential = dedicated.launches[0]?.credential ?? "";
        assert.equal(yield* refusalOf(hub, acmeCredential), "credential-unknown");
        assert.equal(yield* gitStatus(hub, acmeProject, acmeCredential), 401);
        // The machine learns it from the Hub: Acme's server is refused, never welcomed for Globex
        // (so no Globex work reaches Acme's container), and exits; its host asks the Hub,
        // deletes Acme's home and starts one for Globex with a credential for Globex.
        const first = yield* dedicated.nextLaunch;
        const acmeHome = dedicated.launches[0]?.homePath ?? "";
        yield* first.connect;
        const globexServer = yield* dedicated.nextLaunch.pipe(
          Effect.timeout("60 seconds"),
          Effect.orDie,
        );
        assert.deepEqual(
          dedicated.launches[0]?.welcomes.map((welcome) => welcome.spaceId),
          [acme],
        );
        assert.equal(dedicated.launches[1]?.joined.spaceId, globex);
        const globexCredential = dedicated.launches[1]?.credential ?? "";
        assert.notInclude([acmeCredential, dedicated.credential], globexCredential);
        assert.equal(yield* refusalOf(hub, globexCredential), "valid");
        assert.notEqual(dedicated.launches[1]?.homePath, acmeHome);
        assert.isFalse(NodeFS.existsSync(acmeHome));
        assert.equal(dedicated.persisted.at(-1)?.spaceId, globex);
        yield* assertOnline(hub, vps);

        const toPersonal = yield* changeMode(hub.owner, { mode: "personal" });
        assert.equal(toPersonal.status, 200);
        assert.equal(toPersonal.body.mode, "personal");
        assert.equal(toPersonal.body.ownerUserId, owner);
        assert.notEqual(
          (yield* listEnvironments(hub.server, hub.owner)).find((entry) => entry.id === vps)
            ?.status,
          "online",
        );
        // Welcomed as personal, the Sandbox's server refuses; its host deletes Globex's home and
        // serves as a personal machine from then on.
        yield* globexServer.connect;
        const personal = yield* dedicated.turnedPersonal.pipe(Effect.timeout("60 seconds"));
        assert.equal(personal.mode, "personal");
        assert.isFalse(NodeFS.existsSync(dedicated.launches[1]?.homePath ?? ""));
        assert.equal(dedicated.launches.length, 2);
        // Globex's Sandbox credential ended with it; the machine's own now connects as personal.
        assert.equal(yield* refusalOf(hub, globexCredential), "credential-unknown");
        assert.equal(yield* refusalOf(hub, dedicated.credential), "valid");

        const changes = yield* hub
          .service(AuditLog.AuditLog)
          .list({ viewer: owner, query: { action: "environment.mode.change" } })
          .pipe(Effect.orDie);
        assert.deepEqual(changes.entries.map((entry) => entry.detail).reverse(), [
          { from: "dedicated", to: "dedicated", fromSpaceId: acme, toSpaceId: globex },
          { from: "dedicated", to: "personal", fromSpaceId: globex, toSpaceId: null },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "an Admin dedicates a machine to the Organization they run with `t3 join --dedicated`: its Members run Threads there, Globex never sees it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada",
          spaceId: acme,
          role: "admin",
        });
        const grace = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Grace",
          spaceId: acme,
        });
        const hedy = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Hedy",
          spaceId: globex,
        });

        // The page offers Ada only the Organization she runs, and refuses any other.
        const { requestId } = yield* startJoin(hub.server, { dedicatedSpace: "acme" });
        const adasView = yield* hub.server.request("/api/environments/join/request", {
          cookie: ada.cookie,
          body: { requestId },
        });
        assert.equal(adasView.body.viewerMayApprove, true);
        assert.deepEqual(
          (adasView.body.dedicatedSpaces as ReadonlyArray<{ name: string }>).map(
            ({ name }) => name,
          ),
          ["Acme"],
        );
        const toGlobex = yield* approveJoin(hub.server, ada.cookie, requestId, {
          name: "Globex VPS",
          dedicatedSpaceId: globex,
          reauth: yield* passkeyReauth(hub.server, ada.authenticator),
        });
        assert.equal(toGlobex.status, 403);
        assert.equal((yield* joinStatus(hub.server, requestId)).body.status, "pending");
        // A Member of Acme is offered nothing to dedicate to.
        const gracesView = yield* hub.server.request("/api/environments/join/request", {
          cookie: grace.cookie,
          body: { requestId },
        });
        assert.isUndefined(gracesView.body.dedicatedSpaces);

        const dedicated = yield* hub.joinDedicated({
          name: "Acme VPS",
          spaceId: acme,
          adapters: idleAdapters,
          as: { cookie: ada.cookie, authenticator: ada.authenticator },
        });
        const vps = dedicated.environmentId;
        yield* assertOnline(hub, vps);
        const listedForAda = (yield* listEnvironments(hub.server, ada.cookie)).find(
          (entry) => entry.id === vps,
        );
        assert.equal(listedForAda?.mode, "dedicated");
        assert.isNull(listedForAda?.ownerUserId);
        assert.deepEqual(listedForAda?.owner, { kind: "organization", spaceId: acme });
        assert.isTrue(listedForAda?.canManage);
        const listedForGrace = (yield* listEnvironments(hub.server, grace.cookie)).find(
          (entry) => entry.id === vps,
        );
        assert.isFalse(listedForGrace?.canManage);
        assert.notInclude(yield* listedIds(hub, hedy.cookie), vps);

        // Acme's Member runs a Thread on it.
        const acmeProject = ProjectId.make("project:acme");
        yield* seedProject(hub.server, {
          projectId: acmeProject,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* createThread(hub, UserId.make(grace.userId), {
          threadId: "thread:grace-on-vps",
          projectId: acmeProject,
          spaceId: acme,
          environmentId: vps,
          title: "Grace on the VPS",
        });
        const placed = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(ThreadId.make("thread:grace-on-vps"))
          .pipe(Effect.orDie);
        assert.equal(placed.thread.activeEnvironmentId, vps);

        // Audited with its owner, the Organization.
        const entries = yield* hub
          .service(AuditLog.AuditLog)
          .list({ viewer: yield* ownerIdOf(hub), query: { action: "environment.register" } })
          .pipe(Effect.orDie);
        assert.deepInclude(entries.entries[0]?.detail, {
          mode: "dedicated",
          spaceId: acme,
          ownerKind: "organization",
          ownerId: acme,
        });
        assert.equal(
          (entries.entries[0]?.actor as { readonly userId?: string } | undefined)?.userId,
          ada.userId,
        );

        // Ada renames it; Grace, a Member, does not.
        const renamed = yield* hub.server.request("/api/environments/rename", {
          cookie: ada.cookie,
          body: { environmentId: vps, name: "Acme build box" },
        });
        assert.equal(renamed.status, 200);
        const gracesRename = yield* hub.server.request("/api/environments/rename", {
          cookie: grace.cookie,
          body: { environmentId: vps, name: "Mine" },
        });
        assert.equal(gracesRename.status, 403);
      }).pipe(Effect.scoped),
  );

  it.live(
    "an Admin turns their personal machine into their Organization's and back, never someone else's, and a lent one not at all",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada",
          spaceId: acme,
          role: "admin",
        });
        const grace = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Grace",
          spaceId: acme,
        });
        const changeMode = (cookie: string, environmentId: string, body: Record<string, unknown>) =>
          hub.server.request("/api/environments/mode", {
            cookie,
            body: { environmentId, ...body },
          });
        const adasLaptop = yield* joinMachine(hub.server, ada.authenticator, ada.cookie, "Ada's");
        const gracesLaptop = yield* joinMachine(
          hub.server,
          grace.authenticator,
          grace.cookie,
          "Grace's",
        );

        // Grace's machine is hers: neither Ada nor the Owner dedicates it.
        for (const cookie of [ada.cookie, hub.owner]) {
          const refused = yield* changeMode(cookie, gracesLaptop.environmentId, {
            mode: "dedicated",
            spaceId: acme,
          });
          assert.notEqual(refused.status, 200);
        }
        // Grace, a Member, does not dedicate her own to Acme.
        const memberRefused = yield* changeMode(grace.cookie, gracesLaptop.environmentId, {
          mode: "dedicated",
          spaceId: acme,
        });
        assert.equal(memberRefused.status, 403);
        // Ada does not dedicate hers to Globex, which she does not run.
        assert.equal(
          (yield* changeMode(ada.cookie, adasLaptop.environmentId, {
            mode: "dedicated",
            spaceId: globex,
          })).status,
          403,
        );
        // Ada dedicates hers to Acme, and it becomes Acme's.
        const toAcme = yield* changeMode(ada.cookie, adasLaptop.environmentId, {
          mode: "dedicated",
          spaceId: acme,
        });
        assert.equal(toAcme.status, 200);
        assert.equal(toAcme.body.spaceId, acme);
        assert.isNull(toAcme.body.ownerUserId);
        // And takes it back as her own.
        const back = yield* changeMode(ada.cookie, adasLaptop.environmentId, {
          mode: "personal",
        });
        assert.equal(back.status, 200);
        assert.equal(back.body.ownerUserId, ada.userId);

        // A machine with a waiting or active loan keeps its mode until the loan ends.
        yield* hub.server.sql`
          INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
            target_kind, target_id, state, limits_json, created_at, created_by)
          VALUES ('grant-1', 'environment', ${adasLaptop.environmentId}, 'user', ${ada.userId},
            'space', ${globex}, 'pending', '{}', '2026-11-17T00:00:00.000Z', ${ada.userId})
        `;
        const lent = yield* changeMode(ada.cookie, adasLaptop.environmentId, {
          mode: "dedicated",
          spaceId: acme,
        });
        assert.equal(lent.status, 403);
        assert.include(String(lent.body.message), "loan");
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: a dedicated machine is the Installation's", () => {
  it.live(
    "an answer lost on its way to the host leaves the credential it replaced working, until the new one is used or a while passes",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const acme = yield* createOrganization(hub, "Acme");
        const vps = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Acme VPS", acme);
        const issue = registry
          .selfOf(vps.credential)
          .pipe(Effect.map((self) => Option.getOrThrow(self).sandboxCredential ?? ""));
        const running = yield* issue;
        assert.equal(yield* refusalOf(hub, running), "valid");
        // An answer never reaches the host: what its Sandbox holds still connects.
        const lost = yield* issue;
        assert.equal(yield* refusalOf(hub, running), "valid");
        // Only the one a reissue replaces stays: across reissues an old one ends.
        const latest = yield* issue;
        assert.equal(yield* refusalOf(hub, running), "credential-unknown");
        assert.equal(yield* refusalOf(hub, lost), "valid");
        // Once the newest is used, the one it replaced ends.
        assert.equal(yield* refusalOf(hub, latest), "valid");
        assert.equal(yield* refusalOf(hub, lost), "credential-unknown");
        // And unused, it ends on its own after a while.
        const next = yield* issue;
        yield* hub.server.sql`
          UPDATE dedicated_sandbox_credentials SET previous_expires_at = '2000-01-01T00:00:00.000Z'
        `;
        assert.equal(yield* refusalOf(hub, latest), "credential-unknown");
        assert.equal(yield* refusalOf(hub, next), "valid");
      }).pipe(Effect.scoped),
  );

  it.live(
    "owned by nobody, it outlives its Space for the Owner alone, refused at connect, and leaves as itself",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const vps = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Acme VPS", acme);
        const spare = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Spare", acme);
        // Nobody owns it: the Owner who dedicated it is only on record.
        const [row] = yield* hub.server.sql<{ readonly owner: string | null }>`
          SELECT owner_user_id AS owner FROM environments WHERE environment_id = ${vps.environmentId}
        `;
        assert.isNull(row?.owner);
        // Its own credential only asks the Hub (`/self`): only its Sandbox's connects.
        assert.equal(yield* refusalOf(hub, vps.credential), "not-sandboxed");
        const self = yield* registry.selfOf(vps.credential).pipe(Effect.map(Option.getOrThrow));
        assert.equal(self.spaceId, acme);
        assert.isString(self.sandboxCredential);
        assert.equal(yield* refusalOf(hub, self.sandboxCredential ?? ""), "valid");

        // Its Organization is deleted: the Owner still sees, renames and removes it; it runs nothing.
        const lifecycle = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* lifecycle.archive(owner, acme).pipe(Effect.orDie);
        yield* lifecycle.delete(owner, acme).pipe(Effect.orDie);
        assert.equal(yield* refusalOf(hub, vps.credential), "space-missing");
        assert.equal(yield* refusalOf(hub, self.sandboxCredential ?? ""), "space-missing");
        // Asked, the Hub says it serves no Space now, so its host waits instead of giving up.
        const orphaned = yield* registry.selfOf(vps.credential).pipe(Effect.map(Option.getOrThrow));
        assert.deepInclude(orphaned, { mode: "dedicated", spaceId: null });
        assert.isUndefined(orphaned.sandboxCredential);
        assert.include(
          (yield* listEnvironments(hub.server, hub.owner)).map(({ id }) => id),
          vps.environmentId,
        );
        const renamed = yield* hub.server.request("/api/environments/rename", {
          cookie: hub.owner,
          body: { environmentId: vps.environmentId, name: "Old Acme VPS" },
        });
        assert.equal(renamed.status, 200);
        const removed = yield* hub.server.request("/api/environments/remove", {
          cookie: hub.owner,
          body: { environmentId: vps.environmentId },
        });
        assert.equal(removed.status, 200);

        // `t3 leave` on a dedicated machine is recorded as the machine, not as any User.
        yield* hub.server.sql`
          UPDATE environments SET space_id = ${yield* createOrganization(hub, "Globex")}
          WHERE environment_id = ${spare.environmentId}
        `;
        assert.isTrue(yield* registry.leave(spare.credential));
        const entries = yield* hub
          .service(AuditLog.AuditLog)
          .list({ viewer: owner, query: { action: "environment.remove" } })
          .pipe(Effect.orDie);
        const left = entries.entries.find((entry) => entry.target.id === spare.environmentId);
        assert.equal(left?.actor.source, "cli");
        assert.isNull(left?.actor.userId);
        assert.equal(left?.detail.via, "leave");
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: a dedicated machine's Sandbox limits", () => {
  it.live(
    "are the Space's own over the Installation's defaults, set for the machine even with no Hub Sandbox, and may be more than the Hub has",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const acme = yield* createOrganization(hub, "Acme");
        const vps = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Acme VPS", acme);
        const limitsOf = registry
          .selfOf(vps.credential)
          .pipe(Effect.map((self) => Option.getOrThrow(self).limits));
        const defaults = {
          cpus: 2,
          memoryBytes: 4 * 1024 ** 3,
          pids: 4096,
          diskBytes: 20 * 1024 ** 3,
        };
        // A Space with only a dedicated machine runs with the defaults, never with no limit.
        assert.deepEqual(yield* limitsOf, defaults);
        // The Owner sets the Space's own on the machine: more than the Hub has, for a bigger one.
        const big = { cpus: 4096, memoryBytes: 64 * 1024 ** 4, pids: null, diskBytes: null };
        const set = yield* hub.server.request("/api/environments/sandboxes/limits", {
          cookie: hub.owner,
          body: { environmentId: vps.environmentId, limits: big },
        });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.deepEqual(yield* limitsOf, { ...big, pids: 4096, diskBytes: 20 * 1024 ** 3 });
        // Only the values given change; an explicit null clears one back to the default.
        const partly = yield* hub.server.request("/api/environments/sandboxes/limits", {
          cookie: hub.owner,
          body: { environmentId: vps.environmentId, limits: { pids: 128, cpus: null } },
        });
        assert.equal(partly.status, 200, JSON.stringify(partly.body));
        const after = {
          cpus: 2,
          memoryBytes: 64 * 1024 ** 4,
          pids: 128,
          diskBytes: 20 * 1024 ** 3,
        };
        assert.deepEqual(yield* limitsOf, after);
        // The answer says what that Space has now, its own and what its Sandboxes start with.
        assert.deepEqual(partly.body.changed, {
          spaceId: acme,
          own: { cpus: null, memoryBytes: 64 * 1024 ** 4, pids: 128, diskBytes: null },
          effective: after,
        });
        // No Hub Sandbox was made for it.
        const [made] = yield* hub.server.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM sandboxes WHERE space_id = ${acme}
        `;
        assert.equal(made?.count, 0);
        // Only the Owner sets them.
        const admin = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada Lovelace",
          role: "admin",
          spaceId: acme,
        });
        const refused = yield* hub.server.request("/api/environments/sandboxes/limits", {
          cookie: admin.cookie,
          body: { environmentId: vps.environmentId, limits: big },
        });
        assert.equal(refused.status, 403);
      }).pipe(Effect.scoped),
  );
});

describe.skipIf(!rootlessPodmanAvailable)("a dedicated machine in Podman", () => {
  const run = makeTestRun();
  let image = "";
  beforeAll(() => {
    image = ensureDevImage();
  });
  afterAll(() => removeTestRunContainers(run));

  it.live(
    "runs its work in a Sandbox container that holds its own credential, not the machine's, and reaches the Hub only by its socket",
    () =>
      Effect.gen(function* () {
        const entry = new URL("../bin.ts", import.meta.url).pathname;
        const checkout = new URL("../../../../", import.meta.url).pathname.replace(/\/$/u, "");
        const hub = yield* makeHub();
        const acme = yield* createOrganization(hub, "Acme");
        const dedicated = yield* hub.joinDedicated({
          name: "Acme VPS",
          spaceId: acme,
          adapters: idleAdapters,
          runtime: (rootDir) =>
            PodmanSandboxRuntime.layer({
              image,
              serverCommand: ["node", entry],
              codeMounts: devCodeMounts(checkout),
              rootDir,
              namePrefix: run.namePrefix,
              labels: run.labels,
            }),
        });
        // The container's server connects as the machine.
        yield* hub
          .service(EnvironmentConnections.EnvironmentConnections)
          .awaitReady(dedicated.environmentId)
          .pipe(Effect.timeout("150 seconds"), Effect.orDie);
        assert.equal(
          (yield* listEnvironments(hub.server, hub.owner)).find(
            (environment) => environment.id === dedicated.environmentId,
          )?.status,
          "online",
        );
        const state = yield* dedicated.hostState;
        assert.equal(state._tag === "sandbox" && state.state, "running");
        const container = `${run.namePrefix}${dedicatedSandboxIdOf(acme)}`;
        const mounts = JSON.parse(
          podmanResult(["container", "inspect", "--format", "{{json .Mounts}}", container]).stdout,
        ) as Array<{ Source: string; Destination: string; RW: boolean }>;
        // Its home, the credential and Hub file read-only, the socket's directory, and the code
        // a dev machine runs from: nothing else of the machine.
        const credential = mounts.find((mount) =>
          mount.Destination.endsWith("/secrets/environment-credential.bin"),
        );
        assert.isDefined(credential);
        assert.isFalse(credential.RW);
        const mounted = NodeFS.readFileSync(credential.Source, "utf8");
        assert.notEqual(mounted, dedicated.credential);
        assert.equal(yield* refusalOf(hub, mounted), "valid");
        const others = mounts.filter(
          (mount) =>
            !mount.Source.startsWith(dedicated.rootDir) && !mount.Source.startsWith(checkout),
        );
        assert.deepEqual(others, []);
        const inspected = podmanResult([
          "container",
          "inspect",
          "--format",
          "{{json .HostConfig.CapDrop}} {{.HostConfig.NetworkMode}}",
          container,
        ]).stdout;
        assert.include(inspected, "slirp4netns");
      }).pipe(Effect.scoped),
  );
});
