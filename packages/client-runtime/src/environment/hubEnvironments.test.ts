import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentList,
  type HubEnvironmentStatus,
  type HubEnvironmentSummary,
  type OrchestrationV2ThreadMove,
  ProviderInstanceId,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  activeEnvironmentLabel,
  activeEnvironmentOf,
  canMoveThread,
  ENVIRONMENT_STATUS_TONES,
  environmentStatusLabel,
  environmentStatusPulses,
  environmentUnavailableReason,
  environmentUseDescription,
  environmentUseOf,
  shownEnvironmentStatus,
  makeHubEnvironmentsPoller,
  moveCandidates,
  moveProgressView,
  placeableEnvironments,
  providersOnEnvironment,
  threadEnvironmentState,
} from "./hubEnvironments.ts";

const laptopId = EnvironmentId.make("env-laptop");

const environment = (
  overrides: Partial<HubEnvironmentSummary> & Pick<HubEnvironmentSummary, "id" | "name">,
): HubEnvironmentSummary => ({
  kind: "external",
  mode: "personal",
  ownerUserId: null,
  status: "online",
  registeredAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: null,
  os: null,
  hostname: null,
  providers: [],
  resources: null,
  runningThreadCount: 0,
  ...overrides,
});

const hub = environment({ id: HUB_MACHINE_ENVIRONMENT_ID, name: "Hub machine", kind: "hub" });
const laptop = environment({ id: laptopId, name: "Laptop", status: "offline" });

// Lets settled fetches reach the poller: a few microtask turns, no clock.
const flush = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("makeHubEnvironmentsPoller", () => {
  it("reads while subscribed, notifies only on a change, and forgets on reset", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer: HubEnvironmentList = { environments: [hub] };
      const fetch = vi.fn(() => Promise.resolve(answer));
      const poller = makeHubEnvironmentsPoller({ fetch, intervalMs: 1000, idleIntervalMs: 1000 });
      const listener = vi.fn();
      const unsubscribe = poller.subscribe(listener);
      await flush();
      expect(poller.snapshot()).toEqual([hub]);
      expect(listener).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);

      answer = { environments: [hub, laptop] };
      vi.advanceTimersByTime(1000);
      await flush();
      expect(poller.snapshot()).toEqual([hub, laptop]);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(poller.sandboxesUnavailable()).toBeNull();

      // Why the Hub has no Sandboxes is part of the list: a change of it notifies too.
      answer = { environments: [hub, laptop], sandboxesUnavailable: "No Podman here." };
      vi.advanceTimersByTime(1000);
      await flush();
      expect(poller.sandboxesUnavailable()).toBe("No Podman here.");
      expect(listener).toHaveBeenCalledTimes(3);

      poller.reset();
      expect(poller.snapshot()).toEqual([]);
      expect(poller.sandboxesUnavailable()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(4);

      unsubscribe();
      vi.advanceTimersByTime(5000);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last list when a read fails and drops an answer that started before a reset", async () => {
    let resolveSlow: (list: HubEnvironmentList) => void = () => undefined;
    const fetch = vi
      .fn<() => Promise<HubEnvironmentList>>()
      .mockResolvedValueOnce({ environments: [hub] })
      .mockRejectedValueOnce(new Error("signed out"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      );
    const poller = makeHubEnvironmentsPoller({ fetch });
    const unsubscribe = poller.subscribe(() => undefined);
    await flush();
    poller.refresh();
    await flush();
    expect(poller.snapshot()).toEqual([hub]);

    poller.refresh();
    poller.reset();
    resolveSlow({ environments: [hub, laptop] });
    await flush();
    expect(poller.snapshot()).toEqual([]);
    unsubscribe();
  });

  it("keeps the answer of the latest read when an older one arrives after it", async () => {
    const resolvers: Array<(list: HubEnvironmentList) => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<HubEnvironmentList>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const poller = makeHubEnvironmentsPoller({ fetch });
    const unsubscribe = poller.subscribe(() => undefined);
    // «Try again» while the first read is still out.
    poller.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers[1]?.({ environments: [hub, laptop] });
    await flush();
    resolvers[0]?.({ environments: [hub] });
    await flush();
    expect(poller.snapshot()).toEqual([hub, laptop]);
    unsubscribe();
  });
});

describe("pausing the poll", () => {
  it("reads nothing in the background, slowly with the Hub machine alone, and reports a failed read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let fail = false;
      const fetch = vi.fn(() =>
        fail ? Promise.reject(new Error("down")) : Promise.resolve({ environments: [hub] }),
      );
      const poller = makeHubEnvironmentsPoller({ fetch, intervalMs: 1000, idleIntervalMs: 60_000 });
      expect(poller.status()).toBe("loading");
      const unsubscribe = poller.subscribe(() => undefined);
      await flush();
      expect(poller.status()).toBe("ready");
      vi.advanceTimersByTime(5000);
      expect(fetch).toHaveBeenCalledTimes(1);
      poller.setActive(false);
      vi.advanceTimersByTime(120_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      fail = true;
      poller.setActive(true);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(poller.status()).toBe("error");
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a Thread's Active environment", () => {
  it("names the machine and its live status, the Hub machine always online", () => {
    const offline = activeEnvironmentOf([hub, laptop], laptopId);
    expect(offline).toEqual({
      name: "Laptop",
      status: "offline",
      isHubMachine: false,
      needsEnvironment: false,
      isSandbox: false,
      startError: null,
    });
    expect(activeEnvironmentLabel(offline!)).toBe("Laptop, offline");
    expect(activeEnvironmentOf([hub, laptop], undefined)?.name).toBe("Hub machine");
    expect(activeEnvironmentOf([hub], laptopId)).toBeNull();
  });

  it("needs an environment once its machine was removed, and pauses a turn on one offline", () => {
    const removed = activeEnvironmentOf([hub], null);
    expect(threadEnvironmentState(removed, false)).toBe("needs-environment");
    expect(activeEnvironmentLabel(removed!)).toBe("needs an environment");
    const offline = activeEnvironmentOf([hub, laptop], laptopId);
    expect(threadEnvironmentState(offline, true)).toBe("paused-offline");
    expect(threadEnvironmentState(offline, false)).toBeNull();
    expect(threadEnvironmentState(activeEnvironmentOf([hub], undefined), true)).toBeNull();
  });
});

describe("a Thread on a Space's Sandbox", () => {
  const sandboxOf = (status: HubEnvironmentStatus, startError: string | null = null) =>
    activeEnvironmentOf(
      [
        hub,
        environment({
          id: EnvironmentId.make("sandbox:org-acme"),
          name: "Acme Sandbox",
          kind: "sandbox",
          mode: "sandbox",
          spaceId: SpaceId.make("org-acme"),
          status,
          startError,
        }),
      ],
      EnvironmentId.make("sandbox:org-acme"),
    );

  it("says it is starting, or why it failed, whether or not a turn waits; stopped says nothing", () => {
    expect(threadEnvironmentState(sandboxOf("starting"), false)).toBe("sandbox-starting");
    expect(threadEnvironmentState(sandboxOf("starting"), true)).toBe("sandbox-starting");
    const failed = sandboxOf("failed", "its server exited before connecting (exit code 137).");
    expect(threadEnvironmentState(failed, false)).toBe("sandbox-failed");
    expect(failed?.startError).toContain("exit code 137");
    expect(activeEnvironmentLabel(failed!)).toBe("Acme Sandbox, failed to start");
    // Stopped, it starts when the Thread's work needs it; a turn under way on it is paused.
    expect(threadEnvironmentState(sandboxOf("stopped"), false)).toBeNull();
    expect(threadEnvironmentState(sandboxOf("stopped"), true)).toBe("paused-offline");
  });
});

describe("a Space's Sandbox in the composer", () => {
  const acme = environment({
    id: EnvironmentId.make("sandbox:org-acme"),
    name: "Acme Sandbox",
    kind: "sandbox",
    mode: "sandbox",
    spaceId: SpaceId.make("org-acme"),
    status: "offline",
  });
  const globex = {
    ...acme,
    id: EnvironmentId.make("sandbox:org-globex"),
    spaceId: SpaceId.make("org-globex"),
  };

  it("is offered only for its Space's Threads", () => {
    expect(placeableEnvironments([hub, laptop, acme, globex], "org-acme")).toEqual([
      hub,
      laptop,
      acme,
    ]);
    expect(placeableEnvironments([hub, acme], undefined)).toEqual([hub]);
  });

  it("as a machine dedicated to a Space is, which other Spaces' Threads never get", () => {
    const vps = environment({
      id: EnvironmentId.make("env-vps"),
      name: "Acme VPS",
      mode: "dedicated",
      ownerUserId: null,
      spaceId: SpaceId.make("org-acme"),
      status: "online",
    });
    expect(placeableEnvironments([hub, laptop, vps], "org-acme")).toEqual([hub, laptop, vps]);
    expect(placeableEnvironments([hub, laptop, vps], "org-globex")).toEqual([hub, laptop]);
    expect(placeableEnvironments([hub, vps], undefined)).toEqual([hub]);
  });

  it("can be chosen while stopped, since sending starts it; once running it needs the provider", () => {
    expect(environmentUnavailableReason(acme, ProviderInstanceId.make("claudeAgent"))).toBeNull();
    expect(
      environmentUnavailableReason(
        { ...acme, status: "online" },
        ProviderInstanceId.make("claudeAgent"),
      ),
    ).toBe("Provider not available");
    // Before the composer has a provider, a running one is offered all the same.
    expect(environmentUnavailableReason({ ...acme, status: "online" }, null)).toBeNull();
    expect(environmentUnavailableReason(laptop, null)).toBe("Offline");
  });

  it("offers the Hub's providers until it has run and reported its own", () => {
    const hubProviders = [{ instanceId: "codex" }] as never;
    expect(providersOnEnvironment(hubProviders, acme)).toBe(hubProviders);
    expect(providersOnEnvironment(hubProviders, hub)).toBe(hubProviders);
    expect(providersOnEnvironment(hubProviders, null)).toBe(hubProviders);
  });
});

describe("moving a Thread", () => {
  it("offers every machine but the source; a Thread with none may go to any", () => {
    expect(moveCandidates([hub, laptop], undefined)).toEqual([laptop]);
    expect(moveCandidates([hub, laptop], laptopId)).toEqual([hub]);
    expect(moveCandidates([hub, laptop], null)).toEqual([hub, laptop]);
  });

  const move = (overrides: Partial<OrchestrationV2ThreadMove>): OrchestrationV2ThreadMove => ({
    id: "move-1",
    sourceEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
    targetEnvironmentId: laptopId,
    ifRunning: "wait",
    step: "fetching",
    status: "running",
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });

  it("shows each step's state while it runs", () => {
    const view = moveProgressView(move({}), "Hub machine", "Laptop");
    expect(view.summary).toBe("Moving to Laptop: Fetching the checkpoint");
    expect(view.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
    expect(view.failure).toBeNull();
  });

  it("says where a failed move stopped and that the Thread stays", () => {
    const view = moveProgressView(
      move({
        status: "failed",
        step: "preparing",
        failure: { step: "preparing", message: "setup script exited 1" },
        sourceOffline: true,
        continuesFrom: { kind: "uploaded", appRunOrdinal: 3 } as never,
      }),
      "Hub machine",
      "Laptop",
    );
    expect(view.summary).toBe(
      "The move stopped at «Preparing the workspace». The Thread stays on Hub machine.",
    );
    expect(view.steps[3]?.state).toBe("failed");
    expect(view.steps[1]?.label).toBe(
      "Uploading a final checkpoint (skipped: Hub machine was offline)",
    );
    expect(view.failure).toBe("setup script exited 1");
    expect(view.continuesFrom).toContain("checkpoint of turn 3");
  });

  it("says a waiting move waits on the User's answer", () => {
    expect(
      moveProgressView(
        move({ step: "waiting-for-turn", waitingOn: "user" }),
        "Hub machine",
        "Laptop",
      ).summary,
    ).toBe("Moving to Laptop: Waiting for your answer in the running turn");
  });
});

describe("canMoveThread", () => {
  it("offers the move only to a User who may continue the Thread, and only with somewhere to go", () => {
    expect(
      canMoveThread({ canContinue: true, environmentCount: 2, activeEnvironmentId: undefined }),
    ).toBe(true);
    expect(
      canMoveThread({ canContinue: false, environmentCount: 2, activeEnvironmentId: undefined }),
    ).toBe(false);
    expect(
      canMoveThread({ canContinue: true, environmentCount: 1, activeEnvironmentId: undefined }),
    ).toBe(false);
    // A Thread whose machine was removed can always go to the Hub machine.
    expect(
      canMoveThread({ canContinue: true, environmentCount: 0, activeEnvironmentId: null }),
    ).toBe(true);
    expect(
      canMoveThread({ canContinue: false, environmentCount: 0, activeEnvironmentId: null }),
    ).toBe(false);
  });
});

describe("the same names, labels and colours on every client", () => {
  const sandbox = environment({
    id: EnvironmentId.make("sandbox:acme"),
    name: "Acme Sandbox",
    kind: "sandbox",
    mode: "sandbox",
  });
  const vps = environment({
    id: EnvironmentId.make("env-vps"),
    name: "Acme VPS",
    mode: "dedicated",
  });
  const laptop = environment({ id: laptopId, name: "Laptop", ownerUserId: UserId.make("user-1") });
  const hub = environment({
    id: HUB_MACHINE_ENVIRONMENT_ID,
    name: "Hub machine",
    kind: "hub",
    status: "offline",
  });

  it("says «Running» for a Sandbox that is online and the same words otherwise", () => {
    expect(environmentStatusLabel("online", "sandbox")).toBe("Running");
    expect(environmentStatusLabel("online", "external")).toBe("Online");
    expect(environmentStatusLabel("failed", "sandbox")).toBe("Failed to start");
    expect(environmentStatusLabel("stopped", "sandbox")).toBe("Stopped");
    expect(environmentStatusLabel("starting", "sandbox")).toBe("Starting");
    expect(shownEnvironmentStatus(hub)).toBe("online");
  });

  it("gives each status one tone, and pulses only while starting", () => {
    const statuses: ReadonlyArray<HubEnvironmentStatus> = [
      "online",
      "reconnecting",
      "offline",
      "stopped",
      "starting",
      "failed",
    ];
    expect(statuses.map((status) => ENVIRONMENT_STATUS_TONES[status])).toEqual([
      "success",
      "warning",
      "muted",
      "muted",
      "warning",
      "danger",
    ]);
    expect(statuses.filter(environmentStatusPulses)).toEqual(["starting"]);
  });

  it("names how each machine is used, with its Space or owner", () => {
    expect([hub, sandbox, vps, laptop].map(environmentUseOf)).toEqual([
      "hub",
      "sandbox",
      "dedicated",
      "personal",
    ]);
    expect(environmentUseDescription(hub)).toBe("Runs the Hub");
    expect(environmentUseDescription(sandbox, { spaceName: "Acme" })).toBe("Sandbox of Acme");
    expect(environmentUseDescription(vps, { spaceName: "Acme" })).toBe("Dedicated to Acme");
    expect(environmentUseDescription(vps)).toBe("Dedicated to a Space");
    expect(environmentUseDescription(laptop, { viewerUserId: "user-1" })).toBe(
      "Your personal machine",
    );
    expect(environmentUseDescription(laptop, { viewerUserId: "owner", ownerName: "Grace" })).toBe(
      "Grace's personal machine",
    );
    expect(environmentUseDescription(laptop, { viewerUserId: "owner" })).toBe(
      "Another User's personal machine",
    );
    expect(environmentUseDescription(laptop)).toBe("Personal machine");
  });
});
