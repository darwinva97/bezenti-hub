import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthInstallationScopes,
  SourceControlProviderKind,
  SourceControlRepositoryError,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  INSTALLATION_OWNER_ONLY_MESSAGE,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalReadScope,
  EventId,
  GuestShareId,
  MessageId,
  NodeId,
  RunId,
  SpaceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ShellStreamItem,
  AuthSessionId,
  CommandId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  UserId,
  WsRpcGroup,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  WsServerRefreshProvidersRpc,
  WsSubscribeServerConfigRpc,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as AssetSigner from "./assets/AssetSigner.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import { CLONE_DESTINATION_REFUSED } from "./project/cloneDestination.ts";
import {
  PROJECT_FOLDER_CHANGE_REFUSED,
  PROJECT_FOLDER_REFUSED,
  projectsRootOf,
  THREAD_WORKTREE_REFUSED,
} from "./spaces/directoryRoots.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as Vaults from "./vaults/Vaults.ts";
import * as SecretProviderScopes from "./vaults/SecretProviderScopes.ts";
import * as Grants from "./grants/Grants.ts";
import * as EffectiveVaults from "./vaults/EffectiveVaults.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as AiAccounts from "./ai/AiAccounts.ts";
import * as AiGateway from "./ai/AiGateway.ts";
import * as AiUsage from "./ai/AiUsage.ts";
import * as AiGatewayKeys from "./ai/AiGatewayKeys.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  connectionEnds,
  layerWsRpc,
  resolveOpenDiscoveryForConfig,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateConfigDiscovery,
} from "./ws.ts";
import * as CurrentPrincipal from "./auth/CurrentPrincipal.ts";
import * as SpaceDirectory from "./spaces/SpaceDirectory.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { layerSeesEverything } from "./spaces/SpaceVisibility.testkit.ts";
import * as SpaceVisibility from "./spaces/SpaceVisibility.ts";
import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "./auth/UserAuth.testkit.ts";
import * as CommandActor from "./auth/CommandActor.ts";
import { untilAccessLost } from "./auth/RpcSpaceAccess.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as McpSessionRegistryTestkit from "./mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderTurnStartServiceTestkit from "./orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import { visibleShells } from "./mcp/mcpVisibility.ts";
import { threadNotFound } from "./mcp/threadAccess.ts";
import * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Context from "effect/Context";

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateConfigDiscovery(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
      { resolveTargets: () => Effect.succeed([]) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a reveal kind and remote targets that outlast the snapshot timeout", () =>
  Effect.gen(function* () {
    const targets = [{ kind: "mdns" as const, host: "test.local" }];
    const finishDiscovery = yield* Deferred.make<typeof targets>();
    const collecting = yield* withLateConfigDiscovery(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
      { resolveTargets: () => Deferred.await(finishDiscovery) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("6 seconds");
    yield* Deferred.succeed(finishDiscovery, targets);
    const events = yield* Fiber.join(collecting);

    const [late, remote] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
    assert.equal(remote?.type, "snapshot");
    if (remote?.type === "snapshot") {
      assert.deepEqual(remote.config.remoteOpenTargets, targets);
      assert.equal(remote.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

it.effect("runs editor, remote open target and direct endpoint discovery side by side", () =>
  Effect.gen(function* () {
    // Each discovery finishes only once the other two have started, so a
    // config that ran them one after another would never resolve.
    const editorsStarted = yield* Deferred.make<void>();
    const targetsStarted = yield* Deferred.make<void>();
    const endpointsStarted = yield* Deferred.make<void>();
    const startThenAwait = <A>(started: Deferred.Deferred<void>, value: A) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.forEach([editorsStarted, targetsStarted, endpointsStarted], Deferred.await),
        ),
        Effect.as(value),
      );

    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: startThenAwait(editorsStarted, ["file-manager" as const]),
      fileManagerRevealKind: Effect.succeed("finder" as const),
      remoteOpenTargets: startThenAwait(targetsStarted, []),
      directEndpoints: startThenAwait(endpointsStarted, []),
    });

    assert.deepEqual(discovery, {
      availableEditors: ["file-manager"],
      shellRevealInFileManager: true,
      shellRevealInFileManagerKind: "finder",
      remoteOpenTargets: [],
      directEndpoints: [],
    });
  }),
);

const ReplayTestLayer = Layer.merge(OrchestrationEventStore.layer, layerSeesEverything).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("coalesces streaming replay before synchronization and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming-replay");
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (version: number, text: string, streaming: boolean) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`streaming-replay:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "agent",
          creationSource: "web",
          id: "message:streaming-replay",
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    yield* insert(0, "H", true);
    yield* insert(1, "He", true);
    const [latest] = yield* insert(2, "Hello", true);
    const [completed] = yield* insert(3, "Hello!", false);
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: 0,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () =>
          Stream.unwrap(
            insert(4, "Next", false).pipe(
              Effect.map(() =>
                store.readAgentEvents({ threadId, afterSequence: completed!.sequence }),
              ),
            ),
          ),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      items.map((item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [latest!.sequence, "Hello"],
        [completed!.sequence, "Hello!"],
        ["synchronized"],
        [completed!.sequence + 1, "Next"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell groups read distinct threads once and keep each event's own sequence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (aggregateKind: "thread" | "project", streamId: string, version: number) =>
      sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`shell-group:${streamId}:${version}`}, ${aggregateKind}, ${streamId}, ${version},
        ${aggregateKind === "thread" ? "provider-session.detached" : "project.meta-updated"},
        ${now}, 'server', ${JSON.stringify(
          aggregateKind === "thread"
            ? { providerSessionId: "session:shell-group", detachedAt: now }
            : { projectId: streamId, updatedAt: now },
        )}, '{}', 2
      ) RETURNING sequence
    `.pipe(Effect.map(([row]) => row!.sequence));
    const shell = (id: string, archivedAt: string | null = null) =>
      ({ id: ThreadId.make(id), archivedAt }) as unknown as OrchestrationV2ThreadShell;
    const project = {
      id: ProjectId.make("project:group"),
    } as unknown as OrchestrationProjectShell;

    const after = yield* insert("project", "project:before", 0);
    yield* insert("thread", "thread:active", 0);
    const archived = yield* insert("thread", "thread:archived", 0);
    const projectUpdated = yield* insert("project", project.id, 0);
    const active = yield* insert("thread", "thread:active", 1);
    const missing = yield* insert("thread", "thread:missing", 0);

    const shellReads: Array<ReadonlyArray<string> | undefined> = [];
    let batchFails = false;
    const collect = (afterSequence: number) =>
      subscribeOrchestrationV2Shell({ afterSequence, requestCompletionMarker: true }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.suspend(() => {
              shellReads.push(options?.threadIds);
              return batchFails
                ? Effect.fail("batch failed")
                : Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: Number.MAX_SAFE_INTEGER,
                    threads: [shell("thread:active")],
                    archivedThreads: [shell("thread:archived", now)],
                  });
            }),
          getThreadShell: (threadId: string) =>
            Effect.sync(() => {
              shellReads.push([`scalar:${threadId}`]);
              return threadId === "thread:missing"
                ? null
                : shell(threadId, threadId === "thread:archived" ? now : null);
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const collectSummary = (afterSequence: number) =>
      collect(afterSequence).pipe(
        Effect.map((items) =>
          items.flatMap((item): ReadonlyArray<ReadonlyArray<string | number>> =>
            item.kind === "thread.updated"
              ? [[item.kind, item.sequence, item.thread.id]]
              : item.kind === "thread.removed"
                ? [[item.kind, item.sequence, item.threadId]]
                : item.kind === "project.updated"
                  ? [[item.kind, item.sequence, item.project.id]]
                  : [],
          ),
        ),
      );
    const expectedGroup = [
      ["thread.removed", archived, "thread:archived"],
      ["project.updated", projectUpdated, project.id],
      ["thread.updated", active, "thread:active"],
      ["thread.removed", missing, "thread:missing"],
    ];

    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [["thread:archived", "thread:active", "thread:missing"]]);

    shellReads.length = 0;
    assert.deepEqual(yield* collectSummary(active), [
      ["thread.removed", missing, "thread:missing"],
    ]);
    assert.deepEqual(shellReads, [["scalar:thread:missing"]]);

    shellReads.length = 0;
    batchFails = true;
    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [
      ["thread:archived", "thread:active", "thread:missing"],
      ["scalar:thread:archived"],
      ["scalar:thread:active"],
      ["scalar:thread:missing"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots omit idle children and older settled threads only on request", () =>
  Effect.gen(function* () {
    const shell = (
      id: string,
      parent: string | null,
      activityRunStatus: "running" | null,
      settledDaysAgo: number | null = null,
    ) =>
      ({
        id: ThreadId.make(id),
        projectId: "project",
        archivedAt: null,
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        settledOverride: settledDaysAgo === null ? null : "settled",
        settledAt:
          settledDaysAgo === null ? null : DateTime.makeUnsafe(-settledDaysAgo * 86_400_000),
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make(parent ?? id),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
      ...Array.from({ length: 25 }, (_, index) => shell(`recent-${index}`, null, null, 1)),
      shell("old", null, null, 30),
    ];
    const firstSnapshot = (input: {
      readonly omitIdleSubagents?: boolean;
      readonly omitOlderSettled?: boolean;
    }) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () =>
            Effect.succeed(
              threads.map((thread) => ({
                ...thread,
                pinnedAt: null,
                snoozedUntil: null,
                mayBeLive: thread.activityRunStatus !== null,
              })),
            ),
          readShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: threads.filter(
                  (thread) => options?.threadIds?.includes(thread.id) ?? true,
                ),
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const recent = threads.slice(3, 28).map((thread) => thread.id);
    const full = yield* firstSnapshot({});
    assert.deepEqual(
      full?.threads.map((thread) => thread.id),
      threads.map((thread) => thread.id),
    );
    assert.isUndefined(full?.olderSettled);
    const withoutChildren = yield* firstSnapshot({ omitIdleSubagents: true });
    assert.deepEqual(
      withoutChildren?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent, "old"],
    );
    const withoutOld = yield* firstSnapshot({ omitIdleSubagents: true, omitOlderSettled: true });
    assert.deepEqual(
      withoutOld?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent],
    );
    assert.deepEqual(withoutOld?.olderSettled?.counts, [
      { projectId: ProjectId.make("project"), count: 1 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(Vaults.Vaults)({}),
  Layer.mock(SecretProviderScopes.SecretProviderScopes)({}),
  Layer.mock(Grants.Grants)({}),
  Layer.mock(EffectiveVaults.EffectiveVaults)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(SpaceDirectory.SpaceDirectory)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "config-test",
    legacyCookieName: undefined,
    previewOrigin: undefined,
  }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(AiGateway.AiGateway)({ authDir: "" }),
  Layer.mock(AiAccounts.AiAccounts)({}),
  Layer.mock(AiUsage.AiUsage)({}),
  Layer.mock(AiGatewayKeys.AiGatewayKeys)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({
    getMetadata: (input) => Effect.succeed({ entries: input.paths.map(() => ({ kind: "file" })) }),
  }),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ServerSettings.layer.pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
  ),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
// Tests not about Spaces read as the Owner.
const layerOwnerConfigSources = Layer.merge(layerConfigSources, layerSeesEverything);

it.effect.each([
  "pending",
  "cached",
  "direct-pending",
  "direct-cached",
  "direct-failed",
  "direct-interrupted",
] as const)(
  "%s endpoint discovery preserves initial config and updates through discovery and ACK",
  (discovery) =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const remoteDiscoveryStarted = yield* Deferred.make<void>();
      const finishRemoteDiscovery = yield* Deferred.make<void>();
      const targets = [{ kind: "mdns" as const, host: "test.local" }];
      const direct = discovery.startsWith("direct-");
      const bound = [{ kind: "lan" as const, httpBaseUrl: "http://192.168.1.10:3773/" }];
      const endpoints = [
        ...bound,
        { kind: "tailnet" as const, httpBaseUrl: "https://test.ts.net/" },
      ];
      const directStarted = yield* Deferred.make<void>();
      const finishDirect = yield* Deferred.make<void>();
      const directStopped = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.undefined,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () =>
            Deferred.succeed(remoteDiscoveryStarted, undefined).pipe(
              Effect.andThen(
                discovery === "cached" || direct
                  ? Effect.void
                  : Deferred.await(finishRemoteDiscovery),
              ),
              Effect.as(targets),
            ),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({
          resolveAvailable: () => Effect.succeed(discovery === "direct-cached" ? endpoints : bound),
          resolve: () =>
            direct
              ? Deferred.succeed(directStarted, undefined).pipe(
                  Effect.andThen(
                    discovery === "direct-cached" ? Effect.void : Deferred.await(finishDirect),
                  ),
                  Effect.andThen(
                    discovery === "direct-failed"
                      ? Effect.die("probe failed")
                      : Effect.succeed(endpoints),
                  ),
                  Effect.onExit(() => Deferred.succeed(directStopped, undefined)),
                )
              : Effect.succeed(bound),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
            secretReferences: true,
          }).pipe(
            Layer.provide(configRpcServices),
            Layer.provide(
              CurrentPrincipal.layer({
                sessionId: AuthSessionId.make("config-test"),
                subject: "config-test",
                method: "browser-session-cookie",
                scopes: [],
              }),
            ),
          ),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);
      assert.isTrue(yield* Deferred.isDone(remoteDiscoveryStarted));

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.deepEqual(
        snapshot.config.remoteOpenTargets,
        discovery === "cached" || direct ? targets : [],
      );
      assert.deepEqual(
        snapshot.config.directEndpoints,
        discovery === "direct-cached" ? endpoints : bound,
      );
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map((value) =>
        ServerSettings.redactServerSettingsForClient(value, { secretReferences: true }),
      );
      const expectedKeybindings = [duringAck.keybindings, latestKeybindings.keybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      if (discovery === "pending") {
        yield* Deferred.await(remoteDiscoveryStarted);
        yield* Deferred.succeed(finishRemoteDiscovery, undefined);
        const resolved = yield* Queue.take(responses);
        assert.equal(resolved.type, "snapshot");
        if (resolved.type !== "snapshot") return yield* Effect.die("Missing remote targets");
        assert.deepEqual(resolved.config.remoteOpenTargets, targets);
        assert.deepEqual(
          resolved.config.settings,
          ServerSettings.redactServerSettingsForClient(latestSettings, { secretReferences: true }),
        );
        assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
        yield* acknowledge;
      }
      if (direct) {
        yield* Deferred.await(directStarted);
        if (discovery === "direct-pending") {
          yield* Deferred.succeed(finishDirect, undefined);
          const resolved = yield* Queue.take(responses);
          assert.equal(resolved.type, "snapshot");
          if (resolved.type !== "snapshot") return yield* Effect.die("Missing direct endpoints");
          assert.deepEqual(resolved.config.directEndpoints, endpoints);
          assert.deepEqual(
            resolved.config.settings,
            ServerSettings.redactServerSettingsForClient(latestSettings, {
              secretReferences: true,
            }),
          );
          assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
          yield* acknowledge;
        } else if (discovery === "direct-failed") {
          yield* Deferred.succeed(finishDirect, undefined);
          yield* Deferred.await(directStopped);
          yield* settings.updateSettings({ defaultAutoPull: false });
          const event = yield* Queue.take(responses);
          assert.equal(event.type, "settingsUpdated");
          yield* acknowledge;
        }
      }
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
      if (direct) yield* Deferred.await(directStopped);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerOwnerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect("on-demand clients get provider config without workspace snapshots", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const snapshotFor = (cwd: string, checkedAt: string) => ({
      cwd,
      checkedAt,
      slashCommands: [{ name: `${cwd.slice(1)}-command` }],
      skills: [],
    });
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-25T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "machine-command" }],
      skills: [],
      workspaceSnapshots: [
        snapshotFor("/a", "2026-10-25T00:00:00.000Z"),
        snapshotFor("/b", "2026-10-25T00:00:00.000Z"),
      ],
    };
    const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const pulled = yield* Queue.unbounded<void>();
    const responses = yield* Queue.unbounded<unknown>();
    const configRpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.undefined,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.fromQueue(providerChanges).pipe(
          Stream.tap(() => Queue.offer(pulled, undefined)),
        ),
        refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([]),
        streamChanges: Stream.make([]),
      }),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
        resolveTargets: () => Effect.succeed([]),
      }),
      Layer.mock(DirectEndpoints.DirectEndpoints)({
        resolve: () => Effect.succeed([]),
        resolveAvailable: () => Effect.succeed([]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedNone,
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("config-test"),
          label: "Config test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        getDescriptor: () =>
          Effect.succeed({
            policy: "loopback-browser",
            bootstrapMethods: [],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "config-test-session",
          }),
      }),
    );
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(WsSubscribeServerConfigRpc, WsServerRefreshProvidersRpc),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
                discard: true,
              })
            : response._tag === "Exit" && response.exit._tag === "Success"
              ? Queue.offer(responses, response.exit.value)
              : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
          secretReferences: true,
        }).pipe(
          Layer.provide(configRpcServices),
          Layer.provide(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            }),
          ),
        ),
      ),
    );
    const configRequest = RpcMessage.RequestId("config");
    yield* server.write(0, {
      _tag: "Request",
      id: configRequest,
      tag: WS_METHODS.subscribeServerConfig,
      payload: { workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const snapshot = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
    assert.isUndefined(snapshot.config.providers[0]?.workspaceSnapshots);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });

    // A rescan that only touches a snapshot sends nothing; the next real change does.
    yield* Queue.offer(providerChanges, [
      { ...provider, workspaceSnapshots: [snapshotFor("/a", "2026-10-25T00:05:00.000Z")] },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(providerChanges, [{ ...provider, status: "warning" }]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const update = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (update.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.equal(update.payload.providers[0]?.status, "warning");
    assert.isUndefined(update.payload.providers[0]?.workspaceSnapshots);

    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { instanceId, cwd: "/b", workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const refreshed = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(
      refreshed.providers.map((entry) => [entry.workspaceSnapshots, entry.slashCommands]),
      [[[snapshotFor("/b", "2026-10-25T00:00:00.000Z")], []]],
    );
    yield* server.write(0, { _tag: "Interrupt", requestId: configRequest, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerOwnerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

// Pruned history cannot be replayed: a cursor below the boundary must resync from a snapshot.
it.effect.each(["thread", "shell"] as const)(
  "%s resume from a cursor below the pruned boundary loads a snapshot",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:pruned");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`pruned:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:pruned", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.die("replay"),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
      );
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A prune pass can delete replayed rows after the boundary check; the read must not be trusted.
it.effect.each(["thread", "shell"] as const)(
  "%s resume loads a snapshot when pruning advances during the replay read",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:prune-race");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`prune-race:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:race", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);

      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      let gated = false;
      const gateReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        // The paged replay read (readApplicationRows), not the stats or high-water queries.
        if (!gated && /^\s*SELECT\s+sequence,\s+event_id,/.test(query)) {
          gated = true;
          return Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, gateReplayRead),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
        Effect.forkChild,
      );
      const fiber = yield* subscription;
      yield* Deferred.await(readStarted);
      // A pass publishes its boundary, then deletes the rows it covers.
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${second!.sequence}`;
      yield* Deferred.succeed(releaseRead, undefined);
      const exit = yield* Fiber.join(fiber);
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A thread idle since before the boundary missed nothing; resuming must not resend its body.
it.effect("thread resume at its own high-water below the pruned boundary skips the snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:idle");
    const [last] = yield* sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'idle:0', 'thread', ${threadId}, 0, 'provider-session.detached',
        ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:idle", detachedAt: now })},
        '{}', 2
      ) RETURNING sequence
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${last!.sequence + 10}, ${now})
    `;
    const exit = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: last!.sequence,
    }).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshot: () => Effect.die("snapshot"),
        streamStoredEventsFrom: () => Stream.empty,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.exit,
    );
    // A snapshot load dies with "snapshot", so success means the resume replayed nothing.
    assert.isTrue(Exit.isSuccess(exit));
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("sends a new Thread on as the session's User, whatever owner the client names", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2Command> = [];
    const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const rpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: (effect) => effect,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2Command);
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
    );
    const dispatchRpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)!;
    const server = yield* RpcServer.makeNoSerialization(RpcGroup.make(dispatchRpc), {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Exit" ? Queue.offer(exits, response.exit) : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
          secretReferences: true,
        }).pipe(
          Layer.provideMerge(RpcAuthorization.layer),
          Layer.provide(rpcServices),
          Layer.provide(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make("member-session"),
              subject: "user-sign-in",
              userId: UserId.make("member-1"),
              method: "browser-session-cookie",
              scopes: [AuthOrchestrationOperateScope],
            }),
          ),
        ),
      ),
    );
    const createThread = Effect.fn(function* (id: string, extra: Record<string, unknown>) {
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(id),
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${id}`),
          threadId: ThreadId.make(`thread:${id}`),
          projectId: ProjectId.make("project:scratch"),
          title: "Hello",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...extra,
        },
        headers: Headers.empty,
      });
      return yield* Queue.take(exits);
    });

    const accepted = yield* createThread("acme", { spaceId: "org-acme", ownerUserId: "owner" });
    assert.isTrue(Exit.isSuccess(accepted));
    const created = dispatched[0];
    assert.equal(created?.type, "thread.create");
    if (created?.type !== "thread.create") return;
    assert.deepEqual([created.spaceId, created.ownerUserId], ["org-acme", "member-1"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerOwnerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

describe("Space visibility", () => {
  const PASSWORD = "correct horse battery";
  const read = [
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    WS_METHODS.pullRequestsList,
    WS_METHODS.scheduledTasksSubscribe,
    WS_METHODS.subscribeTerminalMetadata,
    WS_METHODS.terminalWrite,
    WS_METHODS.terminalOpen,
    WS_METHODS.projectsReadFile,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.filesystemBrowse,
    WS_METHODS.vcsListRefs,
    WS_METHODS.filesystemGetMetadata,
    WS_METHODS.mcpAppsCallTool,
    WS_METHODS.mcpAppsUpdateModelContext,
    WS_METHODS.secretsAnswerRequest,
    ORCHESTRATION_V2_WS_METHODS.forceStopThread,
    WS_METHODS.serverGetProcessDiagnostics,
    WS_METHODS.serverSignalProcess,
    WS_METHODS.serverGetTraceDiagnostics,
    WS_METHODS.serverUpdateSettings,
    WS_METHODS.serverUpsertKeybinding,
    WS_METHODS.providerAuthStart,
    WS_METHODS.deviceConfigure,
    WS_METHODS.deviceAction,
    WS_METHODS.deviceList,
    WS_METHODS.deviceDetail,
    WS_METHODS.agentSessionsScan,
    WS_METHODS.sourceControlCloneRepository,
    WS_METHODS.projectCloneStart,
    WS_METHODS.projectCloneCancel,
    WS_METHODS.projectCloneRetry,
    WS_METHODS.subscribeProjectClones,
    WS_METHODS.attachmentsCreateUploadUrl,
    WS_METHODS.attachmentsDelete,
    WS_METHODS.subscribeDiscoveredLocalServers,
    WS_METHODS.previewStopLocalServer,
    WS_METHODS.assetsCreateUrl,
    WS_METHODS.pullRequestsRunAction,
    WS_METHODS.pullRequestsDetail,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, (typeof read)[number]> =>
        !(read as ReadonlyArray<string>).includes(tag),
    ),
  );

  const threadCreated = (input: {
    readonly id: string;
    readonly projectId: string;
    readonly spaceId?: string;
    readonly ownerUserId?: string;
    readonly worktreePath?: string;
  }) => {
    const id = ThreadId.make(input.id);
    const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const payload: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: ProjectId.make(input.projectId),
      title: input.id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath ?? "/wt/shared",
      activeProviderThreadId: null,
      ...(input.spaceId === undefined ? {} : { spaceId: SpaceId.make(input.spaceId) }),
      ...(input.ownerUserId === undefined ? {} : { ownerUserId: UserId.make(input.ownerUserId) }),
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: EventId.make(`create-${input.id}`),
      type: "thread.created" as const,
      threadId: id,
      providerInstanceId,
      occurredAt: at,
      payload,
    };
  };

  /** The Owner with Acme (Grace is a Member) and Globex (Linus is a Member), work in each. */
  const hub = Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = created.cookie ?? "";
    const organization = (name: string) =>
      server
        .request("/api/spaces/organizations", { body: { name }, cookie: owner })
        .pipe(Effect.map((response) => response.body.id as string));
    const acme = yield* organization("Acme");
    const globex = yield* organization("Globex");
    const member = Effect.fn(function* (spaceId: string, loginName: string) {
      const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
        body: { role: "member" },
        cookie: owner,
      });
      const accepted = yield* server.request("/api/invitations/accept", {
        body: {
          token: invitation.body.token,
          method: "password",
          displayName: loginName,
          loginName,
          password: PASSWORD,
        },
      });
      const [row] = yield* server.sql<{ userId: string }>`
        SELECT user_id AS "userId" FROM users WHERE display_name = ${loginName}
      `;
      return { cookie: accepted.cookie ?? "", userId: UserId.make(row!.userId) };
    });
    const grace = yield* member(acme, "grace");
    const linus = yield* member(globex, "linus");
    const project = (id: string, spaceId: string) =>
      server.request("/api/projects/mutate", {
        cookie: owner,
        body: {
          type: "project.create",
          commandId: `create-${id}`,
          projectId: id,
          title: id,
          workspaceRoot: `/work/${id}`,
          spaceId,
        },
      });
    assert.equal((yield* project("acme-app", acme)).status, 200);
    assert.equal((yield* project("globex-app", globex)).status, 200);
    // A Project from before Spaces: the Owner's Personal space.
    yield* server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('legacy-app', 'legacy-app', '/work/legacy', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `;
    yield* server.eventSink.write({
      events: [
        threadCreated({ id: "acme-thread", projectId: "acme-app", spaceId: acme }),
        // Unstamped (like an agent's child): it follows its Project's Space.
        threadCreated({ id: "acme-child", projectId: "acme-app" }),
        threadCreated({ id: "globex-thread", projectId: "globex-app", spaceId: globex }),
        threadCreated({ id: "legacy-thread", projectId: "legacy-app" }),
      ],
    });
    return { server, owner, acme, globex, grace, linus };
  });

  // The production RPC layer and authorization middleware for one connection of this User.
  const connect = Effect.fn(function* (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId | undefined,
    overrides: Layer.Layer<never> = Layer.empty,
    scopes: ReadonlyArray<AuthEnvironmentScope> = [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthTerminalReadScope,
      AuthTerminalOperateScope,
      AuthFilesystemReadScope,
      AuthFilesystemWriteScope,
    ],
  ) {
    const browser = yield* ServerBrowser.ServerBrowser;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          layerWsRpc(browser, () => Effect.void, { secretReferences: true }),
          RpcAuthorization.layer,
        ).pipe(
          Layer.provideMerge(SpaceVisibility.layerCurrentViewer),
          Layer.provideMerge(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make(`session-${userId}`),
              subject: "user-sign-in",
              ...(userId === undefined ? {} : { userId }),
              method: "browser-session-cookie",
              scopes,
            }),
          ),
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(UsageLimitSources.UsageLimitSources)({}),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
              Layer.mock(DirectEndpoints.DirectEndpoints)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: process.cwd(),
              }),
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
              Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
              // The real Spaces, Projects and Thread reads over the hub's database.
              Layer.succeedContext(server.services),
              overrides,
            ),
          ),
        ),
      ),
    );
  });

  const shellIds = (snapshot: {
    readonly projects: ReadonlyArray<{ readonly id: string }>;
    readonly threads: ReadonlyArray<{ readonly id: string }>;
  }) => ({
    projects: snapshot.projects.map((project) => project.id).toSorted(),
    threads: snapshot.threads.map((thread) => thread.id).toSorted(),
  });

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "each User sees only their Spaces' work in snapshots, live deltas, RPCs, HTTP and MCP",
    () =>
      Effect.gen(function* () {
        const { server, owner, globex, grace, linus } = yield* hub;
        const acmeWork = { projects: ["acme-app"], threads: ["acme-child", "acme-thread"] };

        // HTTP: the shell, the project list, and a single Thread.
        const httpShell = (cookie: string) =>
          server
            .request("/api/orchestration/shell", { cookie })
            .pipe(Effect.map((response) => shellIds(response.body as never)));
        assert.deepEqual(yield* httpShell(grace.cookie), acmeWork);
        assert.deepEqual(yield* httpShell(linus.cookie), {
          projects: ["globex-app"],
          threads: ["globex-thread"],
        });
        assert.deepEqual(yield* httpShell(owner), {
          projects: ["acme-app", "globex-app", "legacy-app"],
          threads: ["acme-child", "acme-thread", "globex-thread", "legacy-thread"],
        });
        const projects = yield* server.request("/api/projects", { cookie: grace.cookie });
        assert.deepEqual(
          (projects.body.projects as ReadonlyArray<{ id: string }>).map((project) => project.id),
          ["acme-app"],
        );
        const hidden = yield* server.request("/api/orchestration/threads/globex-thread", {
          cookie: grace.cookie,
        });
        const missing = yield* server.request("/api/orchestration/threads/no-such-thread", {
          cookie: grace.cookie,
        });
        assert.equal(hidden.status, 404);
        const { traceId: _hiddenTrace, ...hiddenBody } = hidden.body;
        const { traceId: _missingTrace, ...missingBody } = missing.body;
        assert.deepEqual([hidden.status, hiddenBody], [missing.status, missingBody]);

        // WebSocket: the shell snapshot, then live deltas.
        const client = yield* connect(server, grace.userId);
        const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
          requestCompletionMarker: true,
        }).pipe(
          Stream.runForEach((item) => Queue.offer(items, item)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(items);
        assert.equal(first.kind, "snapshot");
        if (first.kind !== "snapshot") return;
        assert.deepEqual(shellIds(first.snapshot), acmeWork);
        // Enrichment refreshes may follow; they name only visible Projects too.
        for (let item = yield* Queue.take(items); item.kind !== "synchronized";) {
          if (item.kind === "snapshot") {
            for (const project of item.snapshot.projects) assert.equal(project.id, "acme-app");
          }
          item = yield* Queue.take(items);
        }
        // Globex's new Thread comes first in the log; Grace's stream must skip it.
        yield* server.eventSink.write({
          events: [
            threadCreated({ id: "globex-late", projectId: "globex-app", spaceId: globex }),
            threadCreated({ id: "acme-late", projectId: "acme-app" }),
          ],
        });
        const seen: Array<string> = [];
        while (!seen.includes("acme-late")) {
          const item = yield* Queue.take(items);
          if (item.kind === "thread.updated") seen.push(item.thread.id);
          if (item.kind === "thread.removed") seen.push(item.threadId);
          if (item.kind === "project.updated") seen.push(item.project.id);
        }
        assert.deepEqual(seen, ["acme-late"]);

        // A single-resource read of a hidden Thread fails exactly like a missing one.
        const projection = (threadId: string) =>
          client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make(threadId),
          }).pipe(Effect.flip);
        const hiddenRpc = yield* projection("globex-thread");
        assert.equal(hiddenRpc._tag, "SpaceResourceNotFoundError");
        assert.deepEqual(hiddenRpc, yield* projection("no-such-thread"));
        const worktreeThreads = client[ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]({
          worktreePath: "/wt/shared",
        }).pipe(Effect.map(({ threadIds }) => [...threadIds].toSorted()));
        assert.deepEqual(yield* worktreeThreads, ["acme-child", "acme-late", "acme-thread"]);

        // Joining Globex shows its work on the same connection.
        const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
        yield* spaces.addMembership({
          spaceId: SpaceId.make(globex),
          userId: grace.userId,
          role: "member",
        });
        yield* spaces.changed;
        assert.deepEqual(yield* worktreeThreads, [
          "acme-child",
          "acme-late",
          "acme-thread",
          "globex-late",
          "globex-thread",
        ]);

        // MCP: a caller with no User reads as the Owner; one acting as Linus reads as Linus.
        const shells = (yield* Context.get(
          server.services,
          ThreadManagement.ThreadManagementService,
        ).getShellSnapshot()).threads;
        const mcpRead = (scope: { readonly userId?: UserId }) =>
          visibleShells(scope, shells).pipe(
            Effect.map((visible) => visible.map((shell) => shell.id).toSorted()),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        assert.deepEqual(yield* mcpRead({}), [
          "acme-child",
          "acme-late",
          "acme-thread",
          "globex-late",
          "globex-thread",
          "legacy-thread",
        ]);
        assert.deepEqual(yield* mcpRead({ userId: linus.userId }), [
          "globex-late",
          "globex-thread",
        ]);

        // A Pull Request diff in a hidden Project answers like one in a missing Project.
        const diff = (projectId: string) =>
          server.request("/api/pull-requests/diff", {
            cookie: grace.cookie,
            body: { projectId, repository: "acme/app", number: 1 },
          });
        // Grace now sees Globex; the Owner's Personal space stays hidden from her.
        const hiddenDiff = yield* diff("legacy-app");
        const missingDiff = yield* diff("no-such-project");
        assert.equal(hiddenDiff.body._tag, "PullRequestUnavailableError");
        const { traceId: _hiddenDiffTrace, ...hiddenDiffBody } = hiddenDiff.body;
        const { traceId: _missingDiffTrace, ...missingDiffBody } = missingDiff.body;
        assert.deepEqual(
          [hiddenDiff.status, hiddenDiffBody],
          [missingDiff.status, missingDiffBody],
        );

        // An agent that pastes a bare id is pointed at the `mcp:` Thread only if it may see it.
        yield* server.eventSink.write({
          events: [threadCreated({ id: "mcp:hint", projectId: "legacy-app" })],
        });
        const hint = (scope: { readonly userId?: UserId }) =>
          threadNotFound(
            Context.get(server.services, ThreadManagement.ThreadManagementService),
            ThreadId.make("hint"),
            "Not found.",
          ).pipe(
            Effect.flip,
            Effect.map((failure) => failure.message),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope as never),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        assert.equal(yield* hint({}), "Not found. Did you mean `mcp:hint`?");
        assert.equal(yield* hint({ userId: grace.userId }), "Not found.");

        // An archived Organization disappears for its Members, not for the Owner.
        yield* server.sql`
          UPDATE spaces SET archived_at = '2026-11-02T00:00:00.000Z' WHERE space_id = ${globex}
        `;
        assert.deepEqual(yield* httpShell(linus.cookie), { projects: [], threads: [] });
        assert.include((yield* httpShell(owner)).projects, "globex-app");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.fresh(layerConfigSources),
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
            Layer.mock(ServerBrowser.ServerBrowser)({}),
          ),
        ),
      ),
  );

  const withHub = <A, E, R>(body: (seeded: Effect.Success<typeof hub>) => Effect.Effect<A, E, R>) =>
    hub.pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "removing a Member closes their sockets, and their shell resumes without the Organization",
    () =>
      Effect.gen(function* () {
        const { server, owner, acme, grace } = yield* hub;
        const graceAgain = yield* server.request("/api/auth/password/sign-in", {
          body: { loginName: "grace", password: PASSWORD },
        });
        // A second Member of Acme, whose access does not change.
        const invitation = yield* server.request(`/api/spaces/${acme}/invitations`, {
          body: { role: "member" },
          cookie: owner,
        });
        yield* server.request("/api/invitations/accept", {
          body: {
            token: invitation.body.token,
            method: "password",
            displayName: "hedy",
            loginName: "hedy",
            password: PASSWORD,
          },
        });
        const [hedyRow] = yield* server.sql<{ userId: string }>`
        SELECT user_id AS "userId" FROM users WHERE display_name = 'hedy'
      `;
        const hedy = UserId.make(hedyRow!.userId);
        const sessionOf = Effect.fn(function* (userId: UserId) {
          const [row] = yield* server.sql<{ sessionId: string }>`
          SELECT session_id AS "sessionId" FROM auth_sessions
          WHERE user_id = ${userId} AND revoked_at IS NULL LIMIT 1
        `;
          return {
            sessionId: AuthSessionId.make(row!.sessionId),
            subject: "user-sign-in",
            userId,
            method: "browser-session-cookie" as const,
            scopes: [],
          };
        });
        const socketEnds = (userId: UserId) =>
          sessionOf(userId).pipe(
            Effect.flatMap(connectionEnds),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        const graceSocket = yield* (yield* socketEnds(grace.userId)).pipe(Effect.forkScoped);
        const hedySocket = yield* (yield* socketEnds(hedy)).pipe(Effect.forkScoped);

        const firstShell = Effect.fn(function* (
          userId: UserId,
          input: { readonly afterSequence?: number },
        ) {
          const client = yield* connect(server, userId);
          const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            ...input,
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          return yield* Queue.take(items);
        });
        const before = yield* firstShell(grace.userId, {});
        assert.equal(before.kind, "snapshot");
        if (before.kind !== "snapshot") return;
        assert.deepEqual(shellIds(before.snapshot), {
          projects: ["acme-app"],
          threads: ["acme-child", "acme-thread"],
        });

        // A change to the Role someone already has changes nothing, so their sockets stay.
        const unchanged = yield* server.request(`/api/spaces/${acme}/members/role`, {
          body: { userId: hedy, role: "member" },
          cookie: owner,
        });
        assert.equal(unchanged.status, 200);
        const removed = yield* server.request(`/api/spaces/${acme}/members/remove`, {
          body: { userId: grace.userId },
          cookie: owner,
        });
        assert.equal(removed.status, 200);
        // Every socket of hers closes, whichever browser opened it; Hedy's stays open.
        yield* Fiber.join(graceSocket);
        assert.isUndefined(hedySocket.pollUnsafe());
        assert.equal(yield* isSignedIn(server, graceAgain.cookie), true);

        // Reconnecting from where her shell was, she gets a fresh snapshot without Acme.
        const resumed = yield* firstShell(grace.userId, {
          afterSequence: before.snapshot.snapshotSequence,
        });
        assert.equal(resumed.kind, "snapshot");
        if (resumed.kind !== "snapshot") return;
        assert.isUndefined(resumed.resolvedRepositoryIdentityRoots);
        assert.deepEqual(shellIds(resumed.snapshot), { projects: [], threads: [] });
        // Others resume as before: no authoritative snapshot.
        const hedyResumed = yield* firstShell(hedy, {
          afterSequence: before.snapshot.snapshotSequence,
        });
        assert.isFalse(
          hedyResumed.kind === "snapshot" &&
            hedyResumed.resolvedRepositoryIdentityRoots === undefined,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.fresh(layerConfigSources),
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
            Layer.mock(ServerBrowser.ServerBrowser)({}),
          ),
        ),
      ),
  );

  it.effect("a command on a hidden Thread or Project fails exactly like one on a missing one", () =>
    withHub(({ server, grace }) =>
      Effect.gen(function* () {
        const client = yield* connect(server, grace.userId);
        const archive = (threadId: string) =>
          client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make(`archive-${threadId}`),
            threadId: ThreadId.make(threadId),
          } as never).pipe(Effect.flip);
        const hidden = yield* archive("globex-thread");
        assert.equal(hidden._tag, "SpaceResourceNotFoundError");
        assert.deepEqual(hidden, yield* archive("no-such-thread"));
        // A new Thread in a hidden Project is refused the same way.
        const created = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("create-in-globex"),
          threadId: ThreadId.make("new-thread"),
          projectId: ProjectId.make("globex-app"),
          title: "Hello",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }).pipe(Effect.flip);
        assert.deepEqual(created, hidden);
      }),
    ),
  );

  it.effect(
    "listings that name no Project see only the viewer's, streams skip hidden Threads",
    () =>
      withHub(({ server, grace }) =>
        Effect.gen(function* () {
          const listed: Array<unknown> = [];
          const task = (id: string, projectId: string, threadId: string | null) =>
            ({ id, projectId, threadId, prompt: id }) as never;
          const client = yield* connect(
            server,
            grace.userId,
            Layer.mergeAll(
              Layer.mock(PullRequestService.PullRequestService)({
                list: (input) =>
                  Effect.sync(() => {
                    listed.push(input.projectIds);
                    return { pullRequests: [] } as never;
                  }),
              }),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({
                subscribeList: () =>
                  Stream.make({
                    tasks: [
                      task("acme-task", "acme-app", "acme-thread"),
                      task("globex-task", "globex-app", null),
                      task("acme-on-hidden", "acme-app", "globex-thread"),
                    ],
                  }),
              }),
              Layer.mock(TerminalManager.TerminalManager)({
                subscribeMetadata: (listener) =>
                  listener({
                    type: "snapshot",
                    terminals: ["acme-thread", "globex-thread", "draft-thread"].map(
                      (threadId) => ({ threadId, terminalId: "t", cwd: "/work" }) as never,
                    ),
                  }).pipe(Effect.as(() => undefined)),
              }),
            ),
          );
          yield* client[WS_METHODS.pullRequestsList]({ state: "open" } as never);
          assert.deepEqual(listed, [["acme-app"]]);
          const [tasks] = yield* client[WS_METHODS.scheduledTasksSubscribe]({} as never).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.deepEqual(
            tasks?.tasks.map((item) => item.id),
            ["acme-task"],
          );
          const [terminals] = yield* client[WS_METHODS.subscribeTerminalMetadata]({} as never).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          // Terminals are their Thread owner's: the Owner's Thread and a draft nobody holds are
          // not Grace's to see.
          assert.deepEqual(
            terminals?.type === "snapshot"
              ? terminals.terminals.map((item) => item.threadId)
              : null,
            [],
          );
        }),
      ),
  );
  // The real orchestrator and Thread services over the hub's database: every transport's
  // commands meet the Role rules there, so these run the production path end to end.
  const codex = ProviderInstanceId.make("codex");
  const codexInstance = {
    instanceId: codex,
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
    },
    displayName: "Codex",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) },
    orchestrationAdapter: {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("no provider turn runs in these tests"),
    },
    textGeneration: {},
  } as never;
  const layerOrchestration = (server: Effect.Success<typeof serveAuthHttp>) =>
    RuntimeLayer.layer.pipe(
      Layer.provide(ProviderTurnStartServiceTestkit.layer),
      Layer.provide(McpSessionRegistryTestkit.layer),
      Layer.provide(McpProviderSessions.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("no title links in these tests"),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codex ? codexInstance : undefined),
            listInstances: Effect.succeed([codexInstance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
        ),
      ),
      Layer.provide(Layer.succeedContext(server.services)),
    );

  // Ada is Acme's Admin and Gus its Guest; Grace, a Member, owns grace-thread. acme-thread,
  // which names no owner, is the Owner's.
  const team = hub.pipe(
    Effect.flatMap((seeded) =>
      Effect.gen(function* () {
        const { server, acme, grace } = seeded;
        yield* server.eventSink.write({
          events: [
            threadCreated({
              id: "grace-thread",
              projectId: "acme-app",
              spaceId: acme,
              ownerUserId: grace.userId,
            }),
          ],
        });
        const adaCookie = yield* addMember(server, { id: "ada", displayName: "Ada" });
        yield* joinOrganization(server, acme, "ada", "admin");
        // An Admin's rights need a passkey or an authenticator app.
        yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
            transports, rp_id, created_at)
          VALUES ('ada-key', 'ada', 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
        const gusCookie = yield* addMember(server, { id: "gus", displayName: "Gus" });
        yield* joinOrganization(server, acme, "gus", "guest");
        return {
          ...seeded,
          ada: { cookie: adaCookie, userId: UserId.make("ada") },
          gus: { cookie: gusCookie, userId: UserId.make("gus") },
        };
      }),
    ),
  );
  const withTeam = <A, E, R>(
    body: (seeded: Effect.Success<typeof team>) => Effect.Effect<A, E, R>,
  ) =>
    team.pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    );
  const connectWriter = (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId | undefined,
    scopes?: ReadonlyArray<AuthEnvironmentScope>,
  ) =>
    connect(
      server,
      userId,
      Layer.mergeAll(
        layerOrchestration(server),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand: (effect) => effect,
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          write: () => Effect.void,
          // A shell reports what it started with (spec 5 ticket 07); the Hub admits it on that.
          open: (input, start) =>
            Effect.succeed({
              threadId: input.threadId,
              terminalId: input.terminalId,
              ...(start.facts === null ? {} : { facts: start.facts }),
            } as never),
        }),
        SecretRequests.layer.pipe(
          Layer.provide(layerOrchestration(server)),
          Layer.provide(
            Layer.succeed(ServerSecretStore.ServerSecretStore, {
              getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
            } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
          ),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      // Undefined keeps connect's default (every scope a writer holds).
      scopes,
    );
  type Writer = Effect.Success<ReturnType<typeof connectWriter>>;
  let sent = 0;
  const dispatch = (client: Writer, command: Record<string, unknown>) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      commandId: CommandId.make(`${String(command.type)}-${(sent += 1)}`),
      ...command,
    } as never).pipe(Effect.result);
  const refusal = (result: Result.Result<unknown, unknown>) =>
    Result.isFailure(result) ? ((result.failure as { detail?: string }).detail ?? null) : null;
  const receiptActor = (server: Effect.Success<typeof serveAuthHttp>, commandId: string) =>
    server.sql<{ actor: string | null }>`
      SELECT actor_user_id AS actor FROM orchestration_command_receipts
      WHERE command_id = ${commandId}
    `.pipe(Effect.map((rows) => rows[0]?.actor));

  it.effect("only a Thread's owner continues it; Admins archive and stop others' Threads", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const message = (threadId: string) => ({
          type: "message.dispatch",
          threadId,
          messageId: MessageId.make(`message-${threadId}`),
          text: "Hi",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        // Grace sees the Owner's Thread, so she is told why rather than that it is missing.
        assert.equal(
          refusal(yield* dispatch(asGrace, message("acme-thread"))),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // Answering its agent's approval acts in the owner's live session too.
        assert.equal(
          refusal(
            yield* dispatch(asGrace, {
              type: "runtime-request.respond",
              threadId: "acme-thread",
              requestId: "approval-1",
              decision: "accept",
            }),
          ),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // Not even an Admin continues someone else's Thread.
        assert.isNotNull(refusal(yield* dispatch(asAda, message("grace-thread"))));
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.archive", threadId: "acme-thread" })) ??
            "",
          /Only its creator or an Admin/,
        );
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.stop", threadId: "acme-thread" })) ?? "",
          /Only its creator or an Admin/,
        );
        const forceStop = yield* asGrace[ORCHESTRATION_V2_WS_METHODS.forceStopThread]({
          threadId: ThreadId.make("acme-thread"),
        } as never).pipe(Effect.flip);
        assert.include(forceStop.message, "Only the Thread's creator or an Admin");

        // The Admin stops and archives it; Grace archives her own.
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.stop", threadId: "acme-thread" }),
          ),
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.archive", threadId: "acme-thread" }),
          ),
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asGrace, { type: "thread.archive", threadId: "grace-thread" }),
          ),
        );
        // Deleting for good is the Admin's alone.
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.delete", threadId: "grace-thread" })) ??
            "",
          /Only an Admin/,
        );
      }),
    ),
  );

  it.effect("the server stamps the acting User on every receipt; a client cannot set it", () =>
    withTeam(({ server, owner, grace }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const commandId = CommandId.make("grace-pins");
        const pinned = yield* asGrace[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pin",
          commandId,
          threadId: ThreadId.make("grace-thread"),
          // A forged actor is dropped by the schema; the session decides.
          actorUserId: "someone-else",
        } as never).pipe(Effect.result);
        assert.isTrue(Result.isSuccess(pinned));
        assert.equal(yield* receiptActor(server, commandId), grace.userId);
        // Over HTTP too: the Project the Owner creates carries the Owner.
        const created = yield* server.request("/api/projects/mutate", {
          cookie: owner,
          body: {
            type: "project.create",
            commandId: "owner-creates",
            projectId: "owner-app",
            title: "owner-app",
            workspaceRoot: "/work/owner-app",
          },
        });
        assert.equal(created.status, 200);
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        assert.equal(yield* receiptActor(server, "owner-creates"), ownerRow?.userId);
      }),
    ),
  );

  it.effect("Project rules hold over HTTP: Guests create none, Members archive only theirs", () =>
    withTeam(({ server, acme, grace, gus, ada }) =>
      Effect.gen(function* () {
        const mutate = (cookie: string, body: Record<string, unknown>) =>
          server.request("/api/projects/mutate", { cookie, body });
        const guestCreates = yield* mutate(gus.cookie, {
          type: "project.create",
          commandId: "gus-creates",
          projectId: "gus-app",
          title: "gus-app",
          workspaceRoot: "/work/gus-app",
          spaceId: acme,
        });
        assert.notEqual(guestCreates.status, 200);
        // acme-app is the Owner's: Grace may not archive it, Ada may.
        const graceArchives = yield* mutate(grace.cookie, {
          type: "project.update",
          commandId: "grace-archives",
          projectId: "acme-app",
          archived: true,
        });
        assert.notEqual(graceArchives.status, 200);
        assert.include(JSON.stringify(graceArchives.body), "Only its creator or an Admin");
        const adaArchives = yield* mutate(ada.cookie, {
          type: "project.update",
          commandId: "ada-archives",
          projectId: "acme-app",
          archived: true,
        });
        assert.equal(adaArchives.status, 200);
      }),
    ),
  );

  describe("folder roots come from the Hub's own records", () => {
    const ownerOf = (server: Effect.Success<typeof serveAuthHttp>) =>
      server.sql<{ userId: string }>`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`.pipe(
        Effect.map((rows) => UserId.make(rows[0]!.userId)),
      );
    const messageOf = (body: unknown) => JSON.stringify(body);

    it.effect(
      "only the Owner roots a Project outside a new folder in the Hub's Projects folder",
      () =>
        withTeam(({ server, owner, acme, grace, ada, gus }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const config = Context.get(server.services, ServerConfigModule.ServerConfig);
            const projects = projectsRootOf(path, config.baseDir);
            yield* fs.makeDirectory(path.join(projects, "existing"), { recursive: true });
            let created = 0;
            const create = (cookie: string, workspaceRoot: string) =>
              server.request("/api/projects/mutate", {
                cookie,
                body: {
                  type: "project.create",
                  commandId: `roots-create-${(created += 1)}`,
                  projectId: `roots-project-${created}`,
                  title: "app",
                  workspaceRoot,
                  createWorkspaceRootIfMissing: true,
                  spaceId: acme,
                },
              });
            // Not the Hub's disk root, its data, an existing folder or one nested deeper.
            for (const who of [grace, ada]) {
              for (const root of [
                "/",
                config.baseDir,
                path.join(projects, "existing"),
                path.join(projects, "new-app", "inner"),
                "/work/acme-app/inside",
              ]) {
                const response = yield* create(who.cookie, root);
                assert.notEqual(response.status, 200, `${who.userId} at ${root}`);
                assert.include(messageOf(response.body), PROJECT_FOLDER_REFUSED);
              }
            }
            assert.notEqual((yield* create(gus.cookie, "/")).status, 200);
            // A new folder right in the Hub's Projects folder is what Members create.
            const members = yield* create(grace.cookie, path.join(projects, "grace-new"));
            assert.equal(members.status, 200, messageOf(members.body));
            const admins = yield* create(ada.cookie, path.join(projects, "ada-new"));
            assert.equal(admins.status, 200, messageOf(admins.body));
            // Nor does a Member move her own Project elsewhere afterwards.
            const moved = yield* server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.update",
                commandId: "roots-move-grace",
                projectId: `roots-project-${created - 1}`,
                workspaceRoot: "/",
              },
            });
            assert.notEqual(moved.status, 200);
            assert.include(messageOf(moved.body), PROJECT_FOLDER_CHANGE_REFUSED);
            // The same folder spelled another way is no move.
            const respelled = yield* server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.update",
                commandId: "roots-respell-grace",
                projectId: `roots-project-${created - 1}`,
                workspaceRoot: `${path.join(projects, "grace-new")}/`,
                title: "renamed",
              },
            });
            assert.equal(respelled.status, 200, messageOf(respelled.body));
            // Refused before the folder is looked at: a missing one answers the same.
            const toMissing = yield* server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.update",
                commandId: "roots-move-grace-missing",
                projectId: `roots-project-${created - 1}`,
                workspaceRoot: "/missing/folder",
              },
            });
            assert.include(messageOf(toMissing.body), PROJECT_FOLDER_CHANGE_REFUSED);
            // Nor names an icon outside her Project, which would be served from anywhere.
            const icon = yield* server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.update",
                commandId: "roots-icon-grace",
                projectId: `roots-project-${created - 1}`,
                faviconPath: "/etc/ssh/host.png",
              },
            });
            assert.notEqual(icon.status, 200);
            assert.include(messageOf(icon.body), "Only the Owner of this Hub can use an image");
            // The Owner uses any folder.
            assert.equal((yield* create(owner, "/srv/owner-app")).status, 200);
            assert.isDefined(yield* ownerOf(server));
          }),
        ),
    );

    it.effect(
      "a Thread's folder on the Hub machine is inside its Project or a worktree of its repository",
      () =>
        withTeam(({ server, owner, acme, grace, ada, gus }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-roots-project-" });
            const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3-roots-other-" });
            // A worktree of the Project's repository, as `git worktree add` records it, and one
            // of another repository.
            const linkWorktree = Effect.fn(function* (repository: string, name: string) {
              const worktree = path.join(elsewhere, name);
              const entry = path.join(repository, ".git", "worktrees", name);
              yield* fs.makeDirectory(worktree, { recursive: true });
              yield* fs.makeDirectory(entry, { recursive: true });
              yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${entry}\n`);
              yield* fs.writeFileString(path.join(entry, "gitdir"), `${worktree}/.git\n`);
              return worktree;
            });
            const ownWorktree = yield* linkWorktree(root, "feature");
            const foreignWorktree = yield* linkWorktree(elsewhere, "foreign");
            assert.equal(
              (yield* server.request("/api/projects/mutate", {
                cookie: owner,
                body: {
                  type: "project.create",
                  commandId: "roots-real",
                  projectId: "acme-real",
                  title: "acme-real",
                  workspaceRoot: root,
                  spaceId: acme,
                },
              })).status,
              200,
            );
            const ownerId = yield* ownerOf(server);
            yield* server.eventSink.write({
              events: [grace.userId, ada.userId, gus.userId, ownerId].map((userId) =>
                threadCreated({
                  id: `roots-${userId}`,
                  projectId: "acme-real",
                  spaceId: acme,
                  ownerUserId: userId,
                  worktreePath: root,
                }),
              ),
            });
            const services = yield* Layer.build(layerOrchestration(server));
            const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
            let sentCommands = 0;
            const setFolder = (actor: UserId, worktreePath: string) =>
              orchestrator
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`roots-folder-${(sentCommands += 1)}`),
                  threadId: ThreadId.make(`roots-${actor}`),
                  worktreePath,
                } as never)
                .pipe(
                  CommandActor.actAs(actor),
                  Effect.result,
                  Effect.map((result) =>
                    Result.isSuccess(result)
                      ? "set"
                      : (SpaceDirectory.spaceRefusalMessage(result.failure) ?? "failed"),
                  ),
                );
            for (const actor of [grace.userId, ada.userId]) {
              for (const folder of ["/", path.dirname(root), foreignWorktree]) {
                assert.deepEqual(
                  [actor, folder, yield* setFolder(actor, folder)],
                  [actor, folder, THREAD_WORKTREE_REFUSED],
                );
              }
              assert.equal(yield* setFolder(actor, path.join(root, "packages", "app")), "set");
              assert.equal(yield* setFolder(actor, ownWorktree), "set");
            }
            // What reaches the directory checks: Grace reads her Project, not the Hub's disk.
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const graceSees = yield* spaceVisibility.of(grace.userId);
            assert.isFalse(yield* spaceVisibility.mayReadDirectory(graceSees, "/etc"));
            assert.isFalse(yield* spaceVisibility.mayUseDirectory(graceSees, grace.userId, "/etc"));
            assert.isTrue(yield* spaceVisibility.mayReadDirectory(graceSees, ownWorktree));
            assert.notEqual(yield* setFolder(gus.userId, "/"), "set");
            // The Owner uses any folder.
            assert.equal(yield* setFolder(ownerId, "/srv/anywhere"), "set");
            // A new Thread on the Hub machine names its folder by the same rule.
            const createIn = (actor: UserId, worktreePath: string) =>
              orchestrator
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make(`roots-create-${(sentCommands += 1)}`),
                  threadId: ThreadId.make(`roots-new-${sentCommands}`),
                  projectId: ProjectId.make("acme-real"),
                  title: "new",
                  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath,
                  createdAt: "2026-11-01T00:00:00.000Z",
                } as never)
                .pipe(
                  CommandActor.actAs(actor),
                  Effect.result,
                  Effect.map((result) =>
                    Result.isSuccess(result)
                      ? "created"
                      : (SpaceDirectory.spaceRefusalMessage(result.failure) ?? "failed"),
                  ),
                );
            assert.equal(yield* createIn(grace.userId, "/"), THREAD_WORKTREE_REFUSED);
          }),
        ),
    );

    it.effect("another machine's folder counts as no folder of the Hub", () =>
      withTeam(({ server, acme, grace }) =>
        Effect.gen(function* () {
          yield* server.eventSink.write({
            events: [
              threadCreated({
                id: "grace-laptop",
                projectId: "acme-app",
                spaceId: acme,
                ownerUserId: grace.userId,
                worktreePath: "/",
              }),
            ],
          });
          yield* server.sql`
            UPDATE orchestration_v2_projection_threads SET active_environment_id = 'laptop'
            WHERE thread_id = 'grace-laptop'
          `;
          const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
          const graceSees = yield* spaceVisibility.of(grace.userId);
          assert.isFalse(yield* spaceVisibility.mayReadDirectory(graceSees, "/etc"));
          assert.isFalse(yield* spaceVisibility.mayUseDirectory(graceSees, grace.userId, "/etc"));
        }),
      ),
    );

    it.effect(
      "Scratch Threads keep their folders, whoever made the Scratch Project, but not the whole Scratch folder",
      () =>
        withTeam(({ server, owner, grace, ada }) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const config = Context.get(server.services, ServerConfigModule.ServerConfig);
            const scratch = path.resolve(config.baseDir, "scratch");
            const grant = (userId: string) =>
              server.request(`/api/installation/users/${userId}/permissions`, {
                cookie: owner,
                body: { permission: "personalSpace.create", granted: true },
              });
            assert.equal((yield* grant(grace.userId)).status, 200);
            assert.equal((yield* grant(ada.userId)).status, 200);
            // Grace was the first to ask for Scratch, so the Scratch Project is stamped hers.
            yield* server.sql`
              INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
                created_at, updated_at, space_id, owner_user_id)
              VALUES ('scratch', 'No project', ${scratch}, '[]', '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z', ${`personal:${grace.userId}`}, ${grace.userId})
            `;
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "ada-scratch",
                  projectId: "scratch",
                  spaceId: `personal:${ada.userId}`,
                  ownerUserId: ada.userId,
                  worktreePath: `${scratch}/2026-11-09-ada`,
                }),
              ],
            });
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const adaSees = yield* spaceVisibility.of(ada.userId);
            assert.isTrue(
              yield* spaceVisibility.mayReadDirectory(adaSees, `${scratch}/2026-11-09-ada/notes`),
            );
            assert.isTrue(
              yield* spaceVisibility.mayUseDirectory(
                adaSees,
                ada.userId,
                `${scratch}/2026-11-09-ada`,
              ),
            );
            // Grace sees the Scratch Project's Space, but not Ada's Scratch folder through it.
            const graceSees = yield* spaceVisibility.of(grace.userId);
            assert.isFalse(
              yield* spaceVisibility.mayReadDirectory(graceSees, `${scratch}/2026-11-09-ada`),
            );
            // A file call on Ada's Scratch Thread reaches the file services.
            const asAda = yield* connect(server, ada.userId);
            const read = yield* asAda[WS_METHODS.projectsReadFile]({
              threadId: "ada-scratch",
              cwd: `${scratch}/2026-11-09-ada`,
              relativePath: "notes.md",
            } as never).pipe(
              Effect.flip,
              Effect.map((error) => (error as { readonly _tag: string })._tag),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
            assert.notEqual(read, "SpaceResourceNotFoundError");
          }),
        ),
    );

    it.effect(
      "a Member's Scratch Thread takes only a folder of its own, never the Scratch folder or another User's",
      () =>
        withTeam(({ server, owner, grace, ada }) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const fs = yield* FileSystem.FileSystem;
            const config = Context.get(server.services, ServerConfigModule.ServerConfig);
            const scratch = path.resolve(config.baseDir, "scratch");
            const adaFolder = `${scratch}/2026-11-09-ada`;
            const graceFolder = `${scratch}/2026-11-09-grace`;
            yield* fs.makeDirectory(adaFolder, { recursive: true });
            yield* fs.makeDirectory(graceFolder, { recursive: true });
            for (const userId of [grace.userId, ada.userId]) {
              const granted = yield* server.request(
                `/api/installation/users/${userId}/permissions`,
                { cookie: owner, body: { permission: "personalSpace.create", granted: true } },
              );
              assert.equal(granted.status, 200);
            }
            yield* server.sql`
              INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
                created_at, updated_at, space_id, owner_user_id)
              VALUES ('scratch', 'No project', ${scratch}, '[]', '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z', ${`personal:${grace.userId}`}, ${grace.userId})
            `;
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "ada-scratch",
                  projectId: "scratch",
                  spaceId: `personal:${ada.userId}`,
                  ownerUserId: ada.userId,
                  worktreePath: adaFolder,
                }),
                threadCreated({
                  id: "grace-scratch",
                  projectId: "scratch",
                  spaceId: `personal:${grace.userId}`,
                  ownerUserId: grace.userId,
                  worktreePath: graceFolder,
                }),
              ],
            });
            const services = yield* Layer.build(layerOrchestration(server));
            const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
            let sentCommands = 0;
            const setFolder = (worktreePath: string) =>
              orchestrator
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`scratch-folder-${(sentCommands += 1)}`),
                  threadId: ThreadId.make("grace-scratch"),
                  worktreePath,
                } as never)
                .pipe(
                  CommandActor.actAs(grace.userId),
                  Effect.result,
                  Effect.map((result) =>
                    Result.isSuccess(result)
                      ? "set"
                      : (SpaceDirectory.spaceRefusalMessage(result.failure) ?? "failed"),
                  ),
                );
            // Writing: not the Scratch folder, not Ada's folder, not a folder inside hers.
            assert.equal(yield* setFolder(scratch), THREAD_WORKTREE_REFUSED);
            assert.equal(yield* setFolder(adaFolder), THREAD_WORKTREE_REFUSED);
            assert.equal(yield* setFolder(`${adaFolder}/src`), THREAD_WORKTREE_REFUSED);
            // Nor the folder of a Thread from before Users, which is the Owner's.
            const legacyFolder = `${scratch}/2026-11-09-legacy`;
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "legacy-scratch",
                  projectId: "scratch",
                  spaceId: `personal:${grace.userId}`,
                  worktreePath: legacyFolder,
                }),
              ],
            });
            assert.equal(yield* setFolder(legacyFolder), THREAD_WORKTREE_REFUSED);
            // Her own folder, or a new one of her own, still works.
            assert.equal(yield* setFolder(`${scratch}/2026-11-09-grace-2`), "set");
            assert.equal(yield* setFolder(graceFolder), "set");
            // Reading: rows recorded anyway (before the rule, by a move) open nothing of Ada's.
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "grace-whole-scratch",
                  projectId: "scratch",
                  spaceId: `personal:${grace.userId}`,
                  ownerUserId: grace.userId,
                  worktreePath: scratch,
                }),
                threadCreated({
                  id: "grace-takes-ada",
                  projectId: "scratch",
                  spaceId: `personal:${grace.userId}`,
                  ownerUserId: grace.userId,
                  worktreePath: adaFolder,
                }),
              ],
            });
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const graceSees = yield* spaceVisibility.of(grace.userId);
            assert.isFalse(yield* spaceVisibility.mayReadDirectory(graceSees, adaFolder));
            assert.isFalse(
              yield* spaceVisibility.mayUseDirectory(graceSees, grace.userId, `${adaFolder}/x`),
            );
            assert.isFalse(yield* spaceVisibility.mayReadDirectory(graceSees, scratch));
            assert.isTrue(yield* spaceVisibility.mayReadDirectory(graceSees, graceFolder));
            // Ada keeps her own folder.
            const adaSees = yield* spaceVisibility.of(ada.userId);
            assert.isTrue(
              yield* spaceVisibility.mayUseDirectory(adaSees, ada.userId, `${adaFolder}/x`),
            );
          }),
        ),
    );

    it.effect(
      "a Space-limited agent of an ownerless Thread keeps to its Space's folders, and a Hub Thread with no folder is refused",
      () =>
        withTeam(({ server, acme, grace }) =>
          Effect.gen(function* () {
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const acmeOnly = { all: false, spaceIds: [SpaceId.make(acme)] } as const;
            assert.isFalse(yield* spaceVisibility.mayUseDirectory(acmeOnly, undefined, "/etc"));
            assert.isTrue(
              yield* spaceVisibility.mayUseDirectory(acmeOnly, undefined, "/work/acme-app/src"),
            );
            assert.isFalse(
              yield* spaceVisibility.mayRootProject(acmeOnly, undefined, "/srv/anywhere", [
                "/srv/projects",
              ]),
            );
            assert.equal(
              yield* spaceVisibility.claimWork(acmeOnly, undefined, "globex-thread"),
              "hidden",
            );
            // A Hub Thread whose Project row is gone has no folder to check: refused.
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "grace-orphan",
                  projectId: "no-such-project",
                  spaceId: acme,
                  ownerUserId: grace.userId,
                }),
              ],
            });
            yield* server.sql`
              UPDATE orchestration_v2_projection_threads
              SET payload_json = json_set(payload_json, '$.worktreePath', NULL)
              WHERE thread_id = 'grace-orphan'
            `;
            const asGrace = yield* connect(server, grace.userId);
            const read = yield* asGrace[WS_METHODS.projectsReadFile]({
              threadId: "grace-orphan",
              cwd: "/work/acme-app",
              relativePath: "README.md",
            } as never).pipe(
              Effect.flip,
              Effect.map((error) => (error as { readonly _tag: string })._tag),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
            assert.equal(read, "SpaceResourceNotFoundError");
          }),
        ),
    );

    it.effect("a Member's Thread folder inside the Project needs no more of the Hub's setup", () =>
      withTeam(({ server, acme, grace }) =>
        Effect.gen(function* () {
          yield* server.eventSink.write({
            events: [
              threadCreated({
                id: "grace-inside",
                projectId: "acme-app",
                spaceId: acme,
                ownerUserId: grace.userId,
              }),
            ],
          });
          // The orchestration without the Hub's config (as in a test of it, or a slim host).
          const services = yield* Layer.build(
            layerOrchestration({
              ...server,
              services: Context.omit(ServerConfigModule.ServerConfig)(server.services) as never,
            }),
          );
          const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
          const set = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("inside-no-config"),
              threadId: ThreadId.make("grace-inside"),
              worktreePath: "/work/acme-app/packages/x",
            } as never)
            .pipe(CommandActor.actAs(grace.userId), Effect.result);
          assert.isTrue(Result.isSuccess(set));
        }),
      ),
    );

    it.effect("two Spaces racing for the same new folder: only one Project takes it", () =>
      withTeam(({ server, acme, globex, grace, linus }) =>
        Effect.gen(function* () {
          const contested = server.newProjectFolder("contested");
          const create = (cookie: string, spaceId: string, id: string) =>
            server.request("/api/projects/mutate", {
              cookie,
              body: {
                type: "project.create",
                commandId: `race-${id}`,
                projectId: `race-${id}`,
                title: id,
                workspaceRoot: contested,
                createWorkspaceRootIfMissing: true,
                spaceId,
              },
            });
          const [first, second] = yield* Effect.all(
            [create(grace.cookie, acme, "acme"), create(linus.cookie, globex, "globex")],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(
            [first.status, second.status].filter((status) => status === 200),
            [200],
          );
          const rows = yield* server.sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM projection_projects WHERE workspace_root = ${contested}
          `;
          assert.equal(rows[0]?.count, 1);
        }),
      ),
    );

    it.effect(
      "a recorded root counts only if today's rule passes: a Member's old Project at /, a Thread's unchecked folder",
      () =>
        withTeam(({ server, acme, grace }) =>
          Effect.gen(function* () {
            // Recorded before the rule: Grace's Project at the Hub's root, and Threads whose
            // folders nobody checked (a machine that was removed, a move to the Hub that kept it).
            yield* server.sql`
              INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
                created_at, updated_at, space_id, owner_user_id)
              VALUES ('grace-root', 'grace-root', '/', '[]', '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z', ${acme}, ${grace.userId})
            `;
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "grace-unplaced",
                  projectId: "acme-app",
                  spaceId: acme,
                  ownerUserId: grace.userId,
                  worktreePath: "/home/owner/private",
                }),
                threadCreated({
                  id: "grace-moved",
                  projectId: "acme-app",
                  spaceId: acme,
                  ownerUserId: grace.userId,
                  worktreePath: "/srv/other-machine/app",
                }),
              ],
            });
            yield* server.sql`
              UPDATE orchestration_v2_projection_threads SET active_environment_id = 'hub'
              WHERE thread_id = 'grace-moved'
            `;
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const graceSees = yield* spaceVisibility.of(grace.userId);
            for (const directory of ["/etc", "/home/owner/private", "/srv/other-machine/app"]) {
              assert.isFalse(
                yield* spaceVisibility.mayReadDirectory(graceSees, directory),
                `read ${directory}`,
              );
              assert.isFalse(
                yield* spaceVisibility.mayUseDirectory(graceSees, grace.userId, directory),
                `use ${directory}`,
              );
            }
            // The Owner's Project stays a root for its Members.
            assert.isTrue(yield* spaceVisibility.mayReadDirectory(graceSees, "/work/acme-app/src"));
            // A call on the Thread's own folder, with no folder named, is refused too.
            const asGrace = yield* connect(server, grace.userId);
            const read = yield* asGrace[WS_METHODS.projectsReadFile]({
              threadId: "grace-unplaced",
              cwd: "/home/owner/private",
              relativePath: "id_ed25519",
            } as never).pipe(Effect.flip);
            assert.equal((read as { readonly _tag?: string })._tag, "SpaceResourceNotFoundError");
          }),
        ),
    );

    it.effect(
      "a monorepo Project's Thread works only in its own part of a worktree, whoever's it is",
      () =>
        withTeam(({ server, owner, acme, globex, grace }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-roots-mono-" });
            const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3-roots-mono-wt-" });
            yield* fs.makeDirectory(path.join(repo, ".git", "worktrees", "b-feature"), {
              recursive: true,
            });
            const worktree = path.join(elsewhere, "b-feature");
            for (const part of ["packages/a", "packages/b"]) {
              yield* fs.makeDirectory(path.join(repo, part), { recursive: true });
              yield* fs.makeDirectory(path.join(worktree, part), { recursive: true });
            }
            yield* fs.writeFileString(
              path.join(worktree, ".git"),
              `gitdir: ${path.join(repo, ".git", "worktrees", "b-feature")}
`,
            );
            yield* fs.writeFileString(
              path.join(repo, ".git", "worktrees", "b-feature", "gitdir"),
              `${worktree}/.git
`,
            );
            for (const [id, part, spaceId] of [
              ["mono-a", "packages/a", acme],
              ["mono-b", "packages/b", globex],
            ] as const) {
              const created = yield* server.request("/api/projects/mutate", {
                cookie: owner,
                body: {
                  type: "project.create",
                  commandId: `create-${id}`,
                  projectId: id,
                  title: id,
                  workspaceRoot: path.join(repo, part),
                  spaceId,
                },
              });
              assert.equal(created.status, 200);
            }
            yield* server.eventSink.write({
              events: [
                threadCreated({
                  id: "grace-mono",
                  projectId: "mono-a",
                  spaceId: acme,
                  ownerUserId: grace.userId,
                  worktreePath: worktree,
                }),
              ],
            });
            const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
            const graceSees = yield* spaceVisibility.of(grace.userId);
            assert.isTrue(
              yield* spaceVisibility.mayReadDirectory(graceSees, path.join(worktree, "packages/a")),
            );
            assert.isFalse(
              yield* spaceVisibility.mayReadDirectory(graceSees, path.join(worktree, "packages/b")),
            );
            assert.isFalse(
              yield* spaceVisibility.mayUseDirectory(
                graceSees,
                grace.userId,
                path.join(worktree, "packages/b"),
              ),
            );
          }),
        ),
    );
  });

  it.effect("terminals work only on one's own Thread or a draft one holds", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        // Typing goes to a shell the Hub admitted: each is opened first, where the door lets it.
        const write = (client: Writer, threadId: string) =>
          client[WS_METHODS.terminalOpen]({
            threadId,
            terminalId: "t",
            cwd: "/work/acme-app",
          } as never).pipe(
            Effect.ignore,
            Effect.andThen(
              client[WS_METHODS.terminalWrite]({ threadId, terminalId: "t", data: "ls" } as never),
            ),
            Effect.result,
          );
        const owners = yield* write(asGrace, "acme-thread");
        assert.isTrue(Result.isFailure(owners) && owners.failure._tag === "SpaceActionDeniedError");
        assert.isTrue(Result.isSuccess(yield* write(asGrace, "grace-thread")));
        // Grace's draft is hers: to Ada it looks like it does not exist.
        assert.isTrue(Result.isSuccess(yield* write(asGrace, "grace-draft")));
        const adas = yield* write(asAda, "grace-draft");
        assert.isTrue(Result.isFailure(adas) && adas.failure._tag === "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect(
    "an agent on a machine bound to one Space acts only there, with its User's rights in it",
    () =>
      withTeam(({ server, acme, globex }) =>
        Effect.gen(function* () {
          const services = yield* Layer.build(layerOrchestration(server));
          const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
          const [ownerRow] = yield* server.sql<{ userId: string }>`
            SELECT user_id AS "userId" FROM users WHERE is_owner = 1
          `;
          const ownerId = UserId.make(ownerRow!.userId);
          // The Owner's agent in Acme's Sandbox, whose token any agent there could read.
          const inAcme: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make(`sandbox:${acme}`),
            requestNamespace: "acme-agent",
            thread: undefined,
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
            userId: ownerId,
            spaceLimit: SpaceId.make(acme),
          };
          const archive = (threadId: string) =>
            orchestrator
              .dispatch({
                type: "thread.archive",
                commandId: CommandId.make(`limited-archive-${threadId}`),
                threadId: ThreadId.make(threadId),
              })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, inAcme),
                Effect.result,
                Effect.map((result) =>
                  Result.isSuccess(result)
                    ? "archived"
                    : String((result.failure.cause as { _tag?: string } | undefined)?._tag),
                ),
              );
          // The Owner's own Personal space and another Organization are out of reach, as missing.
          assert.equal(yield* archive("legacy-thread"), "SpaceResourceNotFoundError");
          assert.equal(yield* archive("globex-thread"), "SpaceResourceNotFoundError");
          assert.equal(yield* archive("acme-thread"), "archived");
          // Nor creates elsewhere.
          const created = yield* server.projects
            .create({
              commandId: CommandId.make("limited-create"),
              projectId: ProjectId.make("limited-project"),
              title: "limited",
              workspaceRoot: "/srv/limited",
              spaceId: SpaceId.make(globex),
            })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, inAcme),
              Effect.flip,
            );
          assert.include(created.message, "works only in the Space of the machine");
          // Every Space action passes the same check: none on another Space, no Project move out.
          const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
          const limited = <A, E>(effect: Effect.Effect<A, E>) =>
            effect.pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, inAcme),
              Effect.result,
              Effect.map(Result.isSuccess),
            );
          assert.isFalse(
            yield* limited(directory.authorize(ownerId, "space.view", SpaceId.make(globex))),
          );
          assert.isTrue(
            yield* limited(directory.authorize(ownerId, "space.view", SpaceId.make(acme))),
          );
          assert.isFalse(
            yield* limited(
              server.projects.move({
                commandId: CommandId.make("limited-move"),
                projectId: ProjectId.make("acme-app"),
                spaceId: SpaceId.make(globex),
              }),
            ),
          );
          // Within Acme it keeps the Owner's rights: it works Acme's Projects.
          const spaceVisibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
          const workable = yield* spaceVisibility.workableProjectIds(
            { all: false, spaceIds: [SpaceId.make(acme)] },
            ownerId,
            [ProjectId.make("acme-app")],
          );
          assert.isTrue(workable.has(ProjectId.make("acme-app")));
          const ownerless = yield* spaceVisibility.workableProjectIds(
            { all: false, spaceIds: [SpaceId.make(acme)] },
            undefined,
            [ProjectId.make("acme-app")],
          );
          assert.isTrue(ownerless.has(ProjectId.make("acme-app")));
        }),
      ),
  );

  it.effect("guest links are an Admin's, only in Organizations", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const services = yield* Layer.build(layerOrchestration(server));
        const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
        const open = (actor: UserId, threadId: string) =>
          orchestrator
            .dispatch({
              type: "thread.guest-share.open",
              commandId: CommandId.make(`share-${actor}-${threadId}`),
              threadId: ThreadId.make(threadId),
              shareId: GuestShareId.make(`share-${actor}`),
              host: "https://hub.example.com",
              expiresAt: "2026-11-06T00:00:00.000Z",
            } as never)
            .pipe(CommandActor.actAs(actor), Effect.result);
        const members = yield* open(grace.userId, "grace-thread");
        assert.equal(
          Result.isFailure(members) ? SpaceDirectory.spaceRefusalMessage(members.failure) : null,
          "Only an Admin can create guest links, and only in an Organization.",
        );
        const admins = yield* open(ada.userId, "grace-thread");
        assert.isTrue(Result.isSuccess(admins));
        // Nothing is shared from a Personal space, not even by the Owner.
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        const personal = yield* open(UserId.make(ownerRow!.userId), "legacy-thread");
        assert.isTrue(Result.isFailure(personal));
        // Off the WebSocket too (MCP, agents), a hidden Thread fails exactly like a missing one.
        const archive = (threadId: string) =>
          orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make(`archive-${threadId}`),
              threadId: ThreadId.make(threadId),
            })
            .pipe(
              CommandActor.actAs(grace.userId),
              Effect.flip,
              Effect.map((error) => error.cause),
            );
        assert.deepEqual(yield* archive("globex-thread"), yield* archive("no-such-thread"));
      }),
    ),
  );
  it.effect("not even the Owner continues someone else's Thread or works its live session", () =>
    withTeam(({ server, grace }) =>
      Effect.gen(function* () {
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        const asOwner = yield* connectWriter(server, UserId.make(ownerRow!.userId));
        const sent = yield* dispatch(asOwner, {
          type: "message.dispatch",
          threadId: "grace-thread",
          messageId: MessageId.make("owner-speaks"),
          text: "Hi",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          refusal(sent),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // The Owner still archives it.
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asOwner, { type: "thread.archive", threadId: "grace-thread" }),
          ),
        );
        // An MCP app acts in the Thread's live session, so it is Grace's alone.
        const app = yield* asOwner[WS_METHODS.mcpAppsCallTool]({
          threadId: ThreadId.make("grace-thread"),
          itemId: "item",
          name: "tool",
          arguments: {},
        } as never).pipe(Effect.flip);
        assert.equal(app._tag, "SpaceActionDeniedError");
        const asGrace = yield* connectWriter(server, grace.userId);
        // Its model context may not name a Thread she cannot see either.
        const context = yield* asGrace[WS_METHODS.mcpAppsUpdateModelContext]({
          threadId: ThreadId.make("grace-thread"),
          itemId: "item",
          conversationThreadId: ThreadId.make("globex-thread"),
        } as never).pipe(Effect.flip);
        assert.equal(context._tag, "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect("viewers open a Thread; only its creator or an Admin organizes it", () =>
    withTeam(({ server, gus, ada }) =>
      Effect.gen(function* () {
        const asGus = yield* connectWriter(server, gus.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const visit = yield* dispatch(asGus, {
          type: "thread.visit",
          threadId: "grace-thread",
          visitedAt: "2026-11-05T00:00:00.000Z",
        });
        assert.isTrue(Result.isSuccess(visit));
        assert.match(
          refusal(yield* dispatch(asGus, { type: "thread.pin", threadId: "grace-thread" })) ?? "",
          /Only its creator or an Admin/,
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.pin", threadId: "grace-thread" }),
          ),
        );
      }),
    ),
  );

  it.effect("a command id replays only for the User who sent it", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        // Both may archive grace-thread, so only the replay rule tells them apart.
        const pin = (client: Writer) =>
          client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("shared-id"),
            threadId: ThreadId.make("grace-thread"),
          } as never).pipe(Effect.result);
        assert.isTrue(Result.isSuccess(yield* pin(asGrace)));
        assert.isTrue(Result.isSuccess(yield* pin(asGrace)));
        assert.isTrue(Result.isFailure(yield* pin(asAda)));
      }),
    ),
  );

  it.effect("terminals open only in folders the User may work in", () =>
    withTeam(({ server, grace, gus }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asGus = yield* connectWriter(server, gus.userId);
        const open = (client: Writer, threadId: string, cwd: string) =>
          client[WS_METHODS.terminalOpen]({ threadId, terminalId: "t", cwd } as never).pipe(
            Effect.result,
          );
        const outcome = (result: Result.Result<unknown, unknown>) =>
          Result.isSuccess(result) ? "opened" : (result.failure as { _tag: string })._tag;
        // A Member works in her team's Projects, not in another Organization's.
        assert.equal(outcome(yield* open(asGrace, "grace-draft", "/work/acme-app")), "opened");
        assert.equal(
          outcome(yield* open(asGrace, "grace-draft", "/work/globex-app/src")),
          "SpaceActionDeniedError",
        );
        // A Guest works only in their own Threads' folders.
        assert.equal(
          outcome(yield* open(asGus, "gus-draft", "/work/acme-app")),
          "SpaceActionDeniedError",
        );
      }),
    ),
  );

  it.effect("a file call that names a Thread keeps to who may see and work that Thread", () =>
    withTeam(({ server, ada }) =>
      Effect.gen(function* () {
        const asAda = yield* connectWriter(server, ada.userId);
        const refusal = (result: Result.Result<unknown, unknown>) =>
          Result.isSuccess(result) ? "ran" : (result.failure as { _tag: string })._tag;
        // An Admin sees grace-thread but saves only in a Thread of her own.
        const saved = yield* asAda[WS_METHODS.projectsWriteFile]({
          cwd: "/work/acme-app",
          relativePath: "notes.md",
          contents: "x",
          threadId: "grace-thread",
        } as never).pipe(Effect.result);
        assert.equal(refusal(saved), "SpaceActionDeniedError");
        // A Thread in a Space she cannot see answers like a missing one.
        const read = yield* asAda[WS_METHODS.projectsReadFile]({
          cwd: "/work/globex-app",
          relativePath: "README.md",
          threadId: "globex-thread",
        } as never).pipe(Effect.result);
        assert.equal(refusal(read), "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect("a copy read (unmasked) needs what a save needs, not only what a read does", () =>
    withTeam(({ server, ada, gus }) =>
      Effect.gen(function* () {
        const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
          call.pipe(
            Effect.flip,
            Effect.map((error) => (error as { readonly _tag: string })._tag),
            Effect.catchCause(() => Effect.succeed("reached")),
          );
        const asGus = yield* connectWriter(server, gus.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const read = (client: Writer, input: Record<string, unknown>) =>
          outcome(
            client[WS_METHODS.projectsReadFile]({ relativePath: "README.md", ...input } as never),
          );
        // A Guest reads the team's Project, but works only in their own Threads' folders.
        assert.notEqual(
          yield* read(asGus, { cwd: "/work/acme-app" }),
          "SpaceResourceNotFoundError",
        );
        assert.equal(
          yield* read(asGus, { cwd: "/work/acme-app", forCopy: true }),
          "SpaceResourceNotFoundError",
        );
        // An Admin who sees another User's Thread reads it, but copies only from her own.
        assert.equal(
          yield* read(asAda, { cwd: "/work/acme-app", threadId: "grace-thread", forCopy: true }),
          "SpaceActionDeniedError",
        );
      }),
    ),
  );

  it.effect(
    "a copy read (unmasked) is refused to a session that may read files but not write them",
    () =>
      withTeam(({ server, grace }) =>
        Effect.gen(function* () {
          const message = <A, E, R>(call: Effect.Effect<A, E, R>) =>
            call.pipe(
              Effect.flip,
              Effect.map((error) => String((error as { readonly message?: unknown }).message)),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
          // Every scope a writer holds but filesystem:write.
          const readOnly = yield* connectWriter(server, grace.userId, [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthTerminalReadScope,
            AuthTerminalOperateScope,
            AuthFilesystemReadScope,
          ]);
          const writer = yield* connectWriter(server, grace.userId);
          const copy = (client: Writer) =>
            message(
              client[WS_METHODS.projectsReadFile]({
                cwd: "/work/acme-app",
                relativePath: "README.md",
                forCopy: true,
              } as never),
            );
          // Her team's Project: a read-only session reads it masked, but never as it is on disk.
          assert.equal(yield* copy(readOnly), "Copying files needs permission to write files.");
          // A writer passes both the Space rule and the scope: the read itself answers.
          assert.notInclude(
            [
              "Copying files needs permission to write files.",
              "That Project or Thread does not exist.",
            ],
            yield* copy(writer),
          );
        }),
      ),
  );

  it.effect(
    "a file call with no Thread, or a draft's, keeps to folders of Spaces the User sees",
    () =>
      withTeam(({ server, ada }) =>
        Effect.gen(function* () {
          const asAda = yield* connectWriter(server, ada.userId);
          // The refusal's tag, or "reached" once the call got past the guard to the file services
          // (which these tests do not run).
          const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
            call.pipe(
              Effect.flip,
              Effect.map((error) => (error as { readonly _tag: string })._tag),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
          const read = (cwd: string, threadId?: string) =>
            outcome(
              asAda[WS_METHODS.projectsReadFile]({
                cwd,
                relativePath: "README.md",
                ...(threadId === undefined ? {} : { threadId }),
              } as never),
            );
          // Another Organization's Project answers like a missing one, with no Thread or a draft's,
          // which run on the Hub's own copy of the folder.
          assert.equal(yield* read("/work/globex-app"), "SpaceResourceNotFoundError");
          assert.equal(
            yield* read("/work/globex-app/src", "ada-draft"),
            "SpaceResourceNotFoundError",
          );
          const written = yield* outcome(
            asAda[WS_METHODS.projectsWriteFile]({
              cwd: "/work/globex-app",
              relativePath: "notes.md",
              contents: "x",
            } as never),
          );
          assert.equal(written, "SpaceResourceNotFoundError");
          // Her own team's Project gets past the guard.
          assert.notEqual(yield* read("/work/acme-app"), "SpaceResourceNotFoundError");
          assert.notEqual(yield* read("/work/acme-app", "ada-draft"), "SpaceResourceNotFoundError");
        }),
      ),
  );

  it.effect(
    "with no Thread, a file named by its own path, a link out of the Project, or a browse keep to the User's Spaces",
    () =>
      withTeam(({ server, ada }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // The two Projects on disk, Acme's with a link committed into Globex's checkout.
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-space-folders-" });
          const acmeRoot = path.join(root, "acme-app");
          const globexRoot = path.join(root, "globex-app");
          yield* fs.makeDirectory(acmeRoot);
          yield* fs.makeDirectory(globexRoot);
          yield* fs.writeFileString(path.join(globexRoot, "README.md"), "globex\n");
          yield* fs.symlink(globexRoot, path.join(acmeRoot, "vendor"));
          yield* server.sql`
            UPDATE projection_projects SET workspace_root = ${acmeRoot} WHERE project_id = 'acme-app'
          `;
          yield* server.sql`
            UPDATE projection_projects SET workspace_root = ${globexRoot}
            WHERE project_id = 'globex-app'
          `;
          const asAda = yield* connectWriter(server, ada.userId);
          const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
            call.pipe(
              Effect.flip,
              Effect.map((error) => (error as { readonly _tag: string })._tag),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
          const read = (cwd: string, relativePath: string) =>
            outcome(asAda[WS_METHODS.projectsReadFile]({ cwd, relativePath } as never));
          const browse = (partialPath: string) =>
            outcome(asAda[WS_METHODS.filesystemBrowse]({ partialPath } as never));
          const hidden = "SpaceResourceNotFoundError";
          // A file outside her Spaces, named by its own path or by home.
          assert.equal(yield* read(acmeRoot, path.join(globexRoot, "README.md")), hidden);
          assert.equal(yield* read(acmeRoot, "~/.ssh/id_ed25519"), hidden);
          // A link in her Project to another Space's checkout.
          assert.equal(yield* read(path.join(acmeRoot, "vendor"), "README.md"), hidden);
          // Browsing the Hub's disk outside her Projects.
          assert.equal(yield* browse(`${root}/`), hidden);
          assert.equal(yield* browse(`${globexRoot}/`), hidden);
          assert.equal(yield* browse("~/"), hidden);
          // A link followed by `..` (the kernel goes through the link, a lexical check does not).
          assert.equal(yield* read(acmeRoot, `${acmeRoot}/vendor/../globex-app/README.md`), hidden);
          // A browse that is not explicitly relative (resolved against the server's own folder),
          // and folders named relative to nothing or to home.
          assert.equal(
            yield* outcome(
              asAda[WS_METHODS.filesystemBrowse]({ partialPath: "src/", cwd: acmeRoot } as never),
            ),
            hidden,
          );
          assert.equal(yield* read("acme-app", "README.md"), hidden);
          assert.equal(yield* read("~", "README.md"), hidden);
          // A Thread on the Hub machine runs there too: her team's Thread, another Space's folder.
          assert.equal(
            yield* outcome(
              asAda[WS_METHODS.projectsReadFile]({
                cwd: globexRoot,
                relativePath: "README.md",
                threadId: "acme-thread",
              } as never),
            ),
            hidden,
          );
          // Deleted, a Thread on the Hub machine still runs its calls there.
          yield* server.sql`
            UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-01T00:00:00.000Z'
            WHERE thread_id = 'acme-child'
          `;
          assert.equal(
            yield* outcome(
              asAda[WS_METHODS.projectsReadFile]({
                cwd: globexRoot,
                relativePath: "README.md",
                threadId: "acme-child",
              } as never),
            ),
            hidden,
          );
          // A browse ending in `.` lists its parent.
          assert.equal(yield* browse(`${acmeRoot}/.`), hidden);
          // Git on another Space's folder.
          const git = (method: "vcs.listRefs", cwd: string) =>
            outcome(
              (asAda as unknown as Record<string, (input: unknown) => Effect.Effect<unknown>>)[
                method
              ]!({ cwd }),
            );
          assert.equal(yield* git(WS_METHODS.vcsListRefs, globexRoot), hidden);
          assert.notEqual(yield* git(WS_METHODS.vcsListRefs, acmeRoot), hidden);
          // File chips: only the paths she may not read answer nothing.
          const metadata = yield* asAda[WS_METHODS.filesystemGetMetadata]({
            paths: [path.join(acmeRoot, "README.md"), path.join(globexRoot, "README.md"), "~/x"],
          } as never);
          assert.deepEqual((metadata as { readonly entries: ReadonlyArray<unknown> }).entries, [
            { kind: "file" },
            null,
            null,
          ]);
          // Her own Project's files and folders get past the guard.
          assert.notEqual(yield* read(acmeRoot, "README.md"), hidden);
          assert.notEqual(
            yield* outcome(
              asAda[WS_METHODS.filesystemBrowse]({ partialPath: "./", cwd: acmeRoot } as never),
            ),
            hidden,
          );
          assert.notEqual(yield* read(acmeRoot, path.join(acmeRoot, "README.md")), hidden);
          assert.notEqual(yield* browse(`${acmeRoot}/`), hidden);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("answering a secret request is the Thread creator's, refused before storing", () =>
    withTeam(({ server, gus }) =>
      Effect.gen(function* () {
        const asGus = yield* connectWriter(server, gus.userId);
        const answered = yield* asGus[WS_METHODS.secretsAnswerRequest]({
          threadId: ThreadId.make("grace-thread"),
          turnItemId: "item",
          answer: { type: "save", secret: "hunter2" },
        } as never).pipe(Effect.flip);
        assert.equal((answered as { reason?: string }).reason, "not_permitted");
      }),
    ),
  );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "the Owner turns a Member's Personal space on and off; her open connection follows at once",
    () =>
      withHub(({ server, owner, grace, linus }) =>
        Effect.gen(function* () {
          const setPersonal = (cookie: string, granted: boolean) =>
            server.request(`/api/installation/users/${grace.userId}/permissions`, {
              cookie,
              body: { permission: "personalSpace.create", granted },
            });
          // Only the Owner lists Users and grants or revokes their permissions.
          assert.equal((yield* setPersonal(grace.cookie, true)).status, 403);
          assert.equal(
            (yield* server.request("/api/installation/users", { cookie: linus.cookie })).status,
            403,
          );
          const users = yield* server.request("/api/installation/users", { cookie: owner });
          assert.deepInclude(users.body.users as ReadonlyArray<unknown>, {
            id: grace.userId,
            displayName: "grace",
            loginName: "grace",
            isOwner: false,
            status: "active",
            installationPermissions: [],
          });

          const path = yield* Path.Path;
          const projectsRoot = projectsRootOf(
            path,
            Context.get(server.services, ServerConfigModule.ServerConfig).baseDir,
          );
          // A Member's Projects go in new folders of the Hub's Projects folder.
          const createNotes = (id: string) =>
            server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.create",
                commandId: `create-${id}`,
                projectId: id,
                title: id,
                workspaceRoot: path.join(projectsRoot, id),
              },
            });
          const spaceIds = (cookie: string) =>
            server
              .request("/api/spaces", { cookie })
              .pipe(
                Effect.map((response) =>
                  (response.body.spaces as ReadonlyArray<{ id: string }>).map((space) => space.id),
                ),
              );
          const personal = `personal:${grace.userId}`;
          assert.notInclude(yield* spaceIds(grace.cookie), personal);
          assert.equal((yield* createNotes("too-early")).status, 403);

          // Grace's open shell, synchronized before anything changes.
          const client = yield* connect(server, grace.userId);
          const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          while ((yield* Queue.take(items)).kind !== "synchronized");

          const granted = yield* setPersonal(owner, true);
          assert.equal(granted.status, 200);
          assert.deepEqual(granted.body.installationPermissions, ["personalSpace.create"]);
          assert.include(yield* spaceIds(grace.cookie), personal);
          const notes = yield* createNotes("notes");
          assert.equal(notes.status, 200);
          assert.equal(notes.body.spaceId, personal);
          // The same connection shows it, with no resubscribe: as a delta, or in the fresh
          // snapshot the grant restarts the stream with.
          for (let item = yield* Queue.take(items); ; item = yield* Queue.take(items)) {
            if (item.kind === "project.updated" && item.project.id === "notes") break;
            if (item.kind === "snapshot" && shellIds(item.snapshot).projects.includes("notes"))
              break;
          }

          // The Owner reads every Personal space; another Member reads none but her own.
          const projectIds = (cookie: string) =>
            server
              .request("/api/projects", { cookie })
              .pipe(
                Effect.map((response) =>
                  (response.body.projects as ReadonlyArray<{ id: string }>).map(
                    (project) => project.id,
                  ),
                ),
              );
          assert.include(yield* projectIds(owner), "notes");
          assert.include(yield* spaceIds(owner), personal);
          assert.notInclude(yield* projectIds(linus.cookie), "notes");
          assert.notInclude(yield* spaceIds(linus.cookie), personal);

          // Revoking hides it again: the open shell gets a fresh snapshot without it.
          assert.equal((yield* setPersonal(owner, false)).status, 200);
          for (let item = yield* Queue.take(items); ; item = yield* Queue.take(items)) {
            if (item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined) {
              assert.notInclude(shellIds(item.snapshot).projects, "notes");
              break;
            }
          }
          assert.notInclude(yield* spaceIds(grace.cookie), personal);
          assert.notInclude(yield* projectIds(grace.cookie), "notes");
          assert.equal((yield* createNotes("after-revoke")).status, 403);
          assert.include(yield* projectIds(owner), "notes");
        }),
      ),
  );

  it.effect("the Owner's Users endpoints need the access scopes, not just the Owner", () =>
    withHub(({ server, grace }) =>
      Effect.gen(function* () {
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        // A narrowed session of the Owner's, such as a read-only client paired by the Owner.
        const narrow = yield* server.sessions.issue({
          method: "browser-session-cookie",
          subject: "user-sign-in",
          userId: UserId.make(ownerRow!.userId),
          scopes: ["orchestration:read"],
        });
        const cookie = `${server.sessions.cookieName}=${narrow.token}`;
        assert.equal((yield* server.request("/api/installation/users", { cookie })).status, 403);
        const set = yield* server.request(`/api/installation/users/${grace.userId}/permissions`, {
          cookie,
          body: { permission: "personalSpace.create", granted: true },
        });
        assert.equal(set.status, 403);
        const [granted] = yield* server.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM installation_permissions
        `;
        assert.equal(granted?.count, 0);
      }),
    ),
  );

  it.effect("naming someone else's Personal space answers like naming a missing one", () =>
    withHub(({ server, grace, linus }) =>
      Effect.gen(function* () {
        const create = (spaceId: string) =>
          server
            .request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.create",
                commandId: `probe-${spaceId}`,
                projectId: `probe-${spaceId}`,
                title: "probe",
                workspaceRoot: "/work/probe",
                spaceId,
              },
            })
            .pipe(
              Effect.map((response) => {
                const { traceId: _traceId, ...body } = response.body;
                return [response.status, JSON.stringify(body).replaceAll(spaceId, "<space>")];
              }),
            );
        assert.deepEqual(
          yield* create(`personal:${linus.userId}`),
          yield* create("personal:no-such-user"),
        );
      }),
    ),
  );

  it.effect(
    "revoking a Personal space ends its streams, closes its folders and the Owner only reads it",
    () =>
      withTeam(({ server, owner, grace }) =>
        Effect.gen(function* () {
          const setPersonal = (granted: boolean) =>
            server.request(`/api/installation/users/${grace.userId}/permissions`, {
              cookie: owner,
              body: { permission: "personalSpace.create", granted },
            });
          assert.equal((yield* setPersonal(true)).status, 200);
          // Her own Project in the Hub's Projects folder, and a Thread in it.
          const notesRoot = server.newProjectFolder("grace-notes");
          yield* server.sql`
            INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
              created_at, updated_at, space_id, owner_user_id)
            VALUES ('grace-notes', 'grace-notes', ${notesRoot}, '[]', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', ${`personal:${grace.userId}`}, ${grace.userId})
          `;
          yield* server.eventSink.write({
            events: [
              threadCreated({
                id: "notes-thread",
                projectId: "grace-notes",
                spaceId: `personal:${grace.userId}`,
                ownerUserId: grace.userId,
                worktreePath: `${notesRoot}/notes`,
              }),
            ],
          });
          const visibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
          const mayUseNotes = Effect.flatMap(visibility.of(grace.userId), (seen) =>
            visibility.mayUseDirectory(seen, grace.userId, `${notesRoot}/notes`),
          );
          assert.isTrue(yield* mayUseNotes);

          // The Owner reads it but changes nothing in it.
          const services = yield* Layer.build(layerOrchestration(server));
          const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
          const [ownerRow] = yield* server.sql<{ userId: string }>`
            SELECT user_id AS "userId" FROM users WHERE is_owner = 1
          `;
          const archived = yield* orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make("owner-archive-notes"),
              threadId: ThreadId.make("notes-thread"),
            })
            .pipe(CommandActor.actAs(UserId.make(ownerRow!.userId)), Effect.result);
          assert.isTrue(Result.isFailure(archived));

          // A stream the middleware let open on that Thread, such as its command output.
          const viewer = yield* SpaceVisibility.CurrentViewer.pipe(
            Effect.provide(
              SpaceVisibility.layerCurrentViewer.pipe(
                Layer.provide(
                  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
                    sessionId: AuthSessionId.make("session-grace"),
                    subject: "user-sign-in",
                    userId: grace.userId,
                    method: "browser-session-cookie",
                    scopes: new Set([AuthOrchestrationReadScope]),
                  } as never),
                ),
                Layer.provide(Layer.succeedContext(server.services)),
              ),
            ),
          );
          const open = yield* Stream.never.pipe(
            untilAccessLost(
              ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
              { threadId: "notes-thread", itemId: "item-1" },
              viewer,
              visibility,
              grace.userId,
              (lost) => Effect.fail(lost),
            ),
            Stream.runDrain,
            Effect.flip,
            Effect.forkScoped,
          );

          assert.equal((yield* setPersonal(false)).status, 200);
          assert.equal((yield* Fiber.join(open))._tag, "SpaceResourceNotFoundError");
          assert.isFalse(yield* mayUseNotes);
        }),
      ),
  );

  it.effect("once an Owner exists, a request with no User changes nothing", () =>
    withTeam(({ server }) =>
      Effect.gen(function* () {
        const anonymous = yield* connectWriter(server, undefined);
        // It sees no Space, so the Thread is missing to it before any command is decided.
        const archived = yield* dispatch(anonymous, {
          type: "thread.archive",
          threadId: "acme-thread",
        });
        assert.isTrue(
          Result.isFailure(archived) &&
            (archived.failure as { readonly _tag: string })._tag === "SpaceResourceNotFoundError",
        );
      }),
    ),
  );

  it.effect("the server's own work starts nothing in an archived Organization", () =>
    withTeam(({ server, owner, acme }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/archive`, { body: {}, cookie: owner }))
            .status,
          200,
        );
        // A recovery or continuation worker resuming a Thread acts as no User.
        const resumed = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("server-resumes"),
            threadId: ThreadId.make("grace-thread"),
            messageId: MessageId.make("server-resume-message"),
            text: "Continue",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          } as never)
          .pipe(Effect.flip);
        assert.equal(resumed._tag, "OrchestratorCommandRejectedError");
        assert.match(String((resumed as { cause?: unknown }).cause), /archived/);
      }).pipe(Effect.provide(layerOrchestration(server))),
    ),
  );

  it.effect("once its deletion started, an Organization is not restored", () =>
    withHub(({ server, owner, acme }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/archive`, { body: {}, cookie: owner }))
            .status,
          200,
        );
        // A deletion cut short (a crash, or a restore racing it) left the mark behind.
        yield* server.sql`
          UPDATE spaces SET deleting_at = '2026-11-02T00:00:00.000Z' WHERE space_id = ${acme}
        `;
        const restored = yield* server.request(`/api/spaces/${acme}/restore`, {
          body: {},
          cookie: owner,
        });
        assert.equal(restored.status, 403);
        assert.equal(
          restored.body.message,
          "This Organization is being deleted. Delete it again to finish.",
        );
        // A Project-level scheduled task goes with the Organization.
        yield* server.sql`
          INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
            workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
            created_by, creation_source, created_at, updated_at, last_run_status, run_count)
          VALUES ('acme-task', 'Check in', 'Check', 1, '{"type":"interval","everyMs":60000}',
            'acme-app', '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5"}',
            'full-access', 'default', 'user', 'web', '2026-11-01T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z', 'never', 0)
        `;
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/delete`, { body: {}, cookie: owner })).status,
          200,
        );
        const tasks = yield* server.sql`SELECT task_id FROM scheduled_tasks`;
        assert.deepEqual(tasks, []);
      }),
    ),
  );

  it.effect("while a Project moves, nothing is created or started in it", () =>
    withTeam(({ server, acme, ada }) =>
      Effect.gen(function* () {
        yield* server.eventSink.write({
          events: [
            threadCreated({
              id: "ada-thread",
              projectId: "acme-app",
              spaceId: acme,
              ownerUserId: "ada",
            }),
          ],
        });
        const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
        const during = yield* spaces.whileProjectMoves(
          ProjectId.make("acme-app"),
          Effect.all([
            spaces
              .claimCreation({
                action: "thread.create",
                actorUserId: ada.userId,
                projectId: ProjectId.make("acme-app"),
              })
              .pipe(Effect.flip),
            spaces.workBlocked(ThreadId.make("ada-thread")),
          ]),
        );
        assert.equal(
          during[0].message,
          "This Project is moving to another Space. Try again in a moment.",
        );
        // The orchestrator refuses any start in such a Thread, whoever asks.
        assert.equal(during[1], "project-moving");
        assert.isUndefined(yield* spaces.workBlocked(ThreadId.make("ada-thread")));
      }),
    ),
  );

  it.effect("a move restamps only Threads whose Space the mover may move them out of", () =>
    withTeam(({ server, globex, ada }) =>
      Effect.gen(function* () {
        // A Thread of Acme's Project stamped with Globex, which Ada does not run.
        yield* server.eventSink.write({
          events: [threadCreated({ id: "stray", projectId: "acme-app", spaceId: globex })],
        });
        const [acmeSpace] = yield* server.sql<{ spaceId: string }>`
          SELECT space_id AS "spaceId" FROM projection_projects WHERE project_id = 'acme-app'
        `;
        const sameSpace = yield* server.request("/api/projects/mutate", {
          cookie: ada.cookie,
          body: {
            type: "project.move",
            commandId: "move-in-place",
            projectId: "acme-app",
            spaceId: acmeSpace!.spaceId,
          },
        });
        assert.notEqual(sameSpace.status, 200);
        const [stray] = yield* server.sql<{ spaceId: string }>`
          SELECT space_id AS "spaceId" FROM orchestration_v2_projection_threads
          WHERE thread_id = 'stray'
        `;
        assert.equal(stray?.spaceId, globex);
      }),
    ),
  );

  // A User's shell over WebSocket, and the next authoritative snapshot it is sent.
  const watchShell = Effect.fn(function* (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId,
  ) {
    const client = yield* connect(server, userId);
    const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
      requestCompletionMarker: true,
    }).pipe(
      Stream.runForEach((item) => Queue.offer(items, item)),
      Effect.forkScoped,
    );
    return items;
  });
  /** Skips deltas and enrichment refreshes until a snapshot shows exactly `expected`. */
  const snapshotShowing = Effect.fn(function* (
    items: Queue.Queue<OrchestrationV2ShellStreamItem>,
    expected: { readonly projects: ReadonlyArray<string>; readonly threads: ReadonlyArray<string> },
  ) {
    for (;;) {
      const item = yield* Queue.take(items);
      if (item.kind !== "snapshot") continue;
      const shown = shellIds(item.snapshot);
      if (JSON.stringify(shown) === JSON.stringify(expected)) return shown;
    }
  });
  const spaceNamesOf = (server: Effect.Success<typeof serveAuthHttp>, cookie: string) =>
    server
      .request("/api/spaces", { cookie })
      .pipe(
        Effect.map((response) =>
          (response.body.spaces as ReadonlyArray<{ name: string; archived?: boolean }>).map(
            (space) => `${space.name}${space.archived === true ? " (archived)" : ""}`,
          ),
        ),
      );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "archiving an Organization hides it from its Members at once and stops new work; restore brings it back",
    () =>
      withHub(({ server, owner, acme, grace }) =>
        Effect.gen(function* () {
          const lifecycle = (action: "archive" | "restore" | "delete", cookie: string) =>
            server.request(`/api/spaces/${acme}/${action}`, { body: {}, cookie });
          const acmeWork = { projects: ["acme-app"], threads: ["acme-child", "acme-thread"] };
          const shell = yield* watchShell(server, grace.userId);
          yield* snapshotShowing(shell, acmeWork);

          // Only the Owner archives.
          const byMember = yield* lifecycle("archive", grace.cookie);
          assert.equal(byMember.status, 403);
          assert.equal(
            byMember.body.message,
            "Only the Owner archives, restores or deletes an Organization.",
          );

          const archived = yield* lifecycle("archive", owner);
          assert.equal(archived.status, 200);
          // The Owner keeps it, marked archived; Grace's open shell reloads without it.
          assert.include(yield* spaceNamesOf(server, owner), "Acme (archived)");
          yield* snapshotShowing(shell, { projects: [], threads: [] });
          assert.notInclude(yield* spaceNamesOf(server, grace.cookie), "Acme");
          // To her it no longer exists, so she cannot restore it either.
          const restoreByMember = yield* lifecycle("restore", grace.cookie);
          assert.equal(restoreByMember.body.message, "That Organization does not exist.");

          // Nothing new starts in it, not even from the Owner.
          const created = yield* server.request("/api/projects/mutate", {
            cookie: owner,
            body: {
              type: "project.create",
              commandId: "create-in-archived",
              projectId: "late-app",
              title: "late-app",
              workspaceRoot: "/work/late-app",
              spaceId: acme,
            },
          });
          assert.equal(created.status, 403);
          // Archiving twice changes nothing.
          assert.equal((yield* lifecycle("archive", owner)).status, 200);

          assert.equal((yield* lifecycle("restore", owner)).status, 200);
          yield* snapshotShowing(shell, acmeWork);
          assert.include(yield* spaceNamesOf(server, grace.cookie), "Acme");
          assert.include(yield* spaceNamesOf(server, owner), "Acme");
        }),
      ),
  );

  it.effect("an Organization is deleted for good only once archived, with everything in it", () =>
    withHub(({ server, owner, acme, grace }) =>
      Effect.gen(function* () {
        const lifecycle = (action: "archive" | "delete", cookie: string) =>
          server.request(`/api/spaces/${acme}/${action}`, { body: {}, cookie });
        // A pending Invitation, which goes with the Organization.
        yield* server.request(`/api/spaces/${acme}/invitations`, {
          body: { role: "member" },
          cookie: owner,
        });

        const early = yield* lifecycle("delete", owner);
        assert.equal(early.status, 403);
        assert.equal(
          early.body.message,
          "Archive the Organization before deleting it permanently.",
        );
        assert.equal((yield* lifecycle("archive", owner)).status, 200);

        const deleted = yield* lifecycle("delete", owner);
        assert.equal(deleted.status, 200);
        assert.notInclude(
          (deleted.body.spaces as ReadonlyArray<{ name: string }>).map((space) => space.name),
          "Acme",
        );
        // Its Projects and Threads went through their delete paths; Globex's work stays.
        const shell = yield* server.request("/api/orchestration/shell", { cookie: owner });
        assert.deepEqual(shellIds(shell.body as never), {
          projects: ["globex-app", "legacy-app"],
          threads: ["globex-thread", "legacy-thread"],
        });
        const [left] = yield* server.sql<{
          memberships: number;
          invitations: number;
          spaces: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM space_memberships WHERE space_id = ${acme}) AS memberships,
            (SELECT COUNT(*) FROM space_invitations WHERE space_id = ${acme}) AS invitations,
            (SELECT COUNT(*) FROM spaces WHERE space_id = ${acme}) AS spaces
        `;
        assert.deepEqual(left, { memberships: 0, invitations: 0, spaces: 0 });
        assert.equal(yield* isSignedIn(server, grace.cookie), true);
        assert.equal(
          (yield* lifecycle("delete", owner)).body.message,
          "That Organization does not exist.",
        );
      }),
    ),
  );

  const runEvent = (threadId: string, status: "running" | "completed") => {
    const at = DateTime.makeUnsafe("2026-11-01T00:01:00.000Z");
    const id = ThreadId.make(threadId);
    const runId = RunId.make(`run-${threadId}`);
    const nodeId = NodeId.make(`node-${threadId}`);
    const instanceId = ProviderInstanceId.make("codex");
    return {
      id: EventId.make(`run-${threadId}-${status}`),
      type: status === "running" ? "run.created" : "run.updated",
      threadId: id,
      runId,
      nodeId,
      driver: ProviderDriverKind.make("codex"),
      occurredAt: at,
      payload: {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message-${threadId}`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status,
        requestedAt: at,
        startedAt: at,
        completedAt: status === "running" ? null : at,
        checkpointId: null,
        contextHandoffId: null,
      },
    } as const;
  };

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "a Project moves only for an Admin of both Spaces, never while a Thread runs, and its Threads and viewers follow",
    () =>
      withTeam(({ server, owner, globex, grace, linus, ada }) =>
        Effect.gen(function* () {
          const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
          let moves = 0;
          const move = (cookie: string, spaceId: string) =>
            server.request("/api/projects/mutate", {
              cookie,
              body: {
                type: "project.move",
                commandId: `move-${(moves += 1)}`,
                projectId: "acme-app",
                spaceId,
              },
            });
          // Ada runs Acme but is not in Globex, which answers like a Space that does not exist.
          const hidden = yield* move(ada.cookie, globex);
          const missing = yield* move(ada.cookie, "no-such-space");
          assert.equal(hidden.status, 400);
          const { traceId: _hiddenTrace, ...hiddenBody } = hidden.body;
          const { traceId: _missingTrace, ...missingBody } = missing.body;
          assert.deepEqual([hidden.status, hiddenBody], [missing.status, missingBody]);
          // As a Member of Globex she still may not; nor may Grace, a Member of Acme.
          yield* joinOrganization(server, globex, "ada", "member");
          yield* spaces.changed;
          const asMember = yield* move(ada.cookie, globex);
          assert.equal(asMember.status, 403);
          assert.match(String(asMember.body.message), /Admin where it is and where it goes/);
          assert.equal((yield* move(grace.cookie, globex)).status, 400);
          yield* server.sql`
            UPDATE space_memberships SET role = 'admin' WHERE space_id = ${globex} AND user_id = 'ada'
          `;
          yield* spaces.changed;

          // A running Thread blocks the move, and the message says which.
          yield* server.eventSink.write({ events: [runEvent("acme-thread", "running")] as never });
          const blocked = yield* move(ada.cookie, globex);
          assert.equal(blocked.status, 409);
          assert.equal(
            blocked.body.message,
            'Stop the running Threads of this Project before moving it: "acme-thread".',
          );
          yield* server.eventSink.write({
            events: [runEvent("acme-thread", "completed")] as never,
          });

          const graceShell = yield* watchShell(server, grace.userId);
          const linusShell = yield* watchShell(server, linus.userId);
          const acmeWork = {
            projects: ["acme-app"],
            threads: ["acme-child", "acme-thread", "grace-thread"],
          };
          yield* snapshotShowing(graceShell, acmeWork);
          yield* snapshotShowing(linusShell, {
            projects: ["globex-app"],
            threads: ["globex-thread"],
          });

          const moved = yield* move(ada.cookie, globex);
          assert.equal(moved.status, 200);
          assert.equal(moved.body.spaceId, globex);
          // Every Thread follows, the unstamped child too.
          const threadSpaces = yield* server.sql<{ threadId: string; spaceId: string | null }>`
            SELECT thread_id AS "threadId", space_id AS "spaceId"
            FROM orchestration_v2_projection_threads WHERE project_id = 'acme-app'
            ORDER BY thread_id
          `;
          assert.deepEqual(
            threadSpaces.map((row) => row.spaceId),
            threadSpaces.map(() => globex),
          );
          // Acme's viewers lose it live; Globex's gain it.
          yield* snapshotShowing(graceShell, { projects: [], threads: [] });
          yield* snapshotShowing(linusShell, {
            projects: ["acme-app", "globex-app"],
            threads: ["acme-child", "acme-thread", "globex-thread", "grace-thread"],
          });

          // Not even the Owner moves it into someone else's Personal space.
          const intoPersonal = yield* move(owner, `personal:${grace.userId}`);
          assert.equal(intoPersonal.status, 403);
          assert.equal(
            intoPersonal.body.message,
            "This is someone else's Personal space: you can read it but not change anything in it.",
          );
        }),
      ),
  );

  describe("the Installation as a whole is its Owner's", () => {
    const ownerUserId = (server: Effect.Success<typeof serveAuthHttp>) =>
      server.sql<{ userId: string }>`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`.pipe(
        Effect.map((rows) => UserId.make(rows[0]!.userId)),
      );
    type Client = Effect.Success<ReturnType<typeof connect>>;
    // The refusal's message (or tag), or "reached" once the call got past the guard to the
    // services, which these tests leave unused.
    const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
      call.pipe(
        Effect.flip,
        Effect.map((error) => {
          const failure = error as {
            readonly _tag: string;
            readonly message?: string;
            readonly detail?: unknown;
          };
          if (typeof failure.detail === "string") return failure.detail;
          return failure._tag === "SpaceActionDeniedError"
            ? (failure.message ?? failure._tag)
            : failure._tag;
        }),
        Effect.catchCause(() => Effect.succeed("reached")),
      );

    it.effect(
      "a Member or an Admin, even with every scope, reaches no process, setting, provider or device of the Hub",
      () =>
        withTeam(({ server, grace, ada }) =>
          Effect.gen(function* () {
            const handled: Array<string> = [];
            const record = (name: string) =>
              Effect.sync(() => {
                handled.push(name);
                return {} as never;
              });
            const services = Layer.mergeAll(
              Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
                read: record("processes"),
                signal: () => record("signal"),
              }),
              Layer.mock(DeviceService.DeviceService)({
                configure: () => record("deviceConfigure"),
                action: () => record("deviceAction"),
                retryHost: () => record("retryHost"),
              }),
              Layer.mock(ProviderAuthService.ProviderAuthService)({
                start: () => record("providerAuth"),
              }),
            );
            const calls = (client: Client) => ({
              processes: client[WS_METHODS.serverGetProcessDiagnostics]({}),
              signal: client[WS_METHODS.serverSignalProcess]({
                pid: 4242,
                startTimeMs: 0,
                signal: "SIGKILL",
              } as never),
              traces: client[WS_METHODS.serverGetTraceDiagnostics]({}),
              settings: client[WS_METHODS.serverUpdateSettings]({
                patch: { defaultRuntimeMode: "full-access" },
              } as never),
              keybinding: client[WS_METHODS.serverUpsertKeybinding]({
                key: "mod+shift+k",
                command: "terminal.toggle",
              } as never),
              providerAuth: client[WS_METHODS.providerAuthStart]({
                instanceId: ProviderInstanceId.make("codex"),
              }),
              deviceConfigure: client[WS_METHODS.deviceConfigure]({ enabled: true }),
              deviceAction: client[WS_METHODS.deviceAction]({
                deviceId: "phone",
                type: "setAppearance",
                value: "dark",
              } as never),
              retryHost: client[WS_METHODS.deviceList]({ retryHostId: "lab" } as never),
            });
            for (const userId of [grace.userId, ada.userId]) {
              const client = yield* connect(server, userId, services, AuthStandardClientScopes);
              for (const [name, call] of Object.entries(calls(client)) as Array<
                [string, Effect.Effect<unknown, object>]
              >) {
                assert.deepEqual(
                  [name, yield* outcome(call)],
                  [name, INSTALLATION_OWNER_ONLY_MESSAGE],
                );
              }
            }
            assert.deepEqual(handled, []);
            // The Owner reaches every one of them.
            const asOwner = yield* connect(
              server,
              yield* ownerUserId(server),
              services,
              AuthStandardClientScopes,
            );
            for (const [name, call] of Object.entries(calls(asOwner)) as Array<
              [string, Effect.Effect<unknown, object>]
            >) {
              assert.notDeepEqual(
                [name, yield* outcome(call)],
                [name, INSTALLATION_OWNER_ONLY_MESSAGE],
              );
            }
            assert.includeMembers(handled, [
              "processes",
              "signal",
              "deviceConfigure",
              "deviceAction",
              "retryHost",
              "providerAuth",
            ]);
          }),
        ),
    );

    it.effect("an asset URL serves only Hub files from folders the User may read", () =>
      withTeam(({ server, owner, acme, grace, ada, gus }) =>
        Effect.gen(function* () {
          const asset = (client: Client, resource: Record<string, unknown>) =>
            outcome(client[WS_METHODS.assetsCreateUrl]({ resource } as never));
          const refused = "SpaceResourceNotFoundError";
          const outside = [
            { _tag: "media-file", threadId: "grace-thread", path: "/etc/ssh/ssh_host_rsa_key" },
            { _tag: "media-file", threadId: "grace-thread", path: "/work/acme-app/../../etc/x" },
            // Relative paths that climb out of the Thread's folder or name a home.
            {
              _tag: "media-file",
              threadId: "grace-thread",
              path: "../../../../home/owner/.ssh/id_ed25519",
            },
            { _tag: "media-file", threadId: "grace-thread", path: "~/.ssh/id_ed25519" },
            { _tag: "media-file", threadId: "grace-thread", path: "..\\..\\secrets.png" },
            { _tag: "draft-workspace-file", cwd: "/", path: "etc/passwd" },
            { _tag: "draft-workspace-file", cwd: "/work/acme-app", path: "../globex-app/.env" },
            { _tag: "project-favicon", cwd: "/work/globex-app" },
            { _tag: "github-media", cwd: "/work/globex-app", url: "https://example.com/a.png" },
          ];
          const inside = [
            { _tag: "media-file", threadId: "grace-thread", path: "/work/acme-app/shot.png" },
            { _tag: "draft-workspace-file", cwd: "/work/acme-app", path: "docs/shot.png" },
          ];
          for (const userId of [grace.userId, ada.userId, gus.userId]) {
            const client = yield* connect(server, userId, Layer.empty, AuthStandardClientScopes);
            for (const resource of outside) {
              assert.deepEqual(
                [userId, resource, yield* asset(client, resource)],
                [userId, resource, refused],
              );
            }
            for (const resource of inside) {
              assert.notEqual(yield* asset(client, resource), refused);
            }
          }
          const asOwner = yield* connect(
            server,
            yield* ownerUserId(server),
            Layer.empty,
            AuthStandardClientScopes,
          );
          assert.notEqual(yield* asset(asOwner, outside[0]!), refused);
          // An icon the Owner pointed outside the Project is no way out of it for a Member.
          const pointed = yield* server.request("/api/projects/mutate", {
            cookie: owner,
            body: {
              type: "project.update",
              commandId: "acme-icon-outside",
              projectId: "acme-app",
              faviconPath: "/etc/ssh/host.png",
            },
          });
          assert.equal(pointed.status, 200);
          const asGrace = yield* connect(
            server,
            grace.userId,
            Layer.empty,
            AuthStandardClientScopes,
          );
          assert.equal(
            yield* asset(asGrace, { _tag: "project-favicon", cwd: "/work/acme-app" }),
            "AssetWorkspaceContextNotFoundError",
          );
          // Nor an icon inside a Project that links out of it; a name merely holding ".." is fine.
          const fs = yield* FileSystem.FileSystem;
          const nodePath = yield* Path.Path;
          const iconRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-icon-project-" });
          const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-icon-outside-" });
          yield* fs.writeFileString(nodePath.join(outsideRoot, "secret.png"), "secret");
          yield* fs.makeDirectory(nodePath.join(iconRoot, "linked"));
          yield* fs.makeDirectory(nodePath.join(iconRoot, "plain"));
          yield* fs.symlink(
            nodePath.join(outsideRoot, "secret.png"),
            nodePath.join(iconRoot, "linked", "icon.png"),
          );
          yield* fs.writeFileString(nodePath.join(iconRoot, "plain", "logo..png"), "logo");
          const iconProject = (faviconPath: string, id: string) =>
            Effect.gen(function* () {
              yield* server.request("/api/projects/mutate", {
                cookie: owner,
                body: {
                  type: "project.create",
                  commandId: `icon-create-${id}`,
                  projectId: `icon-${id}`,
                  title: id,
                  workspaceRoot: nodePath.join(iconRoot, id),
                  createWorkspaceRootIfMissing: true,
                  spaceId: acme,
                },
              });
              yield* server.request("/api/projects/mutate", {
                cookie: owner,
                body: {
                  type: "project.update",
                  commandId: `icon-set-${id}`,
                  projectId: `icon-${id}`,
                  faviconPath,
                },
              });
              return nodePath.join(iconRoot, id);
            });
          const linked = yield* iconProject("icon.png", "linked");
          const plain = yield* iconProject("logo..png", "plain");
          assert.equal(
            yield* asset(asGrace, { _tag: "project-favicon", cwd: linked }),
            "AssetWorkspaceContextNotFoundError",
          );
          assert.notEqual(
            yield* asset(asGrace, { _tag: "project-favicon", cwd: plain }),
            "AssetWorkspaceContextNotFoundError",
          );
        }),
      ),
    );

    it.effect(
      "a Guest reads a Project's pull requests but changes none; Members and Admins do",
      () =>
        withTeam(({ server, grace, ada, gus }) =>
          Effect.gen(function* () {
            const ref = { projectId: "acme-app", repository: "acme/app", number: 7 };
            const merge = (client: Client) =>
              outcome(
                client[WS_METHODS.pullRequestsRunAction]({ ...ref, action: "merge" } as never),
              );
            const read = (client: Client) =>
              outcome(client[WS_METHODS.pullRequestsDetail](ref as never));
            const refused =
              "Only Members and Admins of this Project's Space can change its pull requests.";
            const asGus = yield* connect(server, gus.userId, Layer.empty, AuthStandardClientScopes);
            assert.equal(yield* merge(asGus), refused);
            assert.notEqual(yield* read(asGus), "SpaceResourceNotFoundError");
            for (const userId of [grace.userId, ada.userId]) {
              const client = yield* connect(server, userId, Layer.empty, AuthStandardClientScopes);
              assert.notEqual(yield* merge(client), refused);
            }
            // Another Space's Project answers like a missing one.
            const asGrace = yield* connect(
              server,
              grace.userId,
              Layer.empty,
              AuthStandardClientScopes,
            );
            assert.equal(
              yield* outcome(
                asGrace[WS_METHODS.pullRequestsRunAction]({
                  ...ref,
                  projectId: "globex-app",
                  action: "merge",
                } as never),
              ),
              "SpaceResourceNotFoundError",
            );
          }),
        ),
    );

    it.effect(
      "a session that names no User, once an Owner exists, reaches nothing of the Installation and sees no Space",
      () =>
        withTeam(({ server }) =>
          Effect.gen(function* () {
            const userless = yield* connect(
              server,
              undefined,
              Layer.empty,
              AuthStandardClientScopes,
            );
            assert.equal(
              yield* outcome(userless[WS_METHODS.serverGetProcessDiagnostics]({})),
              INSTALLATION_OWNER_ONLY_MESSAGE,
            );
            assert.equal(
              yield* outcome(
                userless[WS_METHODS.assetsCreateUrl]({
                  resource: {
                    _tag: "media-file",
                    threadId: "acme-thread",
                    path: "/work/acme-app/shot.png",
                  },
                } as never),
              ),
              "SpaceResourceNotFoundError",
            );
          }),
        ),
    );

    it.effect("a Member's session holds none of the Installation's scopes; the Owner's all", () =>
      withTeam(({ server, owner, grace }) =>
        Effect.gen(function* () {
          const permissions = (cookie: string) =>
            server
              .request("/api/auth/session", { cookie })
              .pipe(Effect.map((response) => response.body.permissions as ReadonlyArray<string>));
          const graceHolds = yield* permissions(grace.cookie);
          assert.include(graceHolds, AuthOrchestrationOperateScope);
          for (const scope of AuthInstallationScopes) assert.notInclude(graceHolds, scope);
          const ownerHolds = yield* permissions(owner);
          for (const scope of AuthInstallationScopes) assert.include(ownerHolds, scope);
          // A Member's pairing link hands on what the Member holds, no more.
          const link = yield* server.request("/api/auth/pairing-token", {
            cookie: grace.cookie,
            body: {},
          });
          assert.equal(link.status, 200);
          const linked = yield* server.sql<{ scopes: string }>`
            SELECT scopes FROM auth_pairing_links WHERE user_id = ${grace.userId}
          `;
          assert.lengthOf(linked, 1);
          for (const scope of AuthInstallationScopes) {
            assert.notInclude(linked[0]!.scopes, scope);
          }
        }),
      ),
    );

    it.effect(
      "a Member clones only into folders where they may work, and sees and cancels only their clones",
      () =>
        withTeam(({ server, grace, linus }) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const tracker = yield* ProjectCloneTracker.make.pipe(
              Effect.provideService(SourceControlRepositoryService.SourceControlRepositoryService, {
                prepareClone: (input: { readonly destinationPath: string }) =>
                  Effect.succeed({
                    destinationPath: input.destinationPath,
                    remoteUrl: "https://example.com/acme/app.git",
                    cloneUrl: "https://example.com/acme/app.git",
                    repository: null,
                  }),
                cloneRepository: () => Effect.never,
                discardClone: () => Effect.void,
              } as never),
            );
            const services = Layer.mergeAll(
              Layer.succeed(ProjectCloneTracker.ProjectCloneTracker, tracker),
              Layer.mock(ProjectService.ProjectService)({
                create: () => Effect.succeed({} as never),
              }),
            );
            const as = (userId: UserId) =>
              connect(server, userId, services, AuthStandardClientScopes);
            const asOwner = yield* as(yield* ownerUserId(server));
            const asGrace = yield* as(grace.userId);
            const asLinus = yield* as(linus.userId);
            const clone = (client: Client, projectId: string, destinationPath: string) =>
              outcome(
                client[WS_METHODS.projectCloneStart]({
                  projectId: ProjectId.make(projectId),
                  title: projectId,
                  remoteUrl: "https://example.com/acme/app.git",
                  destinationPath,
                  createdAt: "2026-11-01T00:00:00.000Z",
                } as never),
              );
            const refused = CLONE_DESTINATION_REFUSED;
            // Outside her team's Projects and the Hub's Projects folder: refused, a direct clone too.
            assert.equal(yield* clone(asGrace, "grace-etc", "/etc/cron.d/app"), refused);
            assert.equal(
              yield* clone(asGrace, "grace-globex", "/work/globex-app/vendor/app"),
              refused,
            );
            assert.equal(yield* clone(asGrace, "grace-tilde", "~/app"), refused);
            assert.equal(
              yield* outcome(
                asGrace[WS_METHODS.sourceControlCloneRepository]({
                  remoteUrl: "https://example.com/acme/app.git",
                  destinationPath: "/home/someone/app",
                } as never),
              ),
              refused,
            );
            // In the Hub's Projects folder it starts as a new Project.
            assert.equal(
              yield* clone(asGrace, "grace-clone", path.join(process.cwd(), "grace-clone-target")),
              "reached",
            );
            // Inside her team's Project a plain clone starts, but not one that becomes a Project:
            // that folder is no Project root of hers, and she is told so before anything runs.
            assert.equal(
              yield* clone(asGrace, "grace-vendor", "/work/acme-app/vendor/lib"),
              PROJECT_FOLDER_REFUSED,
            );
            assert.equal(
              yield* outcome(
                asGrace[WS_METHODS.sourceControlCloneRepository]({
                  remoteUrl: "https://example.com/acme/app.git",
                  destinationPath: "/work/acme-app/vendor/lib",
                } as never),
              ),
              "reached",
            );
            assert.equal(yield* clone(asOwner, "owner-clone", "/srv/owner-clone"), "reached");
            const seen = (client: Client) =>
              client[WS_METHODS.subscribeProjectClones]({}).pipe(
                Stream.runHead,
                Effect.map((head) =>
                  Option.getOrElse(head, () => [])
                    .map((snapshot) => snapshot.projectId)
                    .toSorted(),
                ),
              );
            assert.deepEqual(yield* seen(asGrace), ["grace-clone"]);
            assert.deepEqual(yield* seen(asLinus), []);
            assert.deepEqual(yield* seen(asOwner), ["grace-clone", "owner-clone"]);
            // Nor does anyone but her (or the Owner) cancel hers.
            const cancel = (client: Client, projectId: string) =>
              client[WS_METHODS.projectCloneCancel]({ projectId: ProjectId.make(projectId) });
            assert.deepEqual(yield* cancel(asLinus, "grace-clone"), { applied: false });
            assert.deepEqual(yield* cancel(asGrace, "owner-clone"), { applied: false });
            assert.deepEqual(yield* cancel(asGrace, "grace-clone"), { applied: true });
          }),
        ),
    );

    it.effect(
      "in the Hub's Projects folder a Member clones only into a new folder no Project holds, asked again on retry",
      () =>
        withTeam(({ server, grace, globex }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const projects = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-root-" });
            const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-elsewhere-" });
            yield* fs.makeDirectory(path.join(projects, "existing"));
            yield* fs.symlink(elsewhere, path.join(projects, "link"));
            // Another Organization's Project kept in the shared folder.
            yield* server.sql`
              INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, space_id)
              VALUES ('globex-shared', 'globex-shared', ${path.join(projects, "globex-shared")}, '[]',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${globex})
            `;
            const tracker = yield* ProjectCloneTracker.make.pipe(
              Effect.provideService(SourceControlRepositoryService.SourceControlRepositoryService, {
                prepareClone: (input: { readonly destinationPath: string }) =>
                  Effect.succeed({
                    destinationPath: input.destinationPath,
                    remoteUrl: "https://example.com/acme/app.git",
                    cloneUrl: "https://example.com/acme/app.git",
                    repository: null,
                  }),
                cloneRepository: () =>
                  Effect.fail(
                    new SourceControlRepositoryError({
                      operation: "cloneRepository",
                      provider: SourceControlProviderKind.make("unknown"),
                      detail: "offline",
                    }),
                  ),
                discardClone: () => Effect.void,
              } as never),
            );
            const asGrace = yield* connect(
              server,
              grace.userId,
              Layer.mergeAll(
                Layer.succeed(ProjectCloneTracker.ProjectCloneTracker, tracker),
                Layer.mock(ProjectService.ProjectService)({
                  create: () => Effect.succeed({} as never),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: projects,
                }),
              ),
              AuthStandardClientScopes,
            );
            const clone = (projectId: string, destinationPath: string) =>
              outcome(
                asGrace[WS_METHODS.projectCloneStart]({
                  projectId: ProjectId.make(projectId),
                  title: projectId,
                  remoteUrl: "https://example.com/acme/app.git",
                  destinationPath,
                  createdAt: "2026-11-01T00:00:00.000Z",
                } as never),
              );
            for (const [id, destination] of [
              ["existing", path.join(projects, "existing")],
              ["nested", path.join(projects, "new", "app")],
              ["held", path.join(projects, "globex-shared")],
              ["inside-held", path.join(projects, "globex-shared", ".claude")],
              ["through-link", path.join(projects, "link", "app")],
              ["the-link", path.join(projects, "link")],
            ] as const) {
              assert.deepEqual(
                [id, yield* clone(id, destination)],
                [id, CLONE_DESTINATION_REFUSED],
              );
            }
            // A new folder right in it starts; its git run fails here, so it can be retried.
            const target = path.join(projects, "app");
            assert.equal(yield* clone("app", target), "reached");
            yield* tracker.stream.pipe(
              Stream.filter((clones) =>
                clones.some((entry) => entry.projectId === "app" && entry.phase === "failed"),
              ),
              Stream.runHead,
            );
            // Meanwhile a link to elsewhere took the folder's place: the retry is refused.
            yield* fs.symlink(elsewhere, target);
            assert.equal(
              yield* outcome(
                asGrace[WS_METHODS.projectCloneRetry]({ projectId: ProjectId.make("app") }),
              ),
              CLONE_DESTINATION_REFUSED,
            );
          }),
        ),
    );

    it.effect("a Member sees device sessions and details only of Threads she sees", () =>
      withTeam(({ server, grace }) =>
        Effect.gen(function* () {
          const state = {
            sessions: [
              { threadId: "grace-thread", hostId: "local", deviceId: "phone", platform: "ios" },
              { threadId: "globex-thread", hostId: "local", deviceId: "tablet", platform: "ios" },
            ],
            bootingDevices: [{ threadId: "globex-thread", id: "watch" }],
          };
          const devices = Layer.mock(DeviceService.DeviceService)({
            state: Effect.succeed(state as never),
            list: Effect.succeed(state as never),
            detail: (input: { readonly deviceId: string }) =>
              Effect.succeed({ deviceId: input.deviceId } as never),
          });
          const asGrace = yield* connect(server, grace.userId, devices);
          const listed = (yield* asGrace[WS_METHODS.deviceList]({})) as unknown as typeof state;
          assert.deepEqual(
            listed.sessions.map((session) => session.threadId),
            ["grace-thread"],
          );
          assert.deepEqual(listed.bootingDevices, []);
          const detail = (deviceId: string) =>
            outcome(asGrace[WS_METHODS.deviceDetail]({ hostId: "local", deviceId } as never));
          assert.equal(yield* detail("tablet"), "DeviceNotFoundError");
          assert.equal(yield* detail("phone"), "reached");
        }),
      ),
    );

    it.effect("agent sessions to import list only what the User may read", () =>
      withTeam(({ server, grace }) =>
        Effect.gen(function* () {
          const candidate = (path: string, projectId?: string) => ({
            path,
            title: path,
            ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
            sources: [],
            threadCount: 1,
            lastActiveAt: null,
            alreadyImported: projectId !== undefined,
          });
          const scanner = Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            scan: Effect.succeed({
              candidates: [
                candidate("/work/acme-app", "acme-app"),
                candidate("/work/acme-app/packages/web"),
                candidate("/work/globex-app", "globex-app"),
                // A Project id she cannot see, though its folder sits inside one she can.
                candidate("/work/acme-app/globex-copy", "globex-app"),
                candidate("/home/owner/secret-project"),
              ],
              scannedAt: "2026-11-01T00:00:00.000Z",
            } as never),
          });
          const paths = (client: Client) =>
            client[WS_METHODS.agentSessionsScan]({}).pipe(
              Effect.map((result) => result.candidates.map((entry) => entry.path)),
            );
          assert.deepEqual(yield* paths(yield* connect(server, grace.userId, scanner)), [
            "/work/acme-app",
            "/work/acme-app/packages/web",
          ]);
          assert.lengthOf(
            yield* paths(yield* connect(server, yield* ownerUserId(server), scanner)),
            5,
          );
        }),
      ),
    );

    it.effect("a pending attachment is deleted only by the User who uploaded it", () =>
      withTeam(({ server, grace, linus }) =>
        Effect.gen(function* () {
          const signer = Layer.mock(AssetSigner.AssetSigner)({
            sign: () => Effect.succeed("signature"),
          });
          const asGrace = yield* connect(server, grace.userId, signer);
          const asLinus = yield* connect(server, linus.userId, signer);
          const upload = yield* asGrace[WS_METHODS.attachmentsCreateUploadUrl]({
            name: "notes.png",
            mimeType: "image/png",
            sizeBytes: 3,
          } as never);
          const removal = (client: Client) =>
            outcome(client[WS_METHODS.attachmentsDelete]({ attachmentId: upload.attachmentId }));
          assert.equal(
            yield* removal(asLinus),
            "Only the person who uploaded this attachment can remove it.",
          );
          assert.equal(yield* removal(asGrace), "reached");
        }),
      ),
    );

    it.effect("of the Hub's listening servers a Member sees and stops only her own Threads'", () =>
      withTeam(({ server, grace }) =>
        Effect.gen(function* () {
          const stopped: Array<number> = [];
          const listed = [
            { pid: 101, terminal: { threadId: "grace-thread", terminalId: "t" } },
            { pid: 102, terminal: { threadId: "acme-thread", terminalId: "t" } },
            { pid: 103, terminal: null },
          ].map(({ pid, terminal }) => ({
            host: "127.0.0.1",
            port: 3000 + pid,
            url: `http://127.0.0.1:${3000 + pid}/`,
            processName: "node",
            pid,
            terminal,
          }));
          const discovery = Layer.mock(PortScanner.PortDiscovery)({
            trackAgent: () => () => undefined,
            retain: Effect.void,
            scan: () => Effect.succeed(listed as never),
            subscribe: () => Effect.void,
            stopServer: (input: { readonly pid: number }) =>
              Effect.sync(() => {
                stopped.push(input.pid);
              }),
          });
          const asGrace = yield* connect(server, grace.userId, discovery);
          const first = yield* asGrace[WS_METHODS.subscribeDiscoveredLocalServers]({}).pipe(
            Stream.runHead,
          );
          assert.deepEqual(
            Option.getOrThrow(first).servers.map((entry) => entry.pid),
            [101],
          );
          const stop = (pid: number) =>
            outcome(asGrace[WS_METHODS.previewStopLocalServer]({ pid, port: 3000 + pid }));
          assert.equal(yield* stop(102), "PreviewStopLocalServerError");
          assert.equal(yield* stop(103), "PreviewStopLocalServerError");
          assert.equal(yield* stop(101), "reached");
          assert.deepEqual(stopped, [101]);
        }),
      ),
    );
  });
});
