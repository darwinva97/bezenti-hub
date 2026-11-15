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
const shells = ["alpha", "beta", "gamma", "delta"].map((id) =>
  makeThreadFixture({ environmentId: hub, id: ThreadId.make(id), title: `Title ${id}` }),
);

function setup(input: { readonly stored: readonly ThreadTab[]; readonly active: string }) {
  window.localStorage.setItem(
    storageKey,
    serializeThreadTabs({ tabs: input.stored, activeKey: tabKey(thread(input.active)) }),
  );
  useThreadTabsStore.setState({ tabs: [], activeKey: null, scope: null, newTabFrom: null });
  useCurrentSpace.setState({ environmentId: hub, view });
  vi.mocked(useQuietThreadShell).mockImplementation(
    (ref) => shells.find((shell) => ref !== null && shell.id === ref.threadId) ?? null,
  );
  vi.mocked(useQuietThreadShells).mockReturnValue(shells);
  vi.mocked(useAllEnvironmentShellsBootstrapped).mockReturnValue(true);
  vi.mocked(useHiddenThreadKeys).mockReturnValue(new Set());
  vi.mocked(useProject).mockReturnValue(null);
}

// The strip follows the route, so the test brings a route that carries the Thread id.
async function renderAt(path: string) {
  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$threadId",
    component: function Harness() {
      const { threadId } = threadRoute.useParams();
      return (
        <ThreadTabStrip activeTab={thread(threadId)} activeLabel={<span>Active {threadId}</span>} />
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

  it("drops a stored tab whose Thread is gone", async () => {
    setup({ stored: [thread("alpha"), thread("vanished"), thread("beta")], active: "alpha" });
    await using app = await renderAt("/alpha");
    const { screen } = app;

    expect(screen.getByRole("tab").elements()).toHaveLength(2);
    expect(window.localStorage.getItem(storageKey)).not.toContain("vanished");
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

    await userEvent.click(screen.getByRole("button", { name: "Close Title beta" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/gamma"));
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
