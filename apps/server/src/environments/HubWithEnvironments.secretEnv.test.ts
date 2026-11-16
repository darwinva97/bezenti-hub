/**
 * A Thread's secrets as environment variables (spec 5 «Vaults», ticket 04): a provider session, a
 * terminal and a setup script get the secrets of the User who starts them, on the Thread's machine
 * alone, and a machine on an executor contract before 10 gets none and says why.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests make checkouts on disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  MAIN_VAULT_ID,
  ProjectId,
  type ProviderInstanceId,
  type SecretEnv,
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
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import * as Vaults from "../vaults/Vaults.ts";
import {
  type Hub,
  makeHub,
  seedProject,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import {
  createOrganization,
  idleAdapters,
  loadFixture,
  ownerIdOf,
  replayOn,
  startSandbox,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const ACME_TOKEN = "acme-token-value-1111";
const GRACE_TOKEN = "grace-token-value-2222";
const OWNER_TOKEN = "owner-token-value-3333";
const KUBECONFIG_TEXT = "apiVersion: v1\nkind: Config\n";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/** Makes the Project's checkout on the machine, as its first turn would. */
const checkoutOnMachine = Effect.fn(function* (
  hub: Hub,
  environmentId: EnvironmentId,
  projectId: ProjectId,
) {
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const checkout = Option.getOrThrow(
    yield* (yield* registry.get(environmentId)).workspace.paths.checkout(projectId),
  );
  yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
});

/** A machine's adapters that note the secrets each session opened with and take them. */
const recordingSecrets = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  seen: Array<SecretEnv | undefined>,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            receivesSecretEnv: true as const,
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.suspend(() => {
                seen.push(input.secretEnv);
                return adapter.openSession(input);
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

const valueOf = (secretEnv: SecretEnv | undefined, name: string) =>
  secretEnv?.variables?.find((variable) => variable.name === name)?.value;

/** Ada and Grace (Members of Acme) share Acme's Sandbox; Grace has a Vault of her own. */
const sharedSandbox = Effect.fn(function* () {
  const instanceId = "claudeAgent" as ProviderInstanceId;
  const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
  const owner = yield* ownerIdOf(hub);
  const acme = yield* createOrganization(hub, "Acme");
  const globex = yield* createOrganization(hub, "Globex");
  for (const id of ["ada", "grace"]) {
    yield* addMember(hub.server, { id, displayName: id });
    yield* joinOrganization(hub.server, acme, id, "member");
  }
  const ada = UserId.make("ada");
  const grace = UserId.make("grace");
  yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada, grace]);

  const vaults = hub.service(Vaults.Vaults);
  const asOwner = CommandActor.actAs(owner);
  const acmeVault = yield* vaults.create({ name: "Acme", spaceId: acme }).pipe(asOwner);
  yield* vaults
    .putEntry({ vaultId: acmeVault.id, name: "ACME_TOKEN", value: Redacted.make(ACME_TOKEN) })
    .pipe(asOwner);
  yield* vaults.setSpaceDefaults({ spaceId: acme, vaultIds: [acmeVault.id] }).pipe(asOwner);
  const graceVault = yield* vaults.create({ name: "Grace keys", spaceId: null }).pipe(asOwner);
  yield* vaults
    .putEntry({ vaultId: graceVault.id, name: "GRACE_TOKEN", value: Redacted.make(GRACE_TOKEN) })
    .pipe(asOwner);
  yield* vaults
    .allow({ vaultId: graceVault.id, subject: { kind: "user", userId: grace }, allowed: true })
    .pipe(asOwner);

  const project = Effect.fn(function* (id: string, spaceId: SpaceId) {
    const projectId = ProjectId.make(id);
    const { workspaceRoot } = yield* seedProject(hub.server, {
      projectId,
      title: id,
      defaultModelSelection: null,
      spaceId,
    });
    return { projectId, workspaceRoot };
  });
  const thread = Effect.fn(function* (
    id: string,
    projectId: ProjectId,
    spaceId: SpaceId,
    ownerUserId: UserId,
  ) {
    const threadId = ThreadId.make(id);
    yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection: { instanceId, model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      spaceId,
      ownerUserId,
      activeEnvironmentId: sandboxEnvironmentIdOf(spaceId),
    });
    return threadId;
  });
  const acmeWeb = yield* project("project:acme-web", acme);
  const adaThread = yield* thread("thread:ada", acmeWeb.projectId, acme, ada);
  const graceThread = yield* thread("thread:grace", acmeWeb.projectId, acme, grace);
  yield* startSandbox(hub, acme);
  yield* checkoutOnMachine(hub, sandboxEnvironmentIdOf(acme), acmeWeb.projectId);
  return {
    hub,
    owner,
    acme,
    globex,
    ada,
    grace,
    acmeWeb,
    adaThread,
    graceThread,
    graceVault: graceVault.id,
    acmeVault: acmeVault.id,
    project,
    thread,
    vaults,
    asOwner,
    sandbox: yield* hub.sandboxOf(acme),
    workspace: yield* threadWorkspaceOf(hub),
  };
});

/** The environment of the shell the machine started last. */
const lastShell = (machine: TestEnvironment) => {
  const spawn = machine.ptySpawns.at(-1);
  assert.isDefined(spawn);
  return spawn.env;
};

describe("Hub con Environments: a Thread's secrets as environment variables", () => {
  it.live("reach each User's terminals alone, in a Sandbox two Users share", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const cwd = s.acmeWeb.workspaceRoot;

      yield* s.workspace.terminalOpen(
        { threadId: s.adaThread, terminalId: "term-1", cwd },
        { userId: s.ada },
      );
      const adas = lastShell(s.sandbox);
      assert.equal(adas.ACME_TOKEN, ACME_TOKEN);
      assert.isUndefined(adas.GRACE_TOKEN, "Grace's own Vault never reaches Ada's shell");

      yield* s.workspace.terminalOpen(
        { threadId: s.graceThread, terminalId: "term-1", cwd },
        { userId: s.grace },
      );
      const graces = lastShell(s.sandbox);
      assert.equal(graces.ACME_TOKEN, ACME_TOKEN);
      assert.equal(graces.GRACE_TOKEN, GRACE_TOKEN);

      // Ada's shell, started before, never got Grace's value either.
      assert.isTrue(
        s.sandbox.ptySpawns.every(
          (spawn) => spawn.env.GRACE_TOKEN === undefined || spawn === s.sandbox.ptySpawns.at(-1),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("stop reaching the next shell once revoked; an open one says to reopen", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const cwd = s.acmeWeb.workspaceRoot;
      const open = (terminalId: string) =>
        s.workspace.terminalOpen({ threadId: s.graceThread, terminalId, cwd }, { userId: s.grace });
      yield* open("term-1");
      assert.equal(lastShell(s.sandbox).GRACE_TOKEN, GRACE_TOKEN);
      yield* s.vaults
        .allow({
          vaultId: s.graceVault,
          subject: { kind: "user", userId: s.grace },
          allowed: false,
        })
        .pipe(s.asOwner);

      const spawnsBefore = s.sandbox.ptySpawns.length;
      yield* open("term-2");
      assert.equal(s.sandbox.ptySpawns.length, spawnsBefore + 1);
      const next = lastShell(s.sandbox);
      assert.isUndefined(next.GRACE_TOKEN, "a revoked Vault reaches no new shell");
      assert.equal(next.ACME_TOKEN, ACME_TOKEN);

      // The running shell keeps what it started with (the accepted limit) and says so.
      const reopened = yield* open("term-1");
      assert.equal(s.sandbox.ptySpawns.length, spawnsBefore + 1, "no new shell for term-1");
      assert.isTrue(reopened.secretsStale);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a removed User's terminals in a shared Sandbox close, and stay refused (ticket 07)",
    () =>
      Effect.gen(function* () {
        const s = yield* sharedSandbox();
        const cwd = s.acmeWeb.workspaceRoot;
        yield* s.workspace.terminalOpen(
          { threadId: s.graceThread, terminalId: "term-1", cwd },
          { userId: s.grace },
        );
        const graces = s.sandbox.ptySpawns.at(-1);
        assert.isDefined(graces);
        assert.equal(graces.env.GRACE_TOKEN, GRACE_TOKEN);
        // Ada's terminal, in the same Sandbox, stays.
        yield* s.workspace.terminalOpen(
          { threadId: s.adaThread, terminalId: "term-1", cwd },
          { userId: s.ada },
        );
        const adas = s.sandbox.ptySpawns.at(-1);
        assert.isDefined(adas);

        const sentBefore = s.sandbox.requests.length;
        yield* s.hub
          .service(InstallationUserService.InstallationUserService)
          .setStatus({ actorUserId: s.owner, userId: s.grace, status: "removed" });
        // The machine closes the shells started with her set, whoever's Thread they are in.
        yield* s.sandbox.awaitAnswered("terminal.reconcile", sentBefore);
        assert.isNotEmpty(graces.signals, "her shell, with her own Vault's secret, ended");
        assert.isEmpty(adas.signals, "Ada's stays");
      }).pipe(Effect.scoped),
  );

  it.live("stop reaching the Space's next shell once its allowance is taken back (ticket 07)", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const tools = yield* s.vaults.create({ name: "Tools", spaceId: null }).pipe(s.asOwner);
      yield* s.vaults
        .putEntry({ vaultId: tools.id, name: "TOOLS_TOKEN", value: Redacted.make(OWNER_TOKEN) })
        .pipe(s.asOwner);
      yield* s.vaults
        .allow({ vaultId: tools.id, subject: { kind: "space", spaceId: s.acme }, allowed: true })
        .pipe(s.asOwner);
      yield* s.vaults
        .setSpaceDefaults({ spaceId: s.acme, vaultIds: [s.acmeVault, tools.id] })
        .pipe(s.asOwner);
      const open = (terminalId: string) =>
        s.workspace.terminalOpen(
          { threadId: s.adaThread, terminalId, cwd: s.acmeWeb.workspaceRoot },
          { userId: s.ada },
        );
      yield* open("term-1");
      assert.equal(lastShell(s.sandbox).TOOLS_TOKEN, OWNER_TOKEN);

      yield* s.vaults
        .allow({ vaultId: tools.id, subject: { kind: "space", spaceId: s.acme }, allowed: false })
        .pipe(s.asOwner);
      yield* open("term-2");
      assert.isUndefined(
        lastShell(s.sandbox).TOOLS_TOKEN,
        "a taken-back Vault reaches no new shell",
      );
      assert.equal(lastShell(s.sandbox).ACME_TOKEN, ACME_TOKEN);
      assert.isTrue((yield* open("term-1")).secretsStale, "the running shell says to reopen");
      // Allowed again, it is no default until chosen again.
      yield* s.vaults
        .allow({ vaultId: tools.id, subject: { kind: "space", spaceId: s.acme }, allowed: true })
        .pipe(s.asOwner);
      yield* open("term-3");
      assert.isUndefined(lastShell(s.sandbox).TOOLS_TOKEN);
    }).pipe(Effect.scoped),
  );

  it.live("never reach another Space's Sandbox", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const globexApp = yield* s.project("project:globex-app", s.globex);
      const threadId = yield* s.thread("thread:globex", globexApp.projectId, s.globex, s.owner);
      yield* startSandbox(s.hub, s.globex);
      yield* checkoutOnMachine(s.hub, sandboxEnvironmentIdOf(s.globex), globexApp.projectId);
      const globexSandbox = yield* s.hub.sandboxOf(s.globex);
      yield* s.workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd: globexApp.workspaceRoot },
        { userId: s.owner },
      );
      const env = lastShell(globexSandbox);
      assert.isUndefined(env.ACME_TOKEN);
      assert.isUndefined(env.GRACE_TOKEN);
      assert.isEmpty(s.sandbox.ptySpawns, "Acme's Sandbox started no shell for it");
    }).pipe(Effect.scoped),
  );

  it.live("reach the provider session of a turn, as its Thread owner's", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      yield* hub
        .service(Vaults.Vaults)
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name: "OWNER_TOKEN",
          value: Redacted.make(OWNER_TOKEN),
        })
        .pipe(CommandActor.actAs(owner));
      const seen: Array<SecretEnv | undefined> = [];
      const laptop = yield* hub.join({
        name: "Laptop",
        adapters: recordingSecrets(loaded.adapters, seen),
      });
      yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
      assert.isNotEmpty(seen);
      assert.equal(valueOf(seen[0], "OWNER_TOKEN"), OWNER_TOKEN);
    }).pipe(Effect.scoped),
  );

  it.live(
    "refuse the terminals of a machine before executor contract 12, which says to update",
    () =>
      Effect.gen(function* () {
        const instanceId = "claudeAgent" as ProviderInstanceId;
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        // Its shells would report no facts: the Hub could not tell which Space they belong to.
        const old = yield* hub.join({
          name: "Old laptop",
          adapters: idleAdapters(instanceId),
          executorContractVersion: 11,
        });
        const projectId = ProjectId.make("project:old");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Old",
          defaultModelSelection: null,
        });
        const threadId = ThreadId.make("thread:old");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:old"),
          threadId,
          projectId,
          title: "Old",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ownerUserId: owner,
          activeEnvironmentId: old.environmentId,
        });
        yield* checkoutOnMachine(hub, old.environmentId, projectId);
        const workspace = yield* threadWorkspaceOf(hub);
        const opened = yield* Effect.exit(
          workspace.terminalOpen(
            { threadId, terminalId: "term-1", cwd: workspaceRoot },
            {
              userId: owner,
            },
          ),
        );
        assert.isTrue(Exit.isFailure(opened));
        if (Exit.isFailure(opened)) {
          assert.include(
            Cause.pretty(opened.cause),
            "Old laptop needs an update to open this Thread's terminals",
          );
        }
        const attached = yield* Effect.exit(
          workspace
            .terminalAttach({ threadId, terminalId: "term-2", cwd: workspaceRoot }, "viewer-1", {
              userId: owner,
            })
            .pipe(Stream.take(1), Stream.runDrain),
        );
        assert.isTrue(Exit.isFailure(attached));
        if (Exit.isFailure(attached)) {
          assert.include(Cause.pretty(attached.cause), "Old laptop needs an update");
        }
        assert.isEmpty(old.ptySpawns, "no shell started on it");
        assert.isFalse(old.requests.includes("terminal.open"), "nothing was sent");
      }).pipe(Effect.scoped),
  );

  it.live("say a running shell is stale once the User's set became empty", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const open = () =>
        s.workspace.terminalOpen(
          { threadId: s.graceThread, terminalId: "term-1", cwd: s.acmeWeb.workspaceRoot },
          { userId: s.grace },
        );
      yield* open();
      assert.equal(lastShell(s.sandbox).GRACE_TOKEN, GRACE_TOKEN);
      yield* s.vaults.setSpaceDefaults({ spaceId: s.acme, vaultIds: [] }).pipe(s.asOwner);
      yield* s.vaults
        .allow({
          vaultId: s.graceVault,
          subject: { kind: "user", userId: s.grace },
          allowed: false,
        })
        .pipe(s.asOwner);
      const reopened = yield* open();
      assert.isTrue(reopened.secretsStale, "no secrets now: the shell that has some is stale");
      assert.equal(s.sandbox.ptySpawns.length, 1, "it keeps running");
    }).pipe(Effect.scoped),
  );

  it.live("give a turn its Thread owner's secrets, never those of whoever continues it", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      // A Vault of the Owner's, allowed to the Owner alone.
      const ownersOwn = yield* s.vaults
        .create({ name: "Owner keys", spaceId: null })
        .pipe(s.asOwner);
      yield* s.vaults
        .putEntry({ vaultId: ownersOwn.id, name: "OWNER_ONLY", value: Redacted.make(OWNER_TOKEN) })
        .pipe(s.asOwner);
      yield* s.vaults
        .allow({ vaultId: ownersOwn.id, subject: { kind: "user", userId: s.owner }, allowed: true })
        .pipe(s.asOwner);
      const delivery = s.hub.service(SecretDelivery.SecretDelivery);
      const target = {
        environmentId: sandboxEnvironmentIdOf(s.acme),
        contractVersion: 10,
      };
      const graces = yield* delivery.planTurn({ threadId: s.graceThread, target });
      assert.deepEqual(
        graces.variables.map((v) => v.name),
        ["ACME_TOKEN", "GRACE_TOKEN"],
        "Grace's Thread: her set, whoever sends the turn",
      );
      // Nobody else continues it: the Owner and an Admin are refused at the door.
      const directory = s.hub.service(SpaceDirectory.SpaceDirectory);
      const continued = yield* Effect.exit(
        directory.authorizeItem(s.owner, "thread.continue", { kind: "thread", id: s.graceThread }),
      );
      assert.isTrue(Exit.isFailure(continued), "the Owner does not speak in Grace's Thread");
    }).pipe(Effect.scoped),
  );

  it.live("never attach one User's terminal for another (no door lets them)", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      // terminal.attach, open, write and observe are «work» doors: only the Thread's owner passes.
      const visibility = s.hub.service(SpaceVisibility.SpaceVisibility);
      const claim = (userId: UserId) =>
        Effect.flatten(visibility.viewer(userId)).pipe(
          Effect.flatMap((viewer) => visibility.claimWork(viewer, userId, s.graceThread)),
        );
      assert.equal(yield* claim(s.grace), "allowed");
      assert.equal(yield* claim(s.ada), "not-yours");
      assert.equal(yield* claim(s.owner), "not-yours");
    }).pipe(Effect.scoped),
  );

  it.live("refuse, never strip, secrets sent to a machine before contract 10", () =>
    Effect.gen(function* () {
      const instanceId = "claudeAgent" as ProviderInstanceId;
      const hub = yield* makeHub();
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: idleAdapters(instanceId),
        executorContractVersion: 9,
      });
      const projectId = ProjectId.make("project:old-guard");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Old",
        defaultModelSelection: null,
      });
      yield* checkoutOnMachine(hub, old.environmentId, projectId);
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const forward = Option.getOrThrow((yield* registry.get(old.environmentId)).workspace.forward);
      const checkout = Option.getOrThrow(
        yield* (yield* registry.get(old.environmentId)).workspace.paths.checkout(projectId),
      );
      void workspaceRoot;
      const sent = yield* Effect.exit(
        forward.call("terminal.open", {
          root: checkout,
          input: { threadId: "thread:old-guard", terminalId: "term-1", cwd: checkout },
          secretEnv: {
            fingerprint: "set-1",
            variables: [{ name: "OWNER_TOKEN", value: OWNER_TOKEN }],
          },
        }),
      );
      assert.isTrue(Exit.isFailure(sent));
      if (Exit.isFailure(sent)) assert.include(Cause.pretty(sent.cause), "needs an update");
      assert.isEmpty(old.ptySpawns, "no shell started without its secrets");
      assert.isFalse(old.requests.includes("terminal.open"), "nothing was sent");
    }).pipe(Effect.scoped),
  );

  it.live("refuse, never strip, Secret files sent to a machine before contract 16", () =>
    Effect.gen(function* () {
      const instanceId = "claudeAgent" as ProviderInstanceId;
      const hub = yield* makeHub();
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: idleAdapters(instanceId),
        // The contract just before files (remote assets'): refused like any older one.
        executorContractVersion: 15,
      });
      const projectId = ProjectId.make("project:old-files");
      yield* seedProject(hub.server, { projectId, title: "Old", defaultModelSelection: null });
      yield* checkoutOnMachine(hub, old.environmentId, projectId);
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const forward = Option.getOrThrow((yield* registry.get(old.environmentId)).workspace.forward);
      const checkout = Option.getOrThrow(
        yield* (yield* registry.get(old.environmentId)).workspace.paths.checkout(projectId),
      );
      // Past the plan's own refusal: the last guard sends nothing, and no variable instead.
      const sent = yield* Effect.exit(
        forward.call("terminal.open", {
          root: checkout,
          input: { threadId: "thread:old-files", terminalId: "term-1", cwd: checkout },
          secretEnv: {
            fingerprint: "set-1",
            variables: [],
            files: [{ name: "KUBECONFIG", content: KUBECONFIG_TEXT, mode: 0o600 }],
            filesFolder: "0123456789abcdef0123456789abcdef",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(sent));
      if (Exit.isFailure(sent)) {
        assert.include(
          Cause.pretty(sent.cause),
          "Old laptop needs an update to receive this Thread's secret files",
        );
      }
      assert.isEmpty(old.ptySpawns, "no shell started without its files");
      assert.isFalse(old.requests.includes("terminal.open"), "nothing was sent");
    }).pipe(Effect.scoped),
  );

  it.live(
    "write a shell's Secret files in memory on its machine, with their paths, gone when it ends",
    () =>
      Effect.gen(function* () {
        const instanceId = "claudeAgent" as ProviderInstanceId;
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const base = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.mkdtempSync("/dev/shm/t3-files-e2e-")),
          (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: idleAdapters(instanceId),
          secretFilesRoot: { path: base, inMemory: true },
        });
        const vaults = hub.service(Vaults.Vaults);
        const asOwner = CommandActor.actAs(owner);
        yield* vaults
          .putEntry({
            vaultId: MAIN_VAULT_ID,
            name: "KUBE_TOKEN",
            value: Redacted.make(OWNER_TOKEN),
            delivery: "file",
          })
          .pipe(asOwner);
        yield* vaults
          .putEntry({
            vaultId: MAIN_VAULT_ID,
            name: "KUBECONFIG",
            template: { text: "users: [{ user: { tokenFile: {{ KUBE_TOKEN | path }} } }]\n" },
            delivery: "file",
          })
          .pipe(asOwner);
        const projectId = ProjectId.make("project:files");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "Files",
          defaultModelSelection: null,
        });
        const threadId = ThreadId.make("thread:files");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:files"),
          threadId,
          projectId,
          title: "Files",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ownerUserId: owner,
          activeEnvironmentId: laptop.environmentId,
        });
        yield* checkoutOnMachine(hub, laptop.environmentId, projectId);
        const workspace = yield* threadWorkspaceOf(hub);
        yield* workspace.terminalOpen(
          { threadId, terminalId: "term-1", cwd: workspaceRoot },
          { userId: owner },
        );
        const shell = lastShell(laptop);
        const kubeconfig = shell.KUBECONFIG ?? "";
        const token = shell.KUBE_TOKEN ?? "";
        const folder = NodePath.dirname(kubeconfig);
        // Paths in the environment, in memory under the machine's root; never a value there.
        assert.equal(NodePath.dirname(folder), base);
        assert.equal(NodePath.dirname(token), folder);
        assert.notInclude(Object.values(shell).join("\n"), OWNER_TOKEN);
        assert.equal(NodeFS.statSync(folder).mode & 0o777, 0o700);
        assert.equal(NodeFS.statSync(kubeconfig).mode & 0o777, 0o600);
        assert.equal(NodeFS.readFileSync(token, "utf8"), OWNER_TOKEN);
        assert.equal(
          NodeFS.readFileSync(kubeconfig, "utf8"),
          `users: [{ user: { tokenFile: ${token} } }]\n`,
        );
        // The shell ends: its folder goes with it (no other process of the Thread holds it).
        yield* workspace.terminalClose({ threadId, terminalId: "term-1" }, { userId: owner });
        assert.isFalse(NodeFS.existsSync(folder));
      }).pipe(Effect.scoped),
  );
});
