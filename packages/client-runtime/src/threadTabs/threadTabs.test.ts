import { describe, expect, it } from "vite-plus/test";

import {
  activateTab,
  adjacentTab,
  closeTab,
  emptyThreadTabs,
  moveTab,
  openInCurrentTab,
  openInNewTab,
  parseStoredThreadTabs,
  pruneThreadTabs,
  serializeThreadTabs,
  syncThreadTabsToRoute,
  tabAtIndex,
  tabKey,
  threadTabsStorageKey,
  type ThreadTab,
  type ThreadTabsState,
} from "./threadTabs.ts";

const thread = (id: string, environmentId = "env"): ThreadTab => ({
  kind: "thread",
  environmentId,
  threadId: id,
});
const draft = (draftId: string): ThreadTab => ({ kind: "draft", draftId });
const stateOf = (tabs: ThreadTab[], active: ThreadTab | null): ThreadTabsState => ({
  tabs,
  activeKey: active === null ? null : tabKey(active),
});
const names = (state: ThreadTabsState) => state.tabs.map(tabKey);
const [a, b, c, d] = [thread("a"), thread("b"), thread("c"), thread("d")] as [
  ThreadTab,
  ThreadTab,
  ThreadTab,
  ThreadTab,
];

describe("opening", () => {
  it("opens the first Thread as the only tab", () => {
    const next = openInCurrentTab(emptyThreadTabs, a);
    expect(names(next)).toEqual([tabKey(a)]);
    expect(next.activeKey).toBe(tabKey(a));
  });

  it("reuses the current tab for a Thread that is not open", () => {
    const next = openInCurrentTab(stateOf([a, b, c], b), d);
    expect(names(next)).toEqual([tabKey(a), tabKey(d), tabKey(c)]);
    expect(next.activeKey).toBe(tabKey(d));
  });

  it("focuses the tab of a Thread that is already open", () => {
    const state = stateOf([a, b, c], a);
    const next = openInCurrentTab(state, c);
    expect(names(next)).toEqual(names(state));
    expect(next.activeKey).toBe(tabKey(c));
  });

  it("opens a new tab after the current one and focuses it", () => {
    const next = openInNewTab(stateOf([a, b, c], a), d, { activate: true });
    expect(names(next)).toEqual([tabKey(a), tabKey(d), tabKey(b), tabKey(c)]);
    expect(next.activeKey).toBe(tabKey(d));
  });

  it("focuses an open Thread when a new tab is asked for in the foreground", () => {
    const next = openInNewTab(stateOf([a, b], a), b, { activate: true });
    expect(names(next)).toEqual([tabKey(a), tabKey(b)]);
    expect(next.activeKey).toBe(tabKey(b));
  });

  it("opens a background tab without changing the active one", () => {
    const next = openInNewTab(stateOf([a, b], a), c, { activate: false });
    expect(names(next)).toEqual([tabKey(a), tabKey(c), tabKey(b)]);
    expect(next.activeKey).toBe(tabKey(a));
  });

  it("leaves an open Thread alone when opened in the background", () => {
    const state = stateOf([a, b], a);
    expect(openInNewTab(state, b, { activate: false })).toBe(state);
  });

  it("appends when there is no current tab", () => {
    const next = openInNewTab(stateOf([a, b], null), c, { activate: false });
    expect(names(next)).toEqual([tabKey(a), tabKey(b), tabKey(c)]);
  });
});

describe("closing", () => {
  it("activates the right neighbour of the closed active tab", () => {
    const next = closeTab(stateOf([a, b, c], b), tabKey(b));
    expect(names(next)).toEqual([tabKey(a), tabKey(c)]);
    expect(next.activeKey).toBe(tabKey(c));
  });

  it("falls back to the left neighbour at the end", () => {
    const next = closeTab(stateOf([a, b, c], c), tabKey(c));
    expect(next.activeKey).toBe(tabKey(b));
  });

  it("keeps the active tab when another one closes", () => {
    const next = closeTab(stateOf([a, b, c], a), tabKey(c));
    expect(next.activeKey).toBe(tabKey(a));
  });

  it("leaves nothing active after the last tab", () => {
    const next = closeTab(stateOf([a], a), tabKey(a));
    expect(next).toEqual(emptyThreadTabs);
  });

  it("ignores a tab that is not open", () => {
    const state = stateOf([a], a);
    expect(closeTab(state, tabKey(b))).toBe(state);
  });
});

describe("moving around", () => {
  it("jumps to the nth tab and ignores a missing one", () => {
    const state = stateOf([a, b, c], a);
    expect(tabAtIndex(state, 2)).toEqual(c);
    expect(tabAtIndex(state, 3)).toBeNull();
  });

  it("steps to the next and previous tab, wrapping", () => {
    const state = stateOf([a, b, c], c);
    expect(adjacentTab(state, "next")).toEqual(a);
    expect(adjacentTab(state, "previous")).toEqual(b);
    expect(adjacentTab(stateOf([a], a), "next")).toBeNull();
    expect(adjacentTab(stateOf([a, b], null), "next")).toEqual(a);
  });

  it("activates only a tab that is open", () => {
    const state = stateOf([a, b], a);
    expect(activateTab(state, tabKey(b)).activeKey).toBe(tabKey(b));
    expect(activateTab(state, tabKey(c))).toBe(state);
  });

  it("reorders by dragging a tab to another index", () => {
    const next = moveTab(stateOf([a, b, c, d], b), tabKey(a), 2);
    expect(names(next)).toEqual([tabKey(b), tabKey(c), tabKey(a), tabKey(d)]);
    expect(next.activeKey).toBe(tabKey(b));
    expect(moveTab(next, tabKey(a), 2)).toBe(next);
  });
});

describe("following the route", () => {
  it("replaces the current tab when the route opens an unknown Thread", () => {
    const next = syncThreadTabsToRoute(stateOf([a, b], a), c);
    expect(names(next)).toEqual([tabKey(c), tabKey(b)]);
  });

  it("turns a promoted draft into its Thread in place", () => {
    const next = syncThreadTabsToRoute(stateOf([a, draft("x"), b], draft("x")), c);
    expect(names(next)).toEqual([tabKey(a), tabKey(c), tabKey(b)]);
    expect(next.activeKey).toBe(tabKey(c));
  });

  it("focuses an open tab the route points at", () => {
    const next = syncThreadTabsToRoute(stateOf([a, b], a), b);
    expect(next.activeKey).toBe(tabKey(b));
  });

  it("keeps the state for a route that is no Thread", () => {
    const state = stateOf([a], a);
    expect(syncThreadTabsToRoute(state, null)).toBe(state);
  });

  it("returns the same state when the route already is the active tab", () => {
    const state = stateOf([a, b], b);
    expect(syncThreadTabsToRoute(state, b)).toBe(state);
  });
});

describe("pruning", () => {
  it("drops tabs whose Thread is gone and picks a neighbour for the active one", () => {
    const live = new Set([tabKey(a), tabKey(c)]);
    const next = pruneThreadTabs(stateOf([a, b, c], b), (tab) => live.has(tabKey(tab)));
    expect(names(next)).toEqual([tabKey(a), tabKey(c)]);
    expect(next.activeKey).toBe(tabKey(c));
  });

  it("returns the same state when everything is live", () => {
    const state = stateOf([a, b], a);
    expect(pruneThreadTabs(state, () => true)).toBe(state);
  });

  it("never drops the tab named to keep", () => {
    const next = pruneThreadTabs(stateOf([a, b], a), () => false, tabKey(b));
    expect(names(next)).toEqual([tabKey(b)]);
    expect(next.activeKey).toBe(tabKey(b));
  });
});

describe("persistence", () => {
  it("scopes the key by User and environment", () => {
    expect(threadTabsStorageKey("u1", "env")).toBe("t3code:thread-tabs:v1:u1:env");
  });

  it("round-trips the tabs and the active one", () => {
    const state = stateOf([a, draft("x"), thread("z", "other")], draft("x"));
    expect(parseStoredThreadTabs(serializeThreadTabs(state))).toEqual(state);
  });

  it.each([
    null,
    "",
    "not json",
    "{}",
    '{"version":2,"tabs":[]}',
    '{"version":1,"tabs":"x"}',
    "[1,2]",
  ])("reads %j as no tabs", (raw) => {
    expect(parseStoredThreadTabs(raw)).toEqual(emptyThreadTabs);
  });

  it("skips malformed and duplicate entries and repairs a dangling active key", () => {
    const raw = JSON.stringify({
      version: 1,
      tabs: [
        { kind: "thread", environmentId: "env", threadId: "a" },
        { kind: "thread", environmentId: "env" },
        { kind: "draft", draftId: 7 },
        { kind: "thread", environmentId: "env", threadId: "a" },
        { kind: "other" },
        null,
        { kind: "draft", draftId: "x" },
      ],
      active: "missing",
    });
    const state = parseStoredThreadTabs(raw);
    expect(names(state)).toEqual([tabKey(a), tabKey(draft("x"))]);
    expect(state.activeKey).toBe(tabKey(a));
  });
});
