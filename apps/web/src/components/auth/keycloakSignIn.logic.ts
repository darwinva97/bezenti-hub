import { KEYCLOAK_RESULT_PARAM, KeycloakSignInFailure } from "@t3tools/contracts";
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

// Said to everyone alike: it never tells whether some account here exists.
const ALREADY_HERE =
  "If you already have an account here, sign in with it and connect Keycloak in your account settings.";

/** Why the last Keycloak sign-in was refused, from the page's `?keycloak=`, in plain words. */
export const keycloakResultMessage = (search: string): string | null => {
  const code = new URLSearchParams(search).get(KEYCLOAK_RESULT_PARAM);
  if (code === null || !isFailure(code)) return null;
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
      return "Admin invitations need a strong sign-in; available soon. Ask for a Member invitation for now.";
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
