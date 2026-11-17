import { describe, expect, it } from "vite-plus/test";

import { canRevokeInvitation } from "./invitations.ts";
import { memberRoleChoices } from "./memberships.ts";

describe("changing a Member's Role", () => {
  it("offers what the viewer may assign", () => {
    expect(memberRoleChoices({ role: "member" }, ["member", "guest"])).toEqual(["member", "guest"]);
  });

  it("keeps the Member's current Role in the choice when the viewer cannot assign it", () => {
    expect(memberRoleChoices({ role: "admin" }, ["member", "guest"])).toEqual([
      "admin",
      "member",
      "guest",
    ]);
  });
});

describe("revoking an Invitation", () => {
  const assignedByAdmin = ["member", "guest"] as const;
  const assignedByOwner = ["admin", "member", "guest"] as const;

  it("is for pending Invitations only", () => {
    for (const status of ["accepted", "expired", "revoked"] as const) {
      expect(canRevokeInvitation({ status, role: "member" }, assignedByOwner)).toBe(false);
    }
    expect(canRevokeInvitation({ status: "pending", role: "member" }, assignedByAdmin)).toBe(true);
  });

  it("leaves Admin Invitations to the Owner", () => {
    expect(canRevokeInvitation({ status: "pending", role: "admin" }, assignedByAdmin)).toBe(false);
    expect(canRevokeInvitation({ status: "pending", role: "admin" }, assignedByOwner)).toBe(true);
  });
});
