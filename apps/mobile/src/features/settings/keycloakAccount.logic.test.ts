import type { AuthAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { keycloakAccountRow, openableHubUrl } from "./keycloakAccount.logic";

const base = {
  user: {},
  loginName: null,
  hasPasskey: false,
  hasPassword: true,
  totpEnrolled: false,
  passwordRequiresTotp: false,
} as unknown as AuthAccount;

describe("keycloakAccountRow", () => {
  it("shows the linked identity, by username then email", () => {
    const identity = { username: "ana", email: "a@x.test", accountUrl: "https://kc.test/a" };
    expect(keycloakAccountRow({ ...base, identity })).toEqual({ kind: "linked", value: "ana" });
    expect(keycloakAccountRow({ ...base, identity: { ...identity, username: null } })).toEqual({
      kind: "linked",
      value: "a@x.test",
    });
  });
  it("offers Connect Keycloak when allowed, a reset hint when it needs one", () => {
    expect(keycloakAccountRow({ ...base, keycloakLink: "allowed" })?.kind).toBe("connect");
    expect(keycloakAccountRow({ ...base, keycloakLink: "needs-reset" })?.kind).toBe("needs-reset");
  });
  it("shows nothing without an account or when Keycloak is not offered", () => {
    expect(keycloakAccountRow(null)).toBeNull();
    expect(keycloakAccountRow(base)).toBeNull();
  });
});

describe("openableHubUrl", () => {
  it("opens https and loopback http only", () => {
    expect(openableHubUrl("https://hub.example.com/settings/user/account")).toBe(
      "https://hub.example.com/settings/user/account",
    );
    expect(openableHubUrl("http://127.0.0.1:3773/x")).toBe("http://127.0.0.1:3773/x");
    expect(openableHubUrl("http://hub.example.com/x")).toBeNull();
    expect(openableHubUrl("javascript:alert(1)")).toBeNull();
    expect(openableHubUrl("t3code://x")).toBeNull();
    expect(openableHubUrl(null)).toBeNull();
  });
});
