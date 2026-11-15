import { EnvironmentId, ThreadId, UserId, type SpaceDirectoryView } from "@t3tools/contracts";
import {
  serializeThreadTabs,
  tabKey,
  threadTabsStorageKey,
  type ThreadTab,
} from "@t3tools/client-runtime/thread-tabs";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCurrentSpace } from "../../state/currentSpace";
import {
  useAllEnvironmentShellsBootstrapped,
  useHiddenThreadKeys,
  useProject,
  useQuietThreadShell,
  useQuietThreadShells,
} from "../../state/entities";
import { useThreadTabsStore } from "../../state/threadTabs";
import { makeThreadFixture } from "../../test-fixtures";
import { ThreadTabStrip } from "./ThreadTabStrip";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../state/hubEnvironment", () => ({
  useHubEnvironmentId: () => "hub",
  readHubEnvironmentId: () => "hub",
}));

const hub = EnvironmentId.make("hub");
const userId = UserId.make("grace");
const storageKey = threadTabsStorageKey(userId, hub);
const view = { userId, spaces: [] } as unknown as SpaceDirectoryView;

const thread = (id: string): ThreadTab => ({ kind: "thread", environmentId: hub, threadId: id });
const shells = [
  ...["alpha", "beta", "gamma", "delta"].map((id) =>
    makeThreadFixture({ environmentId: hub, id: ThreadId.make(id), title: `Title ${id}` }),
  ),
  makeThreadFixture({
    environmentId: hub,
    id: ThreadId.make("archived"),
    title: "Title archived",
    archivedAt: "2026-01-01T00:00:00.000Z",
  }),
];
// Threads the client lists know of; "older" is stored in a tab but missing from the lists.
const listed = shells.filter((shell) => shell.id !== "older");

function setup(input: { readonly stored: readonly ThreadTab[]; readonly active: string }) {
  window.localStorage.setItem(
    storageKey,
    serializeThreadTabs({ tabs: input.stored, activeKey: tabKey(thread(input.active)) }),
  );
  useThreadTabsStore.setState({ tabs: [], activeKey: null, scope: null, newTabFrom: null });
  useCurrentSpace.setState({ environmentId: hub, view, loadFailed: false });
  vi.mocked(useQuietThreadShell).mockImplementation(
    (ref) => shells.find((shell) => ref !== null && shell.id === ref.threadId) ?? null,
  );
  vi.mocked(useQuietThreadShells).mockReturnValue(listed);
  vi.mocked(useAllEnvironmentShellsBootstrapped).mockReturnValue(true);
  vi.mocked(useHiddenThreadKeys).mockReturnValue(new Set());
  vi.mocked(useProject).mockReturnValue(null);
}

// The strip follows the route, so the test brings a route that carries the Thread id.
async function renderAt(path: string, options: { onContextMenu?: () => void } = {}) {
  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$threadId",
    component: function Harness() {
      const { threadId } = threadRoute.useParams();
      return (
        <div onContextMenu={options.onContextMenu}>
          <ThreadTabStrip
            activeTab={thread(threadId)}
            activeLabel={<span>Active {threadId}</span>}
            activeProjectName="Acme"
          />
        </div>
      );
    },
  });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute, homeRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
  // The test owns the router so the route can carry the Thread id.
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return { screen, router, [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose]() };
}

describe("ThreadTabStrip", () => {
  it("restores the stored tabs with the route's Thread selected", async () => {
    setup({ stored: [thread("alpha"), thread("beta"), thread("gamma")], active: "beta" });
    await using app = await renderAt("/beta");
    const { screen } = app;

    await expect.element(screen.getByRole("tablist", { name: "Open threads" })).toBeVisible();
    expect(screen.getByRole("tab").elements()).toHaveLength(3);
    await expect
      .element(screen.getByRole("tab", { name: "Title alpha" }))
      .toHaveAttribute("aria-selected", "false");
    const selected = screen.getByRole("tab", { selected: true });
    await expect.element(selected).toHaveTextContent("Active beta");
    expect(screen.getByRole("tab", { selected: true }).elements()).toHaveLength(1);
  });

  it("opens a Thread that is not in a tab in the current tab", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "alpha" });
    await using app = await renderAt("/delta");
    const { screen } = app;

    expect(useThreadTabsStore.getState().tabs.map(tabKey)).toEqual([
      tabKey(thread("delta")),
      tabKey(thread("beta")),
    ]);
    await expect
      .element(screen.getByRole("tab", { selected: true }))
      .toHaveTextContent("Active delta");
  });

  it("keeps a tab whose Thread is only missing from the lists, with its last title", async () => {
    const older: ThreadTab = { ...thread("older"), title: "Older settled work" };
    setup({ stored: [thread("alpha"), older, thread("beta")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen } = app;

    expect(screen.getByRole("tab").elements()).toHaveLength(3);
    await expect.element(screen.getByRole("tab", { name: "Older settled work" })).toBeVisible();
    expect(window.localStorage.getItem(storageKey)).toContain("older");
  });

  it("drops a tab whose Thread is archived", async () => {
    setup({ stored: [thread("alpha"), thread("archived"), thread("beta")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen } = app;

    expect(screen.getByRole("tab").elements()).toHaveLength(2);
    expect(window.localStorage.getItem(storageKey)).not.toContain("archived");
  });

  it("reads no stored tabs while the Space directory failed to load", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "alpha" });
    useCurrentSpace.setState({ view: null, loadFailed: true });
    await using app = await renderAt("/gamma");
    const { screen } = app;

    expect(screen.getByRole("tab").elements()).toHaveLength(1);
    expect(window.localStorage.getItem(storageKey)).toContain("beta");
    expect(window.localStorage.getItem(storageKey)).not.toContain("gamma");
  });

  it("leaves the open Thread's menu out of another tab's right-click", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "alpha" });
    const headerMenu = vi.fn();
    await using app = await renderAt("/alpha", { onContextMenu: headerMenu });
    const { screen } = app;

    await screen.getByRole("tab", { name: "Title beta" }).click({ button: "right" });
    expect(headerMenu).not.toHaveBeenCalled();
    await screen.getByRole("tab", { selected: true }).click({ button: "right" });
    expect(headerMenu).toHaveBeenCalledOnce();
  });

  it("names the Project on the new-thread button", async () => {
    setup({ stored: [thread("alpha")], active: "alpha" });
    await using app = await renderAt("/alpha");

    await expect
      .element(app.screen.getByRole("button", { name: "New thread in Acme" }))
      .toBeVisible();
  });

  it("goes to a tab on click", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen, router } = app;

    await userEvent.click(screen.getByRole("tab", { name: "Title beta" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/beta"));
  });

  it("closes a tab without touching the Thread and moves to its right neighbour", async () => {
    setup({ stored: [thread("alpha"), thread("beta"), thread("gamma")], active: "beta" });
    await using app = await renderAt("/beta");
    const { screen, router } = app;

    const navigate = vi.spyOn(router, "navigate");
    await userEvent.click(screen.getByRole("button", { name: "Close Title beta" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/gamma"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    expect(useThreadTabsStore.getState().tabs.map(tabKey)).toEqual([
      tabKey(thread("alpha")),
      tabKey(thread("gamma")),
    ]);
  });

  it("closes a background tab without leaving the open Thread", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen, router } = app;

    await userEvent.click(screen.getByRole("button", { name: "Close Title beta" }));
    expect(useThreadTabsStore.getState().tabs.map(tabKey)).toEqual([tabKey(thread("alpha"))]);
    expect(router.state.location.pathname).toBe("/alpha");
  });

  it("moves focus with the arrow keys and closes with Delete", async () => {
    setup({ stored: [thread("alpha"), thread("beta"), thread("gamma")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen, router } = app;

    screen.getByRole("tab", { selected: true }).element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByRole("tab", { name: "Title beta" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect.element(screen.getByRole("tab", { selected: true })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/beta"));
    await userEvent.keyboard("{Delete}");
    expect(useThreadTabsStore.getState().tabs.map(tabKey)).toEqual([
      tabKey(thread("alpha")),
      tabKey(thread("gamma")),
    ]);
  });

  it("keeps one roving tab stop", async () => {
    setup({ stored: [thread("alpha"), thread("beta")], active: "beta" });
    await using app = await renderAt("/beta");
    const { screen } = app;

    await expect
      .element(screen.getByRole("tab", { selected: true }))
      .toHaveAttribute("tabindex", "0");
    await expect
      .element(screen.getByRole("tab", { name: "Title alpha" }))
      .toHaveAttribute("tabindex", "-1");
  });
});
