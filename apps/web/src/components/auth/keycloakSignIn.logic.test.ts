import { describe, expect, it } from "vite-plus/test";

import {
  keycloakProofOf,
  keycloakResultCode,
  keycloakResultMessage,
  keycloakReturnTo,
  keycloakSignOutHandleOf,
  signedOutLocation,
} from "./keycloakSignIn.logic";

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

describe("keycloakProofOf", () => {
  it("reads a confirmation's proof from the fragment only", () => {
    expect(keycloakProofOf("#keycloakProof=abc")).toBe("abc");
    expect(keycloakProofOf("keycloakProof=abc")).toBe("abc");
    expect(keycloakProofOf("#other=1")).toBeNull();
    expect(keycloakProofOf("#keycloakProof=")).toBeNull();
    expect(keycloakProofOf("")).toBeNull();
  });
});

describe("signedOutLocation (ticket 07)", () => {
  it("carries the sign-out's handle in the fragment only, and reads it back", () => {
    expect(signedOutLocation(undefined)).toBe("/sign-in");
    const location = signedOutLocation("a+b/c");
    expect(location.startsWith("/sign-in#")).toBe(true);
    expect(location).not.toContain("?");
    expect(keycloakSignOutHandleOf(location.slice(location.indexOf("#")))).toBe("a+b/c");
    expect(keycloakSignOutHandleOf("#other=1")).toBeNull();
    expect(keycloakSignOutHandleOf("#keycloak-sign-out=")).toBeNull();
  });
});

describe("keycloakResultMessage", () => {
  it("says why Keycloak sign-in was refused, and nothing for an unknown code", () => {
    expect(keycloakResultMessage("?keycloak=unknown")).toContain("doesn't know you");
    expect(keycloakResultMessage("?keycloak=taken")).toContain("another account");
    expect(keycloakResultMessage("?keycloak=invitation-only")).toContain("invitation only");
    expect(keycloakResultMessage("?keycloak=registration-closed")).toContain("not taking");
    expect(keycloakResultMessage("?keycloak=strong-factor-required")).toContain(
      "second factor in Keycloak",
    );
    expect(keycloakResultCode("?keycloak=strong-factor-required")).toBe("strong-factor-required");
    expect(keycloakResultCode("?keycloak=nope")).toBeNull();
    expect(keycloakResultMessage("?keycloak=<script>")).toBeNull();
    expect(keycloakResultMessage("")).toBeNull();
  });
});
