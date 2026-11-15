import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  effectiveSpaceFilter,
  filterProjectsBySpace,
  filterThreadsBySpace,
  hiddenProjectKeys,
  inSpaceProjectKeys,
  projectKeyOf,
} from "@t3tools/client-runtime/spaces/space-filter";

import { isSidebarHiddenThread } from "../components/Sidebar.logic";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useCurrentSpace } from "../state/currentSpace";

/**
 * The Projects and Threads the sidebar lists for the current Space. The open Thread, its ancestors
 * up to the row that shows it, and the Project of an open draft stay listed even from another
 * Space. Nothing is filtered without a current Space or when «All Spaces» is on.
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

  // A subagent has no row of its own, so its whole chain of parents stays, up to a listed Thread.
  const openChain: Array<(typeof threads)[number]> = [];
  if (spaceId !== null && openThreadEnvironmentId !== null && openThreadId !== null) {
    const visited = new Set<ThreadId>();
    let id: ThreadId | null = openThreadId;
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const current: (typeof threads)[number] | undefined = threads.find(
        (candidate) => candidate.id === id && candidate.environmentId === openThreadEnvironmentId,
      );
      if (current === undefined) break;
      openChain.push(current);
      id = isSidebarHiddenThread(current) ? current.lineage.parentThreadId : null;
    }
  }
  const openThreads = [
    ...(openThreadEnvironmentId !== null && openThreadId !== null
      ? [{ environmentId: openThreadEnvironmentId, threadId: openThreadId }]
      : []),
    ...openChain.map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  ];
  const keepProjectKeys = [
    ...openChain.map((thread) => projectKeyOf(thread.environmentId, thread.projectId)),
    ...(openDraftEnvironmentId !== null && openDraftProjectId !== null
      ? [projectKeyOf(openDraftEnvironmentId, openDraftProjectId)]
      : []),
  ];

  const filteredThreads = filterThreadsBySpace({
    spaceId,
    environmentId: spaceEnvironmentId,
    threads,
    projects,
    openThreads,
  });
  const filteredProjects = filterProjectsBySpace({
    spaceId,
    environmentId: spaceEnvironmentId,
    projects,
    keepProjectKeys,
  });
  return {
    projects: filteredProjects,
    threads: filteredThreads,
    /** Keys of the Projects actually in the Space, not those kept for the open Thread; null without a filter. */
    spaceProjectKeys: inSpaceProjectKeys({
      spaceId,
      environmentId: spaceEnvironmentId,
      projects,
    }),
    /** Keys of the Projects the filter hides, so drafts of them are hidden too; null without a filter. */
    hiddenProjectKeys: hiddenProjectKeys(projects, filteredProjects),
    /** Whether this install has more than one Space to tell apart, so the toggle is worth showing. */
    canToggleAllSpaces: spaceCount > 1 && currentSpaceId !== null,
    showAllSpaces,
  };
}
