import { SpaceId, UserId, type HubEnvironmentSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineInScope, ownerInScope, sandboxOfScope } from "./ownedResourceScope";

const ME = UserId.make("user-me");
const OTHER = UserId.make("user-other");
const ACME = SpaceId.make("space-acme");
const BETA = SpaceId.make("space-beta");

type MachineShape = Pick<
  HubEnvironmentSummary,
  "kind" | "mode" | "ownerUserId" | "spaceId" | "lent"
>;
const machine = (shape: Partial<MachineShape>): MachineShape => ({
  kind: "external",
  mode: "personal",
  ownerUserId: ME,
  ...shape,
});

describe("ownerInScope", () => {
  it("lists a User's own resources in User settings, and nobody else's", () => {
    expect(ownerInScope({ kind: "user" }, { kind: "user", userId: ME }, ME)).toBe(true);
    expect(ownerInScope({ kind: "user" }, { kind: "user", userId: OTHER }, ME)).toBe(false);
    expect(ownerInScope({ kind: "user" }, { kind: "organization", spaceId: ACME }, ME)).toBe(false);
    expect(ownerInScope({ kind: "user" }, { kind: "user", userId: ME }, undefined)).toBe(false);
  });

  it("lists one Organization's resources in its Space settings", () => {
    const scope = { kind: "organization", spaceId: ACME } as const;
    expect(ownerInScope(scope, { kind: "organization", spaceId: ACME }, ME)).toBe(true);
    expect(ownerInScope(scope, { kind: "organization", spaceId: BETA }, ME)).toBe(false);
    expect(ownerInScope(scope, { kind: "user", userId: ME }, ME)).toBe(false);
  });
});

describe("machineInScope", () => {
  it("lists a User's personal machines, not others', lent or the Hub's", () => {
    const scope = { kind: "user" } as const;
    expect(machineInScope(scope, machine({}), ME)).toBe(true);
    expect(machineInScope(scope, machine({ ownerUserId: OTHER }), ME)).toBe(false);
    expect(machineInScope(scope, machine({ mode: "dedicated", spaceId: ACME }), ME)).toBe(false);
    expect(machineInScope(scope, machine({ kind: "hub", ownerUserId: null }), ME)).toBe(false);
    expect(machineInScope(scope, machine({}), undefined)).toBe(false);
  });

  it("lists the machines dedicated to the Organization, and no Sandbox", () => {
    const scope = { kind: "organization", spaceId: ACME } as const;
    const dedicated = (spaceId: SpaceId) =>
      machine({ mode: "dedicated", ownerUserId: null, spaceId });
    expect(machineInScope(scope, dedicated(ACME), ME)).toBe(true);
    expect(machineInScope(scope, dedicated(BETA), ME)).toBe(false);
    expect(machineInScope(scope, machine({}), ME)).toBe(false);
    expect(machineInScope(scope, { ...dedicated(ACME), kind: "sandbox" }, ME)).toBe(false);
  });
});

describe("sandboxOfScope", () => {
  const list = [
    { kind: "hub", spaceId: null },
    { kind: "sandbox", spaceId: BETA },
    { kind: "sandbox", spaceId: ACME },
  ] as const;

  it("finds the Sandbox of the Organization's Space", () => {
    expect(sandboxOfScope({ kind: "organization", spaceId: ACME }, list)).toBe(list[2]);
    expect(
      sandboxOfScope({ kind: "organization", spaceId: SpaceId.make("none") }, list),
    ).toBeUndefined();
    expect(sandboxOfScope({ kind: "user" }, list)).toBeUndefined();
  });
});
