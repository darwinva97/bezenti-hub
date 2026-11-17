import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { LegacyMachineRedirect } from "./LegacyMachineRedirect";
import { MachineSettings } from "./MachineSettings";

const session = vi.hoisted(() => ({ isOwner: true }));

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  usePrimaryActsForInstallation: () => session.isOwner,
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "hub",
  useEnvironments: () => ({
    environments: [{ environmentId: "hub" }, { environmentId: "laptop" }],
  }),
}));
vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: ["hub"], members: [] },
    environment: { environmentId: "hub", label: "Hub" },
  }),
}));
// The panels are other tests' business; here only which one a machine page shows matters.
vi.mock("./ProviderSettingsPanel", () => ({ ProviderSettingsPanel: () => <p>Providers panel</p> }));
vi.mock("./SourceControlSettings", () => ({
  SourceControlSettingsPanel: () => <p>Source control panel</p>,
}));
vi.mock("./IntegrationsSettings", () => ({ DevicesSettingsPanel: () => <p>Devices panel</p> }));
vi.mock("./SettingsPanels", () => ({ MaintenanceSettingsPanel: () => <p>Maintenance panel</p> }));
vi.mock("./DiagnosticsSettings", () => ({
  DiagnosticsSettingsPanel: () => <p>Diagnostics panel</p>,
}));
vi.mock("./MachineNetworkSection", () => ({ MachineNetworkSection: () => <p>Network panel</p> }));

function createMachineRouter() {
  const root = createRootRoute({ component: Outlet });
  const route = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => root, path, component });
  const hubMachine = (path: string) =>
    route(path, () => <MachineSettings base={{ kind: "hub" }} />);
  const legacy = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: (raw: Record<string, unknown>) =>
        typeof raw.machine === "string" ? { machine: raw.machine } : {},
      component: () => <LegacyMachineRedirect path={`/${path}`} />,
    });
  return createRouter({
    routeTree: root.addChildren([
      route("/opener", () => <p>Opener</p>),
      hubMachine("/settings/platform/hub-machine/$machineSection"),
      hubMachine("/settings/platform/hub-machine/maintenance/diagnostics"),
      route("/settings/user/machines/$environmentId/$machineSection", () => (
        <MachineSettings base={{ kind: "user", environmentId: "laptop" }} />
      )),
      legacy("settings/providers"),
      legacy("settings/diagnostics"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/opener"] }),
    disableGlobalCatchBoundary: true,
  });
}

async function open(initialEntry: string) {
  const router = createMachineRouter();
  const stopTracking = startMainAppLocationTracking(router);
  const screen = await render(<RouterProvider router={router} />, { router: false });
  // Settings opens from a page, which is where leaving it leads back to.
  await router.navigate({ href: initialEntry });
  return {
    router,
    [Symbol.asyncDispose]: async () => {
      stopTracking();
      await screen[Symbol.asyncDispose]();
    },
  };
}

it("shows the Owner the sections of the machine, with no machine selector", async () => {
  session.isOwner = true;
  await using screen = await open("/settings/platform/hub-machine/providers");
  await expect.element(page.getByText("Providers panel")).toBeVisible();
  for (const name of ["Providers", "Source control", "Devices", "Maintenance"]) {
    await expect.element(page.getByRole("button", { name })).toBeVisible();
  }
  // Network is how this computer's own backend is reached, and only the desktop app has it.
  expect(page.getByRole("button", { name: "Network" }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: /Environment scope/ }).elements()).toHaveLength(0);

  await page.getByRole("button", { name: "Devices" }).click();
  await expect.element(page.getByText("Devices panel")).toBeVisible();
  expect(screen.router.state.location.pathname).toBe("/settings/platform/hub-machine/devices");
});

it("opens Diagnostics as a subpage of Maintenance", async () => {
  session.isOwner = true;
  await using _screen = await open("/settings/platform/hub-machine/maintenance/diagnostics");
  await expect.element(page.getByText("Diagnostics panel")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Maintenance" }))
    .toHaveAttribute("aria-current", "page");
});

it("shows a Member none of the sections", async () => {
  session.isOwner = false;
  await using _screen = await open("/settings/platform/hub-machine/providers");
  await expect
    .element(page.getByText("Only the Owner of this Hub opens the settings of its machines."))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Providers" }).elements()).toHaveLength(0);
});

it("leads the old Providers page to the machine the query names, else to the Hub machine", async () => {
  session.isOwner = true;
  {
    await using screen = await open("/settings/providers?machine=laptop");
    await vi.waitFor(() =>
      expect(screen.router.state.location.pathname).toBe(
        "/settings/user/machines/laptop/providers",
      ),
    );
  }
  {
    await using screen = await open("/settings/providers");
    await vi.waitFor(() =>
      expect(screen.router.state.location.pathname).toBe(
        "/settings/platform/hub-machine/providers",
      ),
    );
  }
  {
    // A machine this app does not know cannot be opened: the Hub machine takes its place.
    await using screen = await open("/settings/providers?machine=unknown");
    await vi.waitFor(() =>
      expect(screen.router.state.location.pathname).toBe(
        "/settings/platform/hub-machine/providers",
      ),
    );
  }
  {
    await using screen = await open("/settings/diagnostics");
    await vi.waitFor(() =>
      expect(screen.router.state.location.pathname).toBe(
        "/settings/platform/hub-machine/maintenance/diagnostics",
      ),
    );
  }
});

it("sends anyone but the Owner back to where Settings was opened", async () => {
  session.isOwner = false;
  await using screen = await open("/settings/providers");
  await vi.waitFor(() => expect(screen.router.state.location.pathname).toBe("/opener"));
});
