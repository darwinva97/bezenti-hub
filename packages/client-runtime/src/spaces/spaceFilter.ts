// Which Projects and Threads a client lists for the current Space. The Space selector decides where
// new things go; this rule also decides what the sidebar shows. Pure, so clients share it.
import type { SpaceId, UserId } from "@t3tools/contracts";

/** Where a User's «All Spaces» choice is kept, next to their current Space. */
export const showAllSpacesStorageKey = (userId: UserId) => `t3code:all-spaces:v1:${userId}`;

export interface SpaceFilterProject {
  readonly environmentId: string;
  readonly id: string;
  /** Absent on Projects from before Spaces, and from servers without them. */
  readonly spaceId?: SpaceId | null | undefined;
}

export interface SpaceFilterThread {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly spaceId?: SpaceId | null | undefined;
}

/** A Thread's Space is its own, else its Project's; null when neither is known. */
export function threadSpaceId(
  thread: Pick<SpaceFilterThread, "spaceId">,
  project: Pick<SpaceFilterProject, "spaceId"> | undefined,
): SpaceId | null {
  return thread.spaceId ?? project?.spaceId ?? null;
}

/** The Space to filter by, or null to show everything: no current Space, or «All Spaces» is on. */
export function effectiveSpaceFilter(input: {
  readonly currentSpaceId: SpaceId | null;
  readonly showAllSpaces: boolean;
}): SpaceId | null {
  return input.showAllSpaces ? null : input.currentSpaceId;
}

const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

/**
 * Keeps what belongs to `spaceId`; items of other environments or of unknown Space stay. The open
 * Thread and an open draft's Project stay, and a Project stays when it hosts a kept Thread.
 * Arrays that lose nothing come back as they were.
 */
export function filterBySpace<T extends SpaceFilterThread, P extends SpaceFilterProject>(input: {
  readonly spaceId: SpaceId | null;
  /** The environment whose Spaces `spaceId` belongs to. */
  readonly environmentId: string | null;
  readonly threads: readonly T[];
  readonly projects: readonly P[];
  readonly openThreads: ReadonlyArray<{
    readonly environmentId: string;
    readonly threadId: string;
  }>;
  readonly openProject: { readonly environmentId: string; readonly projectId: string } | null;
}): { readonly threads: readonly T[]; readonly projects: readonly P[] } {
  const { spaceId, environmentId, threads, projects, openThreads, openProject } = input;
  if (spaceId === null || environmentId === null) return { threads, projects };

  const projectByKey = new Map<string, P>();
  for (const project of projects) {
    projectByKey.set(projectKey(project.environmentId, project.id), project);
  }
  const matches = (candidate: SpaceId | null) => candidate === null || candidate === spaceId;

  const keptProjectKeys = new Set<string>();
  if (openProject !== null) {
    keptProjectKeys.add(projectKey(openProject.environmentId, openProject.projectId));
  }
  const keptThreads = threads.filter((thread) => {
    const key = projectKey(thread.environmentId, thread.projectId);
    const keep =
      thread.environmentId !== environmentId ||
      matches(threadSpaceId(thread, projectByKey.get(key))) ||
      openThreads.some(
        (open) => open.environmentId === thread.environmentId && open.threadId === thread.id,
      );
    if (keep) keptProjectKeys.add(key);
    return keep;
  });
  const keptProjects = projects.filter(
    (project) =>
      project.environmentId !== environmentId ||
      matches(project.spaceId ?? null) ||
      keptProjectKeys.has(projectKey(project.environmentId, project.id)),
  );
  return {
    threads: keptThreads.length === threads.length ? threads : keptThreads,
    projects: keptProjects.length === projects.length ? projects : keptProjects,
  };
}
