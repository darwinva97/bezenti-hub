import { overflowNavigationTabs } from "../workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../workspace/navigation-tabs";
import { currentWorkspaceSelections } from "../workspace/workspace-selection-store";
import { rememberedSettingsPage } from "../workspace/workspace-tab-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useNavigationState } from "@react-navigation/native";
import { use, type ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import type { SettingsModalId } from "@t3tools/client-runtime/settings/modal-visibility";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection, SettingsSidebarContext } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  useSettingsEnvironmentMenu,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { filterSettingsSections } from "./settings-search";
import {
  SETTINGS_MODAL_LABELS,
  SETTINGS_MODAL_TARGETS,
  visibleSettingsModals,
} from "./settings-modals";
import { useSettingsModalContext } from "./useSettingsModalContext";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";

export function SettingsRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const inSidebar = use(NativePrimaryColumnContext) !== null && layout.usesSplitView;
  // The page open beside the list: the route right above the Settings tab's route. While
  // another tab is open this list stays mounted, hidden, and must keep showing the page Settings
  // reopens on; otherwise returning shows it unselected for a frame before the page arrives.
  const selected = useNavigationState((state) => {
    const list = state.routes.findIndex((route) => route.name === "Settings");
    return list < 0
      ? rememberedSettingsPage(currentWorkspaceSelections())
      : (state.routes[list + 1]?.name ?? null);
  });
  return <SettingsListScreen sidebar={inSidebar} selected={selected} />;
}

export function SettingsListScreen(props: {
  readonly sidebar: boolean;
  readonly selected: string | null;
}) {
  const workspace = useWorkspaceTabs();
  const environmentMenu = useSettingsEnvironmentMenu();
  const inSidebar = props.sidebar;
  const selected = props.selected;
  const sidebar = inSidebar ? { selected } : null;
  const content = <LocalSettingsRouteScreen />;

  return (
    <SettingsSidebarContext value={sidebar}>
      <View className="flex-1 bg-screen">
        <SettingsEnvironmentFilterHeader />
        {Platform.OS === "android" ? (
          <SettingsScreen
            title="Settings"
            workspaceRoot={inSidebar}
            menus={[environmentMenu]}
            search={
              workspace
                ? {
                    value: workspace.state.tabs.settings.query,
                    onChangeText: (query) =>
                      workspace.dispatch({ type: "query", tab: "settings", query }),
                    placeholder: "Search settings",
                  }
                : undefined
            }
          >
            {content}
          </SettingsScreen>
        ) : (
          content
        )}
      </View>
    </SettingsSidebarContext>
  );
}

type SettingsListRow = ComponentProps<typeof SettingsRow> & { readonly id: string };

interface SettingsListSection {
  readonly title?: string;
  readonly rows: readonly SettingsListRow[];
}

function LocalSettingsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return <SettingsList connections={[environmentsRow(Object.keys(savedConnectionsById).length)]} />;
}

function environmentsRow(count: number): SettingsListRow {
  return {
    id: "SettingsEnvironments",
    icon: "desktopcomputer",
    label: "Environments",
    value: `${count}`,
    valuePosition: "trailing",
    target: "SettingsEnvironments",
  };
}

function SettingsList(props: { readonly connections: readonly SettingsListRow[] }) {
  // UIKit's scroll-edge material takes the scroll view's own color; like the chat list, match
  // the sidebar's surface so the bar doesn't darken over content at rest.
  // Grouped cards only lift off the screen surface; the drawer is as dark as they are.
  const listSurface = use(SettingsSidebarContext) ? "bg-drawer" : "bg-screen";
  const insets = useSafeAreaInsets();
  // UIKit insets the scroll view by its column's safe area, which this context can report as 0.
  const bottomSafeArea = useNativeColumnLayoutMetrics()?.safeArea.bottom ?? insets.bottom;
  const workspace = useWorkspaceTabs();
  const query = workspace?.state.tabs.settings.query ?? "";
  const overflowRows = useOverflowRows();
  const indexSections = useSettingsIndexSections(query);
  const sections = filterSettingsSections(
    [{ rows: overflowRows }, ...indexSections, { title: "Connections", rows: props.connections }],
    query,
  );

  return (
    <View collapsable={false} className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className={`flex-1 ${listSurface}`}
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          // The workspace's clearance keeps the last row above its search field and keyboard.
          paddingBottom:
            Platform.OS === "ios"
              ? Math.max(Math.max(bottomSafeArea, 18) + 18, workspace?.bottomClearance ?? 0) -
                bottomSafeArea
              : Math.max(Math.max(insets.bottom, 18) + 18, workspace?.bottomClearance ?? 0),
        }}
      >
        {sections.length ? (
          sections.map((section, index) => (
            <SettingsSection key={section.title ?? `untitled-${index}`} title={section.title}>
              {section.rows.map(({ id, ...row }) => (
                <SettingsRow key={id} {...row} />
              ))}
            </SettingsSection>
          ))
        ) : (
          <EmptyState
            variant="plain"
            title="No results"
            detail={`No settings match “${query.trim()}”.`}
          />
        )}
      </ScrollView>
    </View>
  );
}

const SETTINGS_ENTRY_ICONS: Record<SettingsModalId, SettingsListRow["icon"]> = {
  user: "person.crop.circle",
  space: "person.2",
  project: "folder",
  platform: "server.rack",
};

function useSettingsIndexSections(query: string): SettingsListSection[] {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const modals = visibleSettingsModals(useSettingsModalContext());
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  const projectValue = selectedProjectKey !== null ? projectLabel : undefined;
  if (query.trim() === "") {
    // Four entries; each opens the pages of its modal.
    return [
      {
        rows: modals.map(({ modal }) => ({
          id: SETTINGS_MODAL_TARGETS[modal],
          icon: SETTINGS_ENTRY_ICONS[modal],
          label: SETTINGS_MODAL_LABELS[modal],
          target: SETTINGS_MODAL_TARGETS[modal],
          ...(modal === "project" && projectValue !== undefined ? { value: projectValue } : {}),
        })),
      },
    ];
  }
  // Searching reaches every page of every entry, grouped under its entry.
  return modals.map(({ modal, pages }) => ({
    title: SETTINGS_MODAL_LABELS[modal],
    rows: pages.map((page) => ({
      id: page.target,
      icon: page.icon,
      label: page.label,
      target: page.target,
      disabled: page.needsServer === true && noServerTargets,
      ...(page.target === "SettingsProjectOverview" && projectValue !== undefined
        ? { value: projectValue }
        : {}),
    })),
  }));
}

function useOverflowRows(): SettingsListRow[] {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs.map((tab) => ({
    id: tab,
    icon: NAVIGATION_TAB_ICONS[tab],
    label: WORKSPACE_TAB_LABELS[tab],
    onPress: () => selectTab(tab),
  }));
}
