import type { AuthAccount } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

/** Where the web app's own account page lives; «Connect Keycloak» opens it in the browser. */
export const USER_ACCOUNT_BROWSER_PATH = "/settings/user/account";

/**
 * Only an address safe to hand the system browser: https, or http to this device (a Hub in
 * development). Anything else (a `javascript:` or app-scheme address, a plain-http remote) is
 * never opened.
 */
export function openableHubUrl(url: string | null): string | null {
  if (url === null) return null;
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  if (parsed.protocol === "https:") return parsed.href;
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname) ? parsed.href : null;
}

export type KeycloakAccountRow =
  | { readonly kind: "linked"; readonly value: string }
  | { readonly kind: "connect"; readonly value: string }
  | { readonly kind: "needs-reset"; readonly value: string };

/**
 * What the account screen says about Keycloak: the identity this User signs in with, or
 * «Connect Keycloak». Null when the Hub offers neither (Keycloak is off for this account).
 */
export function keycloakAccountRow(account: AuthAccount | null): KeycloakAccountRow | null {
  if (account === null) return null;
  if (account.identity !== undefined) {
    return {
      kind: "linked",
      value: account.identity.username ?? account.identity.email ?? "Your Keycloak account",
    };
  }
  if (account.keycloakLink === "allowed") {
    return { kind: "connect", value: "Opens your account on the Hub in the browser" };
  }
  if (account.keycloakLink === "needs-reset") {
    return {
      kind: "needs-reset",
      value: "Ask the Owner for a reset link to connect Keycloak to this account",
    };
  }
  return null;
}
