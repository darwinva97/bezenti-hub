// Which Projects and Threads a client lists for the current Space. The Space selector decides where
// new things go; this rule also decides what the sidebar, search and Settled show, and nothing of
// another Space is ever listed beside it (ticket 19). Pure, so clients share it.
import type { SpaceDirectoryView, SpaceId } from "@t3tools/contracts";

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

/**
 * The Space of rows from before Spaces (no Space on the row or its Project): the Owner's Personal
 * space, as the server counts them. Only the Owner is sent such rows, so for anyone else it is
 * none.
 */
export function legacySpaceIdOf(
  view: Pick<SpaceDirectoryView, "isOwner" | "personalSpaceId"> | null,
): SpaceId | null {
  return view?.isOwner === true ? view.personalSpaceId : null;
}

/** A Thread's Space is its own, else its Project's, else the legacy Space; null when none. */
export function threadSpaceId(
  thread: Pick<SpaceFilterThread, "spaceId">,
  project: Pick<SpaceFilterProject, "spaceId"> | undefined,
  legacySpaceId: SpaceId | null = null,
): SpaceId | null {
  return thread.spaceId ?? project?.spaceId ?? legacySpaceId;
}

/**
 * The Space to switch to when the User opens a Thread, Project or draft of another Space (a link,
 * a notification, the browser's history), so the sidebar follows instead of mixing Spaces. Null
 * to stay: it is current already, unknown, or not one of the User's Spaces.
 */
export function spaceToFollow(input: {
  readonly view: { readonly spaces: ReadonlyArray<{ readonly id: SpaceId }> } | null;
  readonly currentSpaceId: SpaceId | null;
  readonly openSpaceId: SpaceId | null;
}): SpaceId | null {
  const { view, currentSpaceId, openSpaceId } = input;
  if (view === null || openSpaceId === null || openSpaceId === currentSpaceId) return null;
  return view.spaces.some((space) => space.id === openSpaceId) ? openSpaceId : null;
}

const projectKeyOf = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

interface SpaceScope {
  /** The current Space; null shows everything (no Spaces here, or none chosen yet). */
  readonly spaceId: SpaceId | null;
  /** The environment whose Spaces `spaceId` belongs to; others are left alone. */
  readonly environmentId: string | null;
  /** Where rows from before Spaces belong (`legacySpaceIdOf`). */
  readonly legacySpaceId: SpaceId | null;
}

/**
 * Keeps the Threads of `spaceId`, by their own Space, else their Project's (which need not be
 * loaded), else the legacy Space. Threads of other environments stay. Arrays that lose nothing
 * come back as they were.
 */
export function filterThreadsBySpace<T extends SpaceFilterThread, P extends SpaceFilterProject>(
  input: SpaceScope & {
    readonly threads: readonly T[];
    readonly projects: readonly P[];
  },
): readonly T[] {
  const { spaceId, environmentId, legacySpaceId, threads, projects } = input;
  if (spaceId === null || environmentId === null) return threads;
  const projectByKey = new Map<string, P>();
  for (const project of projects) {
    projectByKey.set(projectKeyOf(project.environmentId, project.id), project);
  }
  const kept = threads.filter(
    (thread) =>
      thread.environmentId !== environmentId ||
      threadSpaceId(
        thread,
        projectByKey.get(projectKeyOf(thread.environmentId, thread.projectId)),
        legacySpaceId,
      ) === spaceId,
  );
  return kept.length === threads.length ? threads : kept;
}

const projectInSpace = (project: SpaceFilterProject, scope: SpaceScope & { spaceId: SpaceId }) =>
  project.environmentId !== scope.environmentId ||
  (project.spaceId ?? scope.legacySpaceId) === scope.spaceId;

// One slot each: the sidebar renders on every shell update, and these inputs rarely change, so the
// same arrays and sets come back until they do.
let projectsSlot: {
  readonly projects: readonly unknown[];
  readonly key: string;
  readonly result: readonly unknown[];
} | null = null;

/**
 * Keeps the Projects in `spaceId` (and those of other environments). Same result array for the
 * same inputs.
 */
export function filterProjectsBySpace<P extends SpaceFilterProject>(
  input: SpaceScope & { readonly projects: readonly P[] },
): readonly P[] {
  const { spaceId, environmentId, legacySpaceId, projects } = input;
  if (spaceId === null || environmentId === null) return projects;
  const key = `${spaceId}\0${environmentId}\0${legacySpaceId ?? ""}`;
  if (projectsSlot?.projects === projects && projectsSlot.key === key) {
    return projectsSlot.result as readonly P[];
  }
  const kept = projects.filter((project) =>
    projectInSpace(project, { spaceId, environmentId, legacySpaceId }),
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

/** Keys of the Projects in `spaceId` (other environments' included); null when nothing is filtered. */
export function inSpaceProjectKeys(
  input: SpaceScope & { readonly projects: readonly SpaceFilterProject[] },
): ReadonlySet<string> | null {
  const { spaceId, environmentId, legacySpaceId, projects } = input;
  if (spaceId === null || environmentId === null) return null;
  const key = `${spaceId}\0${environmentId}\0${legacySpaceId ?? ""}`;
  if (inSpaceSlot?.projects === projects && inSpaceSlot.key === key) return inSpaceSlot.result;
  const result = new Set(
    projects
      .filter((project) => projectInSpace(project, { spaceId, environmentId, legacySpaceId }))
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
