import {
  type AuthAccount,
  KEYCLOAK_PROOF_FRAGMENT_PARAM,
  KEYCLOAK_RESULT_PARAM,
  KEYCLOAK_SIGN_OUT_FRAGMENT_PARAM,
  KeycloakSignInFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isFailure = Schema.is(KeycloakSignInFailure);

/** Where the browser comes back after Keycloak: this page, but the sign-in page itself is `/`. */
export const keycloakReturnTo = (location: {
  readonly pathname: string;
  readonly search: string;
}) => {
  if (location.pathname === "/sign-in") return "/";
  const params = new URLSearchParams(location.search);
  params.delete(KEYCLOAK_RESULT_PARAM);
  const search = params.toString();
  return `${location.pathname}${search === "" ? "" : `?${search}`}`;
};

/**
 * The proof a Keycloak confirmation (`step-up`) came back with, from the page's fragment; never
 * the query, so it reaches no server log or `Referer`.
 */
export const keycloakProofOf = (hash: string): string | null => {
  const proofId = new URLSearchParams(hash.replace(/^#/, "")).get(KEYCLOAK_PROOF_FRAGMENT_PARAM);
  return proofId === null || proofId === "" ? null : proofId;
};

/**
 * Where a signed-out browser lands (ticket 07): the sign-in page, with the sign-out's handle for
 * «Also sign out of Keycloak» in the fragment, never the query, so no server log keeps it.
 */
export const signedOutLocation = (keycloakSignOutHandle: string | undefined) =>
  keycloakSignOutHandle === undefined
    ? "/sign-in"
    : `/sign-in#${new URLSearchParams({ [KEYCLOAK_SIGN_OUT_FRAGMENT_PARAM]: keycloakSignOutHandle })}`;

/** The sign-out's handle the signed-out page was sent with; null when none. */
export const keycloakSignOutHandleOf = (hash: string): string | null => {
  const handle = new URLSearchParams(hash.replace(/^#/, "")).get(KEYCLOAK_SIGN_OUT_FRAGMENT_PARAM);
  return handle === null || handle === "" ? null : handle;
};

/** A User who signs in only with Keycloak confirms through it: nothing local to confirm with. */
export const confirmsWithKeycloak = (account: AuthAccount) =>
  account.identity !== undefined && !account.hasPasskey && !account.hasPassword;

// Said to everyone alike: it never tells whether some account here exists.
const ALREADY_HERE =
  "If you already have an account here, sign in with it and connect Keycloak in your account settings.";

/** Why the last Keycloak flow was refused, from the page's `?keycloak=`; null when none. */
export const keycloakResultCode = (search: string): KeycloakSignInFailure | null => {
  const code = new URLSearchParams(search).get(KEYCLOAK_RESULT_PARAM);
  return code === null || !isFailure(code) ? null : code;
};

/** Why the last Keycloak sign-in was refused, from the page's `?keycloak=`, in plain words. */
export const keycloakResultMessage = (search: string): string | null => {
  const code = keycloakResultCode(search);
  if (code === null) return null;
  switch (code) {
    case "unknown":
      return "This Hub doesn't know you yet. Ask its Owner for an invitation.";
    case "invitation-only":
      return `This Hub is invitation only. Ask for an invitation. ${ALREADY_HERE}`;
    case "registration-closed":
      return `This Hub is not taking new accounts. ${ALREADY_HERE}`;
    case "invitation-invalid":
      return "This invitation is no longer valid. Ask whoever invited you for a new link.";
    case "already-member":
      return "You're already in this Organization.";
    case "owner":
      return "You're the Owner, who already sees every Organization.";
    case "strong-factor-required":
      return "Your Role needs a second factor in Keycloak. Retry and confirm with it there.";
    case "identity-mismatch":
      return "You signed in at Keycloak with another account than this one's. Try again with yours.";
    case "disabled":
      return "The Owner disabled this account. Ask them to turn it back on.";
    case "removed":
      return "This account was removed from this Hub.";
    case "taken":
      return "That Keycloak account is already connected to another account on this Hub.";
    case "cancelled":
      return "Signing in with Keycloak was cancelled.";
    case "throttled":
      return "Too many failed attempts. Wait a few minutes and try again.";
    case "unavailable":
      return "Keycloak is not answering right now. Try again in a moment.";
    case "failed":
      return "Signing in with Keycloak did not go through. Try again.";
  }
};
