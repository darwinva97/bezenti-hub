import {
  CommandId,
  OrchestrationDispatchCommandError,
  type SourceControlRepositoryError,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectCloneHooks } from "./ProjectCloneTracker.ts";
import type * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import type * as ProjectService from "./ProjectService.ts";
import type * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export interface ProjectCloneHookDeps {
  readonly projectService: ProjectService.ProjectService["Service"];
  readonly repositoryIdentityResolver: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];
  readonly projectEnrichment: ProjectEnrichmentService.ProjectEnrichmentService["Service"];
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly verifyDestination: (
    destinationPath: string,
  ) => Effect.Effect<void, SourceControlRepositoryError>;
}

/**
 * What a clone into a new Project runs (WS `projectClone.start`; Makita ticket 21 too): the
 * Project made before git writes, then its identity, git status and enrichment refreshed. With
 * `target`, it is made in that Space for that User, as ProjectService and the Space's rules decide.
 */
export const projectCloneHooks = (
  deps: ProjectCloneHookDeps,
  target?: { readonly spaceId: SpaceId; readonly actorUserId: UserId },
): ProjectCloneHooks => ({
  createProject: (project) =>
    deps.projectService
      .create({
        commandId: CommandId.make(`project-clone-create:${project.projectId}`),
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        ...(target === undefined
          ? {}
          : { spaceId: target.spaceId, actorUserId: target.actorUserId }),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to create clone project.",
              cause,
            }),
        ),
      ),
  onCloned: (project) =>
    deps.repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
      Effect.andThen(
        deps.projectService.update({
          commandId: CommandId.make(`project-clone-done:${project.projectId}`),
          projectId: project.projectId,
        }),
      ),
      Effect.andThen(deps.refreshGitStatus(project.workspaceRoot)),
      // The folder was empty when the project was created, so the cached
      // enrichment says "no repository" and clients cannot group it yet.
      Effect.andThen(deps.projectEnrichment.invalidate([project.workspaceRoot])),
      Effect.andThen(deps.projectEnrichment.request(project.workspaceRoot)),
      Effect.ignoreCause({ log: true }),
    ),
  verifyDestination: deps.verifyDestination,
});
