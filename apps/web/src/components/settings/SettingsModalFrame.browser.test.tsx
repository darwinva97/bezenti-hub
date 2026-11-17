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
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

function Frame() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider defaultOpen>
      <AppRouteModal label="User settings">
        <SettingsSidebarNav pathname={pathname} />
        <Outlet />
      </AppRouteModal>
    </SidebarProvider>
  );
}

function SectionPage() {
  const { section } = useParams({ strict: false });
  return <p>Page {section}</p>;
}

function createFrameRouter() {
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
    path: "/user/$section",
    component: SectionPage,
  });
  return createRouter({
    routeTree: root.addChildren([opener, settings.addChildren([section])]),
    history: createMemoryHistory({ initialEntries: ["/opener"] }),
    disableGlobalCatchBoundary: true,
  });
}

it("opens a deep link, changes section in place and goes back to the opener", async () => {
  const router = createFrameRouter();
  const stopTracking = startMainAppLocationTracking(router);
  // The frame needs its own route tree, which the shared test router does not have.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await router.navigate({ to: "/settings/user/$section", params: { section: "appearance" } });
    await expect.element(page.getByText("Page appearance")).toBeVisible();
    await expect
      .element(page.getByRole("treeitem", { name: "Appearance" }))
      .toHaveAttribute("aria-current", "page");

    await page.getByRole("treeitem", { name: "Chat" }).click();
    await expect.element(page.getByText("Page chat")).toBeVisible();
    await expect
      .element(page.getByRole("treeitem", { name: "Chat" }))
      .toHaveAttribute("aria-current", "page");

    // Changing section replaced the entry, so one step back leaves Settings.
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/opener"));
  } finally {
    stopTracking();
  }
});

it("closes on Esc to the page that opened it", async () => {
  const router = createFrameRouter();
  const stopTracking = startMainAppLocationTracking(router);
  // The frame needs its own route tree, which the shared test router does not have.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await router.navigate({ to: "/settings/user/$section", params: { section: "general" } });
    await page.getByRole("treeitem", { name: "Diffs" }).click();
    await expect.element(page.getByText("Page diffs")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/opener"));
  } finally {
    stopTracking();
  }
});
