import type { Grant, GrantGiveInput, GrantId } from "@t3tools/contracts";

import { request, type StepUp, toReauth } from "./userAccounts";

/**
 * Lends a machine or an AI account: a machine's loan the lender also decides on starts active and
 * needs the strong factor (`stepUp`); any other needs none.
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
 * account's without one (`stepUp` undefined).
 */
export async function acceptGrant(grantId: GrantId, stepUp: StepUp | undefined): Promise<Grant> {
  const reauth = stepUp === undefined ? undefined : await toReauth(stepUp);
  return request(
    (client) =>
      client.grants.accept({
        headers: {},
        payload: { grantId, ...(reauth === undefined ? {} : { reauth }) },
      }),
    "Confirming it's you failed: check your password, code or passkey.",
  );
}
