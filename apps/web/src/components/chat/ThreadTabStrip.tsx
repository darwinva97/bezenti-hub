import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { tabKey, type ThreadTab } from "@t3tools/client-runtime/thread-tabs";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { startNewThreadInNewTab } from "../../lib/startNewThreadInNewTab";
import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useHiddenThreadKeys,
  useProject,
  useQuietThreadShell,
  useQuietThreadShells,
} from "../../state/entities";
import {
  closeThreadTab,
  moveThreadTab,
  navigateToThreadTab,
  pruneThreadTabsStore,
  selectThreadTabsScope,
  syncThreadTabsRoute,
  threadTabRef,
  useThreadTabsScope,
  useThreadTabsStore,
} from "../../state/threadTabs";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

interface TabHandlers {
  readonly onActivate: (tab: ThreadTab) => void;
  readonly onClose: (key: string) => void;
}

const ThreadTabItem = memo(function ThreadTabItem(
  props: TabHandlers & {
    tab: ThreadTab;
    selected: boolean;
    tabbable: boolean;
    alone: boolean;
    /** The open Thread's own title controls, which replace the plain title on its tab. */
    label: ReactNode;
  },
) {
  const { tab, selected, alone, onActivate, onClose } = props;
  const key = tabKey(tab);
  const threadRef = tab.kind === "thread" ? threadTabRef(tab) : null;
  const shell = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    tab.kind === "draft" ? store.getDraftSession(DraftId.make(tab.draftId)) : null,
  );
  const project = useProject(
    shell
      ? scopeProjectRef(shell.environmentId, shell.projectId)
      : draft
        ? scopeProjectRef(draft.environmentId, draft.projectId)
        : null,
  );
  const localLastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  const status = shell
    ? resolveThreadStatusPill({
        thread: {
          ...shell,
          lastVisitedAt: resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt),
        },
      })
    : null;
  const title = shell?.title ?? (tab.kind === "draft" ? "New thread" : "Thread");
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: key });

  return (
    <div
      ref={setNodeRef}
      role="tab"
      aria-selected={selected}
      aria-label={status ? `${title}, ${status.label}` : title}
      tabIndex={props.tabbable ? 0 : -1}
      data-thread-tab={key}
      data-active-tab={selected}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/tab flex h-7 min-w-28 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
        selected && !alone && "bg-accent text-foreground",
        selected && alone && "text-foreground",
        !selected && "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "relative z-10",
      )}
      onClick={() => onActivate(tab)}
      onAuxClick={(event: ReactMouseEvent) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose(key);
      }}
      onMouseDown={(event: ReactMouseEvent) => {
        if (event.button === 1) event.preventDefault();
      }}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(tab);
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onClose(key);
        }
      }}
      {...listeners}
    >
      <PanelTabCloseButton label={`Close ${title}`} onClick={() => onClose(key)}>
        {project ? (
          <ProjectFavicon project={project} className="size-3.5" />
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
        )}
      </PanelTabCloseButton>
      {status ? (
        <span
          role="img"
          aria-label={status.label}
          data-thread-tab-status={status.label}
          className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
        />
      ) : null}
      {props.label ?? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate">{title}</span>} />
          <TooltipPopup side="bottom">{title}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
});

/** Drops the tabs of Threads that are gone or hidden once the shells are known. */
function ThreadTabsPruner(props: { routeKey: string }) {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const shells = useQuietThreadShells();
  const hidden = useHiddenThreadKeys();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the live thread list and draft store into the persisted tab store
  useEffect(() => {
    if (!bootstrapped) return;
    const live = new Set(
      shells
        .filter((shell) => shell.deletedAt == null && shell.archivedAt == null)
        .map((shell) =>
          tabKey({ kind: "thread", environmentId: shell.environmentId, threadId: shell.id }),
        ),
    );
    for (const key of hidden) live.delete(`t\u0000${key}`);
    const drafts = useComposerDraftStore.getState();
    pruneThreadTabsStore(
      (tab) =>
        tab.kind === "thread"
          ? live.has(tabKey(tab))
          : drafts.getDraftSession(DraftId.make(tab.draftId)) != null,
      props.routeKey,
    );
  }, [bootstrapped, shells, hidden, props.routeKey]);
  return null;
}

function nextFocus(current: HTMLElement, key: string): HTMLElement | null {
  const tabs = Array.from(
    current.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
  );
  const index = tabs.indexOf(current);
  if (index === -1) return null;
  if (key === "Home") return tabs[0] ?? null;
  if (key === "End") return tabs.at(-1) ?? null;
  const step = key === "ArrowRight" ? 1 : -1;
  return tabs[(index + step + tabs.length) % tabs.length] ?? null;
}

/**
 * Browser-like tabs for the Threads this User has open. The route stays the source of truth: the
 * open Thread is always the active tab, and the other tabs only show a title and a status from the
 * thread shells the sidebar already holds, so nothing but the open Thread is subscribed.
 */
export function ThreadTabStrip(props: {
  /** The Thread or draft the chat area shows. */
  activeTab: ThreadTab;
  /** The open Thread's title controls (rename, actions menu), shown on its tab. */
  activeLabel: ReactNode;
}) {
  const router = useRouter();
  const scope = useThreadTabsScope();
  const tabs = useThreadTabsStore((state) => state.tabs);
  const routeKey = tabKey(props.activeTab);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Before paint, so the strip never shows the previous Thread's tab as the open one.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this User's stored tabs and follows the route into the external tab store
  useLayoutEffect(() => {
    selectThreadTabsScope(scope);
    syncThreadTabsRoute(props.activeTab);
  }, [scope, props.activeTab]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the active tab DOM node into view when it changes
  useEffect(() => {
    document
      .querySelector<HTMLElement>(`[data-thread-tab="${CSS.escape(routeKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A tab added or removed shifts the strip, so the active tab is scrolled back into view.
  }, [routeKey, tabs.length]);

  const activate = useStableCallback((tab: ThreadTab) => {
    // A click on a tab's close button also reaches the tab, whose key is gone by then.
    if (!useThreadTabsStore.getState().tabs.some((entry) => tabKey(entry) === tabKey(tab))) return;
    void navigateToThreadTab(router, tab);
  });
  const close = useStableCallback((key: string) => {
    void closeThreadTab(router, key);
  });
  const openNewTab = useStableCallback(() => {
    void startNewThreadInNewTab(router);
  });
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = tabs.findIndex((tab) => tabKey(tab) === over.id);
    if (toIndex >= 0) moveThreadTab(String(active.id), toIndex);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab")
      return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    nextFocus(event.target, event.key)?.focus();
  };
  // A mouse wheel scrolls the strip sideways; trackpads already do.
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
      event.currentTarget.scrollLeft += event.deltaY;
  };

  const selectedKnown = tabs.some((tab) => tabKey(tab) === routeKey);
  const tabbableKey = selectedKnown ? routeKey : tabs[0] ? tabKey(tabs[0]) : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
      <ThreadTabsPruner routeKey={routeKey} />
      <div
        role="tablist"
        aria-label="Open threads"
        data-thread-tabs
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={DRAG_MODIFIERS}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((tab) => tabKey(tab))}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => {
              const key = tabKey(tab);
              return (
                <ThreadTabItem
                  key={key}
                  tab={tab}
                  selected={key === routeKey}
                  tabbable={key === tabbableKey}
                  alone={tabs.length === 1}
                  label={key === routeKey ? props.activeLabel : null}
                  onActivate={activate}
                  onClose={close}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="New tab"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              onClick={openNewTab}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New thread in a new tab</TooltipPopup>
      </Tooltip>
    </div>
  );
}
