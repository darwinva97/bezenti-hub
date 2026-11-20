import type { AuthAccount } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { SavedRemoteConnection } from "../lib/connection";
import { callHub } from "./space-admin";

/** The signed-in User's own account on the Hub (their Keycloak identity among it); null until loaded or when unavailable. */
export function useHubAccount(connection: SavedRemoteConnection | null): AuthAccount | null {
  const [account, setAccount] = useState<AuthAccount | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the User's account from the Hub when the screen opens
  useEffect(() => {
    if (connection === null) return;
    let cancelled = false;
    void callHub(connection, (client, headers) => client.auth.account({ headers })).then(
      (loaded) => {
        if (!cancelled) setAccount(loaded);
      },
      // A session with no User, or no Hub: nothing to show.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return account;
}
