import { describe, expect, it } from "vite-plus/test";

import { keycloakResultMessage, keycloakReturnTo } from "./keycloakSignIn.logic";

describe("keycloakReturnTo", () => {
  it("comes back to the page that started, never to the sign-in page itself", () => {
    expect(keycloakReturnTo({ pathname: "/sign-in", search: "?keycloak=failed" })).toBe("/");
    expect(
      keycloakReturnTo({ pathname: "/app-sign-in", search: "?redirect_uri=x&keycloak=failed" }),
    ).toBe("/app-sign-in?redirect_uri=x");
    expect(keycloakReturnTo({ pathname: "/settings/user/account", search: "" })).toBe(
      "/settings/user/account",
    );
  });
});

describe("keycloakResultMessage", () => {
  it("says why Keycloak sign-in was refused, and nothing for an unknown code", () => {
    expect(keycloakResultMessage("?keycloak=unknown")).toContain("doesn't know you");
    expect(keycloakResultMessage("?keycloak=taken")).toContain("another account");
    expect(keycloakResultMessage("?keycloak=invitation-only")).toContain("invitation only");
    expect(keycloakResultMessage("?keycloak=registration-closed")).toContain("not taking");
    expect(keycloakResultMessage("?keycloak=strong-factor-required")).toContain(
      "Member invitation",
    );
    expect(keycloakResultMessage("?keycloak=<script>")).toBeNull();
    expect(keycloakResultMessage("")).toBeNull();
  });
});
