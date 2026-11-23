import type { Grant } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import { callHub } from "../../state/space-admin";

/** Why mobile does not accept a machine's loan or apply its link: it needs a strong factor. */
export const MACHINE_ON_WEB_NOTE =
  "Accepting a machine needs a passkey or authenticator code: accept it on the web or desktop app.";

/**
 * Accepts a loan to a Space the User decides for, over HTTP (the Hub's only way to accept): an AI
 * account's, or a Vault group's (`useAsDefault`: also one of the Space's defaults). Never a
 * machine's: that needs the strong factor mobile does not ask for, and the Hub refuses it without.
 */
export function acceptLoan(
  connection: SavedRemoteConnection,
  grant: Grant,
  options: { readonly useAsDefault?: boolean } = {},
): Promise<Grant> {
  if (grant.resource.kind === "environment") return Promise.reject(new Error(MACHINE_ON_WEB_NOTE));
  return callHub(connection, (client, headers) =>
    client.grants.accept({
      headers,
      payload: {
        grantId: grant.id,
        ...(options.useAsDefault === undefined ? {} : { useAsDefault: options.useAsDefault }),
      },
    }),
  );
}
