import type { SpaceId } from "@t3tools/contracts";
import {
  legacySpaceIdOf,
  projectInSpace,
  type SpaceFilterProject,
} from "@t3tools/client-runtime/spaces/space-filter";

import { useProjects } from "../../state/entities";
import { useCurrentSpace } from "../../state/currentSpace";
import { useSettingsSpace } from "./useSettingsSpace";

/**
 * What a Space's modal lists is the Space's: its Projects, and so its archived Threads and its
 * scheduled tasks. Without a known Space nothing is left out.
 */
export function useSettingsSpaceFilter() {
  const space = useSettingsSpace();
  const environmentId = useCurrentSpace((state) => state.environmentId);
  const legacySpaceId = useCurrentSpace((state) => legacySpaceIdOf(state.view));
  const projects = useProjects();
  const spaceId: SpaceId | null = space?.id ?? null;

  /** A Project that carries its own Space, such as one in the archive. */
  const keepsProject = (project: SpaceFilterProject): boolean =>
    spaceId === null || projectInSpace(project, { spaceId, environmentId, legacySpaceId });

  /** A Project known by its ids, such as the one of a scheduled task; unknown ones are left out. */
  const keepsProjectById = (projectEnvironmentId: string, projectId: string): boolean => {
    if (spaceId === null) return true;
    const project = projects.find(
      (candidate) => candidate.environmentId === projectEnvironmentId && candidate.id === projectId,
    );
    return project !== undefined && keepsProject(project);
  };

  return { keepsProject, keepsProjectById };
}
