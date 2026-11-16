/**
 * One executor per Environment holds everything the Hub needs a machine for. The Hub machine's is
 * in process. The orchestration's adapter registry, runtime policy and capability reads resolve the
 * Thread's Environment on each call (`docs/internals/overview.md`, «Environment executors»).
 */
import {
  AiGatewaySessionError,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentExecutorUnavailableError,
  VcsUnsupportedOperationError,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  HUB_RUNS_NO_AGENTS_MESSAGE,
  ProviderInstanceId,
  type EnvironmentExecutorSnapshot,
  type EnvironmentExecutorTransport,
  type EnvironmentProviderCapabilitySnapshot,
  type EnvironmentUnavailableProvider,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ModelSelection,
  type TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { openSessionWithSecrets } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as HubRunsAgents from "./HubRunsAgents.ts";
import * as ServerConfig from "../config.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { prepareGatewaySession } from "../environments/AiGatewayRelay.ts";
import { sandboxHubLoopbackUrl } from "../sandboxes/ProcessSandboxRuntime.ts";
import { SandboxHubAddress } from "../sandboxes/SandboxRuntime.ts";
import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import * as MovedWorkspace from "./MovedWorkspace.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import type * as RemoteExecutorWire from "./RemoteExecutorWire.ts";
import * as ScratchWorkspace from "./ScratchWorkspace.ts";
import { locateInCheckout } from "./WorkspaceLocation.ts";

export { EnvironmentExecutorUnavailableError } from "@t3tools/contracts";

/** How often the in-process executor republishes its snapshot, like a remote heartbeat. */
export const HUB_MACHINE_HEARTBEAT_INTERVAL = Duration.seconds(10);

export class EnvironmentCapabilitiesUnavailableError extends Schema.TaggedError<EnvironmentCapabilitiesUnavailableError>()(
  "EnvironmentCapabilitiesUnavailableError",
  {
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === undefined
      ? `Environment ${this.environmentId} has not reported provider ${this.instanceId}.`
      : `Provider ${this.instanceId} is unavailable on Environment ${this.environmentId}: ${this.reason}`;
  }
}

export type EnvironmentCapabilityReadError =
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2Error
  | ProviderAdapter.ProviderAdapterV2Error
  | EnvironmentCapabilitiesUnavailableError
  | EnvironmentExecutorUnavailableError;

/** The machine-side services behind the workspace RPCs (files, search, browse, terminals, previews). */
export interface EnvironmentWorkspaceRpc {
  readonly entries: WorkspaceEntries.WorkspaceEntries["Service"];
  readonly files: WorkspaceFileSystem.WorkspaceFileSystem["Service"];
  readonly terminals: TerminalManager.TerminalManager["Service"];
  readonly previews: PreviewManager.PreviewManager["Service"];
  readonly ports: PortScanner.PortDiscovery["Service"];
}

/** The checkout's side of the Hub's repository of a Project (`HubRepository.ts`). */
export interface EnvironmentHubRepository {
  readonly push: (
    input: HubRepository.CheckoutTransferInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
  readonly fetch: (
    input: HubRepository.CheckoutTransferInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
  /**
   * Gives a Thread without a Project's folder its own git repository when it has none (one made
   * before folders got one), so it gets checkpoints and can move.
   */
  readonly ensureScratch: (folder: string) => Effect.Effect<void, CheckpointStoreError>;
}

/** The machine's half of moving a Thread to it (`MovedWorkspace.ts`). */
export interface EnvironmentMoveWorkspace {
  /**
   * The source's half for a Thread without a Project: its folder's branches and HEAD as refs
   * under `prefix`, to push, and the repositories nested in it, which do not move.
   */
  readonly publishScratch: (
    input: MovedWorkspace.MovePublishScratchInput,
  ) => Effect.Effect<MovedWorkspace.MovePublishScratchResult, CheckpointStoreError>;
  /** Downloads what the Thread continues from into the Project's checkout, made if missing. */
  readonly fetch: (
    input: MovedWorkspace.MoveFetchInput,
  ) => Effect.Effect<MovedWorkspace.MoveFetchResult, CheckpointStoreError>;
  /** Makes the Thread's branch or worktree, lays the checkpoint over it, runs the setup script. */
  readonly prepare: (
    input: MovedWorkspace.MovePrepareInput,
  ) => Effect.Effect<MovedWorkspace.MovePrepareResult, CheckpointStoreError>;
  /**
   * Back with a Thread that moved away: keeps what its workspace holds that was never uploaded
   * under a recovered ref, uploaded to the Hub. Nothing in the workspace changes.
   */
  readonly recover: (
    input: MovedWorkspace.MoveRecoverInput,
  ) => Effect.Effect<MovedWorkspace.MoveRecoverResult, CheckpointStoreError>;
}

/**
 * Workspace calls carried to a joined Environment, with paths already resolved onto it. A call
 * never waits for a dropped socket: the machine being offline fails it at once, so nothing a User
 * types or saves is kept to run later.
 */
export interface EnvironmentWorkspaceForward {
  /** The executor contract the machine last said it runs. */
  readonly contractVersion: () => number;
  readonly call: <O extends RemoteExecutorWire.RemoteOperation>(
    operation: O,
    input: RemoteExecutorWire.RemoteInput<O>,
  ) => Effect.Effect<
    RemoteExecutorWire.RemoteOutput<O>,
    RemoteExecutorWire.RemoteError<O> | EnvironmentExecutorUnavailableError
  >;
  /** Live only: a dropped socket ends it with `EnvironmentExecutorUnavailableError`. */
  readonly stream: <O extends RemoteExecutorWire.RemoteStreamOperation>(
    operation: O,
    input: Omit<RemoteExecutorWire.RemoteInput<O>, "subscriptionId">,
    /** The Thread it serves: it ends once the Thread no longer runs on this machine. */
    options?: { readonly threadId?: ThreadId },
  ) => Stream.Stream<
    RemoteExecutorWire.RemoteStreamItem<O>,
    RemoteExecutorWire.RemoteError<O> | EnvironmentExecutorUnavailableError
  >;
}

/** The machine's own text generation, with its provider instances and settings. */
export interface EnvironmentTextGeneration {
  /**
   * A moved Thread's handoff summary: one model call. Interrupting it stops the generation on the
   * machine (a joined one is told with `textGeneration.cancel` under `generationId`).
   */
  readonly threadHandoff: (
    input: TextGeneration.ThreadHandoffGenerationInput & { readonly generationId?: string },
  ) => Effect.Effect<
    TextGeneration.ThreadHandoffGenerationResult,
    TextGenerationError | EnvironmentExecutorUnavailableError
  >;
  /** A Thread's title, in the Thread's workspace on this machine (attachments stay on the Hub). */
  readonly threadTitle: (input: {
    readonly cwd: string;
    readonly message: string;
    readonly previousTitle?: string;
    readonly forkSource?: { readonly title: string; readonly history: string };
    readonly instructions?: string;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<
    { readonly title: string },
    TextGenerationError | EnvironmentExecutorUnavailableError
  >;
}

export interface EnvironmentExecutor {
  readonly environmentId: EnvironmentId;
  readonly transport: EnvironmentExecutorTransport;
  readonly provider: {
    /** One `ProviderAdapterV2` per provider instance; a session runtime carries turns and events. */
    readonly adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape;
    /** In process: the live adapter. Remote: the last snapshot, so deciding makes no network call. */
    readonly capabilities: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>;
  };
  readonly workspace: {
    /** Project checkouts on this machine, and logical workspace paths resolved against them. */
    readonly paths: ProjectCheckouts.EnvironmentWorkspacePaths;
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
    readonly hubRepository: EnvironmentHubRepository;
    readonly move: EnvironmentMoveWorkspace;
    /** Takes the Thread with its worktree already resolved onto this machine. */
    readonly runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape;
    /** None where the server runs without the RPC services (orchestration-only tests). */
    readonly rpc: Option.Option<EnvironmentWorkspaceRpc>;
    /** A joined Environment's workspace RPCs, over its socket; none in process. */
    readonly forward: Option.Option<EnvironmentWorkspaceForward>;
  };
  readonly host: {
    /** Host resources and provider capabilities, as published in a hello or heartbeat. */
    readonly describe: Effect.Effect<EnvironmentExecutorSnapshot>;
  };
  /** None where the server runs without text generation (orchestration-only hosts). */
  readonly textGeneration?: EnvironmentTextGeneration;
}

/**
 * Which Environment a Thread runs on: the projection's, read when the registry is built (the
 * server provides it; without it every Thread runs on the Hub machine).
 */
export const ActiveEnvironmentResolver = Context.Reference<{
  readonly resolve: (threadId: ThreadId) => Effect.Effect<EnvironmentId>;
}>("t3/environment/EnvironmentExecutor/ActiveEnvironmentResolver", {
  defaultValue: () => ({ resolve: () => Effect.succeed(HUB_MACHINE_ENVIRONMENT_ID) }),
});

/** Stands for "no Environment": a Thread whose Environment was removed resolves to it. */
export const NO_ENVIRONMENT_ID = EnvironmentId.make("environment:none");

/**
 * The Environment for calls that carry no Thread: checkpoint operations, which only run inside
 * their own Thread's effect. Everything that has a Thread resolves it instead.
 */
const CheckpointEnvironment = Context.Reference<EnvironmentId>(
  "t3/environment/EnvironmentExecutor/CheckpointEnvironment",
  { defaultValue: () => HUB_MACHINE_ENVIRONMENT_ID },
);

/**
 * The effect a call runs for. A request to a joined Environment carries
 * `effectId:<operation>:<n>`: the same on a resend and on the effect's next attempt, so a call the
 * machine already ran answers from its memory instead of running again (a turn is not restarted).
 */
const EffectAttempt = Context.Reference<{ readonly key: string; next: number } | null>(
  "t3/environment/EnvironmentExecutor/EffectAttempt",
  { defaultValue: () => null },
);

/** Runs an effect's work under its idempotency keys. */
export const withEffectAttempt =
  (input: { readonly effectId: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      Effect.provideService(effect, EffectAttempt, { key: input.effectId, next: 0 }),
    );

/** The key for the next request of the current effect, or none outside an effect. */
export const nextIdempotencyKey = Effect.fn("EnvironmentExecutor.nextIdempotencyKey")(function* (
  method: string,
) {
  const attempt = yield* EffectAttempt;
  if (attempt === null) return undefined;
  attempt.next += 1;
  // One effect may make several calls, in the same order on every attempt; each has its own key.
  return `${attempt.key}:${method}:${attempt.next}`;
});

export interface EnvironmentExecutorRegistryShape {
  readonly hubMachineEnvironmentId: EnvironmentId;
  /** The Thread's Active environment, as the projection records it. */
  readonly activeEnvironment: (threadId: ThreadId) => Effect.Effect<EnvironmentId>;
  /** Runs a Thread's effect so its checkpoint work goes to the Thread's Active environment. */
  readonly onActiveEnvironment: (
    threadId: ThreadId,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Signals each time an executor registers or leaves, so waiting work can look again. */
  readonly changes: Effect.Effect<PubSub.Subscription<void>, never, import("effect/Scope").Scope>;
  readonly get: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentId>>;
  /** The executor of the Thread's Active environment. */
  readonly forThread: (
    threadId: ThreadId,
  ) => Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
  /** Adds or replaces an executor; a joined Environment registers on connect. */
  readonly register: (executor: EnvironmentExecutor) => Effect.Effect<void>;
  /** Removes a joined Environment's executor. The Hub machine's stays. */
  readonly unregister: (environmentId: EnvironmentId) => Effect.Effect<void>;
  /**
   * The Hub is stopping: what it still tells joined machines it tells only those connected now,
   * without waiting for one that is away to return (it reconciles when it next connects).
   */
  readonly hubStopping: Effect.Effect<void>;
  /** Resolves once the Hub is stopping. */
  readonly whenHubStops: Effect.Effect<void>;
}

export class EnvironmentExecutorRegistry extends Context.Service<
  EnvironmentExecutorRegistry,
  EnvironmentExecutorRegistryShape
>()("t3/environment/EnvironmentExecutor/EnvironmentExecutorRegistry") {}

export interface EnvironmentCapabilityCacheShape {
  /** Keeps the newest snapshot per Environment by `observedAt`; an older one is ignored. */
  readonly publish: (snapshot: EnvironmentExecutorSnapshot) => Effect.Effect<void>;
  readonly snapshot: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<EnvironmentExecutorSnapshot>>;
  /** A pure read of the last snapshot. A remote executor answers `capabilities` with it. */
  readonly snapshotProvider: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<
    EnvironmentProviderCapabilitySnapshot,
    EnvironmentCapabilitiesUnavailableError
  >;
  /**
   * The provider as the Thread's Active environment's executor reports it. A Thread created by
   * the command being decided has no projected row yet: the caller names its Environment.
   */
  readonly forThread: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly environmentId?: EnvironmentId | undefined;
  }) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>;
}

/** Per-Environment provider capabilities, as the Orchestrator reads them while deciding. */
export class EnvironmentCapabilityCache extends Context.Service<
  EnvironmentCapabilityCache,
  EnvironmentCapabilityCacheShape
>()("t3/environment/EnvironmentExecutor/EnvironmentCapabilityCache") {}

const makeCapabilityCache = Effect.fn("EnvironmentExecutor.makeCapabilityCache")(function* (
  read: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>,
  resolveThread: (threadId: ThreadId) => Effect.Effect<EnvironmentId>,
) {
  const snapshots = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentExecutorSnapshot>>(
    new Map(),
  );
  return EnvironmentCapabilityCache.of({
    publish: Effect.fn("EnvironmentCapabilityCache.publish")(function* (snapshot) {
      // ISO-8601 instants in UTC order as strings, and the update is atomic.
      yield* Ref.update(snapshots, (current) => {
        const known = current.get(snapshot.environmentId);
        if (known !== undefined && known.observedAt > snapshot.observedAt) return current;
        return new Map(current).set(snapshot.environmentId, snapshot);
      });
    }),
    snapshot: Effect.fn("EnvironmentCapabilityCache.snapshot")(function* (environmentId) {
      return Option.fromUndefinedOr((yield* Ref.get(snapshots)).get(environmentId));
    }),
    snapshotProvider: Effect.fn("EnvironmentCapabilityCache.snapshotProvider")(
      function* (environmentId, instanceId) {
        const known = (yield* Ref.get(snapshots)).get(environmentId);
        const found = known?.providers.find((entry) => entry.instanceId === instanceId);
        if (found !== undefined) return found;
        const unavailable = known?.unavailableProviders.find(
          (entry) => entry.instanceId === instanceId,
        );
        return yield* new EnvironmentCapabilitiesUnavailableError({
          environmentId,
          instanceId,
          ...(unavailable === undefined ? {} : { reason: unavailable.reason }),
        });
      },
    ),
    forThread: Effect.fn("EnvironmentCapabilityCache.forThread")(function* (input) {
      const environmentId = input.environmentId ?? (yield* resolveThread(input.threadId));
      return yield* read(environmentId, input.providerInstanceId);
    }),
  });
});

/** What the local adapter registry says about one instance, with its own typed errors. */
const readLocalProvider = Effect.fn("EnvironmentExecutor.readLocalProvider")(function* (
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
  instanceId: ProviderInstanceId,
) {
  if (adapters.getMetadata !== undefined) {
    const { driver, ...metadata } = yield* adapters.getMetadata(instanceId);
    return { instanceId, provider: driver, ...metadata } as EnvironmentProviderCapabilitySnapshot;
  }
  const adapter = yield* adapters.get(instanceId);
  const capabilities = yield* adapter.getCapabilities();
  return {
    instanceId,
    provider: adapter.driver,
    continuationKey: `${adapter.driver}:instance:${instanceId}`,
    enabled: true,
    capabilities,
  } as EnvironmentProviderCapabilitySnapshot;
});

const failureReason = (cause: Cause.Cause<unknown>): string => {
  const text = Cause.pretty(cause).trim();
  return text.length > 0 ? text.slice(0, 500) : "The provider could not be described.";
};

/** Every instance of a local registry: described ones, and the ones that failed with why. */
const describeLocalProviders = Effect.fn("EnvironmentExecutor.describeLocalProviders")(function* (
  environmentId: EnvironmentId,
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
) {
  const instanceIds = yield* adapters.list();
  const described = yield* Effect.forEach(instanceIds, (instanceId) =>
    Effect.exit(readLocalProvider(adapters, instanceId)).pipe(
      Effect.map((exit) => ({ instanceId, exit })),
    ),
  );
  const providers: Array<EnvironmentProviderCapabilitySnapshot> = [];
  const unavailableProviders: Array<EnvironmentUnavailableProvider> = [];
  for (const { instanceId, exit } of described) {
    if (Exit.isSuccess(exit)) {
      providers.push(exit.value);
      continue;
    }
    yield* Effect.logWarning("Provider instance could not be described", {
      environmentId,
      instanceId,
      cause: exit.cause,
    });
    unavailableProviders.push({ instanceId, reason: failureReason(exit.cause) });
  }
  return { providers, unavailableProviders };
});

const optionalWorkspaceRpc: Effect.Effect<Option.Option<EnvironmentWorkspaceRpc>> = Effect.gen(
  function* () {
    const entries = yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries);
    const files = yield* Effect.serviceOption(WorkspaceFileSystem.WorkspaceFileSystem);
    const terminals = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const previews = yield* Effect.serviceOption(PreviewManager.PreviewManager);
    const ports = yield* Effect.serviceOption(PortScanner.PortDiscovery);
    return Option.all({ entries, files, terminals, previews, ports });
  },
);

interface InProcessExecutorInput {
  readonly environmentId: EnvironmentId;
  readonly adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape;
  readonly paths: ProjectCheckouts.EnvironmentWorkspacePaths;
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape;
  readonly rpc: Option.Option<EnvironmentWorkspaceRpc>;
  readonly hostResources: Option.Option<HostResources.HostResources["Service"]>;
  readonly hubRepository: EnvironmentHubRepository;
  readonly move: EnvironmentMoveWorkspace;
  readonly textGeneration: Option.Option<TextGeneration.TextGeneration["Service"]>;
}

/** What a machine needs to prepare a moved Thread's workspace with its own git and files. */
interface MoveWorkspaceDeps {
  readonly vcs: Option.Option<VcsProcess.VcsProcess["Service"]>;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
  readonly path: Option.Option<Path.Path>;
  readonly config: Option.Option<ServerConfig.ServerConfig["Service"]>;
  readonly platform: string;
  readonly home: string;
}

const moveWorkspaceDeps: Effect.Effect<MoveWorkspaceDeps> = Effect.gen(function* () {
  return {
    vcs: yield* Effect.serviceOption(VcsProcess.VcsProcess),
    fileSystem: yield* Effect.serviceOption(FileSystem.FileSystem),
    path: yield* Effect.serviceOption(Path.Path),
    config: yield* Effect.serviceOption(ServerConfig.ServerConfig),
    platform: yield* HostProcess.Platform,
    home: yield* HostProcess.HomeDirectory,
  };
});

/**
 * `move.fetch` and `move.prepare` on this machine: the checkout comes from `checkoutOf` (made
 * there first when needed) and transfers go through the machine's side of the Hub repository.
 */
const makeMoveWorkspace = (input: {
  readonly deps: MoveWorkspaceDeps;
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly hubRepository: LocalHubRepository;
  readonly checkoutOf: (projectId: ProjectId) => Effect.Effect<string, CheckpointStoreError>;
}): EnvironmentMoveWorkspace => {
  const { vcs, fileSystem, path, config, platform, home } = input.deps;
  return {
    publishScratch: (request) =>
      Option.isNone(vcs) || Option.isNone(fileSystem) || Option.isNone(path)
        ? Effect.fail(noCheckout("scratch" as ProjectId, "This server cannot use git."))
        : ScratchWorkspace.publishScratchHistory(
            { vcs: vcs.value, fileSystem: fileSystem.value, path: path.value },
            request,
          ),
    fetch: Effect.fn("EnvironmentExecutor.move.fetch")(function* (request) {
      let checkout = yield* input.checkoutOf(request.projectId);
      const { scratch } = request;
      // A Thread without a Project moves into its own scratch workspace, made here if missing.
      if (scratch !== undefined) {
        if (Option.isNone(vcs) || Option.isNone(fileSystem) || Option.isNone(path)) {
          return yield* noCheckout(
            request.projectId,
            "This server cannot make a scratch workspace.",
          );
        }
        const folder = ScratchWorkspace.scratchFolderIn(path.value, checkout, scratch.folder);
        if (folder === null) {
          return yield* noCheckout(request.projectId, `${scratch.folder} is not a folder name.`);
        }
        yield* ScratchWorkspace.ensureScratchRepository(
          { vcs: vcs.value, fileSystem: fileSystem.value, path: path.value },
          folder,
        );
        checkout = folder;
      }
      if (request.refs.length > 0) {
        yield* input.hubRepository.fetch({
          cwd: checkout,
          projectId: request.projectId,
          ...(scratch === undefined ? {} : { scratchThreadId: scratch.threadId }),
          checkpointRefs: request.refs,
        });
      }
      if (scratch?.history !== undefined) {
        yield* input.hubRepository.fetchPrefix({
          cwd: checkout,
          projectId: request.projectId,
          scratchThreadId: scratch.threadId,
          prefix: scratch.history,
        });
      }
      return { checkout };
    }),
    prepare: (request) =>
      Option.isNone(vcs) ||
      Option.isNone(fileSystem) ||
      Option.isNone(path) ||
      Option.isNone(config)
        ? Effect.fail(
            new VcsUnsupportedOperationError({
              operation: "EnvironmentExecutor.move.prepare",
              kind: "git",
              detail: "This server cannot prepare a moved Thread's workspace.",
            }),
          )
        : MovedWorkspace.prepareMovedWorkspace(
            {
              vcs: vcs.value,
              checkpoints: input.checkpoints,
              fileSystem: fileSystem.value,
              path: path.value,
              worktreesDir: config.value.worktreesDir,
              platform,
              // The policy a terminal's shell gets, where the normal setup script runs.
              scriptEnv: (runtimeEnv) =>
                TerminalManager.createTerminalSpawnEnv(
                  process.env,
                  runtimeEnv,
                  platform as NodeJS.Platform,
                  home,
                ),
            },
            request,
          ),
    recover: (request) =>
      Option.isNone(vcs) || Option.isNone(fileSystem)
        ? Effect.fail(
            new VcsUnsupportedOperationError({
              operation: "EnvironmentExecutor.move.recover",
              kind: "git",
              detail: "This server cannot look for a moved Thread's changes.",
            }),
          )
        : MovedWorkspace.captureRecoveredChanges(
            { vcs: vcs.value, checkpoints: input.checkpoints, fileSystem: fileSystem.value },
            request,
          ).pipe(
            Effect.tap(({ status }) =>
              status === "recovered"
                ? input.hubRepository.push({
                    cwd: request.cwd,
                    ...HubRepository.keyOf(request),
                    checkpointRefs: [request.recoveredRef],
                  })
                : Effect.void,
            ),
          ),
  };
};

const noCheckout = (projectId: ProjectId, detail?: string) =>
  new VcsUnsupportedOperationError({
    operation: "EnvironmentExecutor.move.fetch",
    kind: "git",
    detail: detail ?? `Project ${projectId} has no checkout on this machine.`,
  });

/**
 * The Hub machine's side of the Hub repository: a push to the bare repository on this disk, so
 * its Threads upload through the same path as a joined Environment's at the cost of a local copy.
 */
const localHubRepository = (
  repositories: Option.Option<HubRepositories["Service"]>,
  deps: MoveWorkspaceDeps,
): LocalHubRepository => ({
  ...HubRepository.makeCheckoutTransfers({
    vcs: Option.getOrUndefined(deps.vcs),
    remoteOf: Option.match(repositories, {
      onNone: () => undefined,
      onSome: (hub) => (key: HubRepository.HubRepositoryKey) =>
        hub.ensure(key).pipe(Effect.map((url) => ({ url }))),
    }),
    unavailable: "This server keeps no Hub repository.",
  }),
  ensureScratch: (folder) =>
    Option.isNone(deps.vcs) || Option.isNone(deps.fileSystem) || Option.isNone(deps.path)
      ? Effect.fail(noCheckout("scratch" as ProjectId, "This server cannot use git."))
      : ScratchWorkspace.ensureScratchRepository(
          { vcs: deps.vcs.value, fileSystem: deps.fileSystem.value, path: deps.path.value },
          folder,
        ),
});

type HubRepositories = HubRepository.HubRepositories;

/** The Hub machine's side, with what its own moves need beyond the executor operations. */
type LocalHubRepository = EnvironmentHubRepository &
  Pick<HubRepository.CheckoutTransfers, "fetchPrefix">;

/** An executor whose machine is this process. */
const makeInProcessExecutor = (input: InProcessExecutorInput): EnvironmentExecutor => ({
  environmentId: input.environmentId,
  transport: "in-process",
  provider: {
    adapters: input.adapters,
    capabilities: (instanceId) => readLocalProvider(input.adapters, instanceId),
  },
  workspace: {
    paths: input.paths,
    checkpoints: input.checkpoints,
    hubRepository: input.hubRepository,
    move: input.move,
    runtimePolicy: input.runtimePolicy,
    rpc: input.rpc,
    forward: Option.none(),
  },
  ...Option.match(input.textGeneration, {
    onNone: () => ({}),
    onSome: (textGeneration) => ({
      textGeneration: {
        threadHandoff: ({
          generationId: _generationId,
          ...request
        }: TextGeneration.ThreadHandoffGenerationInput & { readonly generationId?: string }) =>
          textGeneration.generateThreadHandoff === undefined
            ? Effect.fail(
                new EnvironmentExecutorUnavailableError({ environmentId: input.environmentId }),
              )
            : textGeneration.generateThreadHandoff(request),
        threadTitle: (request) =>
          textGeneration
            .generateThreadTitle({ ...request })
            .pipe(Effect.map((result) => ({ title: result.title }))),
      },
    }),
  }),
  host: {
    describe: Effect.gen(function* () {
      const described = yield* describeLocalProviders(input.environmentId, input.adapters);
      const resources = Option.isSome(input.hostResources)
        ? { hostResources: yield* input.hostResources.value.read, disk: null }
        : undefined;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
        environmentId: input.environmentId,
        transport: "in-process",
        ...described,
        ...(resources === undefined ? {} : { resources }),
        observedAt,
      } satisfies EnvironmentExecutorSnapshot;
    }),
  },
});

const makeRegistry = Effect.fn("EnvironmentExecutor.makeRegistry")(function* (
  hubMachine: EnvironmentExecutor,
) {
  const resolver = yield* ActiveEnvironmentResolver;
  const resolveThread = (threadId: ThreadId) => resolver.resolve(threadId);
  const executors = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentExecutor>>(
    new Map([[hubMachine.environmentId, hubMachine]]),
  );
  const changed = yield* PubSub.sliding<void>(1);
  const stopping = yield* Deferred.make<void>();
  const get: EnvironmentExecutorRegistryShape["get"] = (environmentId) =>
    Ref.get(executors).pipe(
      Effect.flatMap((byEnvironment) => {
        const executor = byEnvironment.get(environmentId);
        return executor === undefined
          ? Effect.fail(new EnvironmentExecutorUnavailableError({ environmentId }))
          : Effect.succeed(executor);
      }),
    );
  return EnvironmentExecutorRegistry.of({
    hubMachineEnvironmentId: hubMachine.environmentId,
    activeEnvironment: resolveThread,
    onActiveEnvironment:
      (threadId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        resolveThread(threadId).pipe(
          Effect.flatMap((environmentId) =>
            Effect.provideService(effect, CheckpointEnvironment, environmentId),
          ),
        ),
    changes: PubSub.subscribe(changed),
    get,
    list: Ref.get(executors).pipe(Effect.map((byEnvironment) => [...byEnvironment.keys()])),
    forThread: Effect.fn("EnvironmentExecutorRegistry.forThread")(function* (threadId) {
      return yield* get(yield* resolveThread(threadId));
    }),
    register: Effect.fn("EnvironmentExecutorRegistry.register")(function* (executor) {
      yield* Ref.update(executors, (current) =>
        new Map(current).set(executor.environmentId, executor),
      );
      yield* PubSub.publish(changed, undefined);
    }),
    unregister: Effect.fn("EnvironmentExecutorRegistry.unregister")(function* (environmentId) {
      if (environmentId === hubMachine.environmentId) return;
      yield* Ref.update(executors, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
      yield* PubSub.publish(changed, undefined);
    }),
    hubStopping: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid),
    whenHubStops: Deferred.await(stopping),
  });
});

/**
 * The Hub machine with `T3CODE_HUB_RUNS_AGENTS` off: it opens no provider session, writes no text
 * and prepares no moved workspace (a setup script), whatever asks; its terminals refuse in
 * `TerminalManager` and its text generation in `TextGeneration`.
 */
const refusingAgents = (executor: EnvironmentExecutor): EnvironmentExecutor => {
  const { textGeneration: _textGeneration, ...rest } = executor;
  const adapters = executor.provider.adapters;
  return {
    ...rest,
    provider: {
      ...executor.provider,
      adapters: {
        ...adapters,
        get: (instanceId) =>
          adapters.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: () =>
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: adapter.driver,
                    detail: HUB_RUNS_NO_AGENTS_MESSAGE,
                    cause: new HubRunsAgents.HubRunsNoAgentsError({
                      operation: "provider.openSession",
                    }),
                  }),
                ),
            })),
          ),
      },
    },
    workspace: {
      ...executor.workspace,
      move: {
        ...executor.workspace.move,
        prepare: () =>
          Effect.fail(
            new EnvironmentExecutorUnavailableError({ environmentId: executor.environmentId }),
          ),
      },
    },
  };
};

/** Logs a failed refresh and carries on, so a bad snapshot never stops startup or the heartbeat. */
const logRefreshFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("Hub machine snapshot refresh failed", { cause }),
    ),
  );

/**
 * The registry with the Hub machine's in-process executor, built over the local adapter registry,
 * runtime policy and checkpoint store. Its snapshot (for Settings and the hello of later tickets)
 * is published at startup, when provider instances change, and on every heartbeat.
 */
export const layerHubMachine: Layer.Layer<
  EnvironmentExecutorRegistry | EnvironmentCapabilityCache,
  never,
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | RuntimePolicy.RuntimePolicyV2
  | CheckpointStore.CheckpointStore
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProjectStore.ProjectStoreV2
> = Layer.effectContext(
  Effect.gen(function* () {
    const paths = ProjectCheckouts.hubMachinePaths(yield* ProjectStore.ProjectStoreV2);
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const deps = yield* moveWorkspaceDeps;
    const hubRepository = localHubRepository(
      yield* Effect.serviceOption(HubRepository.HubRepositories),
      deps,
    );
    const inProcess = makeInProcessExecutor({
      environmentId: HUB_MACHINE_ENVIRONMENT_ID,
      adapters: yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      paths,
      checkpoints,
      runtimePolicy: yield* RuntimePolicy.RuntimePolicyV2,
      rpc: yield* optionalWorkspaceRpc,
      hostResources: yield* Effect.serviceOption(HostResources.HostResources),
      hubRepository,
      textGeneration: yield* Effect.serviceOption(TextGeneration.TextGeneration),
      // The Hub machine's checkout of a Project is its workspace root, which always exists.
      move: makeMoveWorkspace({
        deps,
        checkpoints,
        hubRepository,
        checkoutOf: (projectId) =>
          paths.checkout(projectId).pipe(
            Effect.mapError((cause) => noCheckout(projectId, cause.message)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(noCheckout(projectId)),
                onSome: Effect.succeed,
              }),
            ),
          ),
      }),
    });
    // A Hub that runs no agents keeps the executor for its checkouts and checkpoints only.
    const hubMachine = (yield* HubRunsAgents.HubRunsAgents) ? inProcess : refusingAgents(inProcess);
    const registry = yield* makeRegistry(hubMachine);
    const cache = yield* makeCapabilityCache(
      Effect.fn("EnvironmentExecutor.readCapabilities")(function* (environmentId, instanceId) {
        const executor = yield* registry.get(environmentId);
        return yield* executor.provider.capabilities(instanceId);
      }),
      registry.activeEnvironment,
    );
    const refreshLock = yield* Semaphore.make(1);
    const refresh = logRefreshFailure(
      refreshLock.withPermits(1)(hubMachine.host.describe.pipe(Effect.flatMap(cache.publish))),
    );

    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // Startup never waits on the subscription. Refreshing once subscribed covers a change that
    // landed between the first snapshot and the subscription.
    yield* instances.subscribeChanges.pipe(
      Effect.flatMap((instanceChanges) =>
        refresh.pipe(
          Effect.andThen(
            Stream.runForEach(Stream.fromSubscription(instanceChanges), () => refresh),
          ),
        ),
      ),
      Effect.scoped,
      Effect.forkScoped,
    );
    yield* refresh;
    yield* Effect.sleep(HUB_MACHINE_HEARTBEAT_INTERVAL).pipe(
      Effect.andThen(refresh),
      Effect.forever,
      Effect.forkScoped,
    );

    return Context.make(EnvironmentExecutorRegistry, registry).pipe(
      Context.add(EnvironmentCapabilityCache, cache),
    );
  }),
);

/** Capabilities read through to a fixed local adapter registry. For hosts without a registry. */
export const makeLocalCapabilityCache = (
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
) =>
  makeCapabilityCache(
    Effect.fn("EnvironmentExecutor.readLocalCapabilities")(function* (environmentId, instanceId) {
      if (environmentId !== HUB_MACHINE_ENVIRONMENT_ID) {
        return yield* new EnvironmentExecutorUnavailableError({ environmentId });
      }
      return yield* readLocalProvider(adapters, instanceId);
    }),
    () => Effect.succeed(HUB_MACHINE_ENVIRONMENT_ID),
  );

/**
 * `ProviderAdapterRegistryV2` over the executors. Lookups answer from the Hub machine, else from
 * the first joined Environment that has the instance, and a session opens on its Thread's Active
 * environment.
 */
export const layerProviderAdapterRegistry: Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const hubMachine = yield* registry.get(registry.hubMachineEnvironmentId).pipe(Effect.orDie);
    const local = hubMachine.provider.adapters;
    // Spec 4 ticket 06: on the Hub machine the gateway is the Hub's own loopback route.
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const hubAddress = yield* Effect.serviceOption(SandboxHubAddress);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const hubLoopbackUrl = Option.isSome(hubAddress)
      ? hubAddress.value.loopbackUrl
      : Effect.succeed(Option.isSome(config) ? sandboxHubLoopbackUrl(config.value) : undefined);
    // Contract 14: the Hub machine's Secret files, held while each session lives.
    const secretFiles = yield* Effect.serviceOption(ThreadSecretFiles.ThreadSecretFiles);
    /** The session's Secret files written and its gateway completed here, on the Hub machine. */
    const onHubMachine = (
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) =>
      ThreadSecretFiles.holdSecretFiles(secretFiles, input.secretEnv).pipe(
        Effect.map((secretEnv) => (secretEnv === undefined ? input : { ...input, secretEnv })),
        Effect.flatMap((withFiles) => withGateway(adapter, withFiles)),
      );
    /** The session's gateway completed here, for a process on the Hub machine. */
    const withGateway = (
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) =>
      input.aiGateway === undefined || Option.isNone(config) || Option.isNone(fileSystem)
        ? Effect.succeed(input)
        : prepareGatewaySession({
            access: input.aiGateway,
            threadId: input.threadId,
            driver: adapter.driver,
            stateDir: config.value.stateDir,
            baseUrl: hubLoopbackUrl.pipe(
              Effect.filterOrFail(
                (url): url is string => url !== undefined,
                () => new AiGatewaySessionError({ reason: "unreachable" }),
              ),
            ),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem.value),
            Effect.map((aiGateway) => ({
              ...input,
              ...(aiGateway === undefined ? {} : { aiGateway }),
            })),
          );
    const routed = (
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
    ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
      ...adapter,
      openSession: (input) =>
        registry.forThread(input.threadId).pipe(
          Effect.flatMap(
            (
              executor,
            ): Effect.Effect<
              {
                readonly target: ProviderAdapter.ProviderAdapterV2["Service"];
                readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
              },
              unknown,
              Scope.Scope
            > =>
              executor.environmentId === hubMachine.environmentId
                ? onHubMachine(adapter, input).pipe(
                    Effect.map((completed) => ({ target: adapter, input: completed })),
                  )
                : executor.provider.adapters
                    .get(adapter.instanceId)
                    .pipe(Effect.map((target) => ({ target, input }))),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: adapter.driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap(({ target, input: completed }) =>
            openSessionWithSecrets(target, completed),
          ),
        ),
    });
    // An instance the Hub machine lacks is still reachable on an Environment that has it.
    const fromEnvironments = Effect.fn("EnvironmentExecutor.adapters.fromEnvironments")(function* (
      instanceId: ProviderInstanceId,
    ) {
      for (const environmentId of yield* registry.list) {
        if (environmentId === hubMachine.environmentId) continue;
        const executor = yield* Effect.option(registry.get(environmentId));
        if (Option.isNone(executor)) continue;
        const adapter = yield* Effect.option(executor.value.provider.adapters.get(instanceId));
        if (Option.isSome(adapter)) return Option.some(adapter.value);
      }
      return Option.none<ProviderAdapter.ProviderAdapterV2["Service"]>();
    });
    return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: Effect.fn("EnvironmentExecutor.adapters.get")(function* (instanceId) {
        const found = yield* Effect.result(local.get(instanceId));
        if (found._tag === "Success") return routed(found.success);
        const remote = yield* fromEnvironments(instanceId);
        if (Option.isSome(remote)) return routed(remote.value);
        return yield* found.failure;
      }),
      list: Effect.fn("EnvironmentExecutor.adapters.list")(function* () {
        return yield* local.list();
      }),
      // Like `get`: an instance the Hub machine lacks is described by the Environment that has
      // it (a provider switch or an AI-account switch on a Sandbox's Thread plans against it).
      ...(local.getMetadata === undefined
        ? {}
        : {
            getMetadata: Effect.fn("EnvironmentExecutor.adapters.getMetadata")(function* (
              instanceId: ProviderInstanceId,
            ) {
              const found = yield* Effect.result(local.getMetadata!(instanceId));
              if (found._tag === "Success") return found.success;
              const remote = yield* fromEnvironments(instanceId);
              if (Option.isNone(remote)) return yield* found.failure;
              const capabilities = yield* remote.value
                .getCapabilities()
                .pipe(Effect.mapError(() => found.failure));
              return {
                driver: remote.value.driver,
                continuationKey: `${remote.value.driver}:instance:${instanceId}`,
                enabled: true,
                capabilities,
              };
            }),
          }),
    });
  }),
);

/**
 * A Thread's worktree as the executor's machine sees it. The projection records it as the Hub
 * machine resolves it, so the Hub machine takes it as is; another machine resolves its logical
 * form, the stored one when it matches the recorded path, else one computed against the Hub
 * machine's checkout. Null keeps the executor's own checkout of the Project.
 */
export const worktreeOn = Effect.fn("EnvironmentExecutor.worktreeOn")(function* (
  registry: EnvironmentExecutorRegistryShape,
  checkouts: ProjectCheckouts.ProjectCheckouts["Service"],
  executor: EnvironmentExecutor,
  thread: OrchestrationV2AppThread,
) {
  const recorded = thread.worktreePath;
  if (recorded === null || executor.environmentId === registry.hubMachineEnvironmentId) {
    return recorded;
  }
  const stored = yield* checkouts.storedWorktree(thread.id);
  const location =
    Option.isSome(stored) &&
    stored.value.worktreePath === recorded &&
    stored.value.location !== null
      ? stored.value.location
      : locateInCheckout({
          environmentId: registry.hubMachineEnvironmentId,
          checkout: Option.getOrNull(
            yield* (yield* registry.get(registry.hubMachineEnvironmentId)).workspace.paths.checkout(
              thread.projectId,
            ),
          ),
          absolute: recorded,
        });
  return yield* executor.workspace.paths.resolve({ projectId: thread.projectId, location });
});

/** `RuntimePolicyV2` (cwd and sandbox resolution) on the Thread's Active environment. */
export const layerRuntimePolicy: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  EnvironmentExecutorRegistry | ProjectCheckouts.ProjectCheckouts
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const checkouts = yield* ProjectCheckouts.ProjectCheckouts;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("EnvironmentExecutor.runtimePolicy.resolve")(function* (input) {
        const resolveError = (cause: unknown) =>
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        const executor = yield* (
          input.environmentId === undefined
            ? registry.forThread(input.thread.id)
            : registry.get(input.environmentId)
        ).pipe(Effect.mapError(resolveError));
        const worktreePath = yield* worktreeOn(registry, checkouts, executor, input.thread).pipe(
          Effect.mapError(resolveError),
        );
        return yield* executor.workspace.runtimePolicy.resolve({
          ...input,
          thread: { ...input.thread, worktreePath },
        });
      }),
    });
  }),
);

/** `CheckpointStore` on the Environment of the Thread whose effect is running. */
export const layerCheckpointStore: Layer.Layer<
  CheckpointStore.CheckpointStore,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  CheckpointStore.CheckpointStore,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const checkpoints = Effect.gen(function* () {
      const executor = yield* registry.get(yield* CheckpointEnvironment);
      return executor.workspace.checkpoints;
    });
    return CheckpointStore.CheckpointStore.of({
      isGitRepository: Effect.fn("EnvironmentExecutor.checkpoints.isGitRepository")(
        function* (input) {
          return yield* (yield* checkpoints).isGitRepository(input);
        },
      ),
      captureCheckpoint: Effect.fn("EnvironmentExecutor.checkpoints.captureCheckpoint")(
        function* (input) {
          return yield* (yield* checkpoints).captureCheckpoint(input);
        },
      ),
      hasCheckpointRef: Effect.fn("EnvironmentExecutor.checkpoints.hasCheckpointRef")(
        function* (input) {
          return yield* (yield* checkpoints).hasCheckpointRef(input);
        },
      ),
      restoreCheckpoint: Effect.fn("EnvironmentExecutor.checkpoints.restoreCheckpoint")(
        function* (input) {
          return yield* (yield* checkpoints).restoreCheckpoint(input);
        },
      ),
      diffCheckpoints: Effect.fn("EnvironmentExecutor.checkpoints.diffCheckpoints")(
        function* (input) {
          return yield* (yield* checkpoints).diffCheckpoints(input);
        },
      ),
      listAuthoredPaths: Effect.fn("EnvironmentExecutor.checkpoints.listAuthoredPaths")(
        function* (input) {
          return yield* (yield* checkpoints).listAuthoredPaths(input);
        },
      ),
      deleteCheckpointRefs: Effect.fn("EnvironmentExecutor.checkpoints.deleteCheckpointRefs")(
        function* (input) {
          return yield* (yield* checkpoints).deleteCheckpointRefs(input);
        },
      ),
    });
  }),
);

/** Transfers with the Hub repository, made by the checkout on the running effect's Environment. */
export class HubRepositoryTransfers extends Context.Service<
  HubRepositoryTransfers,
  EnvironmentHubRepository
>()("t3/environment/EnvironmentExecutor/HubRepositoryTransfers") {}

export const layerHubRepositoryTransfers: Layer.Layer<
  HubRepositoryTransfers,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  HubRepositoryTransfers,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const current = Effect.gen(function* () {
      return (yield* registry.get(yield* CheckpointEnvironment)).workspace.hubRepository;
    });
    return HubRepositoryTransfers.of({
      push: Effect.fn("EnvironmentExecutor.hubRepository.push")(function* (input) {
        return yield* (yield* current).push(input);
      }),
      fetch: Effect.fn("EnvironmentExecutor.hubRepository.fetch")(function* (input) {
        return yield* (yield* current).fetch(input);
      }),
      ensureScratch: Effect.fn("EnvironmentExecutor.hubRepository.ensureScratch")(
        function* (folder) {
          return yield* (yield* current).ensureScratch(folder);
        },
      ),
    });
  }),
);

/**
 * The workspace RPC services of the Hub machine's executor. A host built without the registry
 * (some ws tests) uses the local services, which are the same in-process implementations.
 */
export const hubMachineWorkspaceRpc: Effect.Effect<
  EnvironmentWorkspaceRpc,
  never,
  | WorkspaceEntries.WorkspaceEntries
  | WorkspaceFileSystem.WorkspaceFileSystem
  | TerminalManager.TerminalManager
  | PreviewManager.PreviewManager
  | PortScanner.PortDiscovery
> = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(EnvironmentExecutorRegistry);
  if (Option.isSome(registry)) {
    const hubMachine = yield* Effect.option(
      registry.value.get(registry.value.hubMachineEnvironmentId),
    );
    if (Option.isSome(hubMachine) && Option.isSome(hubMachine.value.workspace.rpc)) {
      return hubMachine.value.workspace.rpc.value;
    }
  }
  return {
    entries: yield* WorkspaceEntries.WorkspaceEntries,
    files: yield* WorkspaceFileSystem.WorkspaceFileSystem,
    terminals: yield* TerminalManager.TerminalManager,
    previews: yield* PreviewManager.PreviewManager,
    ports: yield* PortScanner.PortDiscovery,
  };
});
