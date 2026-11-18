import type { SignInSettings } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { changesOf, clientUrlsOf, formOf } from "./signInSettings.logic";

const saved: SignInSettings = {
  registrationMode: "invitation-only",
  localSignInForMembers: true,
  keycloak: {
    enabled: false,
    issuer: "https://auth.example.com/realms/acme",
    clientId: "t3-hub",
    clientSecretSet: true,
    clientSecretUpdatedAt: "2026-11-18T10:00:00.000Z",
    groupsClaim: "groups",
    strongAcr: [],
    strongAmr: [],
  },
  publicOrigin: null,
  updatedAt: "2026-11-18T10:00:00.000Z",
};

describe("sign-in settings form", () => {
  it("sends only what changed, and the secret only when typed", () => {
    expect(changesOf(saved, formOf(saved))).toBeNull();
    const changed = changesOf(saved, {
      ...formOf(saved),
      registrationMode: "closed",
      clientSecret: "new-secret",
    });
    expect(changed?.registrationMode).toBe("closed");
    expect(changed?.issuer).toBeUndefined();
    expect(Redacted.value(changed!.clientSecret!)).toBe("new-secret");
  });
});

describe("the URLs for the Keycloak client", () => {
  it("follow T3CODE_PUBLIC_URL, else the page's address, and say which", () => {
    const published = clientUrlsOf("https://hub.example.com", "http://localhost:5733");
    expect(published.fromPage).toBe(false);
    expect(published.urls.map((entry) => entry.url)).toEqual([
      "https://hub.example.com/oauth/keycloak/callback",
      "https://hub.example.com/oauth/keycloak/backchannel-logout",
      "https://hub.example.com/sign-in",
    ]);
    const local = clientUrlsOf(null, "http://localhost:5733");
    expect(local.fromPage).toBe(true);
    expect(local.urls[0]?.url).toBe("http://localhost:5733/oauth/keycloak/callback");
  });
});
