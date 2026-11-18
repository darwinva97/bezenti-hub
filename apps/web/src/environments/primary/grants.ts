import type { Grant, GrantGiveInput, GrantId } from "@t3tools/contracts";

import { request, type StepUp, toReauth } from "./userAccounts";

/**
 * Lends a machine, an AI account or a Vault group: a machine's loan the lender also decides on
 * starts active and needs the strong factor (`stepUp`), as any Vault group's does; others none.
 */
export async function giveGrant(input: GrantGiveInput, stepUp: StepUp | undefined): Promise<Grant> {
  const reauth = stepUp === undefined ? undefined : await toReauth(stepUp);
  return request(
    (client) =>
      client.grants.give({
        headers: {},
        payload: { ...input, ...(reauth === undefined ? {} : { reauth }) },
      }),
    "Confirming it's you failed: check your password, code or passkey.",
  );
}

/**
 * Accepts a loan to a Space the User decides for: a machine's with the strong factor, an AI
 * account's or a Vault group's without one (`stepUp` undefined); a Vault group's may also become
 * one of the Space's defaults (`useAsDefault`).
 */
export async function acceptGrant(
  grantId: GrantId,
  stepUp: StepUp | undefined,
  options: { readonly useAsDefault?: boolean } = {},
): Promise<Grant> {
  const reauth = stepUp === undefined ? undefined : await toReauth(stepUp);
  return request(
    (client) =>
      client.grants.accept({
        headers: {},
        payload: {
          grantId,
          ...(reauth === undefined ? {} : { reauth }),
          ...(options.useAsDefault === undefined ? {} : { useAsDefault: options.useAsDefault }),
        },
      }),
    "Confirming it's you failed: check your password, code or passkey.",
  );
}
