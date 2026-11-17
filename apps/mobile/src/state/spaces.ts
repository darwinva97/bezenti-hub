import {
  type ThreadRoleSubject,
  threadRolePermissions,
} from "@t3tools/client-runtime/spaces/role-permissions";
import {
  createRemoteOrganization,
  fetchRemoteSpaceDirectory,
  makeSpaceSelectionStore,
  type SpaceSelection,
} from "@t3tools/client-runtime/spaces/space-selection";
import type { EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useSyncExternalStore } from "react";

import type { SavedRemoteConnection } from "../lib/connection";
import { runtime } from "../lib/runtime";

// Each Hub's signed-in User and current Space. The choice is kept per User, so a device shared by
// two accounts on one Hub does not mix them up.
const spaceSelections = makeSpaceSelectionStore({
  read: (key) => Storage.getItemSync(key),
  write: (key, value) => Storage.setItemSync(key, value),
});

const loading = new Map<EnvironmentId, string>();

/** Loads the Spaces of each connected Hub; again when its session changes. */
export function useLoadSpaces(connections: ReadonlyArray<SavedRemoteConnection>) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads each connected Hub's Space directory over HTTP when its session token changes
  useEffect(() => {
    for (const connection of connections) {
      const token = connection.bearerToken;
      if (token === null || loading.get(connection.environmentId) === token) continue;
      loading.set(connection.environmentId, token);
      void reloadSpaces(connection);
    }
  }, [connections]);
}

async function reloadSpaces(connection: SavedRemoteConnection): Promise<void> {
  if (connection.bearerToken === null) return;
  const load = await runtime.runPromise(
    fetchRemoteSpaceDirectory({
      httpBaseUrl: connection.httpBaseUrl,
      bearerToken: connection.bearerToken,
    }).pipe(Effect.orElseSucceed(() => ({ _tag: "failed" as const }))),
  );
  spaceSelections.apply(connection.environmentId, load);
}

export function selectSpace(environmentId: EnvironmentId, spaceId: SpaceId) {
  spaceSelections.select(environmentId, spaceId);
}

export function forgetSpaces(environmentId: EnvironmentId) {
  loading.delete(environmentId);
  spaceSelections.clear(environmentId);
}

export function useSpaceSelections(): ReadonlyMap<EnvironmentId, SpaceSelection> {
  return useSyncExternalStore(
    spaceSelections.subscribe,
    spaceSelections.snapshot,
    spaceSelections.snapshot,
  );
}

/** What the signed-in User's Role lets them do with a Thread of this Hub. */
export function useThreadRolePermissions(
  environmentId: EnvironmentId | null,
  thread: ThreadRoleSubject | null,
) {
  const selections = useSpaceSelections();
  const view = environmentId === null ? null : (selections.get(environmentId)?.view ?? null);
  return threadRolePermissions(view, thread);
}

/**
 * Creates an Organization on the Hub (any User may, and becomes its Admin), then lists it and
 * makes it the current Space there. Rejects with the server's reason, such as a name in use.
 */
export async function createOrganization(
  connection: SavedRemoteConnection,
  name: string,
): Promise<void> {
  if (connection.bearerToken === null) throw new Error("Sign in to this Hub first.");
  const created = await runtime.runPromise(
    createRemoteOrganization({
      httpBaseUrl: connection.httpBaseUrl,
      bearerToken: connection.bearerToken,
      name,
    }),
  );
  await reloadSpaces(connection);
  selectSpace(connection.environmentId, created.id);
}
