import type { AnyRouter } from "@tanstack/react-router";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { createNewThreadHandler, resolveDefaultProjectRef } from "../hooks/useHandleNewThread";
import { projectsInCurrentSpace } from "../state/currentSpace";
import { readProjects, readThreadShell } from "../state/entities";
import {
  armNewThreadTab,
  disarmNewThreadTab,
  routeThreadTab,
  threadTabRef,
} from "../state/threadTabs";
import { useUiStateStore } from "../uiStateStore";
import { startNewThreadFromContext } from "./chatThreadActions";

/** The new-tab button: the new-thread draft opens beside the current tab instead of replacing it. */
export async function startNewThreadInNewTab(router: AnyRouter): Promise<boolean> {
  const routeTab = routeThreadTab(router);
  const drafts = useComposerDraftStore.getState();
  const activeThread = routeTab?.kind === "thread" ? readThreadShell(threadTabRef(routeTab)) : null;
  const activeDraftThread = routeTab
    ? routeTab.kind === "thread"
      ? drafts.getDraftThread(threadTabRef(routeTab))
      : drafts.getDraftSession(DraftId.make(routeTab.draftId))
    : null;
  armNewThreadTab(router);
  const started = await startNewThreadFromContext({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef: resolveDefaultProjectRef(
      projectsInCurrentSpace(readProjects()),
      useUiStateStore.getState().projectOrder,
    ),
    handleNewThread: createNewThreadHandler(router),
  });
  disarmNewThreadTab(router);
  return started;
}
