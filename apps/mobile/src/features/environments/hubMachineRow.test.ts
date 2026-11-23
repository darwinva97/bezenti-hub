import {
  EnvironmentId,
  type HubEnvironmentOverviewEntry,
  HUB_MACHINE_ENVIRONMENT_ID,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hubMachineRow } from "./hubMachineRow";

const entry = (
  overrides: Partial<HubEnvironmentOverviewEntry> &
    Pick<HubEnvironmentOverviewEntry, "id" | "name">,
): HubEnvironmentOverviewEntry => ({
  kind: "external",
  mode: "personal",
  spaceId: null,
  spaceName: null,
  ownerUserId: null,
  ownerName: null,
  status: "online",
  startError: null,
  os: null,
  lastSeenAt: null,
  runningThreadCount: 0,
  ...overrides,
});

const acme = SpaceId.make("space-acme");

describe("the Owner's list of machines on mobile", () => {
  it("names each machine's mode, Space and state as web does", () => {
    const sandbox = hubMachineRow(
      entry({
        id: EnvironmentId.make("sandbox:space-acme"),
        name: "Acme Sandbox",
        kind: "sandbox",
        mode: "sandbox",
        spaceId: acme,
        spaceName: "Acme",
        status: "starting",
      }),
    );
    expect(sandbox).toMatchObject({
      status: "starting",
      mode: "Sandbox",
      details: "Starting · Sandbox of Acme",
      accessibilityLabel: "Acme Sandbox, Starting · Sandbox of Acme",
    });

    expect(
      hubMachineRow(
        entry({
          id: EnvironmentId.make("env-vps"),
          name: "Acme VPS",
          mode: "dedicated",
          spaceId: acme,
          spaceName: "Acme",
          os: "linux",
          runningThreadCount: 2,
        }),
      ),
    ).toMatchObject({
      status: "online",
      mode: "Dedicated machine",
      details: "Online · Dedicated to Acme · linux · 2 running Threads",
    });

    expect(
      hubMachineRow(
        entry({
          id: EnvironmentId.make("env-laptop"),
          name: "Laptop",
          ownerUserId: UserId.make("user-grace"),
          ownerName: "Grace",
          status: "offline",
        }),
      ),
    ).toMatchObject({ mode: "Personal machine", details: "Offline · Grace's personal machine" });
    // The Owner's own machine, as web says it.
    expect(
      hubMachineRow(
        entry({
          id: EnvironmentId.make("env-owner-laptop"),
          name: "Ada's laptop",
          ownerUserId: UserId.make("user-ada"),
          ownerName: "Ada",
        }),
        "user-ada",
      ).details,
    ).toBe("Online · Your personal machine");

    expect(
      hubMachineRow(
        entry({
          id: HUB_MACHINE_ENVIRONMENT_ID,
          name: "Hub machine",
          kind: "hub",
          status: "offline",
        }),
      ),
    ).toMatchObject({ status: "online", mode: "Hub machine", details: "Online · Runs the Hub" });
  });

  it("says a running Sandbox runs, a stopped one is stopped, and why a failed one failed", () => {
    const sandbox = (status: HubEnvironmentOverviewEntry["status"], startError: string | null) =>
      hubMachineRow(
        entry({
          id: EnvironmentId.make("sandbox:space-acme"),
          name: "Acme Sandbox",
          kind: "sandbox",
          mode: "sandbox",
          spaceId: acme,
          spaceName: "Acme",
          status,
          startError,
        }),
      );
    expect(sandbox("online", null).details).toBe("Running · Sandbox of Acme");
    expect(sandbox("stopped", null)).toMatchObject({
      details: "Stopped · Sandbox of Acme",
      error: null,
    });
    expect(sandbox("failed", "Podman is not installed")).toMatchObject({
      status: "failed",
      details: "Failed to start · Sandbox of Acme",
      error: "Podman is not installed",
    });
  });

  it("badges a machine lent to the Space and says its lender sees everything on it", () => {
    const lent = hubMachineRow({
      ...entry({ id: EnvironmentId.make("lent:g1"), name: "Ana's box" }),
      mode: "dedicated",
      spaceId: acme,
      spaceName: "Acme",
      lent: { grantId: "g1", lenderName: "Ana" },
    });
    expect(lent.mode).toBe("Lent machine");
    expect(lent.details).toBe("Online · Lent to Acme by Ana, who sees everything that runs on it");
  });
});
