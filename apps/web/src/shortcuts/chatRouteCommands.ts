import {
  AuthPreviewOperateScope,
  THREAD_TAB_JUMP_KEYBINDING_COMMANDS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { adjacentTab, tabAtIndex, tabKey } from "@t3tools/client-runtime/thread-tabs";
import type { AnyRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchPreviewAction, type PreviewAction } from "../components/preview/previewActionBus";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { shouldCreateNewThreadInCurrentProject } from "../components/Sidebar.logic";
import { createNewThreadHandler, resolveDefaultProjectRef } from "../hooks/useHandleNewThread";
import { createScratchProjectActions } from "../hooks/useScratchProject";
import { getClientSettings } from "../hooks/useSettings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { projectsInCurrentSpace } from "../state/currentSpace";
import { readProjects, readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { readEnvironmentScope } from "../state/session";
import {
  closeThreadTab,
  navigateToThreadTab,
  routeThreadTab,
  useThreadTabsStore,
} from "../state/threadTabs";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/**
 * New-thread and preview commands, live while a chat route is showing and no
 * modal page (Settings, Usage) covers it. Everything is read at event time, so
 * the scope is registered once instead of re-registering on every store change.
 */
export function installChatRouteCommands(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = createScratchProjectActions({
    environments: () =>
      [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
        ([environmentId, presentation]) => ({ ...presentation, environmentId }),
      ),
    primaryEnvironmentId: () => appAtomRegistry.get(primaryEnvironmentIdAtom),
    registry: appAtomRegistry,
    handleNewThread,
  });

  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const readRouteThreadRef = () => {
    const target = readRouteTarget();
    return target?.kind === "server" ? target.threadRef : null;
  };
  const readPreviewOpen = () => {
    const threadRef = readRouteThreadRef();
    // Store-only on purpose: the URL-aware arbitration lives in ChatView's
    // preview toggle, which the action bus reaches.
    return threadRef
      ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
      : false;
  };
  const readThreadContext = () => {
    const target = readRouteTarget();
    const drafts = useComposerDraftStore.getState();
    const activeThread = target?.kind === "server" ? readThreadShell(target.threadRef) : null;
    const activeDraftThread = target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null;
    return {
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef: resolveDefaultProjectRef(
        projectsInCurrentSpace(readProjects()),
        useUiStateStore.getState().projectOrder,
      ),
      handleNewThread,
    };
  };
  // Grouped like the sidebar, so the shortcut and the New thread button agree.
  const readProjectGroups = () =>
    buildSidebarProjectSnapshots({
      projects: projectsInCurrentSpace(readProjects()),
      groupScratchProjects: true,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    });
  const canOperatePreview = (environmentId: EnvironmentId) =>
    readEnvironmentScope(environmentId, AuthPreviewOperateScope);

  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const startNewLocal: CommandHandler = (event) => {
    claim(event);
    // With no current or open project, such as when every project is archived, pick one.
    void startNewThreadFromContext(readThreadContext()).then((started) => {
      if (!started) openCommandPalette({ open: "new-thread-in" });
    });
  };

  // The route decides which tab is current; the store only remembers the last one.
  const readTabs = () => {
    const state = useThreadTabsStore.getState();
    const routeTab = routeThreadTab(router);
    return {
      state: { ...state, activeKey: routeTab ? tabKey(routeTab) : state.activeKey },
      routeTab,
    };
  };
  const goToTab =
    (
      pick: (state: ReturnType<typeof readTabs>["state"]) => ReturnType<typeof tabAtIndex>,
    ): CommandHandler =>
    (event) => {
      const tab = pick(readTabs().state);
      if (tab === null) return false;
      claim(event);
      void navigateToThreadTab(router, tab);
    };
  const tabCommands = {
    "threadTab.next": goToTab((state) => adjacentTab(state, "next")),
    "threadTab.previous": goToTab((state) => adjacentTab(state, "previous")),
    "threadTab.close": ((event) => {
      const { routeTab } = readTabs();
      if (routeTab === null) return false;
      claim(event);
      void closeThreadTab(router, tabKey(routeTab));
    }) satisfies CommandHandler,
    ...Object.fromEntries(
      THREAD_TAB_JUMP_KEYBINDING_COMMANDS.map((command, index) => [
        command,
        goToTab((state) => tabAtIndex(state, index)),
      ]),
    ),
  };

  const previewCommand =
    (action: PreviewAction): CommandHandler =>
    (event) => {
      claim(event);
      const threadRef = readRouteThreadRef();
      if (threadRef && canOperatePreview(threadRef.environmentId)) dispatchPreviewAction(action);
    };

  return registerCommands(
    {
      ...tabCommands,
      "chat.newLocal": startNewLocal,
      "chat.newWithoutProject": (event) => {
        const { activeThread, activeDraftThread } = readThreadContext();
        const environmentId = scratch.scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null,
        );
        if (environmentId === null) return;
        claim(event);
        void scratch.startScratchThread(environmentId);
      },
      "chat.new": (event) => {
        const { legacySidebarEnabled } = getClientSettings();
        const groups = readProjectGroups();
        if (
          !legacySidebarEnabled &&
          !shouldCreateNewThreadInCurrentProject(
            false,
            groups.filter((group) => !group.archived).length,
            groups.length,
          )
        ) {
          claim(event);
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        startNewLocal(event);
      },
      "preview.toggle": (event) => {
        claim(event);
        const threadRef = readRouteThreadRef();
        if (!threadRef || (!canOperatePreview(threadRef.environmentId) && !readPreviewOpen())) {
          return;
        }
        if (!isPreviewAvailableFor(threadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
      },
      "preview.refresh": previewCommand("refresh"),
      "preview.focusUrl": previewCommand("focus-url"),
      "preview.zoomIn": previewCommand("zoom-in"),
      "preview.zoomOut": previewCommand("zoom-out"),
      "preview.resetZoom": previewCommand("reset-zoom"),
    },
    {
      when: () =>
        router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
        !router.state.matches.some((match) => isAppModalPage(match.pathname)) &&
        !isCommandPaletteOpen(),
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
          previewOpen: readPreviewOpen(),
        };
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape") return false;
        const selection = useThreadSelectionStore.getState();
        if (selection.selectedThreadKeys.size === 0) return false;
        event.preventDefault();
        selection.clearSelection();
      },
    },
  );
}
