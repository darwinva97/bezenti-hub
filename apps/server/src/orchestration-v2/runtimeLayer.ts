import * as GuestShareService from "../guest/GuestShareService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import * as MakitaIntake from "../makita/MakitaIntake.ts";
import * as MakitaMachines from "../makita/MakitaMachines.ts";
import * as MakitaLanding from "../makita/MakitaLanding.ts";
import * as MakitaPullRequests from "../makita/MakitaPullRequests.ts";
import * as MakitaPushes from "../makita/MakitaPushes.ts";
import * as MakitaStops from "../makita/MakitaStops.ts";
import * as MakitaTasks from "../makita/MakitaTasks.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointUploadService from "./CheckpointUploadService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ActiveEnvironment from "../environment/ActiveEnvironment.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import * as EnvironmentReturnService from "./EnvironmentReturnService.ts";
import * as AiSessionReach from "./AiSessionReach.ts";
import * as ProjectMoveThreads from "./ProjectMoveThreads.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as InactiveUserTurns from "./InactiveUserTurns.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccountReach from "../ai/AiAccountReach.ts";
import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import * as EffectiveVaults from "../vaults/EffectiveVaults.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

// The Hub machine's executor owns the local adapters, runtime policy and checkpoint store; the
// orchestration services get forwarding versions that go to the current Environment's executor.
const layerEnvironmentExecutorsProvided = EnvironmentExecutor.layerHubMachine.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      RuntimePolicy.layerFromProjectStore,
      ActiveEnvironment.layerActiveEnvironmentResolver,
    ).pipe(Layer.provideMerge(ProjectStore.layer)),
  ),
);
// Joined Environments' executors, registered while their sockets are open.
const layerRemoteEnvironmentsProvided = RemoteEnvironments.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      ProjectCheckouts.layer,
      ProjectStore.layer,
      ProjectionStore.layer,
    ),
  ),
);
export const layerProviderAdaptersProvided = EnvironmentExecutor.layerProviderAdapterRegistry.pipe(
  Layer.provide(layerEnvironmentExecutorsProvided),
);
const layerRuntimePolicyProvided = EnvironmentExecutor.layerRuntimePolicy.pipe(
  Layer.provide(Layer.merge(layerEnvironmentExecutorsProvided, ProjectCheckouts.layer)),
);
export const layerCheckpointStoreProvided = EnvironmentExecutor.layerCheckpointStore.pipe(
  Layer.provide(layerEnvironmentExecutorsProvided),
);
const layerHubRepositoryTransfersProvided = EnvironmentExecutor.layerHubRepositoryTransfers.pipe(
  Layer.provide(layerEnvironmentExecutorsProvided),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSink),
);

const layerAllowedAiAccounts = AllowedAiAccounts.layer.pipe(Layer.provide(SpaceDirectory.layer));

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSink,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
      SpaceDirectory.layer,
      // A move's plan reads the Vaults it loses (spec 5 ticket 07): never optional.
      EffectiveVaults.layer.pipe(Layer.provide(SpaceDirectory.layer)),
      // And its AI accounts: it re-chooses them and revokes keys (spec 4 ticket 11).
      AiAccountReach.layer.pipe(Layer.provide(layerAllowedAiAccounts)),
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      layerCheckpointStoreProvided,
      layerHubRepositoryTransfersProvided,
    ),
  ),
);
const layerCheckpointUploadsProvided = CheckpointUploadService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      layerEventSink,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(layerProviderAdaptersProvided),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSink, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      layerCommandOutputHubProvided,
      layerProviderAdaptersProvided,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      PreviewAgentActivity.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
    ),
  ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerCheckpointUploadsProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSink,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      layerProviderAdaptersProvided,
      layerEnvironmentExecutorsProvided,
      // Reuse the continuation worker's layer reference so memoization shares one request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
      // Every command is checked against the Role rules (`commandAccess.ts`).
      SpaceDirectory.layer,
    ),
  ),
);

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSink,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      // Which machines are connected, so a message to a paused Thread queues.
      layerEnvironmentExecutorsProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
      SpaceDirectory.layer,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerManagedProjectFoldersProvided,
      layerSecretRequestsProvided,
      // A task acts as its creator and is checked as them.
      SpaceDirectory.layer,
    ),
  ),
);
const layerScratchThreadPromotionProvided = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerScheduledTaskProvided,
    ),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      ProjectStore.layer,
      TextGeneration.layer,
      // Off the Hub machine, the Thread's own Environment titles it.
      layerEnvironmentExecutorsProvided,
      ProjectCheckouts.layer,
    ),
  ),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerStores, layerEffectExecutorProvided, layerEnvironmentExecutorsProvided),
  ),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

// Moves Threads between Environments outside the effect lane, resuming after a restart.
const layerThreadMovesProvided = ThreadMoveService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      layerRemoteEnvironmentsProvided,
      layerEventSink,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
      ProjectCheckouts.layer,
      layerOrchestratorProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

// Removed machines release their Threads; returning ones hand over the changes they kept.
const layerEnvironmentReturnsProvided = EnvironmentReturnService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEnvironmentExecutorsProvided,
      layerRemoteEnvironmentsProvided,
      layerEventSink,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ProjectionStore.layer,
      layerOrchestratorProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

// Provider processes out of their AI account's reach close (spec 4 ticket 11).
const layerAiSessionReachProvided = AiSessionReach.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProviderSessionManagerProvided,
      layerAllowedAiAccounts,
      SpaceDirectory.layer,
    ),
  ),
);

// A Project moving to another Space stops its Threads and cuts released ones off their machine.
const layerProjectMoveThreadsProvided = ProjectMoveThreads.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      ProjectionStore.layer,
      layerEventSink,
      layerEnvironmentExecutorsProvided,
      // Without it a released Thread's events, terminals and sessions there would go unchecked.
      layerRemoteEnvironmentsProvided,
      layerProviderSessionManagerProvided,
      // Provider processes out of their AI account's reach close (spec 4 ticket 11).
      layerAiSessionReachProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerEnvironmentReturnsProvided,
  layerProjectMoveThreadsProvided,
  layerAiSessionReachProvided,
  layerEnvironmentExecutorsProvided,
  layerRemoteEnvironmentsProvided,
  layerCheckpointUploadsProvided,
  layerThreadMovesProvided,
  layerCommandOutputHubProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

export const layerProduction = Layer.mergeAll(
  layer.pipe(Layer.provide(layerProjectService)),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerScheduledTaskProvided,
  layerScratchThreadPromotionProvided,
  layerSecretRequestsProvided,
  // Archive stops what runs in an Organization; delete goes through the Project delete path.
  OrganizationLifecycle.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerProjectService,
        layerThreadManagementProvided,
        ProjectionStore.layer,
        SpaceDirectory.layer,
      ),
    ),
  ),
  GuestShareService.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerCommandOutputHubProvided)),
  ),
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        layerOrchestratorProvided,
      ),
    ),
  ),
  layerProviderContinuationWorkerProvided,
  InactiveUserTurns.layer.pipe(
    Layer.provide(Layer.merge(layerThreadManagementProvided, SpaceDirectory.layer)),
  ),
  layerAgentSessionImporterProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
  // Makita (tickets 04–05): Makita's token reads each listened repository's events, and an
  // accepted trigger becomes a task whose Thread runs as the configuration's creator.
  MakitaTasks.layerScheduled.pipe(
    // Makita ticket 12: a task's pull request, and the watch of its CI.
    Layer.merge(MakitaPullRequests.layerScheduled),
    Layer.provideMerge(
      MakitaPullRequests.layer.pipe(
        Layer.provide(Layer.mergeAll(layerThreadManagementProvided, AuditLog.layer)),
      ),
    ),
    Layer.provideMerge(
      MakitaTasks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(layerThreadLaunchProvided, layerThreadManagementProvided, AuditLog.layer),
        ),
      ),
    ),
    // Makita ticket 13: landing a task's pull request on an approver's order.
    Layer.provideMerge(MakitaLanding.layer.pipe(Layer.provide(layerThreadManagementProvided))),
    // Makita ticket 10: a pushing task's worktree on its machine, and `makita_push`.
    Layer.provideMerge(
      MakitaPushes.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            MakitaMachines.layer.pipe(Layer.provide(layerEnvironmentExecutorsProvided)),
            AuditLog.layer,
          ),
        ),
      ),
    ),
    Layer.provideMerge(MakitaIntake.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(SpaceDirectory.layer),
  ),
  // Makita ticket 06: a stopped task's turn is interrupted, as the system.
  MakitaStops.layerScheduled.pipe(
    Layer.provide(MakitaStops.layer.pipe(Layer.provide(layerThreadManagementProvided))),
  ),
).pipe(
  Layer.provide(
    ResourceCleanupService.layer.pipe(
      Layer.provide(layerScheduledTaskProvided),
      // Optional to the service: a Thread on a joined Environment closes its terminals there.
      Layer.provide(layerEnvironmentExecutorsProvided),
    ),
  ),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(layerEventInfrastructure),
);
