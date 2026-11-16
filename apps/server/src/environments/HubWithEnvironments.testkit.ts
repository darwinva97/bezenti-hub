/**
 * «Hub con Environments»: a real Hub (HTTP and the Environment socket on a loopback port, an
 * in-memory database, the production orchestration) and real joined Environments that connect to
 * it over the protocol. Each Environment runs its own executor over a replay provider adapter and
 * temporary git repositories, and can drop its socket and reconnect. The seam of spec 2's tests.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  type SecretFilesRoot,
  type EnvironmentCloseReason,
  EnvironmentId,
  EventId,
  type EnvironmentHeartbeatFrame,
  type EnvironmentHelloFrame,
  type EnvironmentWelcomeFrame,
  type ModelSelection,
  OrchestrationV2ProviderCapabilities,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SpaceId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import type * as HttpRouter from "effect/http/HttpRouter";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ServerHttp from "../http.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ServerConfig from "../config.ts";
import type { PreviewOriginPattern } from "../preview/PreviewOrigin.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import { scratchRootOf } from "../environment/ScratchWorkspace.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubPreviews from "../preview/HubPreviews.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as JoinedWorkspaceRoots from "../workspace/JoinedWorkspaceRoots.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProcessSandboxRuntime from "../sandboxes/ProcessSandboxRuntime.ts";
import type * as SandboxImage from "../sandboxes/SandboxImage.ts";
import * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import {
  ENVIRONMENT_CREDENTIAL_SECRET,
  type JoinedHubState,
  readJoinedHubState,
} from "./joinedHubState.ts";
import * as DedicatedHost from "./DedicatedHost.ts";
import * as JoinedHub from "./JoinedHub.ts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type { Authenticator, HubServices, Server } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentAgent from "./EnvironmentAgent.ts";
import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGateway from "../ai/AiGateway.ts";
import * as AiGatewayActivity from "../ai/AiGatewayActivity.ts";
import * as AiUsage from "../ai/AiUsage.ts";
import * as AiGatewayKeyRevocation from "../ai/AiGatewayKeyRevocation.ts";
import * as AiGatewayKeys from "../ai/AiGatewayKeys.ts";
import * as AiGatewayProxy from "../ai/AiGatewayProxy.ts";
import * as AiAccountChoice from "../ai/AiAccountChoice.ts";
import * as AiGatewaySessions from "../ai/AiGatewaySessions.ts";
import { fakeCliproxyRelease, fakeReleases, pinsOf } from "../ai/AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "../ai/cliproxyRelease.ts";
import { CliproxyReleases } from "../ai/CliproxyReleases.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { joinMachine, hubWithOwner } from "./environments.testkit.ts";
import { connectOnce } from "./JoinedHub.ts";
import type * as SshInstall from "./sshInstall/SshInstall.ts";

const HOST_RESOURCES = {
  sampledAt: 0,
  cpuUtilization: 0.1,
  cpuCount: 8,
  availableMemoryBytes: 8_000_000_000,
  totalMemoryBytes: 16_000_000_000,
};

// Providers run on the Environments: the Hub machine has none of its own.
const layerNoProviders = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Effect.never as never,
  subscribeChanges: Effect.never,
} as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);

/** A shell a machine's terminal started: its folder and the environment it got. */
export interface PtySpawn {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  /** The signals the shell got: a close ends it. */
  readonly signals: Array<string>;
  /** Whether it was closed as stale: the machine ended what its session started. */
  sessionEnded: boolean;
}

/**
 * A shell that answers each line typed with the folder it started in, as `pwd` would, so a test
 * sees which machine and folder a terminal runs in without a real shell. Each start is recorded,
 * with the signals that end it. `echo $NAME` prints the variable from its environment; `split $NAME`
 * prints it in two writes, cut in the middle, as a value split between two frames would arrive.
 */
const echoingPty = (spawns: Array<PtySpawn>): PtyAdapter.PtyAdapter["Service"] => ({
  spawn: (input) =>
    Effect.sync(() => {
      const spawn: PtySpawn = {
        cwd: input.cwd,
        env: { ...input.env },
        pid: 4242 + spawns.length,
        signals: [],
        sessionEnded: false,
      };
      spawns.push(spawn);
      const listeners = new Set<(data: string) => void>();
      const emit = (text: string) => {
        for (const listener of listeners) listener(text);
      };
      return {
        pid: spawn.pid,
        write: (data: string) => {
          const variable = /^(echo|split) \$([A-Z_][A-Z0-9_]*)/.exec(data);
          if (variable === null) return emit(`${input.cwd}\r\n`);
          const value = input.env[variable[2]!] ?? "";
          if (variable[1] === "echo") return emit(`${value}\r\n`);
          const half = Math.floor(value.length / 2);
          emit(`out: ${value.slice(0, half)}`);
          // A later write of the PTY, as a real shell's second half would arrive.
          // @effect-diagnostics-next-line globalTimers:off
          setTimeout(() => emit(`${value.slice(half)}\r\n`), 20);
        },
        resize: () => undefined,
        kill: (signal?: string) => {
          spawn.signals.push(signal ?? "SIGHUP");
        },
        onData: (callback: (data: string) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        onExit: () => () => undefined,
      } satisfies PtyAdapter.PtyProcess;
    }),
});

/**
 * The workspace services a joined machine answers files, search and terminals with. As in joined
 * mode, it knows only the workspace roots of the calls its Hub is running.
 */
const layerMachineWorkspace = (spawns: Array<PtySpawn>) =>
  Layer.mergeAll(
    WorkspaceFileSystem.layer.pipe(Layer.provide(KnownWorkspaces.layerJoined)),
    Layer.effect(
      TerminalManager.TerminalManager,
      Effect.flatMap(ServerConfig.ServerConfig, (config) =>
        TerminalManager.makeWithOptions({
          logsDir: config.terminalLogsDir,
          ptyAdapter: echoingPty(spawns),
          processKillGraceMs: 1,
          endSessionProcesses: (sessionId) =>
            Effect.sync(() => {
              const spawn = spawns.find((candidate) => candidate.pid === sessionId);
              if (spawn !== undefined) spawn.sessionEnded = true;
            }),
          subprocessPollIntervalMs: 60_000,
        }),
      ),
    ).pipe(Layer.provide(ProcessRunner.layer)),
    PreviewManager.layer,
    Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  ).pipe(
    Layer.provideMerge(WorkspaceEntries.layer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(JoinedWorkspaceRoots.layer),
  );

const layerCheckpoints = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
);

/** The production orchestration over the Hub's own database and Environments. */
const layerHubOrchestration = CheckpointDiffQuery.layer.pipe(
  // Diffs read checkpoints as the server reads them, through the same executors.
  Layer.provide(RuntimeLayer.layerCheckpointStoreProvided),
  Layer.provideMerge(RuntimeLayer.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(layerCheckpoints),
  Layer.provide(layerNoProviders),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.die("worktrees are not made in these tests"),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused title link"),
    }),
  ),
  Layer.provideMerge(HubRepository.layer),
  Layer.provideMerge(VcsProcess.layer),
);

/** A machine's own text generation, when a test gives it one (none otherwise). */
const layerTextGeneration = (textGeneration: ProviderTextGeneration | undefined) =>
  textGeneration === undefined
    ? Layer.empty
    : Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of(textGeneration),
      );

/**
 * Spec 4 ticket 06: the Hub's AI accounts and gateway over the fake CLIProxyAPI (its files in
 * `memory`), below the orchestration as the server has them.
 */
const withAiAccounts = (memory: string) => (services: Context.Context<HubServices>) =>
  Effect.gen(function* () {
    const os = HostProcess.Platform.defaultValue();
    const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
    if (platform === undefined) return yield* Effect.die("no CLIProxyAPI platform here");
    const release = fakeCliproxyRelease(memory, "1.0.0");
    const stateDir = `${memory}/state`;
    yield* (yield* FileSystem.FileSystem).makeDirectory(stateDir, { recursive: true, mode: 0o700 });
    const gateway = yield* AiGateway.make({
      placement: { _tag: "forced", enabled: true },
      os,
      stateDir,
      platform,
      pinned: pinsOf([release]),
      runtimeFolder: { directory: `${memory}/memory`, inMemory: true },
      restartDelay: { initialMs: 100, maxMs: 200 },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ServerSecretStore.ServerSecretStore,
            Context.get(
              services as unknown as Context.Context<ServerSecretStore.ServerSecretStore>,
              ServerSecretStore.ServerSecretStore,
            ),
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
    yield* gateway.changes.pipe(
      Stream.filter((status) => status.state === "running"),
      Stream.runHead,
    );
    const ai = yield* Layer.build(
      AiAccountChoice.layer.pipe(
        Layer.provideMerge(AiGatewaySessions.layer),
        Layer.provideMerge(AiGatewayProxy.layer),
        Layer.provideMerge(AiGatewayKeys.layer),
        Layer.provideMerge(AiUsage.layer),
        Layer.provideMerge(AiGatewayActivity.layer),
        Layer.provideMerge(AiAccounts.layer),
        Layer.provideMerge(AuditLog.layer),
        Layer.provideMerge(Layer.succeed(AiGateway.AiGateway, gateway)),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(Layer.succeedContext(services)),
      ),
    );
    return Context.merge(services, ai) as unknown as Context.Context<HubServices>;
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const withOrchestration =
  (textGeneration: ProviderTextGeneration | undefined, reconnectWait: Duration.Input | undefined) =>
  (services: Context.Context<HubServices>) =>
    Effect.gen(function* () {
      const orchestration = yield* Layer.build(
        layerHubOrchestration.pipe(
          Layer.provide(Layer.succeedContext(services)),
          Layer.provide(layerTextGeneration(textGeneration)),
          Layer.provide(
            reconnectWait === undefined
              ? Layer.empty
              : Layer.succeed(RemoteEnvironments.ReconnectWait, reconnectWait),
          ),
        ),
      );
      const withRuntime = Context.merge(services, orchestration);
      // Previews through the Hub, as the server serves them (`/preview/<token>/`), and asset URLs
      // of a Thread's files (`/api/assets/...`) read from its Active environment (ticket 15).
      const merged = Context.merge(
        withRuntime,
        yield* Layer.build(
          Layer.mergeAll(
            // A live socket's access is checked again often, so tests see it close quickly.
            HubPreviews.layerWith({ recheckEvery: "200 millis" }),
            AssetSigner.layer,
            WorkspacePaths.layer,
            ThreadWorkspace.layer.pipe(
              Layer.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
            ),
          ).pipe(Layer.provide(Layer.succeedContext(withRuntime))),
        ),
      );
      // The effect worker runs as the server runs it, so effects settle without a test draining them.
      yield* EffectWorker.runDaemon.pipe(Effect.provideContext(merged), Effect.forkScoped);
      // With AI accounts: gateway keys revoked as their sessions and Threads end, as on the Hub.
      if (Context.getOption(merged, AiGatewayKeys.AiGatewayKeys)._tag === "Some") {
        // The AI services were merged in by `withAiAccounts`, which the context's type omits.
        yield* Layer.build(
          AiGatewayKeyRevocation.layer.pipe(Layer.provide(Layer.succeedContext(merged))),
        ) as unknown as Effect.Effect<unknown, never, Scope.Scope>;
      }
      return merged as unknown as Context.Context<HubServices>;
    }).pipe(Effect.orDie);

export interface TestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  /** Its Environment credential, as `t3 join` stored it. */
  readonly credential: string;
  /**
   * The per-Thread MCP configs the Hub sent for this machine's agents. Recorded, not handed to the
   * replay adapters, whose transcripts were recorded without T3's MCP server.
   */
  readonly mcpConfigs: ReadonlyArray<McpProviderSessionConfig>;
  /** Where this machine keeps Project checkouts (`<T3 home>/projects`). */
  readonly workspaceRoot: string;
  /** Every shell its terminals started, in order, with the environment each got. */
  readonly ptySpawns: ReadonlyArray<PtySpawn>;
  /** The method of each request the Hub sent this machine, in order. */
  readonly requests: ReadonlyArray<string>;
  /** Resolves once the Hub sent `method`, counting from request number `from`. */
  readonly awaitRequest: (method: string, from: number) => Effect.Effect<void>;
  /**
   * Resolves once the machine answered a `method` request, counting from request number `from`:
   * the work behind it (its git, its files) is done.
   */
  readonly awaitAnswered: (method: string, from: number) => Effect.Effect<void>;
  /** Opens a socket to the Hub; succeeds once the Hub welcomed it. */
  readonly connect: Effect.Effect<void>;
  /** Drops the socket. The machine keeps running: its sessions and unacknowledged events stay. */
  readonly disconnect: Effect.Effect<void>;
  /**
   * The machine's server process dies and starts again, offline: its provider sessions and
   * unacknowledged events are gone, its files stay. `connect` brings it back.
   */
  readonly restart: Effect.Effect<void>;
}

const decodeResponseFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("response"), requestId: Schema.String }),
  ),
);

/** A joined Environment's half: its executor and agent over the given provider adapters. */
const startEnvironment = Effect.fn("HubWithEnvironments.startEnvironment")(function* (input: {
  readonly hubUrl: string;
  readonly credential: string;
  readonly environmentId: EnvironmentId;
  readonly hubEnvironmentId: EnvironmentId;
  readonly name: string;
  readonly adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >;
  readonly connect: boolean;
  readonly textGeneration?: ProviderTextGeneration;
  /** Its T3 home; a fresh temporary one by default. */
  readonly baseDir?: string;
  /** It runs in a Sandbox, and its hello says so. */
  readonly sandbox?: { readonly runtime: "podman" | "process" };
  /** Runs after each welcome, as a server checks the mode the Hub names. */
  readonly onWelcome?: (welcome: EnvironmentWelcomeFrame) => Effect.Effect<void>;
  /** Runs when the Hub refuses a connection before any welcome, with why. */
  readonly onRefused?: (reason: EnvironmentCloseReason | undefined) => Effect.Effect<void>;
  /** The executor contract its hello names; the current one by default. */
  readonly executorContractVersion?: number;
  /** Its Secret files' root (a tmpfs folder); without one it takes none (contract 14). */
  readonly secretFilesRoot?: SecretFilesRoot;
}) {
  const scope = yield* Effect.scope;
  const ptySpawns: Array<PtySpawn> = [];
  const mcpConfigs: Array<McpProviderSessionConfig> = [];
  const requests: Array<string> = [];
  const requested = yield* PubSub.unbounded<string>();
  // Which request each id was, and which requests the machine has answered, by number.
  const requestNumbers = new Map<string, number>();
  const answered = new Set<number>();
  const answers = yield* PubSub.unbounded<number>();
  const isAnswered = (method: string, from: number) =>
    [...answered].some((number) => number >= from && requests[number] === method);
  const awaitAnswered = (method: string, from: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(answers);
        while (!isAnswered(method, from)) {
          yield* PubSub.take(subscription);
        }
      }),
    );
  /** The machine's frame on its way to the Hub: a response marks its request answered. */
  const noteAnswer = (text: string) =>
    decodeResponseFrame(text).pipe(
      Effect.flatMap((frame) => {
        const number = requestNumbers.get(frame.requestId);
        if (number === undefined) return Effect.void;
        answered.add(number);
        return PubSub.publish(answers, number).pipe(Effect.asVoid);
      }),
      // Not a response: nothing to note.
      Effect.ignore,
    );
  const awaitRequest = (method: string, from: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(requested);
        if (requests.slice(from).includes(method)) return;
        while ((yield* PubSub.take(subscription)) !== method) {
          // Another request: keep waiting for `method`.
        }
      }),
    );
  const layerRecordingMcp = Layer.effect(
    McpProviderSessions.McpProviderSessions,
    Effect.map(McpProviderSessions.McpProviderSessions, (sessions) => ({
      ...sessions,
      set: (config: McpProviderSessionConfig) => Effect.sync(() => void mcpConfigs.push(config)),
    })),
  ).pipe(Layer.provide(McpProviderSessions.layer));
  const layerMachine = Layer.mergeAll(EnvironmentExecutor.layerHubMachine, layerRecordingMcp).pipe(
    Layer.provide(
      Layer.mergeAll(
        input.adapters,
        RuntimePolicy.layer,
        layerCheckpoints,
        layerNoProviders,
        ProjectStore.layer,
        layerMachineWorkspace(ptySpawns),
        layerTextGeneration(input.textGeneration),
      ),
    ),
    Layer.provideMerge(layerRecordingMcp),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      input.secretFilesRoot === undefined
        ? Layer.empty
        : ThreadSecretFiles.layerAt(input.secretFilesRoot),
    ),
    // A joined machine runs agents: that is its job, whatever its Hub does.
    Layer.provideMerge(Layer.succeed(HubRunsAgents.HubRunsAgents, true)),
    // The agent shares the workspace services' roots (memoized: one instance per machine).
    Layer.provideMerge(JoinedWorkspaceRoots.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        input.baseDir ?? { prefix: `t3-environment-${input.name.replace(/\W/gu, "-")}-` },
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const machine = yield* Layer.build(layerMachine).pipe(Effect.orDie);
  // The agent and its provider processes live in their own scope, so a test can kill them
  // (`restart`) while the machine's files, checkouts and config stay.
  const startAgent = Effect.gen(function* () {
    const processScope = yield* Scope.fork(scope);
    const started = yield* EnvironmentAgent.make({
      environmentId: input.environmentId,
      hubUrl: input.hubUrl,
      credential: input.credential,
    }).pipe(Effect.provideContext(machine), Effect.provideService(Scope.Scope, processScope));
    return { agent: started, processScope };
  });
  let running = yield* startAgent;
  const report = Effect.suspend(() => running.agent.report);
  const hello: Effect.Effect<EnvironmentHelloFrame> = Effect.map(report, (described) => ({
    type: "hello",
    protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
    os: "linux",
    hostname: input.name,
    providers: described.orchestration.providers.map((provider) => ({
      instanceId: provider.instanceId,
      provider: provider.provider,
      displayName: null,
      enabled: provider.enabled,
      installed: true,
      version: "1.0.0",
      capabilities: { runtimeModes: [], conversationRollback: true, textGeneration: false },
    })),
    hostResources: HOST_RESOURCES,
    disk: null,
    sessions: described.sessions,
    workspaceRoot: described.workspaceRoot,
    orchestration: described.orchestration,
    executorContractVersion: input.executorContractVersion ?? ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
    secretFilesRoot: input.secretFilesRoot ?? null,
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
  }));
  const heartbeat: Effect.Effect<EnvironmentHeartbeatFrame> = Effect.map(report, (described) => ({
    type: "heartbeat",
    hostResources: HOST_RESOURCES,
    disk: null,
    orchestration: described.orchestration,
  }));

  let connection: Fiber.Fiber<unknown> | undefined;
  const connect = Effect.gen(function* () {
    const welcomed = yield* Deferred.make<void>();
    connection = yield* connectOnce({
      hubUrl: input.hubUrl,
      credential: input.credential,
      expectedHubId: input.hubEnvironmentId,
      hello,
      heartbeat,
      onWelcome: (welcome) =>
        Deferred.succeed(welcomed, undefined).pipe(
          Effect.andThen(input.onWelcome?.(welcome) ?? Effect.void),
        ),
      serve: (write) =>
        Effect.map(
          running.agent.attach((text) => write(text).pipe(Effect.andThen(noteAnswer(text)))),
          (served) => ({
            receive: (frame: unknown) => {
              const request = frame as {
                readonly type?: unknown;
                readonly method?: unknown;
                readonly requestId?: unknown;
              };
              if (request.type === "request" && typeof request.method === "string") {
                if (typeof request.requestId === "string") {
                  requestNumbers.set(request.requestId, requests.length);
                }
                requests.push(request.method);
                return PubSub.publish(requested, request.method).pipe(
                  Effect.andThen(served.receive(frame)),
                );
              }
              return served.receive(frame);
            },
          }),
        ),
    }).pipe(
      // Refused before a welcome: `connect` returns, and the server learns why (it may end, and
      // this connection with it).
      Effect.tap((outcome) =>
        outcome.welcomed
          ? Effect.void
          : Deferred.succeed(welcomed, undefined).pipe(
              Effect.andThen(input.onRefused?.(outcome.reason) ?? Effect.void),
            ),
      ),
      Effect.ensuring(Deferred.succeed(welcomed, undefined)),
      Effect.forkIn(scope),
    );
    yield* Deferred.await(welcomed);
  });
  const disconnect = Effect.suspend(() => {
    const current = connection;
    connection = undefined;
    return current === undefined ? Effect.void : Fiber.interrupt(current);
  });
  const restart = disconnect.pipe(
    Effect.andThen(Effect.suspend(() => Scope.close(running.processScope, Exit.void))),
    Effect.andThen(startAgent),
    Effect.flatMap((started) =>
      Effect.sync(() => {
        running = started;
      }),
    ),
  );
  if (input.connect) yield* connect;
  return {
    environmentId: input.environmentId,
    name: input.name,
    credential: input.credential,
    mcpConfigs,
    workspaceRoot: (yield* report).workspaceRoot,
    ptySpawns,
    requests,
    awaitRequest,
    awaitAnswered,
    connect,
    disconnect,
    restart,
  } satisfies TestEnvironment;
});

/**
 * The process Sandbox runtime as the testkit runs it: the Hub makes each Sandbox's home with its
 * credential and Hub as for a child process, and its server is a testkit Environment started from
 * that home, over `adapters`, instead of a `t3 serve` child.
 */
/** What a dedicated machine's Sandbox server started with: its home, its Hub, its credential. */
export interface SandboxLaunchRecord {
  readonly homePath: string;
  readonly joined: JoinedHubState;
  readonly credential: string;
  /** Every welcome its server got, in order. */
  readonly welcomes: Array<EnvironmentWelcomeFrame>;
}

/** A Sandbox runtime over the testkit's Sandboxes root, reaching the Hub at its address. */
export type SandboxRuntimeOverRoot = (
  rootDir: string,
) => Layer.Layer<
  SandboxRuntime.SandboxRuntime,
  never,
  SandboxRuntime.SandboxHubAddress | ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
>;

/** Sees a start of a Sandbox's server, with its options, before it runs. */
export type SandboxStartObserver = (
  sandboxId: string,
  options: SandboxRuntime.SandboxStartOptions,
) => Effect.Effect<void>;

const makeSandboxRuntime = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  /** A real launcher instead, such as `t3 serve` children. */
  realLauncher: ProcessSandboxRuntime.SandboxLauncher | undefined,
  rootDir: string,
  /**
   * Runs before each start of a testkit server: it may hold the start (to see it `starting`), or
   * answer an exit code, as a server that ends before it connects.
   */
  beforeLaunch: ((sandboxId: string) => Effect.Effect<Option.Option<number>>) | undefined,
  /** Runs before each stop of a Sandbox's server: it may hold the stop half-way, or fail it. */
  beforeStop:
    | ((sandboxId: string) => Effect.Effect<void, SandboxRuntime.SandboxRuntimeError>)
    | undefined,
  /** Another runtime instead, such as Podman's, over the same root and Hub address. */
  otherRuntime: SandboxRuntimeOverRoot | undefined,
  /** Sees each start the Hub asks for, with what it starts with (its limits). */
  onStart: SandboxStartObserver | undefined,
  /** Runs before each `inspect` of a Sandbox, as before each measurement of its home. */
  beforeInspect: ((sandboxId: string) => Effect.Effect<void>) | undefined,
  /** The base image version each start runs, read at each start, as a runtime with images. */
  imageVersion: (() => string | null) | undefined,
  /** Runs before each measurement of a Sandbox's home: it may hold it, as a slow `du`. */
  beforeMeasure: ((sandboxId: string) => Effect.Effect<void>) | undefined,
) => {
  let hubUrl = "";
  const started = new Map<string, TestEnvironment>();
  const exits = new Map<string, Deferred.Deferred<number | null>>();
  const testkitLauncher: ProcessSandboxRuntime.SandboxLauncher = (launch) =>
    Effect.gen(function* () {
      const exitAtOnce =
        beforeLaunch === undefined ? Option.none<number>() : yield* beforeLaunch(launch.sandboxId);
      if (Option.isSome(exitAtOnce)) {
        return { pid: null, exited: Effect.succeed<number | null>(exitAtOnce.value) };
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* ServerConfig.deriveServerPaths(launch.homePath, undefined, {
        baseDirIsExplicit: true,
      });
      const joined = yield* readJoinedHubState(paths.joinedHubPath).pipe(Effect.orDie);
      if (Option.isNone(joined)) return yield* Effect.die("the Sandbox's home has no Hub");
      const credential = yield* fs
        .readFileString(path.join(paths.secretsDir, `${ENVIRONMENT_CREDENTIAL_SECRET}.bin`))
        .pipe(Effect.orDie);
      const environment = yield* startEnvironment({
        hubUrl: joined.value.hubUrl,
        credential,
        environmentId: joined.value.environmentId,
        hubEnvironmentId: joined.value.hubEnvironmentId,
        name: joined.value.name,
        adapters,
        connect: true,
        baseDir: launch.homePath,
        sandbox: { runtime: "process" },
      });
      started.set(launch.sandboxId, environment);
      const exited = yield* Deferred.make<number | null>();
      exits.set(launch.sandboxId, exited);
      return { pid: null, exited: Deferred.await(exited) };
    }).pipe(Effect.provide(NodeServices.layer));
  const processRuntime = (
    otherRuntime?.(rootDir) ??
    ProcessSandboxRuntime.layer({
      launcher: realLauncher ?? testkitLauncher,
      rootDir,
    })
  ).pipe(
    Layer.provide(
      Layer.succeed(
        SandboxRuntime.SandboxHubAddress,
        SandboxRuntime.SandboxHubAddress.of({ loopbackUrl: Effect.sync(() => hubUrl) }),
      ),
    ),
  );
  const runtime =
    beforeStop === undefined &&
    onStart === undefined &&
    beforeInspect === undefined &&
    imageVersion === undefined &&
    beforeMeasure === undefined
      ? processRuntime
      : Layer.effect(
          SandboxRuntime.SandboxRuntime,
          Effect.map(SandboxRuntime.SandboxRuntime, (inner) =>
            SandboxRuntime.SandboxRuntime.of({
              ...inner,
              start: (sandboxId, startOptions) =>
                (onStart?.(sandboxId, startOptions ?? {}) ?? Effect.void).pipe(
                  Effect.andThen(inner.start(sandboxId, startOptions)),
                  Effect.map((started) =>
                    imageVersion === undefined
                      ? started
                      : { ...started, imageVersion: imageVersion() },
                  ),
                ),
              ...(imageVersion === undefined ? {} : { imageVersion: Effect.sync(imageVersion) }),
              stop: (sandboxId) =>
                (beforeStop?.(sandboxId) ?? Effect.void).pipe(
                  Effect.andThen(inner.stop(sandboxId)),
                ),
              inspect: (sandboxId) =>
                (beforeInspect?.(sandboxId) ?? Effect.void).pipe(
                  Effect.andThen(inner.inspect(sandboxId)),
                ),
              measureHome: (sandboxId) =>
                (beforeMeasure?.(sandboxId) ?? Effect.void).pipe(
                  Effect.andThen(inner.measureHome(sandboxId)),
                ),
            }),
          ),
        ).pipe(Layer.provide(processRuntime));
  return {
    runtime,
    setHubUrl: (url: string) => {
      hubUrl = url;
    },
    /** The server the runtime last started for the Space's Sandbox. */
    environmentOf: (spaceId: SpaceId) =>
      Effect.fromNullishOr(started.get(SandboxRuntime.sandboxIdOf(spaceId))).pipe(Effect.orDie),
    /** Its server dies with `exitCode`, as a crashed or killed container: nothing stopped it. */
    crash: (spaceId: SpaceId, exitCode = 137) =>
      Effect.suspend(() => {
        const exited = exits.get(SandboxRuntime.sandboxIdOf(spaceId));
        return exited === undefined
          ? Effect.die("the Sandbox's server never started")
          : Deferred.succeed(exited, exitCode).pipe(Effect.asVoid);
      }),
  };
};

/** A Hub with its Owner signed in, running the orchestration, listening on loopback. */
export const makeHub = Effect.fn("HubWithEnvironments.makeHub")(function* (
  options: {
    /** The Hub machine's own text generation; none by default, as it runs no providers. */
    readonly textGeneration?: ProviderTextGeneration;
    /** What each Sandbox's server runs its providers with; none by default. */
    readonly sandboxAdapters?: Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >;
    /** Runs each Sandbox's server with this launcher instead of in the test's process. */
    readonly sandboxLauncher?: ProcessSandboxRuntime.SandboxLauncher;
    /**
     * Before each testkit Sandbox server starts: hold it, or answer an exit code for a server
     * that ends before connecting.
     */
    readonly beforeSandboxLaunch?: (sandboxId: string) => Effect.Effect<Option.Option<number>>;
    /** Before each stop of a Sandbox's server: hold it half-way, or fail it as a runtime would. */
    readonly beforeSandboxStop?: (
      sandboxId: string,
    ) => Effect.Effect<void, SandboxRuntime.SandboxRuntimeError>;
    /** Sees each start the Hub asks of the runtime, with the limits it passes. */
    readonly onSandboxStart?: SandboxStartObserver;
    /** Before each `inspect` of a Sandbox by the Hub (each measurement of its home among them). */
    readonly beforeSandboxInspect?: (sandboxId: string) => Effect.Effect<void>;
    /** Before each measurement of a Sandbox's home: hold it, as a slow `du`. */
    readonly beforeSandboxMeasure?: (sandboxId: string) => Effect.Effect<void>;
    /** The idle timeout, the start timeout and the clock (a TestClock the test advances). */
    readonly sandboxLifecycle?: Sandboxes.SandboxLifecyclePolicy["Service"];
    /** Runs Sandboxes with this runtime instead of the process one. */
    readonly sandboxRuntime?: SandboxRuntimeOverRoot;
    /** The base image version the testkit's Sandboxes start with, read at each start. */
    readonly sandboxImageVersion?: () => string | null;
    /** Builds and reads the Sandbox image instead of Podman. */
    readonly sandboxImageBuilder?: SandboxImage.SandboxImageBuilder["Service"];
    /** False: no Sandbox runtime, as a production Hub without Podman. */
    readonly sandboxes?: boolean;
    /**
     * Whether the Hub machine runs Threads (`T3CODE_HUB_RUNS_AGENTS`). On by default, as the
     * tests written before Sandboxes expect; off as a production Hub.
     */
    readonly hubRunsAgents?: boolean;
    /** Why there are no Sandboxes, as the Hub says it (with `sandboxes: false`). */
    readonly sandboxesUnavailable?: string;
    /** Previews on their own origin (`T3CODE_PREVIEW_ORIGIN`). */
    readonly previewOrigin?: PreviewOriginPattern;
    /** The Hub's published address (`T3CODE_PUBLIC_URL`). */
    readonly publicUrl?: URL;
    /** How the Owner's SSH installs run (timeouts, the T3 they install). */
    readonly sshInstallPolicy?: SshInstall.SshInstallPolicy["Service"];
    /** How long the Hub's calls wait for a dropped machine to return (30 s by default). */
    readonly reconnectWait?: Duration.Input;
    /** The Hub's AI accounts and gateway, over the fake CLIProxyAPI (spec 4). */
    readonly aiAccounts?: boolean;
  } = {},
) {
  const sandboxRoot = yield* FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-sandboxes-" })),
    Effect.provide(NodeServices.layer),
    Effect.orDie,
  );
  const aiGatewayDir =
    options.aiAccounts === true
      ? yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-ai-gateway-" })),
          Effect.provide(NodeServices.layer),
          Effect.orDie,
        )
      : undefined;
  const sandboxes = makeSandboxRuntime(
    options.sandboxAdapters ?? ProviderAdapterRegistry.layerFromAdapters([]),
    options.sandboxLauncher,
    sandboxRoot,
    options.beforeSandboxLaunch,
    options.beforeSandboxStop,
    options.sandboxRuntime,
    options.onSandboxStart,
    options.beforeSandboxInspect,
    options.sandboxImageVersion,
    options.beforeSandboxMeasure,
  );
  // The lifecycle policy goes in with the runtime, to the Sandboxes that read it.
  const sandboxRuntime =
    options.sandboxLifecycle === undefined
      ? sandboxes.runtime
      : Layer.merge(
          sandboxes.runtime,
          Layer.succeed(Sandboxes.SandboxLifecyclePolicy, options.sandboxLifecycle),
        );
  const { server, authenticator, owner } = yield* hubWithOwner({
    listen: true,
    ...(options.previewOrigin === undefined ? {} : { previewOrigin: options.previewOrigin }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    extend: (services) =>
      (aiGatewayDir === undefined
        ? Effect.succeed(services)
        : withAiAccounts(aiGatewayDir)(services)
      ).pipe(Effect.flatMap(withOrchestration(options.textGeneration, options.reconnectWait))),
    ...(options.sandboxes === false ? {} : { sandboxRuntime }),
    registry: {
      ...(options.hubRunsAgents === undefined ? {} : { hubRunsAgents: options.hubRunsAgents }),
      ...(options.sandboxesUnavailable === undefined
        ? {}
        : { sandboxesUnavailable: options.sandboxesUnavailable }),
    },
    ...(options.sandboxImageBuilder === undefined
      ? {}
      : { sandboxImageBuilder: options.sandboxImageBuilder }),
    ...(options.sshInstallPolicy === undefined
      ? {}
      : { sshInstallPolicy: options.sshInstallPolicy }),
    // Asset URLs as the server serves them: a Thread's files from its Active environment.
    moreRoutes: () =>
      ServerHttp.layerAssetRoute as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>,
  });
  sandboxes.setHubUrl(server.url);
  /**
   * Joins a machine (`t3 join`, approved with a passkey) and connects it: the Owner's, or that of
   * the User signed in as `as`, who needs `environments.registerOwn`.
   */
  const join = Effect.fn("HubWithEnvironments.join")(function* (input: {
    readonly as?: { readonly cookie: string; readonly authenticator: Authenticator };
    readonly name: string;
    readonly adapters: Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >;
    /** Off: the machine joined but never connected, so the Hub sees it offline. */
    readonly connect?: boolean;
    /** The machine's own text generation (with its providers); none by default. */
    readonly textGeneration?: ProviderTextGeneration;
    /** The executor contract the machine runs; the current one by default. */
    readonly executorContractVersion?: number;
    /** Where it writes Secret files (a tmpfs folder); none by default. */
    readonly secretFilesRoot?: SecretFilesRoot;
  }) {
    const joined = yield* joinMachine(
      server,
      input.as?.authenticator ?? authenticator,
      input.as?.cookie ?? owner,
      input.name,
    );
    return yield* startEnvironment({
      hubUrl: server.url,
      credential: joined.credential,
      environmentId: EnvironmentId.make(joined.environmentId),
      hubEnvironmentId: EnvironmentId.make(joined.hubEnvironmentId),
      name: input.name,
      adapters: input.adapters,
      connect: input.connect ?? true,
      ...(input.textGeneration === undefined ? {} : { textGeneration: input.textGeneration }),
      ...(input.executorContractVersion === undefined
        ? {}
        : { executorContractVersion: input.executorContractVersion }),
      ...(input.secretFilesRoot === undefined ? {} : { secretFilesRoot: input.secretFilesRoot }),
    });
  });
  /**
   * `t3 join --dedicated`, approved by the Owner for `spaceId`, and the machine's joined server as
   * a dedicated machine runs it (`DedicatedHost`): no work of its own, one Sandbox through the
   * process runtime whose server, over the machine's credential, is the Environment the Hub sees.
   */
  const joinDedicated = Effect.fn("HubWithEnvironments.joinDedicated")(function* (input: {
    readonly name: string;
    readonly spaceId: SpaceId;
    readonly adapters: Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >;
    /** The machine runs its Sandbox with this runtime instead, such as Podman's. */
    readonly runtime?: SandboxRuntimeOverRoot;
  }) {
    const joined = yield* joinMachine(server, authenticator, owner, input.name, input.spaceId);
    const rootDir = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-dedicated-" })),
      Effect.provide(NodeServices.layer),
      Effect.orDie,
    );
    const started = yield* Deferred.make<TestEnvironment>();
    const launches: Array<SandboxLaunchRecord> = [];
    const environments: Array<TestEnvironment> = [];
    const launched = yield* Queue.unbounded<TestEnvironment>();
    const persisted: Array<JoinedHubState> = [];
    const turnedPersonal = yield* Deferred.make<JoinedHubState>();
    const launcher: ProcessSandboxRuntime.SandboxLauncher = (launch) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const paths = yield* ServerConfig.deriveServerPaths(launch.homePath, undefined, {
          baseDirIsExplicit: true,
        });
        const home = yield* readJoinedHubState(paths.joinedHubPath).pipe(Effect.orDie);
        if (Option.isNone(home)) return yield* Effect.die("the dedicated Sandbox has no Hub");
        const credential = yield* fs
          .readFileString(path.join(paths.secretsDir, `${ENVIRONMENT_CREDENTIAL_SECRET}.bin`))
          .pipe(Effect.orDie);
        const welcomes: Array<EnvironmentWelcomeFrame> = [];
        launches.push({ homePath: launch.homePath, joined: home.value, credential, welcomes });
        const exited = yield* Deferred.make<number | null>();
        const exitChanged = Deferred.succeed(exited, JoinedHub.SANDBOX_MODE_CHANGED_EXIT).pipe(
          Effect.asVoid,
        );
        const environment = yield* startEnvironment({
          hubUrl: home.value.hubUrl,
          credential,
          environmentId: home.value.environmentId,
          hubEnvironmentId: home.value.hubEnvironmentId,
          name: home.value.name,
          adapters: input.adapters,
          connect: true,
          baseDir: launch.homePath,
          sandbox: { runtime: "process" },
          // As the real server does: welcomed for another Space, or as personal, or its
          // credential refused, it exits.
          onWelcome: (welcome) =>
            Effect.sync(() => void welcomes.push(welcome)).pipe(
              Effect.andThen(
                JoinedHub.sandboxedServerRefuses(home.value, welcome) ? exitChanged : Effect.void,
              ),
            ),
          onRefused: (reason) =>
            reason !== undefined && JoinedHub.SANDBOX_CREDENTIAL_ENDED.has(reason)
              ? exitChanged
              : Effect.void,
        });
        environments.push(environment);
        yield* Queue.offer(launched, environment);
        yield* Deferred.succeed(started, environment);
        return { pid: null, exited: Deferred.await(exited) };
      }).pipe(Effect.provide(NodeServices.layer));
    const hubConfig = Context.get(
      server.services as unknown as Context.Context<ServerConfig.ServerConfig>,
      ServerConfig.ServerConfig,
    );
    const runtime = yield* Layer.build(
      (input.runtime?.(rootDir) ?? ProcessSandboxRuntime.layer({ launcher, rootDir })).pipe(
        Layer.provide(
          Layer.succeed(
            SandboxRuntime.SandboxHubAddress,
            SandboxRuntime.SandboxHubAddress.of({ loopbackUrl: Effect.succeed(server.url) }),
          ),
        ),
        Layer.provide(Layer.succeed(ServerConfig.ServerConfig, hubConfig)),
        Layer.provide(NodeServices.layer),
      ),
    );
    const hostState = yield* Ref.make<JoinedHub.JoinedConnectionState>({
      _tag: "connecting",
      attempt: 0,
      lastError: null,
    });
    yield* DedicatedHost.superviseDedicatedSandbox({
      joined: {
        hubUrl: server.url,
        hubEnvironmentId: EnvironmentId.make(joined.hubEnvironmentId),
        environmentId: EnvironmentId.make(joined.environmentId),
        name: joined.name,
        joinedAt: "2026-01-01T00:00:00.000Z",
        mode: "dedicated",
        spaceId: input.spaceId,
      },
      state: hostState,
      askHub: DedicatedHost.askHubAt(server.url, joined.credential),
      homesOnDisk: DedicatedHost.dedicatedHomesIn(rootDir).pipe(Effect.provide(NodeServices.layer)),
      persist: (next) => Effect.sync(() => void persisted.push(next)),
      becomePersonal: (personal) => Deferred.succeed(turnedPersonal, personal).pipe(Effect.asVoid),
    }).pipe(Effect.provide(runtime), Effect.forkScoped);
    // The testkit's own server is known once it started; another runtime's is only seen online.
    const environment = input.runtime === undefined ? yield* Deferred.await(started) : undefined;
    return {
      environmentId: EnvironmentId.make(joined.environmentId),
      credential: joined.credential,
      environment,
      /** Every server its Sandboxes started, the latest last. */
      environments,
      /** The next server its Sandboxes start, in order: the first one first. */
      nextLaunch: Queue.take(launched),
      launches,
      rootDir,
      /** The joined states it wrote, as the Hub answered. */
      persisted,
      /** Completes once the Hub made the machine personal and its server serves as one. */
      turnedPersonal: Deferred.await(turnedPersonal),
      hostState: Ref.get(hostState),
    };
  });
  return {
    server,
    authenticator,
    owner,
    join,
    joinDedicated,
    service: serviceOf(server),
    /** The running server of the Space's Sandbox, once the Hub started it. */
    sandboxOf: sandboxes.environmentOf,
    /** The Space's Sandbox server dies by itself (a crash, or a killed container). */
    crashSandbox: sandboxes.crash,
    /** Where the Sandboxes' homes are. */
    sandboxRoot,
    /** The fake CLIProxyAPI's folder (its request log), with `aiAccounts`. */
    aiGatewayDir,
  };
});

/** A Hub service, as the routes and orchestration share it. */
const serviceOf =
  (server: Server) =>
  <I, S>(tag: Context.Key<I, S>): S =>
    Context.get(server.services as unknown as Context.Context<I>, tag);

/**
 * A Project on the Hub whose workspace is a fresh git repository with one commit, published as
 * its own `origin` so an Environment that lacks it clones it.
 */
export const seedProject = Effect.fn("HubWithEnvironments.seedProject")(function* (
  server: Server,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly defaultModelSelection: ModelSelection | null;
    /** Its Space; none is a Project from before Spaces, in the Owner's Personal space. */
    readonly spaceId?: SpaceId;
    /**
     * The Hub's scratch Project instead, where Threads without a Project live: its workspace root
     * is the Hub's scratch folder, with no repository of its own.
     */
    readonly scratch?: boolean;
    /** The Project is this folder of the repository ("packages/web"), not its top. */
    readonly subfolder?: string;
    /** An existing folder (of another Project's repository, say) instead of a new repository. */
    readonly workspaceRoot?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let workspaceRoot: string;
  if (input.workspaceRoot !== undefined) {
    workspaceRoot = input.workspaceRoot;
  } else if (input.scratch === true) {
    const config = Context.get(
      server.services as unknown as Context.Context<ServerConfig.ServerConfig>,
      ServerConfig.ServerConfig,
    );
    workspaceRoot = scratchRootOf(path, config.baseDir);
    yield* fs.makeDirectory(workspaceRoot, { recursive: true }).pipe(Effect.orDie);
  } else {
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-project-" });
    workspaceRoot = root;
    const git = (...args: ReadonlyArray<string>) =>
      Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
        vcs.run({ operation: "HubWithEnvironments.git", command: "git", args, cwd: root }),
      ).pipe(Effect.provide(VcsProcess.layer), Effect.orDie);
    yield* git("init", "--initial-branch=main");
    yield* git("config", "user.email", "hub@example.com");
    yield* git("config", "user.name", "Hub");
    yield* fs.writeFileString(path.join(root, "README.md"), "# Remote project\n");
    if (input.subfolder !== undefined) {
      yield* fs.makeDirectory(path.join(root, input.subfolder), { recursive: true });
      yield* fs.writeFileString(path.join(root, input.subfolder, "README.md"), "# Subfolder\n");
    }
    yield* git("add", ".");
    yield* git("commit", "-m", "Initial commit");
    yield* git("remote", "add", "origin", root);
    if (input.subfolder !== undefined) workspaceRoot = path.join(root, input.subfolder);
  }
  const projects = Context.get(
    server.services as unknown as Context.Context<ProjectStore.ProjectStoreV2>,
    ProjectStore.ProjectStoreV2,
  );
  const now = "1970-01-01T00:00:00.000Z";
  yield* projects
    .apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    .pipe(Effect.orDie);
  return { workspaceRoot };
}, Effect.provide(NodeServices.layer));

export type Hub = Effect.Success<ReturnType<typeof makeHub>>;

const encodeCapabilities = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2ProviderCapabilities),
);

/**
 * A machine that speaks the protocol by hand, attached to the Hub's side of it in process: tests
 * see each frame the Hub sends and choose each one it receives. It answers `provider.detach` and
 * `preview.events`.
 */
export const connectProtocolEnvironment = Effect.fn("HubWithEnvironments.connectProtocol")(
  function* (
    hub: Hub,
    input: {
      readonly environmentId: EnvironmentId;
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly capabilities: OrchestrationV2ProviderCapabilities;
      /** The sessions the machine says it still runs. */
      readonly sessions?: EnvironmentHelloFrame["sessions"];
      /** The executor contract it says it runs; none: the oldest one. */
      readonly executorContractVersion?: number;
    },
  ) {
    const remote = hub.service(RemoteEnvironments.RemoteEnvironments);
    // Registered as the Owner's machine, as `t3 join` would: the Hub runs nothing on one it
    // does not know.
    yield* hub.server.sql`
      INSERT OR IGNORE INTO environments (
        environment_id, name, kind, mode, owner_user_id, credential_hash, credential_issued_at,
        registered_at
      ) SELECT ${input.environmentId}, 'Protocol', 'external', 'personal', user_id,
        ${`hash-${input.environmentId}`}, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
      FROM users WHERE is_owner = 1
    `.pipe(Effect.orDie);
    const frames = yield* Queue.unbounded<Record<string, unknown>>();
    let receive: (frame: unknown) => Effect.Effect<boolean> = () => Effect.succeed(false);
    let previewSubscription: string | undefined;
    // Its own scope, so a test can drop the socket while the test goes on.
    const socket = yield* Scope.fork(yield* Effect.scope);
    const connection = yield* remote
      .connect({
        environmentId: input.environmentId,
        hello: {
          type: "hello",
          protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
          os: "linux",
          hostname: "protocol",
          ...(input.executorContractVersion === undefined
            ? {}
            : { executorContractVersion: input.executorContractVersion }),
          providers: [
            {
              instanceId: input.instanceId,
              provider: input.driver,
              displayName: null,
              enabled: true,
              installed: true,
              version: "1.0.0",
              capabilities: { runtimeModes: [], conversationRollback: true, textGeneration: false },
            },
          ],
          hostResources: HOST_RESOURCES,
          disk: null,
          sessions: input.sessions ?? [],
          workspaceRoot: "/remote/projects",
          orchestration: {
            providers: [
              {
                instanceId: input.instanceId,
                provider: input.driver,
                enabled: true,
                continuationKey: `${input.driver}:instance:${input.instanceId}`,
                capabilities: input.capabilities,
              },
            ],
            unavailableProviders: [],
          },
        },
        write: (text) => {
          const frame = JSON.parse(text) as Record<string, unknown>;
          if (frame.type === "request" && frame.method === "preview.events") {
            previewSubscription = (frame.payload as { subscriptionId: string }).subscriptionId;
          }
          // It answers detaching sessions and opening its (empty) preview event stream.
          if (
            frame.type === "request" &&
            (frame.method === "provider.detach" || frame.method === "preview.events")
          ) {
            return receive({
              type: "response",
              requestId: frame.requestId,
              result: { _tag: "success", value: null },
            }).pipe(Effect.forkDetach, Effect.asVoid);
          }
          return Queue.offer(frames, frame).pipe(Effect.asVoid);
        },
      })
      .pipe(Effect.provideService(Scope.Scope, socket));
    receive = connection.receive;
    return {
      connection,
      /** The socket drops; the Hub's side of it closes. */
      disconnect: Scope.close(socket, Exit.void),
      /** The next frame the Hub sent, other than `provider.detach`. */
      nextFrame: Queue.take(frames),
      /** Streams a preview event as this machine's own, whatever Thread it names. */
      sendPreviewEvent: (event: Record<string, unknown>) =>
        Effect.suspend(() =>
          receive({
            type: "event",
            method: "workspace.stream",
            payload: { subscriptionId: previewSubscription, item: event },
          }),
        ),
      providerSession: (providerSessionId: string, cwd: string) => ({
        id: providerSessionId,
        driver: input.driver,
        providerInstanceId: input.instanceId,
        status: "ready",
        cwd,
        model: null,
        capabilities: encodeCapabilities(input.capabilities),
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        lastError: null,
      }),
    };
  },
);
