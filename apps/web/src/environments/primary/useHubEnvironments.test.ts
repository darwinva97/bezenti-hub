import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  ProviderDriverKind,
  ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeEnvironmentLabel,
  activeEnvironmentOf,
  previewDefaultEnvironment,
  threadEnvironmentState,
} from "./useHubEnvironments";

const claude = ProviderInstanceId.make("claudeAgent");
const ada = UserId.make("ada");
const machine = (
  id: string,
  overrides: Partial<HubEnvironmentSummary> = {},
): HubEnvironmentSummary => ({
  id: EnvironmentId.make(id),
  name: id,
  kind: "external",
  mode: "personal",
  ownerUserId: ada,
  status: "online",
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  os: null,
  hostname: null,
  providers: [
    {
      instanceId: claude,
      provider: ProviderDriverKind.make("claudeAgent"),
      displayName: null,
      enabled: true,
      installed: true,
      version: null,
      capabilities: {} as never,
    },
  ],
  resources: null,
  runningThreadCount: 0,
  ...overrides,
});
const hubMachine = machine(HUB_MACHINE_ENVIRONMENT_ID, { kind: "hub", ownerUserId: null });

describe("previewDefaultEnvironment", () => {
  const preview = (laptop: HubEnvironmentSummary, userId = ada) =>
    previewDefaultEnvironment({
      environments: [hubMachine, laptop],
      preferredEnvironmentId: laptop.id,
      providerInstanceId: claude,
      userId,
    });

  it("shows where the Hub will start the Thread, never an unavailable preference", () => {
    expect(preview(machine("laptop"))).toBe("laptop");
    // The Owner sees others' machines but runs nothing on them.
    expect(preview(machine("laptop"), UserId.make("grace"))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { status: "offline" }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { status: "reconnecting" }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { providers: [] }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(
      previewDefaultEnvironment({
        environments: [hubMachine],
        preferredEnvironmentId: EnvironmentId.make("hidden"),
        providerInstanceId: claude,
        userId: ada,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
  });

  it("starts in the Space's Sandbox on a Hub whose machine runs no Threads, and nowhere without one", () => {
    const sandbox = machine("sandbox:acme", {
      kind: "sandbox",
      mode: "sandbox",
      ownerUserId: null,
      status: "stopped",
      providers: [],
    });
    const offline = machine("laptop", { status: "offline" });
    const preview = (environments: ReadonlyArray<HubEnvironmentSummary>) =>
      previewDefaultEnvironment({
        environments,
        preferredEnvironmentId: offline.id,
        providerInstanceId: claude,
        userId: ada,
      });
    expect(preview([sandbox, offline])).toBe(sandbox.id);
    expect(preview([offline])).toBeNull();
    expect(preview([])).toBeNull();
    // A machine dedicated to the Space is everyone's there, like its Sandbox: it belongs to no User.
    const dedicated = machine("hub-vps", { mode: "dedicated", ownerUserId: null });
    for (const providerInstanceId of [claude, null]) {
      expect(
        previewDefaultEnvironment({
          environments: [dedicated],
          preferredEnvironmentId: dedicated.id,
          providerInstanceId,
          userId: ada,
          sandboxesUnavailable: "Sandboxes are turned off on this Hub.",
        }),
      ).toBe(dedicated.id);
    }
    // A preferred Sandbox that never ran counts: it starts for the Thread.
    expect(
      previewDefaultEnvironment({
        environments: [sandbox],
        preferredEnvironmentId: sandbox.id,
        providerInstanceId: claude,
        userId: ada,
      }),
    ).toBe(sandbox.id);
  });
});

describe("threadEnvironmentState", () => {
  const list = [hubMachine, machine("laptop"), machine("away", { status: "offline" })];
  const on = (id: string | null) =>
    activeEnvironmentOf(list, id === null ? null : EnvironmentId.make(id));

  it("says a Thread whose machine was removed needs an environment", () => {
    const removed = on(null);
    expect(threadEnvironmentState(removed, false)).toBe("needs-environment");
    expect(removed === null ? null : activeEnvironmentLabel(removed)).toBe("needs an environment");
  });

  it("pauses a turn only while its machine is not online", () => {
    expect(threadEnvironmentState(on("away"), true)).toBe("paused-offline");
    expect(threadEnvironmentState(on("away"), false)).toBeNull();
    expect(threadEnvironmentState(on("laptop"), true)).toBeNull();
    expect(threadEnvironmentState(on(HUB_MACHINE_ENVIRONMENT_ID), true)).toBeNull();
    expect(
      threadEnvironmentState(
        activeEnvironmentOf(
          [hubMachine, machine("laptop", { status: "reconnecting" })],
          EnvironmentId.make("laptop"),
        ),
        true,
      ),
    ).toBe("paused-offline");
  });
});
