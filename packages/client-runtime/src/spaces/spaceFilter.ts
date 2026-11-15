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

export const projectKeyOf = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

const matches = (spaceId: SpaceId, candidate: SpaceId | null) =>
  candidate === null || candidate === spaceId;

/**
 * Keeps the Threads of `spaceId`; Threads of other environments or of unknown Space stay, and so
 * do the open Thread and its ancestors. A Thread's Project need not be loaded. Arrays that lose
 * nothing come back as they were.
 */
export function filterThreadsBySpace<
  T extends SpaceFilterThread,
  P extends SpaceFilterProject,
>(input: {
  readonly spaceId: SpaceId | null;
  /** The environment whose Spaces `spaceId` belongs to. */
  readonly environmentId: string | null;
  readonly threads: readonly T[];
  readonly projects: readonly P[];
  readonly openThreads: ReadonlyArray<{
    readonly environmentId: string;
    readonly threadId: string;
  }>;
}): readonly T[] {
  const { spaceId, environmentId, threads, projects, openThreads } = input;
  if (spaceId === null || environmentId === null) return threads;
  const projectByKey = new Map<string, P>();
  for (const project of projects) {
    projectByKey.set(projectKeyOf(project.environmentId, project.id), project);
  }
  const kept = threads.filter(
    (thread) =>
      thread.environmentId !== environmentId ||
      matches(
        spaceId,
        threadSpaceId(
          thread,
          projectByKey.get(projectKeyOf(thread.environmentId, thread.projectId)),
        ),
      ) ||
      openThreads.some(
        (open) => open.environmentId === thread.environmentId && open.threadId === thread.id,
      ),
  );
  return kept.length === threads.length ? threads : kept;
}

const projectInSpace = (project: SpaceFilterProject, spaceId: SpaceId, environmentId: string) =>
  project.environmentId !== environmentId || matches(spaceId, project.spaceId ?? null);

// One slot each: the sidebar renders on every shell update, and these inputs rarely change, so the
// same arrays and sets come back until they do.
let projectsSlot: {
  readonly projects: readonly unknown[];
  readonly key: string;
  readonly result: readonly unknown[];
} | null = null;

/**
 * Keeps the Projects in `spaceId` (or of unknown Space or another environment), plus the ones in
 * `keepProjectKeys`, such as the open Thread's. Same result array for the same inputs.
 */
export function filterProjectsBySpace<P extends SpaceFilterProject>(input: {
  readonly spaceId: SpaceId | null;
  readonly environmentId: string | null;
  readonly projects: readonly P[];
  readonly keepProjectKeys: readonly string[];
}): readonly P[] {
  const { spaceId, environmentId, projects, keepProjectKeys } = input;
  if (spaceId === null || environmentId === null) return projects;
  const key = `${spaceId}\0${environmentId}\0${keepProjectKeys.join("\n")}`;
  if (projectsSlot?.projects === projects && projectsSlot.key === key) {
    return projectsSlot.result as readonly P[];
  }
  const keep = new Set(keepProjectKeys);
  const kept = projects.filter(
    (project) =>
      projectInSpace(project, spaceId, environmentId) ||
      keep.has(projectKeyOf(project.environmentId, project.id)),
  );
  const result = kept.length === projects.length ? projects : kept;
  projectsSlot = { projects, key, result };
  return result;
}

let inSpaceSlot: {
  readonly projects: readonly unknown[];
  readonly key: string;
  readonly result: ReadonlySet<string>;
} | null = null;

/** Keys of the Projects actually in `spaceId`; null when nothing is filtered. */
export function inSpaceProjectKeys(input: {
  readonly spaceId: SpaceId | null;
  readonly environmentId: string | null;
  readonly projects: readonly SpaceFilterProject[];
}): ReadonlySet<string> | null {
  const { spaceId, environmentId, projects } = input;
  if (spaceId === null || environmentId === null) return null;
  const key = `${spaceId}\0${environmentId}`;
  if (inSpaceSlot?.projects === projects && inSpaceSlot.key === key) return inSpaceSlot.result;
  const result = new Set(
    projects
      .filter((project) => projectInSpace(project, spaceId, environmentId))
      .map((project) => projectKeyOf(project.environmentId, project.id)),
  );
  inSpaceSlot = { projects, key, result };
  return result;
}

let hiddenSlot: {
  readonly all: readonly unknown[];
  readonly kept: readonly unknown[];
  readonly result: ReadonlySet<string>;
} | null = null;

/** Keys of the Projects `kept` leaves out of `all`; null when it leaves none out. */
export function hiddenProjectKeys(
  all: readonly SpaceFilterProject[],
  kept: readonly SpaceFilterProject[],
): ReadonlySet<string> | null {
  if (kept === all) return null;
  if (hiddenSlot?.all === all && hiddenSlot.kept === kept) return hiddenSlot.result;
  const keptKeys = new Set(kept.map((project) => projectKeyOf(project.environmentId, project.id)));
  const result = new Set(
    all
      .map((project) => projectKeyOf(project.environmentId, project.id))
      .filter((key) => !keptKeys.has(key)),
  );
  hiddenSlot = { all, kept, result };
  return result;
}
