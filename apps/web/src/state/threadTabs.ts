import {
  closeTab,
  emptyThreadTabs,
  moveTab,
  openInNewTab,
  parseStoredThreadTabs,
  pruneThreadTabs,
  serializeThreadTabs,
  syncThreadTabsToRoute,
  tabKey,
  threadTabsStorageKey,
  type ThreadTab,
  type ThreadTabsState,
} from "@t3tools/client-runtime/thread-tabs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { create } from "zustand";

import { DraftId } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useCurrentSpace } from "./currentSpace";
import { useHubEnvironmentId } from "./hubEnvironment";

interface ThreadTabsStore extends ThreadTabsState {
  /** The storage key of this User's tabs on this Hub; null until both are known. */
  readonly scope: string | null;
  /**
   * Set by the new-tab button: the next route to a Thread that is not open gets its own tab instead
   * of reusing the current one. Holds the route it was set from.
   */
  readonly newTabFrom: { readonly routeKey: string | null } | null;
}

export const useThreadTabsStore = create<ThreadTabsStore>(() => ({
  ...emptyThreadTabs,
  scope: null,
  newTabFrom: null,
}));

function readStored(scope: string): ThreadTabsState {
  try {
    return parseStoredThreadTabs(window.localStorage.getItem(scope));
  } catch {
    return emptyThreadTabs;
  }
}

function persist(scope: string | null, state: ThreadTabsState) {
  if (scope === null) return;
  try {
    window.localStorage.setItem(scope, serializeThreadTabs(state));
  } catch {
    // Without storage the tabs last until reload.
  }
}

function commit(next: ThreadTabsState) {
  const current = useThreadTabsStore.getState();
  if (next.tabs === current.tabs && next.activeKey === current.activeKey) return;
  useThreadTabsStore.setState({ tabs: next.tabs, activeKey: next.activeKey });
  persist(current.scope, next);
}

/** Reads this User's tabs for the Hub; the strip shows only the route's Thread until then. */
export function selectThreadTabsScope(scope: string | null) {
  if (useThreadTabsStore.getState().scope === scope) return;
  if (scope === null) {
    useThreadTabsStore.setState({ ...emptyThreadTabs, scope: null, newTabFrom: null });
    return;
  }
  useThreadTabsStore.setState({ ...readStored(scope), scope, newTabFrom: null });
}

/** `scope` for the signed-in User on the connected Hub, null until both are loaded. */
export function useThreadTabsScope(): string | null {
  const hubEnvironmentId = useHubEnvironmentId();
  const spacesLoaded = useCurrentSpace((state) => state.environmentId !== null);
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  if (hubEnvironmentId === null || !spacesLoaded) return null;
  return threadTabsStorageKey(userId ?? "local", hubEnvironmentId);
}

export function syncThreadTabsRoute(routeTab: ThreadTab | null) {
  const current = useThreadTabsStore.getState();
  if (routeTab === null) return;
  if (current.newTabFrom !== null && current.newTabFrom.routeKey !== tabKey(routeTab)) {
    useThreadTabsStore.setState({ newTabFrom: null });
    commit(openInNewTab(current, routeTab, { activate: true }));
    return;
  }
  commit(syncThreadTabsToRoute(current, routeTab));
}

export function armNewThreadTab(router: AnyRouter) {
  const routeTab = routeThreadTab(router);
  useThreadTabsStore.setState({ newTabFrom: { routeKey: routeTab ? tabKey(routeTab) : null } });
}

/** Called once the new thread was asked for: if the route never moved, no tab is waiting. */
export function disarmNewThreadTab(router: AnyRouter) {
  const from = useThreadTabsStore.getState().newTabFrom;
  if (from === null) return;
  const routeTab = routeThreadTab(router);
  if ((routeTab ? tabKey(routeTab) : null) === from.routeKey) {
    useThreadTabsStore.setState({ newTabFrom: null });
  }
}

/** Opens `tab` as an extra tab beside the current one without leaving the open Thread. */
export function openThreadTabInBackground(tab: ThreadTab) {
  commit(openInNewTab(useThreadTabsStore.getState(), tab, { activate: false }));
}

export function moveThreadTab(key: string, toIndex: number) {
  commit(moveTab(useThreadTabsStore.getState(), key, toIndex));
}

export function pruneThreadTabsStore(isLive: (tab: ThreadTab) => boolean, keepKey: string | null) {
  commit(pruneThreadTabs(useThreadTabsStore.getState(), isLive, keepKey));
}

export const threadTabRef = (tab: Extract<ThreadTab, { kind: "thread" }>): ScopedThreadRef =>
  scopeThreadRef(EnvironmentId.make(tab.environmentId), ThreadId.make(tab.threadId));

export function routeThreadTab(router: AnyRouter): ThreadTab | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) return null;
  return target.kind === "server"
    ? {
        kind: "thread",
        environmentId: target.threadRef.environmentId,
        threadId: target.threadRef.threadId,
      }
    : { kind: "draft", draftId: target.draftId };
}

/** Moves the route to `tab`; the strip follows from the route. */
export function navigateToThreadTab(router: AnyRouter, tab: ThreadTab) {
  return tab.kind === "thread"
    ? router.navigate({ to: "/$threadId", params: { threadId: tab.threadId } })
    : router.navigate({ to: "/draft/$draftId", params: { draftId: DraftId.make(tab.draftId) } });
}

/**
 * Removes a tab from the strip and nothing else: the Thread is neither stopped nor archived. When
 * it was the open one, the route moves to the neighbour, or to the empty view after the last tab.
 */
export function closeThreadTab(router: AnyRouter, key: string) {
  const before = useThreadTabsStore.getState();
  const routeTab = routeThreadTab(router);
  const next = closeTab(before, key);
  commit(next);
  if (routeTab === null || tabKey(routeTab) !== key) return;
  const neighbour = next.tabs.find((tab) => tabKey(tab) === next.activeKey);
  if (neighbour === undefined) return router.navigate({ to: "/" });
  return navigateToThreadTab(router, neighbour);
}
