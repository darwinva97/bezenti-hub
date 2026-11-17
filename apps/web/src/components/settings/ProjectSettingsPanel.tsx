import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { mapAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import {
  type EnvironmentId,
  type ProjectId,
  type SidebarProjectGroupingMode,
  type SpaceSummary,
} from "@t3tools/contracts";
import { projectMoveDestinations } from "@t3tools/client-runtime/spaces/space-directory";
import { loadProjectMovePlan, type PlannedMove, ProjectMoveDialog } from "./ProjectMoveDialog";
import {
  checkProjectAccess,
  reportProjectFailure,
  useProjectGroupUpdate,
  type ProjectGroupUpdate,
} from "../../hooks/useProjectGroupUpdate";
import { Navigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useCurrentSpace } from "../../state/currentSpace";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  PROJECT_GROUPING_MODE_LABELS,
  withProjectGroupingOverride,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { useFollowOpenSpace } from "../../hooks/useFollowOpenSpace";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import type { ProjectSectionId } from "./settingsModals";
import { WorktreeSettingsSections } from "./WorktreesSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ProjectPreferredEnvironmentSettings } from "./ProjectPreferredEnvironmentSettings";
import {
  defaultProjectIcon,
  hasDefaultProjectIcon,
  projectGroupTitleNeedsUpdate,
  SCRATCH_PROJECT_TITLE,
} from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { ProjectVaults } from "./VaultChoices";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function isGroupingSelection(value: unknown): value is SidebarProjectGroupingMode | "inherit" {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}

// Grouping overrides are client settings, so they stay editable without project write access.
function CheckoutGroupingSelect({ member }: { member: SidebarProjectGroupMember }) {
  const overrideKey = derivePhysicalProjectKey(member);
  const globalMode = useClientSettings((settings) => settings.sidebarProjectGroupingMode);
  const selection = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
  );
  return (
    <Select
      value={selection}
      onValueChange={(value) => {
        if (!isGroupingSelection(value)) return;
        persistClientSettingsUpdate((current) => ({
          ...current,
          sidebarProjectGroupingOverrides: withProjectGroupingOverride(
            current.sidebarProjectGroupingOverrides,
            overrideKey,
            value,
          ),
        })).catch((error) => {
          console.error("Failed to save checkout grouping rule", error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save grouping rule",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Grouping rule for ${member.workspaceRoot} on ${
          member.environmentLabel
            ? `${member.environmentLabel} (${member.environmentId})`
            : member.environmentId
        }`}
      >
        <SelectValue>
          {selection === "inherit"
            ? `Default (${PROJECT_GROUPING_MODE_LABELS[globalMode]})`
            : PROJECT_GROUPING_MODE_LABELS[selection]}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          Use global default
        </SelectItem>
        <SelectItem hideIndicator value="repository">
          {PROJECT_GROUPING_MODE_LABELS.repository}
        </SelectItem>
        <SelectItem hideIndicator value="repository_path">
          {PROJECT_GROUPING_MODE_LABELS.repository_path}
        </SelectItem>
        <SelectItem hideIndicator value="separate">
          {PROJECT_GROUPING_MODE_LABELS.separate}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

export type ProjectSettingsCategory = "general" | "source-control" | "project";

interface ProjectSelection {
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly checkoutKey: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}

/**
 * "Move to…": the Spaces this User may move the Project into, from the server's answers. Spaces
 * live on the primary environment, so only its Project is moved.
 */
function ProjectSpaceSettings({ group }: { group: SidebarProjectSnapshot }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const view = useCurrentSpace((state) =>
    state.environmentId === primaryEnvironmentId ? state.view : null,
  );
  // The move under way: its dialog says what changes first, and stays while the Project moves.
  const [moving, setMoving] = useState<{
    readonly projectId: ProjectId;
    readonly projectTitle: string;
    readonly destination: SpaceSummary;
    readonly planned: PlannedMove;
  } | null>(null);
  const primaryMembers = group.memberProjects.filter(
    (member) => member.environmentId === primaryEnvironmentId,
  );
  const project = primaryMembers.length === 1 ? primaryMembers[0] : undefined;
  const dialog =
    moving === null || primaryEnvironmentId === null ? null : (
      <ProjectMoveDialog
        {...moving}
        primaryEnvironmentId={primaryEnvironmentId}
        onClose={() => setMoving(null)}
      />
    );
  if (view === null || project === undefined) return dialog;
  const destinations = projectMoveDestinations(view, project.spaceId);
  if (destinations.length === 0) return dialog;
  const originId = project.spaceId ?? view.personalSpaceId;
  const originName = view.spaces.find((space) => space.id === originId)?.name ?? "its Space";

  const destinationItems = destinations.map((space) => ({ value: space.id, label: space.name }));

  return (
    <SettingsSection title="Space">
      <SettingsRow
        title="Move to another Space"
        description={`In ${originName}. Its Threads move with it; running ones stop.`}
        control={
          <div className="w-full sm:w-64">
            <Select
              disabled={moving !== null}
              items={destinationItems}
              value={null}
              onValueChange={(value) => {
                const destination = destinations.find((space) => space.id === value);
                if (destination === undefined) return;
                const opened = { projectId: project.id, projectTitle: project.title, destination };
                setMoving({ ...opened, planned: { status: "planning" } });
                void loadProjectMovePlan(project.id, destination.id).then((planned) =>
                  setMoving((current) =>
                    current?.destination.id === destination.id ? { ...opened, planned } : current,
                  ),
                );
              }}
            >
              <SelectTrigger aria-label="Move to…">
                <SelectValue placeholder="Move to…" />
              </SelectTrigger>
              <SelectPopup>
                {destinationItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      {dialog}
    </SettingsSection>
  );
}

/** «Vaults»: the Project's adds and removes among the Vaults allowed to its Space (spec 5). */
function ProjectVaultsSettings({ group }: { group: SidebarProjectSnapshot }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const view = useCurrentSpace((state) =>
    state.environmentId === primaryEnvironmentId ? state.view : null,
  );
  const primaryMembers = group.memberProjects.filter(
    (member) => member.environmentId === primaryEnvironmentId,
  );
  const project = primaryMembers.length === 1 ? primaryMembers[0] : undefined;
  if (primaryEnvironmentId === null || view === null || project === undefined) return null;
  // Threads without a Project take their Space's defaults: the scratch Project chooses none.
  if (project.isScratch === true) return null;
  return (
    <ProjectVaults
      environmentId={primaryEnvironmentId}
      projectId={project.id}
      spaceId={project.spaceId ?? view.personalSpaceId}
    />
  );
}

function sameProjectSelection(a: ProjectSelection | null, b: ProjectSelection): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.environmentId === b.environmentId &&
    a.checkoutKey === b.checkoutKey &&
    a.memberKeys.length === b.memberKeys.length &&
    a.memberKeys.every((key, index) => key === b.memberKeys[index])
  );
}

export function ProjectSettingsPanel({
  projectKey,
  section,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  section: ProjectSectionId;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  // Opening a Project of another Space makes that Space the current one, and follows it if the
  // Project moves.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryMember = selected?.memberProjects.find(
    (member) => member.environmentId === primaryEnvironmentId,
  );
  useFollowOpenSpace({
    threadRef: null,
    draft: primaryMember
      ? { environmentId: primaryMember.environmentId, projectId: primaryMember.id }
      : null,
  });
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Retain group members so grouping-rule changes can follow the project to its new group.
  const [lastSelection, setLastSelection] = useState<ProjectSelection | null>(null);
  if (selected && members.length > 0) {
    const current: ProjectSelection = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
    if (!sameProjectSelection(lastSelection, current)) setLastSelection(current);
  }

  const successor =
    members.length === 0 &&
    lastSelection?.key === projectKey &&
    lastSelection.environmentId === environmentId &&
    lastSelection.checkoutKey === checkoutKey
      ? groups.find((group) =>
          group.memberProjects.some((member) =>
            lastSelection.memberKeys.includes(member.physicalProjectKey),
          ),
        )
      : undefined;
  if (successor) {
    return (
      <Navigate
        to="/settings/project/$projectKey/$section"
        params={{ projectKey: successor.projectKey, section }}
        search={{ machine: environmentId ?? undefined, checkout: checkoutKey ?? undefined }}
        replace
        hashScrollIntoView={false}
      />
    );
  }

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      section={section}
      allMembers={selected.memberProjects}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  section,
  allMembers,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  section: ProjectSectionId;
  /** Pin and archive belong to the whole project, even when one machine is picked. */
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
}) {
  const closeAppModal = useCloseAppModal();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const updateAllMembers = (
    input: ProjectGroupUpdate | ((member: SidebarProjectGroupMember) => ProjectGroupUpdate),
    failureTitle: string,
  ) => updateProjectGroup(group.memberProjects, input, failureTitle);
  const canOrganize =
    allMembers.every((member) => editableIds.has(member.environmentId)) &&
    canOrganizeProjectGroup(allMembers);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const organize = async (input: ProjectGroupUpdate, failureTitle: string) => {
    setIsOrganizing(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsOrganizing(false);
  };

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: Parameters<typeof updateAllMembers>[0]) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const hasMultipleCheckouts = group.memberProjects.length > 1;
  const canResetScratchTitle =
    group.memberProjects.every((member) => member.isScratch) &&
    group.memberProjects.some((member) => member.title !== SCRATCH_PROJECT_TITLE);

  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, "Failed to remove project")) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    // The Project is gone, so there is nothing left to show: back to where Settings was opened.
    if (isWholeGroup && !hasOtherMembers) void closeAppModal();
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  // A lone checkout is removed from the Danger section, but it still needs its grouping
  // rule here so "Keep separate" can be undone.
  const checkoutControls = (member: SidebarProjectGroupMember) => (
    <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto">
      <div className="min-w-0 flex-1 @min-[32rem]/settings-row:w-72 @min-[32rem]/settings-row:flex-none">
        <CheckoutGroupingSelect member={member} />
      </div>
      {hasMultipleCheckouts ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!editableIds.has(member.environmentId)}
          onClick={() => void removeMembers([member])}
          aria-label={`Remove checkout ${member.workspaceRoot}`}
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Grouping rule decides how each checkout joins project groups in the sidebar. Changing it can
        move a checkout to a different project.
      </p>
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? "Environment"}
              description={member.workspaceRoot}
              control={checkoutControls(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: firstMember.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow
            key={environmentId}
            title={labels.primary}
            description={
              <>
                {labels.secondary ? (
                  <span className="block truncate">{labels.secondary}</span>
                ) : null}
                {!hasMultiple ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {firstMember.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>{firstMember.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </>
            }
            control={hasMultiple ? undefined : checkoutControls(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings-row:flex-row @min-[36rem]/settings-row:items-center @min-[36rem]/settings-row:justify-between @min-[36rem]/settings-row:gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutControls(member)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        {section === "general" ? (
          <>
            <SettingsSection id="project-overview" title="Project" hideTitle>
              {!canEditGroup ? (
                <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
                  {group.memberProjects.length > 1
                    ? "Shared settings require permission to change every checkout in this group."
                    : "This connection cannot change this project."}
                </p>
              ) : null}
              <SettingsRow
                title="Name"
                description="The shared name for this project group in the sidebar and thread lists."
                resetAction={
                  canResetScratchTitle ? (
                    <SettingResetButton
                      label="project name"
                      disabled={!canEditGroup}
                      onClick={() =>
                        void updateAllMembers(
                          { title: SCRATCH_PROJECT_TITLE },
                          "Failed to rename project",
                        )
                      }
                    />
                  ) : null
                }
                control={
                  <Input
                    key={`${group.projectKey}:${group.displayName}`}
                    size="sm"
                    className="w-full sm:w-64"
                    aria-label="Project name"
                    disabled={!canEditGroup}
                    defaultValue={group.displayName}
                    onChange={() => {
                      projectNameEditedRef.current = true;
                    }}
                    onBlur={(event) => {
                      const wasEdited = projectNameEditedRef.current;
                      projectNameEditedRef.current = false;
                      void renameGroup(event.currentTarget.value, wasEdited);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                }
              />
              <SettingsRow
                title="Project icon"
                description={
                  projectIcon?.kind === "lucide"
                    ? `${projectIcon.name} · ${projectIcon.color}`
                    : projectIcon?.kind === "monogram"
                      ? `${projectIcon.text} · ${projectIcon.color}`
                      : projectIcon?.kind === "emoji"
                        ? projectIcon.emoji
                        : (faviconPath ?? "Automatic")
                }
                resetAction={
                  group.memberProjects.some((member) => !hasDefaultProjectIcon(member)) ? (
                    <SettingResetButton
                      label="project icon"
                      disabled={isSavingFavicon || !canEditGroup}
                      onClick={() => void setProjectIcon(defaultProjectIcon)}
                    />
                  ) : null
                }
                control={
                  <div className="flex items-center gap-2">
                    <ProjectFavicon project={representative} className="size-6" />
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      aria-label="Choose a project icon"
                      disabled={isSavingFavicon || !canEditGroup}
                      onClick={() => setIconPickerOpen(true)}
                    >
                      Choose icon
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      aria-label="Choose a project icon file"
                      disabled={isSavingFavicon || !canEditGroup}
                      onClick={() => setFaviconPickerOpen(true)}
                    >
                      Choose file
                    </Button>
                  </div>
                }
              />
              {canOrganize ? (
                <>
                  <SettingsRow
                    title="Pin"
                    description="Pinned projects come first in project pickers."
                    control={
                      <Switch
                        checked={group.pinned}
                        disabled={isOrganizing}
                        onCheckedChange={(checked) =>
                          void organize(
                            { pinned: Boolean(checked) },
                            checked ? "Failed to pin project" : "Failed to unpin project",
                          )
                        }
                        aria-label="Pin project"
                      />
                    }
                  />
                  <SettingsRow
                    title="Archive"
                    description={
                      group.archived
                        ? "Hidden from project pickers. Threads and files are kept."
                        : "Hides the project from project pickers. Threads and files are kept."
                    }
                    control={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isOrganizing}
                        onClick={() =>
                          void organize(
                            { archived: !group.archived },
                            group.archived
                              ? "Failed to unarchive project"
                              : "Failed to archive project",
                          )
                        }
                      >
                        {group.archived ? "Unarchive" : "Archive"}
                      </Button>
                    }
                  />
                </>
              ) : null}
            </SettingsSection>
            <ProjectSpaceSettings group={group} />
            <SettingsSection title="Danger">
              <SettingsRow
                title={
                  hasOtherMembers
                    ? "Remove checkout"
                    : group.memberProjects.length > 1
                      ? "Remove this project everywhere"
                      : "Remove project"
                }
                description={
                  hasOtherMembers
                    ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                    : group.memberProjects.length > 1
                      ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                      : "Deletes the project entry and its threads. Files on disk are not touched."
                }
                control={
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={!canEditGroup}
                    onClick={() => void removeMembers(group.memberProjects)}
                  >
                    <Trash2Icon />
                    {hasOtherMembers
                      ? "Remove checkout"
                      : group.memberProjects.length > 1
                        ? "Remove all entries"
                        : "Remove project"}
                  </Button>
                }
              />
            </SettingsSection>
          </>
        ) : null}
        {section === "vaults" ? <ProjectVaultsSettings group={group} /> : null}
        {section === "machine" ? (
          <>
            <ProjectPreferredEnvironmentSettings group={group} canEdit={canEditGroup} />
            {checkoutChoices}
          </>
        ) : null}
        {section === "defaults" ? (
          <>
            <ProjectDefaultsSettings category="project" />
            <WorktreeSettingsSections />
          </>
        ) : null}
        {section === "actions" ? <ProjectActionsSettings /> : null}
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
