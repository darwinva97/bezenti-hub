import { UserId } from "@t3tools/contracts";
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
import { AppRouteModal } from "../AppRouteModal";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { SidebarProvider } from "../ui/sidebar";
import { PlatformSettingsPage } from "./PlatformSettingsPage";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const session = vi.hoisted(() => ({ isOwner: false }));

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimaryActsForInstallation: () => session.isOwner,
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));
vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/runtime")>()),
  runPrimaryHttp: () =>
    Promise.resolve({
      users: [
        {
          id: UserId.make("user-owner"),
          displayName: "Olive Owner",
          loginName: "olive",
          isOwner: true,
          status: "active",
          installationPermissions: [],
        },
      ],
    }),
}));

function Frame() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider defaultOpen>
      <AppRouteModal label="Platform settings">
        <SettingsSidebarNav pathname={pathname} />
        <Outlet />
      </AppRouteModal>
    </SidebarProvider>
  );
}

function SectionPage() {
  const { section } = useParams({ strict: false });
  return <PlatformSettingsPage section={section ?? ""} />;
}

function createFrameRouter(initialEntry: string) {
  const root = createRootRoute({ component: Outlet });
  const opener = createRoute({
    getParentRoute: () => root,
    path: "/opener",
    component: () => <p>Opener</p>,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: Frame,
  });
  const section = createRoute({
    getParentRoute: () => settings,
    path: "/platform/$section",
    component: SectionPage,
  });
  return createRouter({
    routeTree: root.addChildren([opener, settings.addChildren([section])]),
    history: createMemoryHistory({ initialEntries: ["/opener", initialEntry] }),
    disableGlobalCatchBoundary: true,
  });
}

it("tells a Member that Platform belongs to the Owner, and shows nothing else", async () => {
  session.isOwner = false;
  const router = createFrameRouter("/settings/platform/users");
  const stopTracking = startMainAppLocationTracking(router);
  // The frame needs its own route tree, which the shared test router does not have.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect
      .element(page.getByText("Only the Owner of this Hub opens Platform."))
      .toBeVisible();
    expect(page.getByRole("treeitem").elements()).toHaveLength(0);
    expect(page.getByText("Olive Owner").elements()).toHaveLength(0);
  } finally {
    stopTracking();
  }
});

it("opens Platform for the Owner with its built sections", async () => {
  session.isOwner = true;
  const router = createFrameRouter("/settings/platform/users");
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByText("Olive Owner", { exact: false })).toBeVisible();
    for (const name of [
      "Users",
      "Audit log",
      "Master key",
      "AI gateway",
      "Sandboxes",
      "Hub machine",
      "Hub defaults",
      "Labs",
    ]) {
      await expect.element(page.getByRole("treeitem", { name })).toBeVisible();
    }
    // Sections other specs fill in stay out until they are built.
    for (const name of ["Registration", "Keycloak", "Plans", "Terms"]) {
      expect(page.getByRole("treeitem", { name }).elements()).toHaveLength(0);
    }
    await expect
      .element(page.getByRole("treeitem", { name: "Users" }))
      .toHaveAttribute("aria-current", "page");
  } finally {
    stopTracking();
  }
});
