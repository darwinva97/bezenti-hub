import type { Grant, GrantGiveInput, GrantId } from "@t3tools/contracts";

import { request, type StepUp, toReauth } from "./userAccounts";

/**
 * Lends a machine: a loan the lender also decides on starts active and needs the strong factor
 * (`stepUp`); any other waits for its Space and needs none.
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

/** Accepts a loan of a machine to a Space the User decides for, with the strong factor. */
export async function acceptGrant(grantId: GrantId, stepUp: StepUp): Promise<Grant> {
  const reauth = await toReauth(stepUp);
  return request(
    (client) =>
      client.grants.accept({
        headers: {},
        payload: { grantId, ...(reauth === undefined ? {} : { reauth }) },
      }),
    "Confirming it's you failed: check your password, code or passkey.",
  );
}
