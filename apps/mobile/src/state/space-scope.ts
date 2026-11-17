import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  filterProjectsBySpace,
  filterThreadsBySpace,
  legacySpaceIdOf,
  spaceToFollow,
  type SpaceFilterProject,
  type SpaceFilterThread,
} from "@t3tools/client-runtime/spaces/space-filter";
import { useEffect, useMemo } from "react";

import type { SpaceSelection } from "@t3tools/client-runtime/spaces/space-selection";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useProject, useProjects, useQuietThreadShell } from "./entities";
import { selectSpace, useSpaceSelections } from "./spaces";

// Ticket 19: lists, search, Settled and the Project pickers show each Hub's current Space only.
// Mobile talks to several Hubs at once, each with its own current Space; Hubs without Spaces
// (and environments that are not Hubs) are left alone.

function scopes(selections: ReadonlyMap<EnvironmentId, SpaceSelection>) {
  return [...selections].flatMap(([environmentId, selection]) =>
    selection.view === null || selection.currentSpaceId === null
      ? []
      : [
          {
            environmentId,
            spaceId: selection.currentSpaceId,
            legacySpaceId: legacySpaceIdOf(selection.view),
          },
        ],
  );
}

/** The Projects of each Hub's current Space. */
export function projectsInCurrentSpaces<P extends SpaceFilterProject>(
  projects: readonly P[],
  selections: ReadonlyMap<EnvironmentId, SpaceSelection>,
): readonly P[] {
  return scopes(selections).reduce(
    (kept, scope) => filterProjectsBySpace({ ...scope, projects: kept }),
    projects,
  );
}

/** The Threads of each Hub's current Space, by their own Space, else their Project's. */
export function threadsInCurrentSpaces<T extends SpaceFilterThread>(
  threads: readonly T[],
  projects: readonly SpaceFilterProject[],
  selections: ReadonlyMap<EnvironmentId, SpaceSelection>,
): readonly T[] {
  return scopes(selections).reduce(
    (kept, scope) => filterThreadsBySpace({ ...scope, threads: kept, projects }),
    threads,
  );
}

export function useProjectsInCurrentSpaces<P extends SpaceFilterProject>(
  projects: readonly P[],
): readonly P[] {
  const selections = useSpaceSelections();
  return useMemo(() => projectsInCurrentSpaces(projects, selections), [projects, selections]);
}

export function useThreadsInCurrentSpaces<T extends SpaceFilterThread>(
  threads: readonly T[],
  projects: readonly SpaceFilterProject[],
): readonly T[] {
  const selections = useSpaceSelections();
  return useMemo(
    () => threadsInCurrentSpaces(threads, projects, selections),
    [threads, projects, selections],
  );
}

/**
 * For each Hub with a current Space, the ids of that Space's Projects there; Hubs without Spaces
 * are absent (everything of theirs is in scope).
 */
export function spaceProjectIdsByEnvironment<
  P extends SpaceFilterProject & { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  projects: readonly P[],
  selections: ReadonlyMap<EnvironmentId, SpaceSelection>,
): ReadonlyMap<EnvironmentId, ReadonlySet<ProjectId>> {
  const kept = projectsInCurrentSpaces(projects, selections);
  return new Map(
    scopes(selections).map(({ environmentId }) => [
      environmentId,
      new Set(
        kept.flatMap((project) => (project.environmentId === environmentId ? [project.id] : [])),
      ),
    ]),
  );
}

/**
 * Opening a Thread, or a draft in a Project, of another Space of its Hub (a link, a notification)
 * makes that Space the Hub's current one, so lists never show Spaces side by side.
 */
export function useFollowOpenSpace(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}) {
  const { environmentId } = input;
  const selections = useSpaceSelections();
  const selection = environmentId === null ? undefined : selections.get(environmentId);
  const thread = useQuietThreadShell(
    environmentId !== null && input.threadId !== null
      ? scopeThreadRef(environmentId, input.threadId)
      : null,
  );
  const projectId = thread?.projectId ?? input.projectId;
  const project = useProject(
    environmentId !== null && projectId !== null ? scopeProjectRef(environmentId, projectId) : null,
  );
  const view = selection?.view ?? null;
  const legacySpaceId = legacySpaceIdOf(view);
  // Thread shells carry no Space of their own here: a Thread is in its Project's.
  const openSpaceId = project === null ? null : (project.spaceId ?? legacySpaceId);
  const next = spaceToFollow({
    view,
    currentSpaceId: selection?.currentSpaceId ?? null,
    openSpaceId,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Hub's current Space follows what the route opened, a store outside React
  useEffect(() => {
    if (environmentId !== null && next !== null) selectSpace(environmentId, next);
  }, [environmentId, next]);
}

/** `spaceProjectIdsByEnvironment` for render, stable while Projects and Spaces stay put. */
export function useSpaceProjectIds(): ReadonlyMap<EnvironmentId, ReadonlySet<ProjectId>> {
  const projects = useProjects();
  const selections = useSpaceSelections();
  return useMemo(() => spaceProjectIdsByEnvironment(projects, selections), [projects, selections]);
}
