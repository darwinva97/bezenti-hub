import {
  type EnvironmentId,
  EnvironmentHttpForbiddenError,
  type SpaceDirectoryView,
  type SpaceId,
} from "@t3tools/contracts";
import { setCurrentSpace } from "@t3tools/client-runtime/spaces/current-space";
import {
  type ThreadRoleSubject,
  threadRolePermissions,
} from "@t3tools/client-runtime/spaces/role-permissions";
import {
  filterProjectsBySpace,
  filterThreadsBySpace,
  legacySpaceIdOf,
  type SpaceFilterProject,
  type SpaceFilterThread,
} from "@t3tools/client-runtime/spaces/space-filter";
import {
  chooseCurrentSpace,
  createOrganization,
  currentSpaceStorageKey,
  fetchSpaceDirectory,
} from "@t3tools/client-runtime/spaces/space-directory";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { environmentShell } from "./shell";

const isForbidden = Schema.is(EnvironmentHttpForbiddenError);

function readStoredSpace(view: SpaceDirectoryView): string | null {
  try {
    return window.localStorage.getItem(currentSpaceStorageKey(view.userId));
  } catch {
    return null;
  }
}

function storeSpace(view: SpaceDirectoryView, spaceId: SpaceId) {
  try {
    window.localStorage.setItem(currentSpaceStorageKey(view.userId), spaceId);
  } catch {
    // Without storage the choice lasts until reload.
  }
}

interface CurrentSpaceState {
  readonly environmentId: EnvironmentId | null;
  readonly view: SpaceDirectoryView | null;
  readonly currentSpaceId: SpaceId | null;
  /** The last load failed; the previous Spaces and choice stay in place. */
  readonly loadFailed: boolean;
}

export const useCurrentSpace = create<CurrentSpaceState>(() => ({
  environmentId: null,
  view: null,
  currentSpaceId: null,
  loadFailed: false,
}));

/** Null when the User has no Space to work in yet. */
export function selectSpace(spaceId: SpaceId | null) {
  const { environmentId, view } = useCurrentSpace.getState();
  if (environmentId !== null) setCurrentSpace(environmentId, spaceId);
  if (view !== null && spaceId !== null) storeSpace(view, spaceId);
  useCurrentSpace.setState({ currentSpaceId: spaceId });
}

/** Loads the primary environment's Spaces; sign-in and sign-out reload the page, so this runs per User. */
export async function loadSpaces(environmentId: EnvironmentId): Promise<void> {
  const view = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchSpaceDirectory)),
  ).catch((cause: unknown) => (isForbidden(cause) ? "no-user" : null));
  // A session without a User (before the Owner exists) has no Spaces.
  if (view === "no-user") {
    setCurrentSpace(environmentId, null);
    useCurrentSpace.setState({
      environmentId,
      view: null,
      currentSpaceId: null,
      loadFailed: false,
    });
    return;
  }
  if (view === null) {
    useCurrentSpace.setState({ environmentId, loadFailed: true });
    return;
  }
  const previous = useCurrentSpace.getState().currentSpaceId;
  useCurrentSpace.setState({ environmentId, view, loadFailed: false });
  selectSpace(chooseCurrentSpace(view, previous ?? readStoredSpace(view)));
}

const NO_GENERATION = Atom.make(0).pipe(Atom.withLabel("web-shell-generation:none"));
const generationAtoms = new Map<EnvironmentId, Atom.Atom<number>>();
const shellGenerationAtom = (environmentId: EnvironmentId) => {
  let atom = generationAtoms.get(environmentId);
  if (atom === undefined) {
    atom = Atom.make((get) => get(environmentShell.stateValueAtom(environmentId)).generation).pipe(
      Atom.withLabel(`web-shell-generation:${environmentId}`),
    );
    generationAtoms.set(environmentId, atom);
  }
  return atom;
};

/** Changes with each authoritative shell snapshot of the environment, such as after a reconnect. */
export function useShellGeneration(environmentId: EnvironmentId | null): number {
  return useAtomValue(environmentId === null ? NO_GENERATION : shellGenerationAtom(environmentId));
}

export async function createAndSelectOrganization(name: string): Promise<void> {
  const created = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap((client) => createOrganization(client, name))),
  );
  const { environmentId } = useCurrentSpace.getState();
  if (environmentId !== null) await loadSpaces(environmentId);
  selectSpace(created.id);
}

/**
 * What the signed-in User's Role lets them do with a Thread of this environment. Spaces are read
 * from the primary environment only; elsewhere the server's refusal is the only guard.
 */
export function useThreadRolePermissions(
  environmentId: EnvironmentId | null,
  thread: ThreadRoleSubject | null,
) {
  const view = useCurrentSpace((state) =>
    environmentId !== null && state.environmentId === environmentId ? state.view : null,
  );
  return threadRolePermissions(view, thread);
}

/** `useThreadRolePermissions` for event handlers that build menus outside render. */
export function readThreadRolePermissions(
  environmentId: EnvironmentId,
  thread: ThreadRoleSubject | null,
) {
  const state = useCurrentSpace.getState();
  return threadRolePermissions(state.environmentId === environmentId ? state.view : null, thread);
}

/**
 * The Projects of the current Space (and of environments without Spaces), as the sidebar lists
 * them: what a new Thread may be started in, from every entry point.
 */
export function projectsInCurrentSpace<P extends SpaceFilterProject>(
  projects: readonly P[],
  state: Pick<
    CurrentSpaceState,
    "environmentId" | "view" | "currentSpaceId"
  > = useCurrentSpace.getState(),
): readonly P[] {
  return filterProjectsBySpace({
    spaceId: state.currentSpaceId,
    environmentId: state.environmentId,
    legacySpaceId: legacySpaceIdOf(state.view),
    projects,
  });
}

/** `projectsInCurrentSpace` for render. */
export function useProjectsInCurrentSpace<P extends SpaceFilterProject>(
  projects: readonly P[],
): readonly P[] {
  const environmentId = useCurrentSpace((state) => state.environmentId);
  const view = useCurrentSpace((state) => state.view);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  return projectsInCurrentSpace(projects, { environmentId, view, currentSpaceId });
}

/** The Threads of the current Space (and of environments without Spaces), for render. */
export function useThreadsInCurrentSpace<T extends SpaceFilterThread>(
  threads: readonly T[],
  projects: readonly SpaceFilterProject[],
): readonly T[] {
  const environmentId = useCurrentSpace((state) => state.environmentId);
  const spaceId = useCurrentSpace((state) => state.currentSpaceId);
  const legacySpaceId = useCurrentSpace((state) => legacySpaceIdOf(state.view));
  return filterThreadsBySpace({ spaceId, environmentId, legacySpaceId, threads, projects });
}
