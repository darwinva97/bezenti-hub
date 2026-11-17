import { EnvironmentId, type HubEnvironmentOverviewEntry, SpaceId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    isOwner: false,
    connection: null as null | {
      readonly environmentId: string;
      readonly httpBaseUrl: string;
      readonly bearerToken: string | null;
    },
    runPromise: vi.fn(),
    ownList: [] as ReadonlyArray<unknown>,
  },
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("./EnvironmentStatusDot", () => ({
  EnvironmentStatusDot: ({ status }: { status: string }) => <i data-status={status} />,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  hubConnectionAtom: {},
  useHubConnection: () => mocks.connection,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => mocks.connection },
}));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromise: (effect: unknown) => mocks.runPromise(effect) },
}));
vi.mock("../../state/spaces", () => ({
  useSpaceSelections: () =>
    new Map([
      [
        "hub",
        {
          view: {
            isOwner: mocks.isOwner,
            userId: "grace",
            spaces: [{ id: "space-acme", name: "Acme" }],
          },
        },
      ],
    ]),
}));
vi.mock("../../state/hubEnvironments", () => ({
  useHubEnvironments: () => mocks.ownList,
  useHubEnvironmentsStatus: () => "ready",
  refreshHubEnvironments: () => {},
}));

import { HubMachinesSection } from "./HubMachinesSection";

const acme = SpaceId.make("space-acme");

const ENVIRONMENTS: ReadonlyArray<HubEnvironmentOverviewEntry> = [
  {
    id: EnvironmentId.make("sandbox:space-acme"),
    name: "Acme Sandbox",
    kind: "sandbox",
    mode: "sandbox",
    spaceId: acme,
    spaceName: "Acme",
    ownerUserId: null,
    ownerName: null,
    status: "failed",
    startError: "Podman is not installed",
    os: null,
    lastSeenAt: null,
    runningThreadCount: 0,
  },
  {
    id: EnvironmentId.make("env-vps"),
    name: "Acme VPS",
    kind: "external",
    mode: "dedicated",
    spaceId: acme,
    spaceName: "Acme",
    ownerUserId: null,
    ownerName: null,
    status: "online",
    startError: null,
    os: "linux",
    lastSeenAt: null,
    runningThreadCount: 1,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const render = async () => {
  await act(async () => root?.render(<HubMachinesSection />));
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.runPromise.mockReset();
  mocks.runPromise.mockImplementation(() => Promise.resolve({ environments: ENVIRONMENTS }));
  mocks.connection = { environmentId: "hub", httpBaseUrl: "http://hub.test", bearerToken: "token" };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("HubMachinesSection", () => {
  it("shows the Owner every machine with its mode, Space and state, to read only", async () => {
    mocks.isOwner = true;
    await render();
    expect(mocks.runPromise).toHaveBeenCalled();
    expect(container?.querySelector('section[aria-label="Machines on this Hub"]')).not.toBeNull();
    expect(
      container?.querySelector('[aria-label="Acme Sandbox, Failed to start · Sandbox of Acme"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector(
        '[aria-label="Acme VPS, Online · Dedicated to Acme · linux · 1 running Thread"]',
      ),
    ).not.toBeNull();
    expect(container?.textContent).toContain("Podman is not installed");
    expect(container?.textContent).toContain("Dedicated machine");
    expect(container?.querySelectorAll("[data-status]")).toHaveLength(2);
    // Read-only: no action on any machine.
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });

  it("says it could not load, with «Try again», when there is no session to read with", async () => {
    mocks.isOwner = true;
    mocks.connection = { environmentId: "hub", httpBaseUrl: "http://hub.test", bearerToken: null };
    await render();
    expect(container?.textContent).toContain("Could not load this Hub's machines.");
    expect(container?.textContent).not.toContain("Loading machines…");
    expect([...(container?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Try again",
    ]);
  });

  it("shows anyone else their own and dedicated machines and how to add one, never asking the Owner-only endpoint", async () => {
    mocks.isOwner = false;
    mocks.ownList = [
      {
        id: "hub",
        name: "Hub machine",
        kind: "hub",
        mode: "personal",
        ownerUserId: null,
        status: "online",
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: null,
        os: null,
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      },
      {
        id: "env-laptop",
        name: "Grace's laptop",
        kind: "external",
        mode: "personal",
        ownerUserId: "grace",
        status: "online",
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: null,
        os: "linux",
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      },
      {
        id: "env-vps",
        name: "Acme VPS",
        kind: "external",
        mode: "dedicated",
        ownerUserId: null,
        spaceId: "space-acme",
        status: "online",
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: null,
        os: "linux",
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      },
    ];
    await render();
    expect(mocks.runPromise).not.toHaveBeenCalled();
    expect(container?.querySelector('section[aria-label="Your machines"]')).not.toBeNull();
    expect(container?.textContent).toContain("Grace's laptop");
    expect(container?.textContent).toContain("Acme VPS");
    expect(container?.textContent).not.toContain("Hub machine");
    expect(
      container?.querySelector('[aria-label="Acme VPS, Online · Dedicated to Acme · linux"]'),
    ).not.toBeNull();
    expect(container?.textContent).toContain("Add a machine");
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });
});
