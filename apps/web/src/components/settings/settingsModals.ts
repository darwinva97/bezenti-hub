import {
  BotIcon,
  CalendarClockIcon,
  FileDiffIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  UserIcon,
  VaultIcon,
  createLucideIcon,
} from "lucide-react";
import { lazy, type ComponentType } from "react";

/**
 * The four settings modals. Each one is about one object and declares its sections here, in
 * order: the URL segment, the label, the icon, the component and who sees it. A section with no
 * component is reserved for a later ticket or spec: it owns a place in the URL space and the
 * order, and is never visible.
 */
export type SettingsModalId = "user" | "space" | "project" | "platform";

export interface SettingsVisibilityContext {
  /** The session acts for the whole Installation: the Owner's. */
  readonly isOwner: boolean;
  readonly isDesktop: boolean;
  /** The session belongs to a User with an account; a pairing-link session has none. */
  readonly hasUser: boolean;
}

export interface SettingsModalSection {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** `null` reserves the section: it is never visible. */
  readonly component: ComponentType | null;
  readonly visible?: (context: SettingsVisibilityContext) => boolean;
  /** The settings are the whole Hub's: anyone reads them, and only the Owner changes them. */
  readonly hubWide?: boolean;
  /** Sections with the same group number sit together; a new number leaves a gap in the nav. */
  readonly group: number;
}

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const GeneralSection = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.GeneralSettingsPanel })),
);
const ChatSection = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ChatSettingsPanel })),
);
const DiffsSection = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.DiffsSettingsPanel })),
);
const AboutSection = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.AboutSettingsPanel })),
);
const AppearanceSection = lazy(() =>
  import("./AppearanceSettingsPanel").then((module) => ({
    default: module.AppearanceSettingsPanel,
  })),
);
const KeybindingsSection = lazy(() =>
  import("./KeybindingsSettings").then((module) => ({ default: module.KeybindingsSettingsPanel })),
);
const SnapShotSection = lazy(() =>
  import("./SnapShotSettings").then((module) => ({ default: module.SnapShotSettings })),
);

const AccountSection = lazy(() =>
  import("./UserAccountSettings").then((module) => ({ default: module.UserAccountSettings })),
);
const SessionsSection = lazy(() =>
  import("./UserSessionsSettings").then((module) => ({ default: module.UserSessionsSettings })),
);

const reserved = (
  id: string,
  label: string,
  icon: SettingsModalSection["icon"],
  group: number,
): SettingsModalSection => ({ id, label, icon, component: null, group });

export const SETTINGS_MODAL_SECTIONS: Readonly<
  Record<SettingsModalId, ReadonlyArray<SettingsModalSection>>
> = {
  user: [
    {
      id: "account",
      label: "Account",
      icon: UserIcon,
      component: AccountSection,
      visible: ({ hasUser }) => hasUser,
      group: 0,
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: ShieldCheckIcon,
      component: SessionsSection,
      group: 0,
    },
    { id: "general", label: "General", icon: Settings2Icon, component: GeneralSection, group: 1 },
    {
      id: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      component: AppearanceSection,
      group: 1,
    },
    { id: "chat", label: "Chat", icon: MessageSquareTextIcon, component: ChatSection, group: 1 },
    { id: "diffs", label: "Diffs", icon: FileDiffIcon, component: DiffsSection, group: 1 },
    {
      id: "keybindings",
      label: "Keybindings",
      icon: KeyboardIcon,
      component: KeybindingsSection,
      hubWide: true,
      group: 1,
    },
    {
      id: "snap-shot",
      label: "SnapShots",
      icon: SnapShotIcon,
      component: SnapShotSection,
      visible: ({ isDesktop }) => isDesktop,
      group: 1,
    },
    reserved("vault", "Vault", VaultIcon, 2),
    reserved("machines", "Machines", ServerIcon, 2),
    reserved("ai-accounts", "AI accounts", BotIcon, 2),
    reserved("grants-given", "Grants given", KeyRoundIcon, 2),
    reserved("plan", "Plan & usage", SparklesIcon, 2),
    { id: "about", label: "About", icon: InfoIcon, component: AboutSection, group: 3 },
  ],
  space: [
    reserved("general", "General", Settings2Icon, 0),
    reserved("members", "Members", UserIcon, 0),
    reserved("invitations", "Invitations", UserIcon, 0),
    reserved("vault", "Vault", VaultIcon, 1),
    reserved("ai-accounts", "AI accounts", BotIcon, 1),
    reserved("machines", "Machines", ServerIcon, 1),
    reserved("grants-to-accept", "Grants to accept", KeyRoundIcon, 1),
    reserved("scheduled-tasks", "Scheduled tasks", CalendarClockIcon, 2),
    reserved("archive", "Archive", InfoIcon, 2),
  ],
  project: [],
  platform: [
    reserved("users", "Users", UserIcon, 0),
    reserved("audit-log", "Audit log", ShieldCheckIcon, 0),
    reserved("master-key", "Master key", KeyRoundIcon, 0),
    reserved("ai-gateway", "AI gateway", BotIcon, 1),
    reserved("sandboxes", "Sandboxes", ServerIcon, 1),
    reserved("hub-machine", "Hub machine", ServerIcon, 1),
    reserved("hub-defaults", "Hub defaults", Settings2Icon, 1),
    reserved("labs", "Labs", InfoIcon, 2),
  ],
};

export const SETTINGS_MODAL_LABELS: Readonly<Record<SettingsModalId, string>> = {
  user: "User",
  space: "Space",
  project: "Project",
  platform: "Platform",
};

export function isSettingsSectionVisible(
  modal: SettingsModalId,
  section: SettingsModalSection,
  context: SettingsVisibilityContext,
): boolean {
  if (section.component === null) return false;
  if (modal === "platform" && !context.isOwner) return false;
  return section.visible?.(context) ?? true;
}

export function visibleSettingsSections(
  modal: SettingsModalId,
  context: SettingsVisibilityContext,
): ReadonlyArray<SettingsModalSection> {
  return SETTINGS_MODAL_SECTIONS[modal].filter((section) =>
    isSettingsSectionVisible(modal, section, context),
  );
}

export function findSettingsSection(
  modal: SettingsModalId,
  sectionId: string,
): SettingsModalSection | undefined {
  return SETTINGS_MODAL_SECTIONS[modal].find((section) => section.id === sectionId);
}

/** The modal a `/settings/...` URL belongs to; `null` for the old pages that have not moved yet. */
export function settingsModalForPathname(pathname: string): SettingsModalId | null {
  const [, root, modal] = pathname.split("/");
  if (root !== "settings") return null;
  return modal === "user" || modal === "space" || modal === "project" || modal === "platform"
    ? modal
    : null;
}

/** The pages that moved into a modal, by their old path. A new old URL is a new row. */
export const OLD_SETTINGS_PATHS: Readonly<Record<string, string>> = {
  "/settings": "/settings/user/general",
  "/settings/user": "/settings/user/general",
  "/settings/general": "/settings/user/general",
  "/settings/appearance": "/settings/user/appearance",
  "/settings/chat": "/settings/user/chat",
  "/settings/diffs": "/settings/user/diffs",
  "/settings/keybindings": "/settings/user/keybindings",
  "/settings/snap-shot": "/settings/user/snap-shot",
  "/settings/about": "/settings/user/about",
  "/settings/open-source-licenses": "/settings/user/about/licenses",
  // Names older than the modals.
  "/settings/integrations": "/settings/browser",
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/labs",
};

/** Section anchors that moved but are not search results themselves. */
export const MOVED_SECTION_ANCHORS: Readonly<Record<string, string>> = {
  "legacy-features": "/settings/labs",
  "text-generation": "/settings/threads",
  about: "/settings/user/about",
};
