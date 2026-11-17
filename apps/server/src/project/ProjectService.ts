import {
  CommandId,
  type OrchestrationProjectShell,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  type SpaceId,
  type ThreadId,
  type UserId,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  HUB_MACHINE_ENVIRONMENT_ID,
  type VaultGroupId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { withCommandMetrics } from "../observability/Metrics.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  planProjectCommand,
  type ProjectCommand,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  LIVE_WORK_FIELDS,
  LIVE_WORK_FILTER,
  threadHasLiveWork,
} from "../orchestration-v2/threadLiveWork.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as DirectoryRoots from "../spaces/directoryRoots.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import type * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as AuditLog from "../audit/AuditLog.ts";
import { servesSpace } from "../sandboxes/sandboxSpace.ts";
import * as AiAccountReach from "../ai/AiAccountReach.ts";
import * as EffectiveVaults from "../vaults/EffectiveVaults.ts";
import * as VaultReachLoss from "../vaults/VaultReachLoss.ts";
import * as ProjectMoveHooks from "./ProjectMoveHooks.ts";

export interface ProjectCreateInput extends ProjectCreatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  /** The creating User (their session, or an MCP caller's scope); `t3 project` leaves it out for the Owner. */
  readonly actorUserId?: UserId;
  /** The client's current Space. */
  readonly spaceId?: SpaceId;
  /**
   * The Hub chose and made `workspaceRoot` itself (a named Project's folder, a Scratch Thread's):
   * never set from what a client sends.
   */
  readonly workspaceRootFromHub?: boolean;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export interface ProjectMoveInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  /**
   * Stop the Project's running Threads first, as the mover confirmed after seeing them
   * (`movePlan`). Without it a running Thread refuses the move.
   */
  readonly stopThreads?: boolean | undefined;
}

/** One of the Project's Threads, as `movePlan` names it. */
export interface ProjectMovePlanThread {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Its Active environment now; null when it already needs one. */
  readonly environmentId: EnvironmentId | null;
}

/** What moving the Project to `spaceId` would do to its Threads, for the mover to confirm. */
export interface ProjectMovePlan {
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  /** Running now: the move stops them. */
  readonly running: ReadonlyArray<ProjectMovePlanThread>;
  /** On a machine that does not serve `spaceId`: they need an environment after the move. */
  readonly needsEnvironment: ReadonlyArray<ProjectMovePlanThread>;
  /** The Vaults its Threads stop receiving (`EffectiveVaults.projectMove`). */
  readonly vaultsLost: ReadonlyArray<{ readonly vaultId: VaultGroupId; readonly name: string }>;
  /** The AI accounts its Threads lose (`AiAccountReach.projectMoveLoss`, spec 4 ticket 11). */
  readonly aiAccountsLost: ReadonlyArray<AiAccountReach.AiAccountLost>;
}

const encodeSessionIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The moved Project, and the Threads the move released (they need an environment now). */
export interface ProjectMoveResult {
  readonly project: Project;
  readonly released: ReadonlyArray<ProjectMovePlanThread>;
}

/** A Project is moved only once none of its Threads runs. */
export class ProjectMoveBlockedError extends Schema.TaggedError<ProjectMoveBlockedError>()(
  "ProjectMoveBlockedError",
  { projectId: ProjectId, threadTitles: Schema.Array(Schema.String) },
) {
  override get message(): string {
    const names = this.threadTitles.map((title) => `"${title}"`).join(", ");
    return `Stop the running Threads of this Project before moving it: ${names}.`;
  }
}
const isMoveBlocked = Schema.is(ProjectMoveBlockedError);

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedError<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedError<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not empty.`;
  }
}

export class ProjectOperationError extends Schema.TaggedError<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "move-thread",
      "dispatch-project-command",
      "check-environment",
      "check-folder",
      "read-vaults",
      "read-ai-accounts",
      "drop-vault-choices",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | SpaceDirectory.SpaceClaimError
  | SpaceDirectory.ItemAccessError
  | SpaceDirectory.ProjectMoveError
  | ProjectMoveBlockedError
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectNotEmptyError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    /**
     * Moves the Project and every Thread in it to another Space (`project.move`), refused while
     * any of them runs. Viewers of the origin lose it and those of the destination gain it live.
     */
    readonly move: (
      input: ProjectMoveInput,
    ) => Effect.Effect<ProjectMoveResult, ProjectServiceError>;
    /**
     * What `move` would do, checked as `move` is (`project.move` on both Spaces): which Threads it
     * stops and which then need an environment (`servesSpace`).
     */
    readonly movePlan: (input: {
      readonly projectId: ProjectId;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<ProjectMovePlan, ProjectServiceError>;
    /**
     * Permanently deletes every Project and Thread of a Space through their own delete paths, as
     * deleting an archived Organization does. Retry-safe: a rerun deletes what is left.
     */
    readonly deleteSpaceContent: (input: {
      readonly commandId: CommandId;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<void, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /** The Projects the viewer may see, the others never read past their row. */
    readonly snapshotFor: (
      visibility: SpaceVisibility.Visibility,
    ) => Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /**
     * A page of active projects in creation order, each with its repository
     * identity resolved, so a caller can match projects by repository.
     */
    readonly listPage: (input: {
      readonly cursor: number;
      readonly limit: number;
      /** Only the Projects this viewer may see; every Project when absent. */
      readonly visibility?: SpaceVisibility.Visibility;
    }) => Effect.Effect<
      { readonly projects: ReadonlyArray<Project>; readonly nextCursor: number | null },
      ProjectOperationError
    >;
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectOperationError>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const threadProjections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const path = yield* Path.Path;
  const directories = { path, fileSystem: yield* Effect.serviceOption(FileSystem.FileSystem) };
  const moveHooks = yield* Effect.serviceOption(ProjectMoveHooks.ProjectMoveHooks);
  // Required: a move whose losses cannot be read fails rather than warn of none (ticket 07).
  const effectiveVaults = yield* EffectiveVaults.EffectiveVaults;
  // Required too: a move always re-chooses its Threads' AI accounts and revokes their keys.
  const aiReach = yield* AiAccountReach.AiAccountReach;
  const projectLocks = yield* KeyedLock.make<ProjectId>();
  const rootClaims = yield* KeyedLock.make<string>();
  const workspaceLocks = yield* KeyedLock.make<string>();

  const toProject = (
    row: ProjectStore.ProjectRow,
    enrichment: ProjectEnrichmentService.ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    pinnedAt: row.pinnedAt,
    archivedAt: row.archivedAt,
    spaceId: row.spaceId,
    ownerUserId: row.ownerUserId,
    preferredEnvironmentId: row.preferredEnvironmentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (row: ProjectStore.ProjectRow) {
    const enrichment =
      row.deletedAt === null
        ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
        : yield* projectEnrichment.peek(row.workspaceRoot);
    return toProject(row, enrichment);
  });

  const readRow = (projectId: ProjectId, options?: { readonly includeDeleted?: boolean }) =>
    projects
      .get(projectId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );

  const normalizeWorkspaceRoot = (input: {
    readonly projectId?: ProjectId;
    readonly workspaceRoot: string;
    readonly createIfMissing?: boolean;
  }) =>
    workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createIfMissing ?? false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "normalize-workspace",
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        ),
      );

  /** A permanent delete, or a move to another Space, is audited with its commit. */
  const auditOf = (
    command: ProjectCommand,
    project: { readonly spaceId: SpaceId | null } | undefined,
  ): AuditLog.AuditDraft | undefined => {
    const target = { kind: "project", id: command.projectId } as const;
    if (command.type === "project.delete") {
      return { action: "project.delete", spaceId: project?.spaceId ?? null, target };
    }
    if (
      command.type === "project.meta.update" &&
      command.spaceId !== undefined &&
      command.spaceId !== project?.spaceId
    ) {
      return {
        action: "project.move",
        spaceId: command.spaceId,
        target,
        detail: { fromSpaceId: project?.spaceId ?? null },
      };
    }
    return undefined;
  };

  const commit = Effect.fn("ProjectService.commit")(function* (
    command: ProjectCommand,
    /** Committed with the command's event, never on a replay (a move's Vault choices). */
    alsoCommit?: Effect.Effect<void, Error>,
  ) {
    const { projectId } = command;
    const dispatchError = (cause: unknown) =>
      new ProjectOperationError({ operation: "dispatch-project-command", projectId, cause });
    const workspaceRoot = command.type === "project.delete" ? undefined : command.workspaceRoot;
    const planAndCommit = Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* readRow(projectId, { includeDeleted: true }));
      const workspaceOwner =
        workspaceRoot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceRoot(workspaceRoot)
                .pipe(Effect.mapError(dispatchError)),
            );
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: { project, workspaceOwner },
        eventId,
        now,
      });
      if (Result.isSuccess(planned)) {
        const audit = auditOf(command, project);
        const { receipt } = yield* eventSink.commitProjectCommand({
          commandId: command.commandId,
          projectId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
          ...(audit === undefined ? {} : { audit }),
          ...(alsoCommit === undefined ? {} : { alsoCommit }),
        });
        return receipt;
      }
      return yield* eventSink.commitRejectedProjectCommand({
        commandId: command.commandId,
        projectId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeProjectCommandRejection(planned.failure),
      });
    });
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        workspaceRoot === undefined
          ? planAndCommit
          : workspaceLocks.withLock(workspaceRoot, planAndCommit),
      )
      .pipe(Effect.mapError(dispatchError));
    const actor = yield* CommandActor.current;
    if (
      receipt.projectId !== projectId ||
      receipt.commandType !== command.type ||
      // A command id replays only for the User who sent it.
      (actor !== undefined && receipt.actorUserId != null && receipt.actorUserId !== actor)
    ) {
      return yield* dispatchError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.projectId}.`,
      );
    }
    // Retries re-plan against their own effects; the first receipt determines the outcome.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeProjectCommandRejection(receipt.error));
    switch (rejection?._tag) {
      case "ProjectWorkspaceConflictError":
        return yield* new ProjectConflictError({
          projectId,
          workspaceRoot: rejection.workspaceRoot,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectCommandMissingProjectError":
        return yield* new ProjectNotFoundError({ projectId });
      default:
        return yield* dispatchError(
          rejection ?? receipt.error ?? "The command was previously rejected.",
        );
    }
  }, withCommandMetrics);

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* readRow(projectId, { includeDeleted: true });
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project row.",
      });
    }
    return yield* hydrate(row.value);
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* readRow(projectId, options);
      return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* normalizeWorkspaceRoot({ workspaceRoot });
    const row = yield* (
      options?.includeDeleted === true
        ? projects
            .list({ includeDeleted: true })
            .pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(rows.find((row) => row.workspaceRoot === normalized)),
              ),
            )
        : projects.findActiveByWorkspaceRoot(normalized)
    ).pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
  });

  /** Whether the User acts for the whole Installation: the Owner, or anyone before one exists. */
  // An agent bound to one Space's machine never does, whoever its User is.
  const actsForInstallation = (userId: UserId | undefined) =>
    Effect.flatMap(CommandActor.spaceLimit, (limit) =>
      limit !== undefined
        ? Effect.succeed(false)
        : userId === undefined
          ? Effect.succeed(true)
          : spaces.viewableSpaces(userId).pipe(
              Effect.map((viewable) => viewable === "all"),
              Effect.mapError(
                (cause) => new ProjectOperationError({ operation: "check-folder", cause }),
              ),
            ),
    );

  // The same folder however it is spelled, read without touching the disk.
  const sameFolder = Effect.fn("ProjectService.sameFolder")(function* (a: string, b: string) {
    const home = yield* HostProcess.HomeDirectory;
    const lexical = (candidate: string) =>
      path.resolve(
        candidate === "~" || candidate.startsWith("~/")
          ? path.join(home, candidate.slice(1))
          : candidate,
      );
    return lexical(a) === lexical(b);
  });

  // A Project's root is what the directory checks trust (`SpaceVisibility.mayReadDirectory`):
  // the Owner roots one anywhere; anyone else only in a new folder right in the Hub's Projects
  // folder that no Project holds (as a clone's), or in one the Hub made.
  const requireProjectRoot = Effect.fn("ProjectService.requireProjectRoot")(function* (
    actorUserId: UserId | undefined,
    workspaceRoot: string,
  ) {
    if (yield* actsForInstallation(actorUserId)) return;
    const allowed =
      Option.isSome(config) &&
      (yield* DirectoryRoots.isNewFolderIn(directories, sql, workspaceRoot, [
        DirectoryRoots.projectsRootOf(path, config.value.baseDir),
      ]));
    if (!allowed) {
      return yield* new SpaceDirectory.SpaceAccessDeniedError({
        action: "project.create",
        reason: "folder-not-allowed",
      });
    }
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const actorUserId = input.actorUserId ?? Option.getOrUndefined(yield* spaces.actingUser);
      // Before touching the workspace, which may create its folder.
      const stamp = yield* spaces.claimCreation({
        action: "project.create",
        actorUserId,
        spaceId: input.spaceId,
      });
      // The folder is checked, made and claimed as one step, so two creates (from different
      // Spaces, say) never both find the same folder new.
      // Keyed by where the folder leads (its nearest existing parent's real path and the rest), so
      // two spellings of one folder, or a link to it, wait for each other.
      const workspaceRoot = yield* rootClaims.withLock(
        yield* DirectoryRoots.realOf(directories, path.resolve(input.workspaceRoot)),
        Effect.gen(function* () {
          if (input.workspaceRootFromHub !== true) {
            yield* requireProjectRoot(actorUserId, input.workspaceRoot);
          }
          const workspaceRoot = yield* normalizeWorkspaceRoot({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            createIfMissing: input.createWorkspaceRootIfMissing ?? false,
          });
          yield* commit({
            type: "project.create",
            commandId: input.commandId,
            projectId: input.projectId,
            title: input.title,
            workspaceRoot,
            ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
            ...stamp,
          });
          return workspaceRoot;
        }),
      );
      yield* projectEnrichment.invalidate([workspaceRoot]);
      return yield* readCommitted(input.projectId);
    },
  );

  // The Role rules for an existing Project, for whoever the command acts for.
  const authorizeProject = Effect.fn("ProjectService.authorizeProject")(function* (
    projectId: ProjectId,
    actions: ReadonlyArray<AccessPolicy.Action>,
  ) {
    const actor = yield* spaces.actingUser;
    if (Option.isNone(actor)) return;
    for (const action of actions) {
      yield* spaces.authorizeItem(actor.value, action, { kind: "project", id: projectId });
    }
  });

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const { commandId: _commandId, projectId: _projectId, archived, ...changes } = input;
      yield* authorizeProject(input.projectId, [
        ...(archived === undefined ? [] : ["project.archive" as const]),
        ...(Object.values(changes).some((value) => value !== undefined)
          ? ["project.manage" as const]
          : []),
      ]);
      const existing = yield* readRow(input.projectId);
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      // The Hub machine is everyone's and is what no preference means, so it is stored as none.
      const preferredEnvironmentId =
        input.preferredEnvironmentId === HUB_MACHINE_ENVIRONMENT_ID
          ? null
          : input.preferredEnvironmentId;
      if (preferredEnvironmentId !== undefined && preferredEnvironmentId !== null) {
        const actor = yield* spaces.actingUser;
        const usable = yield* EnvironmentRegistry.mayUseEnvironment(
          Option.getOrUndefined(actor),
          preferredEnvironmentId,
          existing.value.spaceId ?? undefined,
        ).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(SpaceDirectory.SpaceDirectory, spaces),
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "check-environment",
                projectId: input.projectId,
                cause,
              }),
          ),
        );
        // Someone else's machine and an unknown one answer alike.
        if (!usable) {
          return yield* new SpaceDirectory.SpaceAccessDeniedError({
            action: "environment.use",
            reason: "not-yours",
          });
        }
      }
      // An icon outside the Project's folder is served from wherever it names: the Owner's call.
      if (
        input.faviconPath != null &&
        DirectoryRoots.leavesFolder(input.faviconPath) &&
        !(yield* actsForInstallation(Option.getOrUndefined(yield* spaces.actingUser)))
      ) {
        return yield* new SpaceDirectory.SpaceAccessDeniedError({
          action: "project.manage",
          reason: "icon-owner-only",
        });
      }
      const previousRoot = existing.value.workspaceRoot;
      // Before the folder is looked at, so the refusal says nothing about what exists on disk.
      if (
        input.workspaceRoot !== undefined &&
        !(yield* sameFolder(input.workspaceRoot, previousRoot)) &&
        !(yield* actsForInstallation(Option.getOrUndefined(yield* spaces.actingUser)))
      ) {
        return yield* new SpaceDirectory.SpaceAccessDeniedError({
          action: "project.manage",
          reason: "folder-owner-only",
        });
      }
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? previousRoot
          : yield* normalizeWorkspaceRoot({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
            });
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(workspaceRoot === previousRoot ? {} : { workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
        ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
        ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
        ...(input.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        ...(preferredEnvironmentId === undefined ? {} : { preferredEnvironmentId }),
      });
      if (workspaceRoot !== previousRoot) {
        yield* projectEnrichment.invalidate([previousRoot, workspaceRoot]);
      }
      return yield* readCommitted(input.projectId);
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteChildThread = Effect.fn("ProjectService.deleteChildThread")(function* (
    input: { readonly commandId: CommandId; readonly projectId?: ProjectId },
    threadId: ThreadId,
  ) {
    yield* legacyImporter.ensureTranscript(threadId);
    const projection = yield* threadProjections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
    ]);
    if (
      projection.thread.deletedAt !== null ||
      (input.projectId !== undefined && projection.thread.projectId !== input.projectId)
    ) {
      return;
    }
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`${input.commandId}:delete-thread:${threadId}`),
      threadId,
    };
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* threadProjections.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    const committed = yield* eventSink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
      // Each Thread a Project or Organization delete destroys is named on its own.
      audit: {
        action: "thread.delete",
        target: { kind: "thread", id: threadId },
        detail: { via: input.projectId === undefined ? "organization.delete" : "project.delete" },
      },
    });
    if (
      committed.receipt.threadId !== command.threadId ||
      committed.receipt.commandType !== command.type
    ) {
      return yield* Effect.fail("The thread deletion command ID belongs to a different command.");
    }
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(
        committed.receipt.error ?? "Thread deletion was previously rejected.",
      );
    }
  });

  const deleteChildThreads = Effect.fn("ProjectService.deleteChildThreads")(function* (
    input: ProjectDeleteInput,
  ) {
    const { projectId } = input;
    const snapshot = yield* threadProjections
      .getShellSnapshot({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads];
    if (projectThreads.length > 0 && input.force !== true) {
      return yield* new ProjectNotEmptyError({ projectId });
    }
    // Delete children durably before the project so a failed cascade can be retried.
    yield* Effect.forEach(
      projectThreads,
      (thread) =>
        threadCommands
          .withLock(thread.id, deleteChildThread(input, thread.id))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  // Best-effort cleanup releases disabled instances kept alive by overrides; crashes have no replay to revisit deletion.
  const clearProjectSettingsOverrides = (projectId: ProjectId) =>
    serverSettings.updateSettings({ projectSettingsOverrides: { [projectId]: null } }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to clear settings overrides for deleted project ${projectId}.`,
          cause,
        ),
      ),
    );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      yield* authorizeProject(projectId, ["project.delete"]);
      // Read deleted rows so retries replay receipts and other command ids fail as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      const isFirstDelete = existing.value.deletedAt === null;
      if (isFirstDelete) {
        yield* deleteChildThreads(input);
      }
      // Its Vault choices go with it (spec 5 ticket 07).
      yield* commit(
        { type: "project.delete", commandId: input.commandId, projectId },
        VaultReachLoss.forgetProject(sql, projectId),
      );
      if (isFirstDelete) {
        yield* clearProjectSettingsOverrides(projectId);
      }
      yield* projectEnrichment.invalidate([existing.value.workspaceRoot]);
      return yield* readCommitted(projectId);
    },
  );

  const listProjectThreads = (projectId: ProjectId) =>
    sql<{ readonly threadId: ThreadId; readonly title: string }>`
      SELECT thread_id AS "threadId", title FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      ORDER BY created_at ASC, thread_id ASC
    `.pipe(
      Effect.mapError(
        (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
      ),
    );
  /** The live work a move checks, with the provider sessions it may release, in one read. */
  const threadMoveWork = (threadId: ThreadId, projectId: ProjectId) =>
    threadProjections
      .getThreadRecords(threadId, [...LIVE_WORK_FIELDS, "providerSessions"], LIVE_WORK_FILTER)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );

  /** `servesSpace` answers, read once per machine within one move or plan. */
  type ServesCache = Map<string, boolean>;

  /**
   * The machine a Thread leaves when its Project's Space becomes `spaceId`: its Active
   * environment, unless that machine serves `spaceId` (`servesSpace`). Undefined when it stays,
   * or has none already.
   */
  const machineLeft = Effect.fn("ProjectService.machineLeft")(function* (
    environmentId: EnvironmentId | null | undefined,
    spaceId: SpaceId,
    projectId: ProjectId,
    cache: ServesCache,
    /** The Thread on it: a Guest's machine serves only that Guest's Threads. */
    thread?: { readonly id: ThreadId; readonly ownerUserId?: UserId | null | undefined },
  ) {
    if (environmentId === undefined || environmentId === null) return undefined;
    // Per machine and Thread owner: the answer depends on nothing else.
    const key = `${environmentId} ${thread?.ownerUserId ?? (thread === undefined ? "" : `thread:${thread.id}`)}`;
    const known = cache.get(key);
    const serves =
      known ??
      (yield* servesSpace(environmentId, spaceId, thread?.id).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({ operation: "check-environment", projectId, cause }),
        ),
      ));
    cache.set(key, serves);
    return serves ? undefined : environmentId;
  });

  /** What moving its Project to `spaceId` does to one Thread; undefined for one not in it. */
  const threadMovePlan = Effect.fn("ProjectService.threadMovePlan")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
    spaceId: SpaceId,
    cache: ServesCache,
  ) {
    const records = yield* threadMoveWork(threadId, projectId);
    const thread = records.thread;
    if (thread.deletedAt !== null || thread.projectId !== projectId) return undefined;
    const releasedFrom = yield* machineLeft(
      thread.activeEnvironmentId,
      spaceId,
      projectId,
      cache,
      thread,
    );
    return {
      records,
      thread,
      releasedFrom,
      // A Thread already in the Space whose machine does not serve it (moved before Sandboxes,
      // or a move cut short) is still released.
      changes: thread.spaceId !== spaceId || releasedFrom !== undefined,
      // A move between machines under way counts: it could land on the machine being left.
      running: threadHasLiveWork(records) || thread.move?.status === "running",
    };
  });

  const planEntry = (
    threadId: ThreadId,
    thread: {
      readonly title: string;
      readonly activeEnvironmentId?: EnvironmentId | null | undefined;
    },
  ): ProjectMovePlanThread => ({
    threadId,
    title: thread.title,
    environmentId:
      thread.activeEnvironmentId === undefined
        ? HUB_MACHINE_ENVIRONMENT_ID
        : thread.activeEnvironmentId,
  });

  /**
   * Gives one Thread the Project's new Space (checked as a move out of the Thread's own). One whose
   * machine does not serve it is released in the same transaction, recorded in
   * `thread_environment_releases` for `drainReleases` to cut that machine off.
   */
  const moveThread = Effect.fn("ProjectService.moveThread")(function* (
    input: ProjectMoveInput,
    threadId: ThreadId,
    actor: UserId | undefined,
    cache: ServesCache,
    /** The destination's catalogs, read before any write (`AiAccountReach.catalogsFor`). */
    catalogs: AiAccountReach.Catalogs,
    /** The Project's Space before the move: a Thread without its own is in it until now. */
    fromSpaceId: SpaceId,
  ) {
    const plan = yield* threadMovePlan(threadId, input.projectId, input.spaceId, cache);
    if (plan === undefined || !plan.changes) return { changed: false, released: undefined };
    const { thread, releasedFrom, records } = plan;
    if (thread.spaceId !== input.spaceId) {
      yield* spaces.authorizeProjectMove({
        actor,
        item: { kind: "thread", id: threadId },
        spaceId: input.spaceId,
      });
    }
    if (plan.running) {
      return yield* new ProjectMoveBlockedError({
        projectId: input.projectId,
        threadTitles: [thread.title],
      });
    }
    const commandId = CommandId.make(`${input.commandId}:move-thread:${threadId}`);
    const now = yield* DateTime.now;
    const id = yield* idAllocator.allocate.event({ threadId, commandId });
    const detached: Array<OrchestrationV2DomainEvent> = [];
    if (releasedFrom !== undefined) {
      for (const session of records.providerSessions) {
        if (session.status === "stopped" || session.status === "error") continue;
        detached.push({
          id: yield* idAllocator.allocate.event({ threadId, commandId }),
          type: "provider-session.detached",
          threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: {
            providerSessionId: session.id,
            detachedAt: now,
            reason: "The Thread's Project moved to a Space its machine does not serve.",
          },
        });
      }
    }
    const commitThread = (modelSelection: typeof thread.modelSelection) =>
      eventSink.commitCommand({
        commandId,
        commandType: "thread.space.move",
        threadId,
        acceptedAt: now,
        events: [
          {
            id,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...thread,
              modelSelection,
              spaceId: input.spaceId,
              updatedAt: now,
              ...(releasedFrom === undefined ? {} : { activeEnvironmentId: null }),
            },
          },
          ...detached,
        ],
        effects: [],
      });
    // Every session the Thread had there is let go, whatever the projection says of it.
    const sessionIds = encodeSessionIds(records.providerSessions.map((session) => session.id));
    // Its Space in effect: a Thread from before Spaces has none of its own, and is its Project's.
    const spaceChanges = (thread.spaceId ?? fromSpaceId) !== input.spaceId;
    const recordRelease = (environmentId: EnvironmentId) =>
      sql`
        INSERT INTO thread_environment_releases (
          thread_id, environment_id, provider_session_ids_json, released_at
        ) VALUES (${threadId}, ${environmentId}, ${sessionIds}, ${DateTime.formatIso(now)})
        ON CONFLICT (thread_id, environment_id)
        DO UPDATE SET provider_session_ids_json = excluded.provider_session_ids_json
      `.pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "move-thread",
              projectId: input.projectId,
              cause,
            }),
        ),
      );
    // Spec 4 ticket 11: in the same transaction, its gateway keys are revoked and its AI account
    // is the destination's (kept if still allowed to its turn owner there, else the first allowed,
    // else none), read in the transaction that writes it.
    const driver = records.providerSessions
      .filter((session) => session.providerInstanceId === thread.providerInstanceId)
      .at(-1)?.driver;
    const write = Effect.gen(function* () {
      if (releasedFrom !== undefined) yield* recordRelease(releasedFrom);
      const modelSelection = spaceChanges
        ? yield* aiReach.moveThread({
            thread: { threadId, modelSelection: thread.modelSelection, driver },
            spaceId: input.spaceId,
            catalogs,
          })
        : thread.modelSelection;
      const done = yield* commitThread(modelSelection);
      // A rejected move writes nothing: no key revoked, no release recorded for it.
      if (done.receipt.status === "rejected") {
        return yield* new ProjectOperationError({
          operation: "move-thread",
          projectId: input.projectId,
          cause: done.receipt.error ?? "The Thread move was rejected.",
        });
      }
      return done;
    });
    const committed = yield* (
      releasedFrom === undefined && !spaceChanges
        ? commitThread(thread.modelSelection)
        : sql.withTransaction(write)
    ).pipe(
      Effect.mapError((cause) =>
        isMoveBlocked(cause)
          ? cause
          : new ProjectOperationError({
              operation: "move-thread",
              projectId: input.projectId,
              cause,
            }),
      ),
    );
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(committed.receipt.error ?? "The Thread move was rejected.");
    }
    return {
      changed: true,
      released: releasedFrom === undefined ? undefined : planEntry(threadId, thread),
    };
  });

  /**
   * The Project's Threads `spaceId` changes, and those of them running now, each read under its
   * own lock.
   */
  const threadsToMove = Effect.fn("ProjectService.threadsToMove")(function* (
    projectId: ProjectId,
    spaceId: SpaceId,
    cache: ServesCache,
  ) {
    const running: Array<{ readonly threadId: ThreadId; readonly title: string }> = [];
    let changing = 0;
    for (const thread of yield* listProjectThreads(projectId)) {
      const plan = yield* threadCommands.withLock(
        thread.threadId,
        threadMovePlan(thread.threadId, projectId, spaceId, cache),
      );
      if (plan === undefined || !plan.changes) continue;
      changing += 1;
      if (plan.running) running.push({ threadId: thread.threadId, title: plan.thread.title });
    }
    return { running, changing };
  });

  /** The Vaults the move takes from the Project's Threads (spec 5 ticket 07), by name. */
  const vaultsLostOnMove = (
    projectId: ProjectId,
    route: { readonly from: SpaceId; readonly to: SpaceId },
  ) =>
    effectiveVaults.projectMoveLoss({ projectId, from: route.from, to: route.to }).pipe(
      Effect.map((lost) => lost.map(({ vaultId, name }) => ({ vaultId, name }))),
      Effect.mapError(
        (cause) => new ProjectOperationError({ operation: "read-vaults", projectId, cause }),
      ),
    );

  const movePlan: ProjectService["Service"]["movePlan"] = Effect.fn("ProjectService.movePlan")(
    function* (input) {
      const { projectId } = input;
      const existing = yield* readRow(projectId);
      if (Option.isNone(existing)) return yield* new ProjectNotFoundError({ projectId });
      const actor = Option.getOrUndefined(yield* spaces.actingUser);
      const route = yield* spaces.authorizeProjectMove({
        actor,
        item: { kind: "project", id: projectId },
        spaceId: input.spaceId,
      });
      const cache: ServesCache = new Map();
      // Machines first, once each, so the Threads read at once share the answers.
      const plans = yield* Effect.forEach(
        yield* listProjectThreads(projectId),
        (listed) =>
          threadMovePlan(listed.threadId, projectId, route.to, cache).pipe(
            Effect.map((plan) => ({ threadId: listed.threadId, plan })),
          ),
        { concurrency: 8 },
      );
      const running: Array<ProjectMovePlanThread> = [];
      const needsEnvironment: Array<ProjectMovePlanThread> = [];
      for (const { threadId, plan } of plans) {
        if (plan === undefined || !plan.changes) continue;
        const entry = planEntry(threadId, plan.thread);
        if (plan.running) running.push(entry);
        if (plan.releasedFrom !== undefined) needsEnvironment.push(entry);
      }
      const vaultsLost = yield* vaultsLostOnMove(projectId, route);
      const aiAccountsLost = yield* aiReach
        .projectMoveLoss({ projectId, from: route.from, to: route.to })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({ operation: "read-ai-accounts", projectId, cause }),
          ),
        );
      return {
        projectId,
        spaceId: route.to,
        running,
        needsEnvironment,
        vaultsLost,
        aiAccountsLost,
      };
    },
  );

  const move: ProjectService["Service"]["move"] = Effect.fn("ProjectService.move")(
    function* (input) {
      const { projectId } = input;
      const existing = yield* readRow(projectId);
      if (Option.isNone(existing)) return yield* new ProjectNotFoundError({ projectId });
      const actor = Option.getOrUndefined(yield* spaces.actingUser);
      const route = yield* spaces.authorizeProjectMove({
        actor,
        item: { kind: "project", id: projectId },
        spaceId: input.spaceId,
      });
      const moved = yield* Ref.make(false);
      const released: Array<ProjectMovePlanThread> = [];
      const cache: ServesCache = new Map();
      const work = Option.isSome(moveHooks) ? yield* moveHooks.value.current : undefined;
      // While it moves nothing is created or started in it, and each Thread is checked idle under
      // its own lock, so a dispatch that passed before the mark has already created its run.
      const relocate = Effect.gen(function* () {
        // Its running Threads stop first, when the mover said so (they saw them in the plan).
        const planned = yield* threadsToMove(projectId, route.to, cache);
        if (planned.running.length > 0) {
          if (input.stopThreads !== true || work === undefined) {
            return yield* new ProjectMoveBlockedError({
              projectId,
              threadTitles: planned.running.map((thread) => thread.title),
            });
          }
          yield* work.stopThreads({
            threadIds: planned.running.map((thread) => thread.threadId),
            reason: "Stopped to move its Project to another Space.",
          });
          const still = yield* threadsToMove(projectId, route.to, cache);
          if (still.running.length > 0) {
            return yield* new ProjectMoveBlockedError({
              projectId,
              threadTitles: still.running.map((thread) => thread.title),
            });
          }
        }
        // It goes ahead: what machines hold on the Project ends now (never for a no-op rerun).
        const cutting = route.from !== route.to || planned.changing > 0;
        if (cutting) {
          yield* spaces.projectAccessEnds(projectId);
        }
        if (route.from !== route.to) {
          // A preferred machine that does not serve the new Space is no preference there.
          const preferred = yield* machineLeft(
            existing.value.preferredEnvironmentId,
            route.to,
            projectId,
            cache,
          );
          // Its choices of Vaults that do not reach the new Space go with the same commit, so
          // allowing one there later never brings an old choice back unseen.
          yield* commit(
            {
              type: "project.meta.update",
              commandId: input.commandId,
              projectId,
              spaceId: route.to,
              ...(preferred === undefined ? {} : { preferredEnvironmentId: null }),
            },
            VaultReachLoss.keepProjectChoicesReaching(sql, {
              projectId,
              from: route.from,
              spaceId: route.to,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectOperationError({ operation: "drop-vault-choices", projectId, cause }),
              ),
            ),
          );
          yield* Ref.set(moved, true);
          // Shells admitted for the old Space are checked again from the next keystroke on, not
          // only once the whole move ends (spec 5 ticket 07).
          yield* spaces.changed;
        }
        // Listed after the Project moved, so none created before it is left behind; legacy
        // Threads with no Space of their own follow too. A rerun finishes a move cut short.
        const threads = yield* listProjectThreads(projectId);
        // The gateway is asked before any write, never while one waits on it.
        const catalogs = yield* aiReach.catalogsFor({
          threadIds: threads.map((thread) => thread.threadId),
          spaceId: route.to,
        });
        for (const thread of threads) {
          const result = yield* threadCommands
            .withLock(
              thread.threadId,
              moveThread(
                { ...input, spaceId: route.to },
                thread.threadId,
                actor,
                cache,
                catalogs,
                route.from,
              ),
            )
            .pipe(
              Effect.mapError((cause) =>
                isMoveBlocked(cause) ||
                (typeof cause === "object" &&
                  cause !== null &&
                  "_tag" in cause &&
                  (cause._tag === "SpaceAccessDeniedError" ||
                    cause._tag === "SpaceNotFoundError" ||
                    cause._tag === "SpaceResourceNotFoundError" ||
                    cause._tag === "SpaceDirectoryStorageError" ||
                    cause._tag === "ProjectOperationError"))
                  ? (cause as
                      | SpaceDirectory.ProjectMoveError
                      | ProjectMoveBlockedError
                      | ProjectOperationError)
                  : new ProjectOperationError({ operation: "move-thread", projectId, cause }),
              ),
            );
          if (result.changed) yield* Ref.set(moved, true);
          if (result.released !== undefined) released.push(result.released);
        }
        // Out of the Threads' locks: each machine left is cut off, this move's and any release
        // an earlier one did not finish.
        if (work !== undefined) {
          yield* work.drainReleases(threads.map((thread) => thread.threadId));
          // Shells started for the old Space close on their machines (spec 5 ticket 07); the
          // move does not wait for it, and the Hub refuses them meanwhile.
          if (cutting) yield* work.reconcileTerminals;
        }
      });
      yield* spaces.whileProjectMoves(projectId, relocate).pipe(
        // Whatever moved, even on a failure part way, its viewers reload.
        Effect.ensuring(
          Effect.flatMap(Ref.get(moved), (any) =>
            any
              ? // Their provider processes started for the old Space (a direct credential, a
                // key) close, also after a failure part way; the next turn opens one for the
                // new Space (spec 4 ticket 11).
                (work === undefined ? Effect.void : work.reconcileAiSessions).pipe(
                  Effect.andThen(spaces.projectMoved(route)),
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not refresh the viewers of a moved Project", {
                      cause,
                    }),
                  ),
                )
              : Effect.void,
          ),
        ),
      );
      return { project: yield* readCommitted(projectId), released };
    },
  );

  const deleteSpaceContent: ProjectService["Service"]["deleteSpaceContent"] = Effect.fn(
    "ProjectService.deleteSpaceContent",
  )(function* (input) {
    const spaceProjects = yield* sql<{ readonly projectId: ProjectId }>`
      SELECT project_id AS "projectId" FROM projection_projects
      WHERE space_id = ${input.spaceId} AND deleted_at IS NULL
    `.pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    for (const { projectId } of spaceProjects) {
      yield* deleteProject({
        commandId: CommandId.make(`${input.commandId}:project:${projectId}`),
        projectId,
        force: true,
      });
    }
    // Threads stamped with the Space whose Project is elsewhere or gone.
    const leftovers = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE space_id = ${input.spaceId} AND deleted_at IS NULL
    `.pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-threads", cause })),
    );
    yield* Effect.forEach(
      leftovers,
      ({ threadId }) =>
        threadCommands
          .withLock(threadId, deleteChildThread({ commandId: input.commandId }, threadId))
          .pipe(
            Effect.mapError(
              (cause) => new ProjectOperationError({ operation: "delete-thread", cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  const enrichShell = (shell: OrchestrationProjectShell) =>
    projectEnrichment.getAvailable(shell.workspaceRoot).pipe(
      Effect.map((enrichment) => ({
        ...shell,
        repositoryIdentity: enrichment.repositoryIdentity,
      })),
    );

  const getShell: ProjectService["Service"]["getShell"] = Effect.fn("ProjectService.getShell")(
    function* (projectId) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      return Option.isNone(shell) ? shell : Option.some(yield* enrichShell(shell.value));
    },
  );

  const listShells: ProjectService["Service"]["listShells"] = Effect.fn(
    "ProjectService.listShells",
  )(function* (options) {
    const shells = yield* projects
      .listShells(options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    return yield* Effect.forEach(shells, enrichShell, { concurrency: 16 });
  });

  const listRows = projects
    .list()
    .pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );

  const snapshotFor = Effect.fn("ProjectService.snapshotFor")(function* (
    visibility: SpaceVisibility.Visibility,
  ) {
    const rows = (yield* listRows).filter((row) => SpaceVisibility.seesProject(visibility, row));
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });
  const snapshot = snapshotFor(SpaceVisibility.everything);

  const listPage: ProjectService["Service"]["listPage"] = Effect.fn("ProjectService.listPage")(
    function* ({ cursor, limit, visibility = SpaceVisibility.everything }) {
      const rows = (yield* listRows).filter(
        (project) => project.deletedAt === null && SpaceVisibility.seesProject(visibility, project),
      );
      const projects = yield* Effect.forEach(
        rows.slice(cursor, cursor + limit),
        (row) =>
          hydrate(row).pipe(
            Effect.filterOrElse(
              (project) => project.repositoryIdentity !== null,
              (project) =>
                projectEnrichment
                  .readRepositoryIdentity(project.workspaceRoot)
                  .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
            ),
          ),
        { concurrency: 8 },
      );
      return { projects, nextCursor: cursor + limit < rows.length ? cursor + limit : null };
    },
  );

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    move,
    movePlan,
    deleteSpaceContent,
    getById,
    getByWorkspaceRoot,
    snapshot,
    snapshotFor,
    listPage,
    getShell,
    listShells,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
