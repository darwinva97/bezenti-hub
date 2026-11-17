import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HubEnvironmentSummary } from "./hubEnvironments.ts";
import { ResourceOwner, sameResourceOwner } from "./ownership.ts";

const decodeSummary = Schema.decodeUnknownSync(HubEnvironmentSummary);

const summary = {
  id: "env-vps",
  name: "Acme VPS",
  kind: "external",
  mode: "dedicated",
  ownerUserId: null,
  spaceId: "space-acme",
  status: "online",
  registeredAt: "2026-11-17T00:00:00.000Z",
  lastSeenAt: null,
  os: "linux",
  hostname: null,
  providers: [],
  resources: null,
  runningThreadCount: 0,
};

describe("ResourceOwner", () => {
  it("is a User or an Organization, nothing else", () => {
    const decode = Schema.decodeUnknownSync(ResourceOwner);
    expect(decode({ kind: "user", userId: "grace" })).toEqual({ kind: "user", userId: "grace" });
    expect(decode({ kind: "organization", spaceId: "space-acme" })).toEqual({
      kind: "organization",
      spaceId: "space-acme",
    });
    expect(() => decode({ kind: "installation" })).toThrow();
    expect(() => decode({ kind: "user", spaceId: "space-acme" })).toThrow();
  });

  it("tells two owners apart by kind and id", () => {
    const grace = { kind: "user", userId: "grace" } as ResourceOwner;
    const acme = { kind: "organization", spaceId: "grace" } as ResourceOwner;
    expect(sameResourceOwner(grace, { kind: "user", userId: "grace" } as ResourceOwner)).toBe(true);
    expect(sameResourceOwner(grace, acme)).toBe(false);
  });

  it("names a dedicated machine's Organization as its owner, and an older Hub's summary still decodes", () => {
    const owned = decodeSummary({
      ...summary,
      owner: { kind: "organization", spaceId: "space-acme" },
      canManage: true,
    });
    expect(owned.owner).toEqual({ kind: "organization", spaceId: "space-acme" });
    expect(owned.canManage).toBe(true);
    const older = decodeSummary(summary);
    expect(older.owner).toBeUndefined();
    expect(older.canManage).toBeUndefined();
  });
});
