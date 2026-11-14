import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { effectiveSpaceFilter, filterBySpace } from "@t3tools/client-runtime/spaces/space-filter";

import { resolveSidebarRowThreadId } from "../components/Sidebar.logic";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useCurrentSpace } from "../state/currentSpace";

/**
 * The Projects and Threads the sidebar lists for the current Space. The open Thread (and the
 * Project of an open draft) stays listed even from another Space, and nothing is filtered without a
 * current Space or when «All Spaces» is on. Primitive inputs keep the compiler's memoization
 * effective across the shell updates that re-render the sidebar.
 */
export function useSidebarSpaceFilter(input: {
  readonly openThreadEnvironmentId: EnvironmentId | null;
  readonly openThreadId: ThreadId | null;
  readonly openDraftEnvironmentId: EnvironmentId | null;
  readonly openDraftProjectId: string | null;
}) {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const spaceEnvironmentId = useCurrentSpace((state) => state.environmentId);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const showAllSpaces = useCurrentSpace((state) => state.showAllSpaces);
  const spaceCount = useCurrentSpace((state) => state.view?.spaces.length ?? 0);
  const { openThreadEnvironmentId, openThreadId, openDraftEnvironmentId, openDraftProjectId } =
    input;

  const spaceId = effectiveSpaceFilter({ currentSpaceId, showAllSpaces });
  const openRowThreadId =
    openThreadEnvironmentId === null || openThreadId === null
      ? null
      : resolveSidebarRowThreadId(openThreadId, openThreadEnvironmentId, threads);
  const openThreads =
    openThreadEnvironmentId === null || openThreadId === null
      ? []
      : [
          { environmentId: openThreadEnvironmentId, threadId: openThreadId },
          ...(openRowThreadId !== null && openRowThreadId !== openThreadId
            ? [{ environmentId: openThreadEnvironmentId, threadId: openRowThreadId }]
            : []),
        ];
  const filtered = filterBySpace({
    spaceId,
    environmentId: spaceEnvironmentId,
    projects,
    threads,
    openThreads,
    openProject:
      openDraftEnvironmentId !== null && openDraftProjectId !== null
        ? { environmentId: openDraftEnvironmentId, projectId: openDraftProjectId }
        : null,
  });
  // Null while every Project is listed, so callers that scope by Project keys can skip the check.
  const projectKeys =
    filtered.projects === projects
      ? null
      : new Set(filtered.projects.map((project) => `${project.environmentId}:${project.id}`));
  return {
    projects: filtered.projects,
    projectKeys,
    threads: filtered.threads,
    /** Whether this install has more than one Space to tell apart, so the toggle is worth showing. */
    canToggleAllSpaces: spaceCount > 1 && currentSpaceId !== null,
    showAllSpaces,
  };
}
