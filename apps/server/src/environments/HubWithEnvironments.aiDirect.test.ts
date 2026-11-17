/**
 * Providers without a base URL (spec 4 ticket 07): a Hub turn of Cursor, Antigravity and the like
 * gets its Thread's direct AI account credential as one variable of its own process (never a
 * terminal's, never another Space's), masked in the Thread's history as `[NAME]`.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests make checkouts on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  CommandId,
  type EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  ProviderSessionId,
  type SecretEnv,
  type SpaceId,
  ThreadId,
  UserId,
  sandboxEnvironmentIdOf,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { maskDeep } from "@t3tools/shared/secretMasking";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as AiAccounts from "../ai/AiAccounts.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "../vaults/EffectiveVaults.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import {
  type Hub,
  makeHub,
  seedProject,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import {
  createOrganization,
  loadFixture,
  ownerIdOf,
  replayOn,
  startSandbox,
} from "./HubWithEnvironments.scenarios.testkit.ts";
import { databaseText, threadWorkspaceOf } from "./HubWithEnvironments.secretMasking.testkit.ts";
import { lendAccount } from "./HubWithEnvironments.aiAccounts.testkit.ts";

const CURSOR = ProviderDriverKind.make("cursor");
const instanceId = "cursor" as ProviderInstanceId;
const ACME_CURSOR_KEY = "crsr-acme-direct-key-0123456789abcdef";
const OWNER_CURSOR_KEY = "crsr-owner-direct-key-0123456789abcdef";

type AdapterLayer = Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  McpProviderSessions.McpProviderSessions
>;

/** A machine's adapters as Cursor's: they take a direct `CURSOR_API_KEY` (and nothing else). */
const asCursor = (
  adapters: AdapterLayer,
  seen: Array<SecretEnv | undefined>,
  options: { readonly fail?: boolean; readonly print?: boolean } = {},
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (id: ProviderInstanceId) =>
        registry.get(id).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            driver: CURSOR,
            acceptsAiCredential: ["CURSOR_API_KEY"],
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.gen(function* () {
                seen.push(input.secretEnv);
                if (options.fail === true) {
                  return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CURSOR,
                    providerSessionId: input.providerSessionId,
                    cause: "the fake agent ends here",
                  });
                }
                const key = input.secretEnv?.variables?.find(
                  (variable) => variable.name === "CURSOR_API_KEY",
                )?.value;
                const { secretEnv: _secrets, ...recorded } = input;
                const runtime = yield* adapter.openSession(recorded);
                // The agent prints the key it got: its reply carries it.
                return options.print !== true || key === undefined
                  ? runtime
                  : {
                      ...runtime,
                      events: runtime.events.pipe(
                        Stream.map((event) =>
                          maskDeep(event, (text) =>
                            text.replaceAll("fixture simple ok", `my key is ${key}, ok`),
                          ),
                        ),
                      ),
                    };
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** A machine with only a Cursor instance, which runs no turn. */
const cursorOnly = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId,
    driver: CURSOR,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

/** A direct AI account of the Owner's, lent to Spaces and Users (as migration 145 did). */
const addDirectAccount = Effect.fn(function* (
  hub: Hub,
  input: {
    readonly name: string;
    readonly key: string;
    readonly provider?: "cursor" | "gemini";
    readonly spaceIds?: ReadonlyArray<SpaceId>;
    readonly userIds?: ReadonlyArray<UserId>;
  },
) {
  const owner = yield* ownerIdOf(hub);
  const accounts = hub.service(AiAccounts.AiAccounts);
  const made = yield* accounts
    .create({
      name: input.name,
      type: "direct",
      provider: input.provider ?? "cursor",
      apiKey: Redacted.make(input.key),
    })
    .pipe(CommandActor.actAs(owner), Effect.orDie);
  yield* lendAccount(hub, made.id, {
    spaceIds: input.spaceIds ?? [],
    userIds: input.userIds ?? [],
  });
  return made;
});

/** A Cursor Thread of `ownerUserId` in `spaceId` on `environmentId`, its checkout made there. */
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
  const { workspaceRoot } = yield* seedProject(hub.server, {
    projectId,
    title: input.id,
    defaultModelSelection: null,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
  });
  const threadId = ThreadId.make(`thread:${input.id}`);
  const modelSelection = {
    instanceId,
    model: "composer-2",
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
  return { threadId, modelSelection, checkout, workspaceRoot };
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

const valueOf = (secretEnv: SecretEnv | undefined, name: string) =>
  secretEnv?.variables?.find((variable) => variable.name === name)?.value;

/** Ada (Acme) and Gil (Globex), each with a Cursor Thread on their Space's Sandbox. */
const twoSpaces = Effect.fn(function* (seen: Array<SecretEnv | undefined>) {
  const hub = yield* makeHub({
    aiAccounts: true,
    sandboxAdapters: asCursor(cursorOnly, seen, { fail: true }),
  });
  const acme = yield* createOrganization(hub, "Acme");
  const globex = yield* createOrganization(hub, "Globex");
  yield* addMember(hub.server, { id: "ada", displayName: "Ada" });
  yield* joinOrganization(hub.server, acme, "ada", "member");
  yield* addMember(hub.server, { id: "gil", displayName: "Gil" });
  yield* joinOrganization(hub.server, globex, "gil", "member");
  const ada = UserId.make("ada");
  const gil = UserId.make("gil");
  yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada, gil]);
  const account = yield* addDirectAccount(hub, {
    name: "Acme Cursor",
    key: ACME_CURSOR_KEY,
    spaceIds: [acme],
  });
  yield* startSandbox(hub, acme);
  yield* startSandbox(hub, globex);
  return { hub, acme, globex, ada, gil, account };
});

/** The environment of the shell the machine started last. */
const lastShell = (machine: TestEnvironment) => {
  const spawn = machine.ptySpawns.at(-1);
  assert.isDefined(spawn);
  return spawn.env;
};

describe("Hub con Environments: providers without a base URL use a direct AI account", () => {
  it.live("give Acme's Cursor turn Acme's direct key alone, and never a Globex turn", () =>
    Effect.gen(function* () {
      const seen: Array<SecretEnv | undefined> = [];
      const s = yield* twoSpaces(seen);

      const adaThread = yield* threadOn(s.hub, {
        id: "ada",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandboxEnvironmentIdOf(s.acme),
      });
      yield* Effect.exit(openSession(s.hub, adaThread, "session:ada"));
      const adas = seen.at(-1);
      assert.equal(valueOf(adas, "CURSOR_API_KEY"), ACME_CURSOR_KEY);
      assert.equal(adas?.aiCredential, "CURSOR_API_KEY", "its process drops ambient AI keys");

      // Gil's Thread in Globex: no account is allowed there, so no session, and no key.
      const before = seen.length;
      const gilThread = yield* threadOn(s.hub, {
        id: "gil",
        spaceId: s.globex,
        ownerUserId: s.gil,
        environmentId: sandboxEnvironmentIdOf(s.globex),
      });
      const refused = yield* Effect.exit(openSession(s.hub, gilThread, "session:gil"));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(failureText(refused), "No AI account is allowed to you in this Space");
      assert.equal(seen.length, before, "no process of Globex's started");

      // Naming Acme's account from Globex is refused too, never another in its place.
      const named = yield* threadOn(s.hub, {
        id: "gil-named",
        spaceId: s.globex,
        ownerUserId: s.gil,
        environmentId: sandboxEnvironmentIdOf(s.globex),
        aiAccountId: s.account.id,
      });
      const refusedNamed = yield* Effect.exit(openSession(s.hub, named, "session:gil-named"));
      assert.include(failureText(refusedNamed), "no longer allowed to you here");
      assert.equal(seen.length, before, "Acme's key never reached a process of Globex's");
    }).pipe(Effect.scoped),
  );

  it.live("mask the key in the Thread's history masker the moment its process starts", () =>
    Effect.gen(function* () {
      const seen: Array<SecretEnv | undefined> = [];
      const s = yield* twoSpaces(seen);
      const adaThread = yield* threadOn(s.hub, {
        id: "ada",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandboxEnvironmentIdOf(s.acme),
      });
      // The history's masker has this Thread loaded (cached) before the session opens.
      const masker = s.hub.service(SecretMasker.SecretMasker);
      assert.equal(
        (yield* masker.forThread(adaThread.threadId)).mask(`k ${ACME_CURSOR_KEY}`),
        `k ${ACME_CURSOR_KEY}`,
      );
      yield* Effect.exit(openSession(s.hub, adaThread, "session:ada"));
      assert.equal(valueOf(seen.at(-1), "CURSOR_API_KEY"), ACME_CURSOR_KEY);
      // Right after: the same masker (one instance, shared with the sessions' rule) hides it.
      assert.equal(
        (yield* masker.forThread(adaThread.threadId)).mask(`k ${ACME_CURSOR_KEY}`),
        "k [CURSOR_API_KEY]",
      );
    }).pipe(Effect.scoped),
  );

  it.live("never put the direct key in a terminal of the same Thread", () =>
    Effect.gen(function* () {
      const seen: Array<SecretEnv | undefined> = [];
      const s = yield* twoSpaces(seen);
      const adaThread = yield* threadOn(s.hub, {
        id: "ada",
        spaceId: s.acme,
        ownerUserId: s.ada,
        environmentId: sandboxEnvironmentIdOf(s.acme),
      });
      yield* Effect.exit(openSession(s.hub, adaThread, "session:ada"));
      assert.equal(valueOf(seen.at(-1), "CURSOR_API_KEY"), ACME_CURSOR_KEY);

      const workspace = yield* threadWorkspaceOf(s.hub);
      yield* workspace.terminalOpen(
        { threadId: adaThread.threadId, terminalId: "term-1", cwd: adaThread.workspaceRoot },
        { userId: s.ada },
      );
      const shell = lastShell(yield* s.hub.sandboxOf(s.acme));
      assert.notInclude(Object.values(shell).join("\n"), ACME_CURSOR_KEY);
      assert.isUndefined(shell.CURSOR_API_KEY);
    }).pipe(Effect.scoped),
  );

  it.live("refuse a machine before contract 13, which would keep its own logins", () =>
    Effect.gen(function* () {
      const seen: Array<SecretEnv | undefined> = [];
      const hub = yield* makeHub({ aiAccounts: true });
      const owner = yield* ownerIdOf(hub);
      yield* addDirectAccount(hub, {
        name: "Owner Cursor",
        key: OWNER_CURSOR_KEY,
        userIds: [owner],
      });
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: asCursor(cursorOnly, seen, { fail: true }),
        executorContractVersion: 12,
      });
      const thread = yield* threadOn(hub, {
        id: "old",
        ownerUserId: owner,
        environmentId: old.environmentId,
      });
      const exit = yield* Effect.exit(openSession(hub, thread, "session:old"));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        failureText(exit),
        "Old laptop needs an update to use the Hub's AI accounts",
        failureText(exit),
      );
      assert.isEmpty(seen, "nothing was sent to it");
    }).pipe(Effect.scoped),
  );

  it.live(
    "mask the key the agent printed as [CURSOR_API_KEY], listed as the Thread's credential",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        yield* addDirectAccount(hub, {
          name: "Owner Cursor",
          key: OWNER_CURSOR_KEY,
          userIds: [owner],
        });
        const seen: Array<SecretEnv | undefined> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: asCursor(loaded.adapters, seen, { print: true }),
        });
        yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        assert.equal(valueOf(seen[0], "CURSOR_API_KEY"), OWNER_CURSOR_KEY);

        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId as ThreadId);
        const reply = JSON.stringify(projection);
        assert.include(reply, "my key is [CURSOR_API_KEY], ok");
        assert.notInclude(reply, OWNER_CURSOR_KEY);
        assert.notInclude(yield* databaseText(hub), OWNER_CURSOR_KEY);

        // The Thread's «Secrets» panel names it, never shows it.
        const listed = yield* hub
          .service(EffectiveVaults.EffectiveVaults)
          .threadEnvironment({ threadId: threadId as ThreadId })
          .pipe(CommandActor.actAs(owner));
        assert.deepEqual(listed.aiCredential, {
          name: "CURSOR_API_KEY",
          aiAccountName: "Owner Cursor",
        });
        assert.notInclude(JSON.stringify(listed), OWNER_CURSOR_KEY);
      }).pipe(Effect.scoped),
  );
});
