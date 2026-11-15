// Browser-like tabs over the Threads a User works on. The route stays the source of truth for
// which Thread is open; this is the list of tabs beside it. Pure, so clients share the rules.

export type ThreadTab =
  | {
      readonly kind: "thread";
      readonly environmentId: string;
      readonly threadId: string;
    }
  | { readonly kind: "draft"; readonly draftId: string };

export interface ThreadTabsState {
  readonly tabs: readonly ThreadTab[];
  /** The last active tab, which stays set while the route shows something else. */
  readonly activeKey: string | null;
}

export const emptyThreadTabs: ThreadTabsState = { tabs: [], activeKey: null };

export const tabKey = (tab: ThreadTab): string =>
  tab.kind === "thread"
    ? `t\u0000${tab.environmentId}\u0000${tab.threadId}`
    : `d\u0000${tab.draftId}`;

const indexOfKey = (state: ThreadTabsState, key: string | null) =>
  key === null ? -1 : state.tabs.findIndex((tab) => tabKey(tab) === key);

/** The tab that takes over when `index` leaves `tabs`: its right neighbour, else the left one. */
const neighbourKey = (tabs: readonly ThreadTab[], index: number): string | null => {
  const neighbour = tabs[index + 1] ?? tabs[index - 1];
  return neighbour === undefined ? null : tabKey(neighbour);
};

export function activateTab(state: ThreadTabsState, key: string): ThreadTabsState {
  if (state.activeKey === key || indexOfKey(state, key) === -1) return state;
  return { tabs: state.tabs, activeKey: key };
}

/** A Thread opened from the sidebar: its tab if open, else it takes the place of the current tab. */
export function openInCurrentTab(state: ThreadTabsState, tab: ThreadTab): ThreadTabsState {
  const key = tabKey(tab);
  if (indexOfKey(state, key) !== -1) return activateTab(state, key);
  const current = indexOfKey(state, state.activeKey);
  if (current === -1) return { tabs: [...state.tabs, tab], activeKey: key };
  return {
    tabs: state.tabs.map((entry, index) => (index === current ? tab : entry)),
    activeKey: key,
  };
}

/** A new tab right after the current one. An open Thread keeps its tab, focused only on request. */
export function openInNewTab(
  state: ThreadTabsState,
  tab: ThreadTab,
  options: { readonly activate: boolean },
): ThreadTabsState {
  const key = tabKey(tab);
  if (indexOfKey(state, key) !== -1) return options.activate ? activateTab(state, key) : state;
  const current = indexOfKey(state, state.activeKey);
  const at = current === -1 ? state.tabs.length : current + 1;
  return {
    tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)],
    activeKey: options.activate ? key : state.activeKey,
  };
}

export function closeTab(state: ThreadTabsState, key: string): ThreadTabsState {
  const index = indexOfKey(state, key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, at) => at !== index);
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  return { tabs, activeKey: neighbourKey(state.tabs, index) };
}

export function moveTab(state: ThreadTabsState, key: string, toIndex: number): ThreadTabsState {
  const from = indexOfKey(state, key);
  const to = Math.max(0, Math.min(state.tabs.length - 1, toIndex));
  if (from === -1 || from === to) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  if (moved === undefined) return state;
  tabs.splice(to, 0, moved);
  return { tabs, activeKey: state.activeKey };
}

export function tabAtIndex(state: ThreadTabsState, index: number): ThreadTab | null {
  return state.tabs[index] ?? null;
}

/** The tab a next or previous shortcut lands on, wrapping; null when it would stay where it is. */
export function adjacentTab(
  state: ThreadTabsState,
  direction: "next" | "previous",
): ThreadTab | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const current = indexOfKey(state, state.activeKey);
  if (current === -1) return state.tabs[direction === "next" ? 0 : count - 1] ?? null;
  if (count === 1) return null;
  const step = direction === "next" ? 1 : count - 1;
  return state.tabs[(current + step) % count] ?? null;
}

/**
 * Makes the route's Thread the active tab: its own if open, else the current tab is reused, which
 * also turns a promoted draft into its Thread in place. A route that is no Thread changes nothing.
 */
export function syncThreadTabsToRoute(
  state: ThreadTabsState,
  routeTab: ThreadTab | null,
): ThreadTabsState {
  if (routeTab === null || state.activeKey === tabKey(routeTab)) return state;
  return openInCurrentTab(state, routeTab);
}

/** Drops the tabs `isLive` refuses, except `keepKey`'s; a dropped active tab hands over to a neighbour. */
export function pruneThreadTabs(
  state: ThreadTabsState,
  isLive: (tab: ThreadTab) => boolean,
  keepKey: string | null = null,
): ThreadTabsState {
  const tabs = state.tabs.filter((tab) => tabKey(tab) === keepKey || isLive(tab));
  if (tabs.length === state.tabs.length) return state;
  if (indexOfKey({ tabs, activeKey: null }, state.activeKey) !== -1) {
    return { tabs, activeKey: state.activeKey };
  }
  const index = indexOfKey(state, state.activeKey);
  const survivors = new Set(tabs.map(tabKey));
  const after = state.tabs.slice(index + 1).find((tab) => survivors.has(tabKey(tab)));
  const before = state.tabs
    .slice(0, Math.max(index, 0))
    .findLast((tab) => survivors.has(tabKey(tab)));
  const next = index === -1 ? tabs[0] : (after ?? before);
  return { tabs, activeKey: next === undefined ? null : tabKey(next) };
}

export const threadTabsStorageKey = (userId: string, environmentId: string) =>
  `t3code:thread-tabs:v1:${userId}:${environmentId}`;

const STORED_VERSION = 1;
const MAX_STORED_TABS = 100;

export function serializeThreadTabs(state: ThreadTabsState): string {
  return JSON.stringify({
    version: STORED_VERSION,
    tabs: state.tabs,
    active: state.activeKey,
  });
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseStoredTab(value: unknown): ThreadTab | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "thread" && isText(entry.environmentId) && isText(entry.threadId)) {
    return { kind: "thread", environmentId: entry.environmentId, threadId: entry.threadId };
  }
  if (entry.kind === "draft" && isText(entry.draftId)) {
    return { kind: "draft", draftId: entry.draftId };
  }
  return null;
}

/** Anything unreadable, of another version, or malformed counts as no tabs; bad entries are skipped. */
export function parseStoredThreadTabs(raw: string | null): ThreadTabsState {
  if (raw === null) return emptyThreadTabs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyThreadTabs;
  }
  if (typeof parsed !== "object" || parsed === null) return emptyThreadTabs;
  const stored = parsed as Record<string, unknown>;
  if (stored.version !== STORED_VERSION || !Array.isArray(stored.tabs)) return emptyThreadTabs;
  const seen = new Set<string>();
  const tabs: ThreadTab[] = [];
  for (const value of stored.tabs.slice(0, MAX_STORED_TABS)) {
    const tab = parseStoredTab(value);
    if (tab === null || seen.has(tabKey(tab))) continue;
    seen.add(tabKey(tab));
    tabs.push(tab);
  }
  const first = tabs[0];
  if (first === undefined) return emptyThreadTabs;
  const activeKey =
    typeof stored.active === "string" && seen.has(stored.active) ? stored.active : tabKey(first);
  return { tabs, activeKey };
}
