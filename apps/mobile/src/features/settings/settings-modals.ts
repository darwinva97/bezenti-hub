import {
  isSettingsSectionAllowed,
  type SettingsModalId,
  type SettingsPrincipal,
  type SpaceSettingsSubject,
} from "@t3tools/client-runtime/settings/modal-visibility";

import type { ComponentProps } from "react";

import type { ListRow } from "../../components/ui/ListRow";
import type { SettingsPageTarget } from "./components/settings-page-targets";

/**
 * The four Settings entries and the pages each one lists. The pages are the ones mobile already
 * has, split the way the web modals split them. Who sees what is decided by
 * `@t3tools/client-runtime/settings/modal-visibility`, shared with the web; this file only says
 * which mobile page stands for which web section.
 */
export const SETTINGS_MODAL_LABELS: Readonly<Record<SettingsModalId, string>> = {
  user: "User",
  space: "Space",
  project: "Project",
  platform: "Platform",
};

export const SETTINGS_MODAL_ORDER: readonly SettingsModalId[] = [
  "user",
  "space",
  "project",
  "platform",
];

/** The route of each modal's index page. `project` opens the Project page itself. */
export const SETTINGS_MODAL_TARGETS: Readonly<Record<SettingsModalId, SettingsPageTarget>> = {
  user: "SettingsUser",
  space: "SettingsSpace",
  project: "SettingsProjectOverview",
  platform: "SettingsPlatform",
};

/** Where the web's Platform modal lives for what mobile has no screen for. */
export const PLATFORM_BROWSER_PATH = "/settings/platform/users";

/** Where the web's Space modal lives, for archiving, restoring and deleting an Organization. */
export const spaceBrowserPath = (spaceId: string) => `/settings/space/${spaceId}/general`;

export interface SettingsModalPage {
  readonly target: SettingsPageTarget;
  readonly label: string;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  /** The web section this page stands for; unset when the shared rules have no opinion. */
  readonly sectionId?: string;
  /** Needs a connected server to do anything. */
  readonly needsServer?: boolean;
  /** Only where the device offers it (the Keyboard page on iOS, Navigation tabs). */
  readonly device?: "ios" | "navigation-customization";
}

const PAGES: Readonly<Record<SettingsModalId, readonly SettingsModalPage[]>> = {
  user: [
    { target: "SettingsOrganization", label: "General", icon: "gearshape", sectionId: "general" },
    {
      target: "SettingsAppearance",
      label: "Appearance",
      icon: "paintbrush",
      sectionId: "appearance",
    },
    {
      target: "SettingsFollowUp",
      label: "Chat",
      icon: "bubble.left.and.bubble.right",
      sectionId: "chat",
    },
    {
      target: "SettingsNavigation",
      label: "Navigation tabs",
      icon: "line.3.horizontal",
      device: "navigation-customization",
    },
    { target: "SettingsKeyboard", label: "Keyboard", icon: "keyboard", device: "ios" },
    { target: "SettingsMicrophone", label: "Microphone", icon: "mic" },
    {
      target: "SettingsAiAccounts",
      label: "AI accounts",
      icon: { ios: "sparkles", android: "auto_awesome" },
      needsServer: true,
    },
    {
      target: "SettingsVaults",
      label: "Vaults",
      icon: { ios: "key", android: "lock" },
      needsServer: true,
    },
    {
      target: "SettingsLoans",
      label: "Loans",
      icon: "arrow.left.arrow.right",
      needsServer: true,
    },
    { target: "SettingsEnvironments", label: "Machines", icon: "desktopcomputer" },
    { target: "SettingsAbout", label: "About", icon: "info.circle", sectionId: "about" },
  ],
  space: [
    {
      target: "SettingsMembers",
      label: "Members",
      icon: "person.2",
      sectionId: "members",
      needsServer: true,
    },
    {
      target: "SettingsInvitations",
      label: "Invitations",
      icon: "person.badge.plus",
      sectionId: "invitations",
      needsServer: true,
    },
    {
      target: "SettingsScheduledTasks",
      label: "Scheduled tasks",
      icon: "clock",
      sectionId: "scheduled-tasks",
    },
    { target: "SettingsArchive", label: "Archive", icon: "archivebox", sectionId: "archive" },
  ],
  project: [{ target: "SettingsProjectOverview", label: "Projects", icon: "folder" }],
  platform: [
    {
      target: "SettingsProviderAccounts",
      label: "Providers",
      icon: "person.crop.circle",
      needsServer: true,
    },
    { target: "SettingsThreads", label: "Threads", icon: "text.bubble", needsServer: true },
    {
      target: "SettingsWorktrees",
      label: "Worktrees",
      icon: "square.on.square",
      needsServer: true,
    },
    {
      target: "SettingsEnvironmentSourceControl",
      label: "Source control",
      icon: "arrow.triangle.branch",
      needsServer: true,
    },
    {
      target: "SettingsEnvironmentMaintenance",
      label: "Maintenance",
      icon: "arrow.clockwise",
      needsServer: true,
    },
    { target: "SettingsLabs", label: "Labs", icon: "sparkles", sectionId: "labs" },
    { target: "SettingsDiagnostics", label: "Diagnostics", icon: "stethoscope" },
  ],
};

/** Who is looking at Settings, and which Space the Space entry is about. */
export interface SettingsModalContext {
  readonly principal: SettingsPrincipal;
  readonly space: SpaceSettingsSubject | null;
  /** The Space the Space entry is about, when the Hub's directory names one. */
  readonly spaceId?: string | null;
  readonly device: { readonly ios: boolean; readonly navigationCustomization: boolean };
}

/** The pages of one modal this viewer sees, in order. An empty list hides the entry. */
export function settingsModalPages(
  modal: SettingsModalId,
  context: SettingsModalContext,
): readonly SettingsModalPage[] {
  // A page the shared rules have no section for follows its modal: the first section stands in.
  const modalOpen = isSettingsSectionAllowed(
    modal,
    modalProbeSection(modal),
    context.principal,
    context.space,
  );
  if (!modalOpen) return [];
  return PAGES[modal].filter((page) => {
    if (page.device === "ios" && !context.device.ios) return false;
    if (page.device === "navigation-customization" && !context.device.navigationCustomization) {
      return false;
    }
    return page.sectionId === undefined
      ? true
      : isSettingsSectionAllowed(modal, page.sectionId, context.principal, context.space);
  });
}

/** A section every viewer of the modal shares, to ask whether the modal is theirs at all. */
function modalProbeSection(modal: SettingsModalId): string {
  switch (modal) {
    case "user":
      return "general";
    case "space":
      return "general";
    case "project":
      return "general";
    case "platform":
      return "users";
  }
}

/** The modals this viewer sees, each with its pages. */
export function visibleSettingsModals(context: SettingsModalContext) {
  return SETTINGS_MODAL_ORDER.flatMap((modal) => {
    const pages = settingsModalPages(modal, context);
    return pages.length === 0 ? [] : [{ modal, pages }];
  });
}

/** A page of the Hub's web app, for what mobile does not have; null without a Hub. */
export function hubBrowserUrl(hubHttpBaseUrl: string | null, path: string): string | null {
  if (hubHttpBaseUrl === null) return null;
  return `${hubHttpBaseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * The Space a Space entry is about, as the viewer's directory lists it. Without a directory (no
 * Hub, or a session with no User) the viewer is alone: their own Personal space.
 */
export function spaceSubject(
  spaces: ReadonlyArray<{
    readonly id: string;
    readonly kind: "organization" | "personal";
    readonly isOwn: boolean;
    readonly canInvite: boolean;
  }> | null,
  currentSpaceId: string | null,
): SpaceSettingsSubject {
  const current = spaces?.find((space) => space.id === currentSpaceId);
  return current
    ? { kind: current.kind, isOwn: current.isOwn, canInvite: current.canInvite }
    : { kind: "personal", isOwn: true, canInvite: false };
}
