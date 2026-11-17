import { isMachineSectionAllowed } from "@t3tools/client-runtime/settings/modal-visibility";
import { describe, expect, it } from "vite-plus/test";

import {
  LEGACY_MACHINE_PAGES,
  isMachineProvidersPathname,
  machinePagePath,
  machineSectionOfPathname,
  machineSettingsHref,
} from "./machineSettings";

const OWNER = { isOwner: true, isDesktop: false, hasUser: true };
const OWNER_ON_DESKTOP = { ...OWNER, isDesktop: true };
const MEMBER = { isOwner: false, isDesktop: false, hasUser: true };

describe("machine page paths", () => {
  it("mounts the page under the Hub, the User or a Space", () => {
    expect(machinePagePath({ kind: "hub" }, "providers")).toBe(
      "/settings/platform/hub-machine/providers",
    );
    expect(machinePagePath({ kind: "user", environmentId: "env 1" }, "devices")).toBe(
      "/settings/user/machines/env%201/devices",
    );
    expect(
      machinePagePath({ kind: "space", spaceId: "s1", environmentId: "e1" }, "maintenance"),
    ).toBe("/settings/space/s1/machines/e1/maintenance");
    expect(machinePagePath({ kind: "hub" }, "maintenance", "diagnostics")).toBe(
      "/settings/platform/hub-machine/maintenance/diagnostics",
    );
  });

  it.each([
    ["/settings/platform/hub-machine", undefined, undefined],
    ["/settings/platform/hub-machine/source-control", "source-control", undefined],
    ["/settings/platform/hub-machine/maintenance/diagnostics", "maintenance", "diagnostics"],
    ["/settings/user/machines/e1/network/", "network", undefined],
    ["/settings/space/s1/machines/e1/devices", "devices", undefined],
  ] as const)("reads the section of %s", (pathname, section, subpage) => {
    expect(machineSectionOfPathname(pathname)).toEqual({ section, subpage });
  });
});

describe("links to a machine", () => {
  const primaryEnvironmentId = "hub";

  it("goes to the Hub machine without a machine in the context, or for the Hub's own", () => {
    expect(machineSettingsHref({ section: "providers", primaryEnvironmentId })).toBe(
      "/settings/platform/hub-machine/providers",
    );
    expect(
      machineSettingsHref({
        section: "source-control",
        environmentId: "hub",
        primaryEnvironmentId,
      }),
    ).toBe("/settings/platform/hub-machine/source-control");
  });

  it("goes to the page of another machine under User settings, with the provider to set up", () => {
    expect(
      machineSettingsHref({
        section: "providers",
        environmentId: "laptop",
        primaryEnvironmentId,
        instanceId: "codex",
      }),
    ).toBe("/settings/user/machines/laptop/providers?instanceId=codex");
  });

  it("recognizes the Providers page wherever it is mounted", () => {
    expect(isMachineProvidersPathname("/settings/platform/hub-machine/providers")).toBe(true);
    expect(isMachineProvidersPathname("/settings/user/machines/e1/providers")).toBe(true);
    expect(isMachineProvidersPathname("/settings/space/s1/machines/e1/providers")).toBe(true);
    expect(isMachineProvidersPathname("/settings/platform/hub-machine/devices")).toBe(false);
    expect(isMachineProvidersPathname("/settings/providers")).toBe(false);
  });

  it("names the machine page every old machine page moved to", () => {
    expect(Object.keys(LEGACY_MACHINE_PAGES).toSorted()).toEqual([
      "/settings/devices",
      "/settings/diagnostics",
      "/settings/maintenance",
      "/settings/providers",
      "/settings/source-control",
    ]);
  });
});

describe("who sees the sections of a machine", () => {
  it("shows them to the Owner, as the old pages did, and to nobody else", () => {
    for (const id of ["providers", "source-control", "devices", "maintenance"]) {
      expect(isMachineSectionAllowed(id, OWNER, { isLocalBackend: false }), id).toBe(true);
      expect(isMachineSectionAllowed(id, MEMBER, { isLocalBackend: false }), id).toBe(false);
    }
  });

  it("gives Network only to the backend of this computer, in the desktop app", () => {
    expect(isMachineSectionAllowed("network", OWNER_ON_DESKTOP, { isLocalBackend: true })).toBe(
      true,
    );
    expect(isMachineSectionAllowed("network", OWNER_ON_DESKTOP, { isLocalBackend: false })).toBe(
      false,
    );
    expect(isMachineSectionAllowed("network", OWNER, { isLocalBackend: true })).toBe(false);
  });

  it("knows no other section", () => {
    expect(isMachineSectionAllowed("sessions", OWNER, { isLocalBackend: true })).toBe(false);
  });
});
