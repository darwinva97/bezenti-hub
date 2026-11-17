import {
  filterProjectsBySpace,
  filterThreadsBySpace,
  hiddenProjectKeys,
  inSpaceProjectKeys,
  legacySpaceIdOf,
} from "@t3tools/client-runtime/spaces/space-filter";

import { useProjects, useQuietThreadShells } from "../state/entities";
import { useCurrentSpace } from "../state/currentSpace";

/**
 * The Projects and Threads the sidebar lists: only the current Space's (ticket 19). Opening
 * something of another Space switches the current Space instead (`useFollowOpenSpace`), so
 * nothing of another Space is ever listed. Nothing is filtered without a current Space.
 */
export function useSidebarSpaceFilter() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const environmentId = useCurrentSpace((state) => state.environmentId);
  const spaceId = useCurrentSpace((state) => state.currentSpaceId);
  const legacySpaceId = useCurrentSpace((state) => legacySpaceIdOf(state.view));
  const scope = { spaceId, environmentId, legacySpaceId };

  const filteredProjects = filterProjectsBySpace({ ...scope, projects });
  return {
    projects: filteredProjects,
    threads: filterThreadsBySpace({ ...scope, threads, projects }),
    /** Keys of the Projects in the Space; null without a filter. */
    spaceProjectKeys: inSpaceProjectKeys({ ...scope, projects }),
    /** Keys of the Projects the filter hides, so drafts of them are hidden too; null without a filter. */
    hiddenProjectKeys: hiddenProjectKeys(projects, filteredProjects),
  };
}
