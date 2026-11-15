import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadMove,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadAiAccountLabel } from "@t3tools/client-runtime/ai-account-picker";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadTab } from "@t3tools/client-runtime/thread-tabs";
import { ThreadMoveBadge } from "./MoveThreadDialog";
import { ThreadTabStrip } from "./ThreadTabStrip";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, CornerLeftUpIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useAtomValue } from "@effect/atom-react";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
import { GuestShareIndicator } from "./GuestShareControls";
import { ThreadSecrets } from "../settings/VaultChoices";
import { EnvironmentStatusDot } from "../EnvironmentStatusDot";
import {
  type ActiveEnvironmentView,
  type ThreadEnvironmentState,
  activeEnvironmentStatusLabel,
  NEEDS_ENVIRONMENT_LABEL,
  PAUSED_OFFLINE_LABEL,
  activeEnvironmentLabel,
} from "../../environments/primary/useHubEnvironments";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  /** The Environment the Thread runs on, by name and live status. */
  activeEnvironment?: ActiveEnvironmentView | null | undefined;
  /** «Needs an environment», or «paused, environment offline» while its turn waits. */
  environmentState?: ThreadEnvironmentState | null | undefined;
  /** The Thread's latest move to another Environment; shown while it runs. */
  activeThreadMove?: OrchestrationV2ThreadMove | null | undefined;
  /**
   * The Hub AI account its requests go to now (spec 4 tickets 06 and 08: also after a failover or
   * a switch), named as this viewer may see it.
   */
  aiAccount?: ThreadAiAccountLabel | null | undefined;
  isServerThread: boolean;
  /** Shows the Thread tab strip in place of the Project / title breadcrumb. */
  showThreadTabs?: boolean | undefined;
  /** The draft this header is for, when it is not a server Thread. */
  activeDraftId?: string | null | undefined;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeEnvironment,
  environmentState,
  activeThreadMove,
  aiAccount,
  isServerThread,
  showThreadTabs,
  activeDraftId,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  onFindInThread,
}: ChatHeaderProps) {
  const activeTab: ThreadTab | undefined = showThreadTabs
    ? activeDraftId
      ? { kind: "draft", draftId: activeDraftId }
      : { kind: "thread", environmentId: activeThreadEnvironmentId, threadId: activeThreadId }
    : undefined;
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
    canShareWithGuest,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const titleControl = (
    <>
      {renamingTitle !== null ? (
        <input
          autoFocus
          dir="auto"
          aria-label="Thread title"
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
          defaultValue={renamingTitle}
          onBlur={(event) => {
            if (renameCommittedRef.current) return;
            if (
              event.relatedTarget instanceof HTMLElement &&
              event.relatedTarget.closest("button")
            ) {
              setRenaming(null);
              return;
            }
            commitRename(event.currentTarget.value);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleRenameKeyDown}
        />
      ) : isServerThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={titleButtonRef}
                type="button"
                aria-label={`Thread actions for ${activeThreadTitle}`}
                aria-haspopup="menu"
                onClick={openMenuFromTitle}
                onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                onBlur={cancelPendingTitleMenu}
                className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <h2 className="min-w-0" dir={textDirection(activeThreadTitle)}>
              <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
            </h2>
            <ChevronDownIcon
              aria-hidden
              data-thread-title-chevron
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1"
                dir={textDirection(activeThreadTitle)}
              />
            }
          >
            <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      )}
    </>
  );
  const statusBadges = (
    <>
      {renamingTitle === null && activeEnvironment?.needsEnvironment ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="warning"
                size="sm"
                role="status"
                data-environment-state="needs-environment"
                aria-label={`Active environment: none. ${NEEDS_ENVIRONMENT_LABEL}`}
              />
            }
          >
            <EnvironmentStatusDot status="offline" />
            {NEEDS_ENVIRONMENT_LABEL}
          </TooltipTrigger>
          <TooltipPopup side="top">
            The machine this Thread ran on was removed or no longer runs Threads. Its history is
            kept; move it to another Environment to continue.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {renamingTitle === null && activeEnvironment && !activeEnvironment.needsEnvironment ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                size="sm"
                data-environment-status={activeEnvironment.status}
                aria-label={`Active environment: ${activeEnvironmentLabel(activeEnvironment)}`}
              />
            }
          >
            <EnvironmentStatusDot status={activeEnvironment.status} />
            {activeEnvironment.name}
            {activeEnvironment.status === "online"
              ? null
              : ` · ${activeEnvironmentStatusLabel(activeEnvironment)}`}
          </TooltipTrigger>
          <TooltipPopup side="top">
            Runs on {activeEnvironment.name} · {activeEnvironmentStatusLabel(activeEnvironment)}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {renamingTitle === null && aiAccount ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                size="sm"
                data-ai-account={aiAccount.id}
                aria-label={`AI account in use: ${aiAccount.name}`}
              />
            }
          >
            {aiAccount.name}
            {aiAccount.model === null ? null : ` · ${aiAccount.model}`}
          </TooltipTrigger>
          <TooltipPopup side="top">
            The agent uses the Hub's AI account {aiAccount.name}
            {aiAccount.model === null ? "" : ` with ${aiAccount.model}`}. No login of the machine is
            used.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {renamingTitle === null && environmentState === "paused-offline" && activeEnvironment ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="warning"
                size="sm"
                role="status"
                data-environment-state="paused-offline"
                aria-label={PAUSED_OFFLINE_LABEL}
              />
            }
          >
            {PAUSED_OFFLINE_LABEL}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {activeEnvironment.name} is{" "}
            {activeEnvironmentStatusLabel(activeEnvironment).toLowerCase()}. The turn goes on when
            it comes back; messages you send are queued until then, or until you move the Thread.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {renamingTitle === null ? (
        <ThreadMoveBadge
          move={activeThreadMove ?? null}
          threadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
        />
      ) : null}
    </>
  );
  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      {activeTab ? (
        <>
          <ThreadTabStrip
            activeTab={activeTab}
            activeProjectName={activeProjectName}
            activeLabel={
              <span className="flex min-w-0 flex-1 items-center gap-1 font-medium text-foreground">
                {activeProjectName ? (
                  <span className="max-w-20 shrink-0 truncate font-normal text-muted-foreground">
                    {activeProjectName} ·
                  </span>
                ) : null}
                {titleControl}
              </span>
            }
          />
          {parentThreadLink ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open parent thread: ${parentThreadLink.title}`}
                    onClick={() => onOpenThread(parentThreadLink.threadId)}
                    className="inline-flex max-w-40 shrink-0 cursor-pointer items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <CornerLeftUpIcon aria-hidden className="size-3 shrink-0" />
                <span aria-hidden className="truncate">
                  {parentThreadLink.title}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">Parent thread: {parentThreadLink.title}</TooltipPopup>
            </Tooltip>
          ) : null}
          <div className="flex shrink-0 items-center gap-1.5">{statusBadges}</div>
        </>
      ) : (
        <WorkspaceBreadcrumb
          ariaLabel="Thread breadcrumb"
          className="flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          {activeProject ? (
            <>
              <WorkspaceBreadcrumbItem className="shrink">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`New thread in ${activeProjectName}`}
                        onClick={onNewThreadInProject}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <ProjectFavicon project={activeProject} className="size-3.5" />
                    <WorkspaceBreadcrumbText className="max-w-40">
                      {activeProjectName}
                    </WorkspaceBreadcrumbText>
                  </TooltipTrigger>
                  <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
                </Tooltip>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          {parentThreadLink ? (
            <>
              <WorkspaceBreadcrumbItem>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Open parent thread: ${parentThreadLink.title}`}
                        onClick={() => onOpenThread(parentThreadLink.threadId)}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <WorkspaceBreadcrumbText
                      aria-hidden
                      className={collapseParentTitle ? "w-0" : undefined}
                    >
                      {parentThreadLink.title}
                    </WorkspaceBreadcrumbText>
                    {collapseParentTitle ? (
                      <span aria-hidden data-parent-breadcrumb-ellipsis>
                        ...
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
                </Tooltip>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            {titleControl}
            {statusBadges}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      )}
      {isServerThread ? (
        <ThreadSecrets environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
      ) : null}
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
});
