import {
  EnvironmentId,
  SpaceId,
  UserId,
  type HubEnvironmentSummary,
  type SpaceSummary,
} from "@t3tools/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCurrentSpace } from "../../state/currentSpace";
import { AppRouteModal } from "../AppRouteModal";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SpaceSettingsPage } from "./SpaceSettingsPage";

const ME = UserId.make("user-me");
const ACME = SpaceId.make("space-acme");
const BETA = SpaceId.make("space-beta");

const hub = vi.hoisted(() => ({ list: [] as unknown[], fetches: 0, isOwner: true }));

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimaryActsForInstallation: () => hub.isOwner,
  usePrimarySessionState: () => ({
    data: { authenticated: true, isOwner: hub.isOwner, userId: "user-me" },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../environments/primary/hubEnvironments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/hubEnvironments")>()),
  fetchHubEnvironments: () => {
    hub.fetches += 1;
    return Promise.resolve({ environments: hub.list });
  },
}));
vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

const machine = (
  id: string,
  name: string,
  shape: Partial<HubEnvironmentSummary>,
): HubEnvironmentSummary =>
  ({
    id: EnvironmentId.make(id),
    name,
    kind: "external",
    mode: "personal",
    ownerUserId: ME,
    status: "online",
    registeredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    os: null,
    hostname: null,
    providers: [],
    resources: null,
    runningThreadCount: 0,
    ...shape,
  }) as HubEnvironmentSummary;

const space = (id: SpaceId, shape: Partial<SpaceSummary>): SpaceSummary => ({
  id,
  kind: "organization",
  name: "Acme",
  role: "admin",
  isOwn: false,
  canCreateThreads: true,
  canInvite: true,
  ...shape,
});

function showSpaces(spaces: ReadonlyArray<SpaceSummary>, current: SpaceId): Disposable {
  useCurrentSpace.setState({
    view: {
      userId: ME,
      spaces,
      personalSpaceId: SpaceId.make("space-personal"),
      canCreateOrganization: false,
      isOwner: false,
    },
    currentSpaceId: current,
  });
  return {
    [Symbol.dispose]: () => useCurrentSpace.setState({ view: null, currentSpaceId: null }),
  };
}

function Frame() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider defaultOpen>
      <AppRouteModal label="Space settings">
        <SettingsSidebarNav pathname={pathname} />
        <Outlet />
      </AppRouteModal>
    </SidebarProvider>
  );
}

function SectionPage() {
  const { spaceId, section } = useParams({ strict: false });
  return <SpaceSettingsPage spaceId={spaceId ?? ""} section={section ?? ""} />;
}

function createFrameRouter(initialEntry: string) {
  const root = createRootRoute({ component: Outlet });
  const opener = createRoute({
    getParentRoute: () => root,
    path: "/opener",
    component: () => <p>Opener</p>,
  });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: Frame });
  const section = createRoute({
    getParentRoute: () => settings,
    path: "/space/$spaceId/$section",
    component: SectionPage,
  });
  return createRouter({
    routeTree: root.addChildren([opener, settings.addChildren([section])]),
    history: createMemoryHistory({ initialEntries: ["/opener", initialEntry] }),
    disableGlobalCatchBoundary: true,
  });
}

function resetHub(isOwner = true) {
  hub.fetches = 0;
  hub.isOwner = isOwner;
  hub.list = [
    machine("env-laptop", "My laptop", {}),
    machine("env-acme", "Acme build box", {
      mode: "dedicated",
      ownerUserId: null,
      spaceId: ACME,
    }),
    machine("env-beta", "Beta build box", {
      mode: "dedicated",
      ownerUserId: null,
      spaceId: BETA,
    }),
    machine("env-acme-sandbox", "Acme Sandbox", {
      kind: "sandbox",
      mode: "dedicated",
      ownerUserId: null,
      spaceId: ACME,
    }),
  ];
}

it("lists an Organization's own machines and its Sandbox in Space settings, each machine linked to its page", async () => {
  resetHub();
  using _spaces = showSpaces([space(ACME, {})], ACME);
  const router = createFrameRouter(`/settings/space/${ACME}/machines`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByRole("heading", { name: /^Acme build box/ })).toBeVisible();
    // The Sandbox of the Space has its own row; the machine rows are the dedicated ones only.
    await expect.element(page.getByRole("heading", { name: /^Acme Sandbox/ })).toBeVisible();
    expect(page.getByRole("heading", { name: /^My laptop/ }).elements()).toHaveLength(0);
    expect(page.getByRole("heading", { name: /^Beta build box/ }).elements()).toHaveLength(0);
    await expect
      .element(page.getByRole("link", { name: "Open Acme build box" }))
      .toHaveAttribute("href", `/settings/space/${ACME}/machines/env-acme/providers`);
    // The full list of Sandboxes stays in Platform.
    await expect.element(page.getByRole("link", { name: /Platform → Sandboxes/ })).toBeVisible();
    await expect.element(page.getByRole("treeitem", { name: "Vault" })).toBeVisible();
    await expect.element(page.getByRole("treeitem", { name: "AI accounts" })).toBeVisible();
  } finally {
    stopTracking();
  }
});

it("gives a Member of the Organization the list without a page to open", async () => {
  resetHub(false);
  using _spaces = showSpaces([space(ACME, { role: "member", canInvite: false })], ACME);
  const router = createFrameRouter(`/settings/space/${ACME}/machines`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByRole("heading", { name: /^Acme build box/ })).toBeVisible();
    expect(page.getByRole("link", { name: /^Open / }).elements()).toHaveLength(0);
    expect(page.getByRole("link", { name: /Platform → Sandboxes/ }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: /^Rename/ }).elements()).toHaveLength(0);
  } finally {
    stopTracking();
  }
});

it("sends a Personal space's resources to User settings, and tells the Owner they are read only", async () => {
  const personal = space(SpaceId.make("space-personal"), {
    kind: "personal",
    name: "Mia",
    role: null,
    isOwn: true,
    canInvite: false,
  });
  const others = space(SpaceId.make("space-other"), {
    kind: "personal",
    name: "Otto",
    role: null,
    isOwn: false,
    canInvite: false,
  });
  resetHub();
  using _spaces = showSpaces([personal, others], personal.id);
  const router = createFrameRouter(`/settings/space/${personal.id}/vault`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByText("Your Vault are yours")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Manage in User settings" }))
      .toHaveAttribute("href", "/settings/user/vault");
    await router.navigate({ href: `/settings/space/${others.id}/machines` });
    await expect.element(page.getByText("Read only")).toBeVisible();
    expect(page.getByRole("link", { name: "Manage in User settings" }).elements()).toHaveLength(0);
    // No machine is listed, and nothing was asked of the Hub for them.
    expect(hub.fetches).toBe(0);
  } finally {
    stopTracking();
  }
});

/** Records the intervals the page sets, and gives the spies back on dispose. */
function watchIntervals() {
  const set = vi.spyOn(window, "setInterval");
  const cleared = vi.spyOn(window, "clearInterval");
  return {
    set,
    cleared,
    [Symbol.dispose]: () => {
      set.mockRestore();
      cleared.mockRestore();
    },
  };
}

it("refreshes the machines only while their section is open", async () => {
  resetHub();
  using _spaces = showSpaces([space(ACME, {})], ACME);
  using intervals = watchIntervals();
  const router = createFrameRouter(`/settings/space/${ACME}/machines`);
  const stopTracking = startMainAppLocationTracking(router);
  const screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByRole("heading", { name: /^Acme build box/ })).toBeVisible();
    // One refresh every 5 seconds, set when the section opens...
    const refreshes = intervals.set.mock.calls
      .map((call, index) => ({ delay: call[1], id: intervals.set.mock.results[index]?.value }))
      .filter((interval) => interval.delay === 5_000);
    expect(refreshes).toHaveLength(1);
    expect(intervals.cleared).not.toHaveBeenCalledWith(refreshes[0]?.id);
    // ...and cleared when it closes.
    await screen.unmount();
    expect(intervals.cleared).toHaveBeenCalledWith(refreshes[0]?.id);
  } finally {
    stopTracking();
  }
});
