// The signed-in User (principal) and current Space of each environment, for clients that talk to
// several Hubs at once (mobile). One entry per environment: its Space directory, which carries the
// User and whether they are the Owner, and the Space new Projects and Threads go to there.
import {
  EnvironmentHttpForbiddenError,
  type EnvironmentId,
  type SpaceDirectoryView,
  type SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import { setCurrentSpace } from "./currentSpace.ts";
import { chooseCurrentSpace, currentSpaceStorageKey } from "./spaceDirectory.ts";

export interface SpaceSelection {
  /** Null before the first load, and for a session without a User (before the Owner exists). */
  readonly view: SpaceDirectoryView | null;
  readonly currentSpaceId: SpaceId | null;
  /** The last load failed; the previous Spaces and choice stay in place. */
  readonly loadFailed: boolean;
}

const EMPTY: SpaceSelection = { view: null, currentSpaceId: null, loadFailed: false };

/** Where a choice outlives the app; reads and writes may fail, which loses only the choice. */
export interface SpaceChoiceStorage {
  readonly read: (key: string) => string | null;
  readonly write: (key: string, value: string) => void;
}

/** What loading an environment's Space directory returned. */
export type SpaceDirectoryLoad =
  | { readonly _tag: "loaded"; readonly view: SpaceDirectoryView }
  /** The session has no User: no Spaces, and the server picks where things go. */
  | { readonly _tag: "no-user" }
  | { readonly _tag: "failed" };

const isForbidden = Schema.is(EnvironmentHttpForbiddenError);

/** Reads an environment's Space directory with a bearer session, as mobile holds one per Hub. */
export const fetchRemoteSpaceDirectory = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "spaces").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/spaces"),
        10_000,
        client.list({ headers: { authorization: `Bearer ${input.bearerToken}` } }),
      ),
    ),
    Effect.map((view): SpaceDirectoryLoad => ({ _tag: "loaded", view })),
    // A session without a User is refused (403); an older server without Spaces answers 404.
    Effect.catch((error) =>
      Effect.succeed<SpaceDirectoryLoad>(
        isForbidden(error) ||
          (typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error.status === 403 || error.status === 404))
          ? { _tag: "no-user" }
          : { _tag: "failed" },
      ),
    ),
  );

/**
 * Creates an Organization on a Hub with a bearer session, as mobile holds one per Hub. Any User
 * may; the caller becomes its Admin. Fails with the server's reason, such as a name in use.
 */
export const createRemoteOrganization = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly name: string;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "spaces").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/spaces/organizations"),
        10_000,
        client.createOrganization({
          headers: { authorization: `Bearer ${input.bearerToken}` },
          payload: { name: input.name },
        }),
      ),
    ),
  );

export function makeSpaceSelectionStore(storage: SpaceChoiceStorage) {
  let selections = new Map<EnvironmentId, SpaceSelection>();
  const listeners = new Set<() => void>();
  const update = (environmentId: EnvironmentId, next: SpaceSelection) => {
    selections = new Map(selections).set(environmentId, next);
    for (const listener of listeners) listener();
  };
  const readStored = (view: SpaceDirectoryView) => {
    try {
      return storage.read(currentSpaceStorageKey(view.userId));
    } catch {
      return null;
    }
  };

  const get = (environmentId: EnvironmentId): SpaceSelection =>
    selections.get(environmentId) ?? EMPTY;

  const select = (environmentId: EnvironmentId, spaceId: SpaceId) => {
    const current = get(environmentId);
    if (current.view === null || !current.view.spaces.some((space) => space.id === spaceId)) return;
    setCurrentSpace(environmentId, spaceId);
    try {
      storage.write(currentSpaceStorageKey(current.view.userId), spaceId);
    } catch {
      // Without storage the choice lasts until the app restarts.
    }
    update(environmentId, { ...current, currentSpaceId: spaceId });
  };

  const apply = (environmentId: EnvironmentId, load: SpaceDirectoryLoad) => {
    const previous = get(environmentId);
    if (load._tag === "failed") {
      update(environmentId, { ...previous, loadFailed: true });
      return;
    }
    if (load._tag === "no-user") {
      setCurrentSpace(environmentId, null);
      update(environmentId, EMPTY);
      return;
    }
    // Another User on the same environment (signed out and in again) starts from their own choice.
    const kept =
      previous.view?.userId === load.view.userId ? previous.currentSpaceId : readStored(load.view);
    const currentSpaceId = chooseCurrentSpace(load.view, kept);
    setCurrentSpace(environmentId, currentSpaceId);
    update(environmentId, { view: load.view, currentSpaceId, loadFailed: false });
  };

  /** Forgets an environment that was removed or signed out. */
  const clear = (environmentId: EnvironmentId) => {
    setCurrentSpace(environmentId, null);
    if (!selections.has(environmentId)) return;
    const next = new Map(selections);
    next.delete(environmentId);
    selections = next;
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { get, select, apply, clear, subscribe, snapshot: () => selections };
}

export type SpaceSelectionStore = ReturnType<typeof makeSpaceSelectionStore>;
