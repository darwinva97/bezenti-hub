import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
} from "@t3tools/client-runtime/rpc";
import { listMembers, type SessionHeaders } from "@t3tools/client-runtime/spaces/memberships";
import type { MemberList, SpaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import type { SavedRemoteConnection } from "../lib/connection";
import { runtime } from "../lib/runtime";

type HubClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

/**
 * Runs one of client-runtime's Space calls (Members, Invitations) against a Hub with the session
 * mobile holds for it. Rejects with the server's reason.
 */
export function callHub<A, E>(
  connection: SavedRemoteConnection,
  call: (client: HubClient, headers: SessionHeaders) => Effect.Effect<A, E>,
): Promise<A> {
  if (connection.bearerToken === null)
    return Promise.reject(new Error("Sign in to this Hub first."));
  const headers: SessionHeaders = { authorization: `Bearer ${connection.bearerToken}` };
  return runtime.runPromise(
    makeEnvironmentHttpApiClient(connection.httpBaseUrl).pipe(
      Effect.flatMap((client) =>
        executeEnvironmentHttpRequest(connection.httpBaseUrl, 10_000, call(client, headers)),
      ),
    ),
  );
}

/** The reason to show for a failed call, or `fallback` when the error carries none. */
export function reasonOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

/** The Organization's Members as this viewer may act on them, loaded when the screen opens. */
export function useSpaceMembers(connection: SavedRemoteConnection | null, spaceId: SpaceId | null) {
  const [members, setMembers] = useState<MemberList | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Members from the Hub when the screen opens
  useEffect(() => {
    if (connection === null || spaceId === null) return;
    let cancelled = false;
    void callHub(connection, (client, headers) => listMembers(client, spaceId, headers)).then(
      (list) => {
        if (!cancelled) setMembers(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(reasonOf(cause, "Could not load the members."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, spaceId]);

  return { members, setMembers, error };
}
