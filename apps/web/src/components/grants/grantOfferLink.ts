import { peekPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../environments/primary/auth";

/** Where a lending link lands (Grants ticket 06): `/grants/offer#token=<token>`. */
export const GRANT_OFFER_PATH = "/grants/offer";

// The tab keeps the token until the link is applied or found dead, so signing in first (or a
// reload) does not lose it; it never goes back into the address bar.
const TOKEN_STORAGE_KEY = "t3code:grant-offer-token";

/** The link's token: read once from the fragment, which then leaves the address bar. */
export function takeGrantOfferToken(): string | null {
  const fromUrl = peekPairingTokenFromUrl();
  if (fromUrl !== null) stripPairingTokenFromUrl();
  try {
    if (fromUrl !== null) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl ?? window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return fromUrl;
  }
}

/** Whether this tab holds a link not applied yet: signing in leads back to it. */
export function hasPendingGrantOffer(): boolean {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function forgetGrantOfferToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing was kept.
  }
}
