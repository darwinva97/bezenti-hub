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

/** Why the last Keycloak sign-in was refused, from the page's `?keycloak=`, in plain words. */
export const keycloakResultMessage = (search: string): string | null => {
  const code = new URLSearchParams(search).get(KEYCLOAK_RESULT_PARAM);
  if (code === null || !isFailure(code)) return null;
  switch (code) {
    case "unknown":
      return "This Hub doesn't know you yet. Ask its Owner for an invitation.";
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
