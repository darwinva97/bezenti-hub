import {
  ArchiveIcon,
  BotIcon,
  BoxIcon,
  FlaskConicalIcon,
  NetworkIcon,
  ScrollTextIcon,
  CalendarClockIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  FileDiffIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  LockKeyholeIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
  VaultIcon,
  createLucideIcon,
} from "lucide-react";
import {
  isSettingsSectionAllowed,
  type SettingsModalId,
  type SettingsPrincipal,
  type SpaceSettingsSubject,
} from "@t3tools/client-runtime/settings/modal-visibility";
import { lazy, type ComponentType } from "react";

import { isSecretsFeatureEnabled } from "../../env";

/**
 * The four settings modals. Each one is about one object and declares its sections here, in
 * order: the URL segment, the label, the icon, the component and who sees it. A section with no
 * component is reserved for a later ticket or spec: it owns a place in the URL space and the
 * order, and is never visible.
 */
export type { SettingsModalId };

export type ProjectSectionId = "general" | "vaults" | "machine" | "defaults" | "actions";

/**
 * Who is looking at Settings and, in a Space's modal, the Space. The rules that read it are shared
 * with the mobile app (`@t3tools/client-runtime/settings/modal-visibility`).
 */
export interface SettingsVisibilityContext extends SettingsPrincipal {
  readonly space?: SpaceSettingsSubject | null;
}

export interface SettingsModalSection {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** `null` reserves the section: it is never visible. */
  readonly component: ComponentType | null;
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

const ProjectGeneralSection = lazy(() =>
  import("./ProjectModalSections").then((module) => ({ default: module.ProjectGeneralSection })),
);
const ProjectVaultsSection = lazy(() =>
  import("./ProjectModalSections").then((module) => ({ default: module.ProjectVaultsSection })),
);
const ProjectMachineSection = lazy(() =>
  import("./ProjectModalSections").then((module) => ({ default: module.ProjectMachineSection })),
);
const ProjectDefaultsSection = lazy(() =>
  import("./ProjectModalSections").then((module) => ({ default: module.ProjectDefaultsSection })),
);
const ProjectActionsSection = lazy(() =>
  import("./ProjectModalSections").then((module) => ({ default: module.ProjectActionsSection })),
);

const SpaceGeneralSection = lazy(() =>
  import("./SpaceSettingsSections").then((module) => ({ default: module.SpaceGeneralSection })),
);
const SpaceMembersSection = lazy(() =>
  import("./SpaceSettingsSections").then((module) => ({ default: module.SpaceMembersSection })),
);
const SpaceInvitationsSection = lazy(() =>
  import("./SpaceSettingsSections").then((module) => ({
    default: module.SpaceInvitationsSection,
  })),
);

const SpaceScheduledTasksSection = lazy(() =>
  import("./SpaceScheduledTasksSection").then((module) => ({
    default: module.SpaceScheduledTasksSection,
  })),
);
const SpaceArchiveSection = lazy(() =>
  import("./ArchivedThreadsPanel").then((module) => ({ default: module.ArchivedThreadsPanel })),
);

const PlatformUsersSection = lazy(() =>
  import("./PlatformUsersSection").then((module) => ({ default: module.PlatformUsersSection })),
);
const PlatformAuditLogSection = lazy(() =>
  import("./PlatformAuditLogSection").then((module) => ({
    default: module.PlatformAuditLogSection,
  })),
);
const PlatformMasterKeySection = lazy(() =>
  import("./PlatformSections").then((module) => ({ default: module.PlatformMasterKeySection })),
);
const PlatformSecretProvidersSection = lazy(() =>
  import("./SecretsSettings").then((module) => ({ default: module.SecretsSettingsPanel })),
);
const PlatformSandboxesSection = lazy(() =>
  import("./PlatformSections").then((module) => ({ default: module.PlatformSandboxesSection })),
);
const PlatformAiGatewaySection = lazy(() =>
  import("./AiGatewaySettings").then((module) => ({ default: module.AiGatewaySettingsPanel })),
);
const PlatformLabsSection = lazy(() =>
  import("./LabsSettingsPanel").then((module) => ({ default: module.LabsSettingsPanel })),
);
const HubDefaultsSection = lazy(() =>
  import("./HubDefaultsSettings").then((module) => ({ default: module.HubDefaultsSettings })),
);

const HubMachineSection = lazy(() =>
  import("./MachinePages").then((module) => ({ default: module.HubMachineSection })),
);
const UserMachinesSection = lazy(() =>
  import("./MachinePages").then((module) => ({ default: module.UserMachinesSection })),
);

const UserVaultSection = lazy(() =>
  import("./OwnedResourceSections").then((module) => ({ default: module.UserVaultSection })),
);
const UserAiAccountsSection = lazy(() =>
  import("./OwnedResourceSections").then((module) => ({ default: module.UserAiAccountsSection })),
);
const SpaceVaultSection = lazy(() =>
  import("./OwnedResourceSections").then((module) => ({ default: module.SpaceVaultSection })),
);
const SpaceAiAccountsSection = lazy(() =>
  import("./OwnedResourceSections").then((module) => ({ default: module.SpaceAiAccountsSection })),
);
const SpaceMachinesSection = lazy(() =>
  import("./OwnedResourceSections").then((module) => ({ default: module.SpaceMachinesSection })),
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
      group: 1,
    },
    { id: "vault", label: "Vault", icon: VaultIcon, component: UserVaultSection, group: 2 },
    {
      id: "machines",
      label: "Machines",
      icon: ServerIcon,
      component: UserMachinesSection,
      group: 2,
    },
    {
      id: "ai-accounts",
      label: "AI accounts",
      icon: BotIcon,
      component: UserAiAccountsSection,
      group: 2,
    },
    reserved("grants-given", "Grants given", KeyRoundIcon, 2),
    reserved("plan", "Plan & usage", SparklesIcon, 2),
    { id: "about", label: "About", icon: InfoIcon, component: AboutSection, group: 3 },
  ],
  space: [
    {
      id: "general",
      label: "General",
      icon: Settings2Icon,
      component: SpaceGeneralSection,
      group: 0,
    },
    { id: "members", label: "Members", icon: UsersIcon, component: SpaceMembersSection, group: 0 },
    {
      id: "invitations",
      label: "Invitations",
      icon: UserPlusIcon,
      component: SpaceInvitationsSection,
      group: 0,
    },
    { id: "vault", label: "Vault", icon: VaultIcon, component: SpaceVaultSection, group: 1 },
    {
      id: "ai-accounts",
      label: "AI accounts",
      icon: BotIcon,
      component: SpaceAiAccountsSection,
      group: 1,
    },
    {
      id: "machines",
      label: "Machines",
      icon: ServerIcon,
      component: SpaceMachinesSection,
      group: 1,
    },
    reserved("grants-to-accept", "Grants to accept", KeyRoundIcon, 1),
    {
      id: "scheduled-tasks",
      label: "Scheduled tasks",
      icon: CalendarClockIcon,
      component: SpaceScheduledTasksSection,
      group: 2,
    },
    {
      id: "archive",
      label: "Archive",
      icon: ArchiveIcon,
      component: SpaceArchiveSection,
      group: 2,
    },
  ],
  project: [
    {
      id: "general",
      label: "General",
      icon: Settings2Icon,
      component: ProjectGeneralSection,
      group: 0,
    },
    { id: "vaults", label: "Vaults", icon: VaultIcon, component: ProjectVaultsSection, group: 0 },
    {
      id: "machine",
      label: "Machine",
      icon: ServerIcon,
      component: ProjectMachineSection,
      group: 0,
    },
    {
      id: "defaults",
      label: "Defaults",
      icon: SlidersHorizontalIcon,
      component: ProjectDefaultsSection,
      group: 0,
    },
    {
      id: "actions",
      label: "Actions",
      icon: SquareTerminalIcon,
      component: ProjectActionsSection,
      group: 0,
    },
  ],
  platform: [
    { id: "users", label: "Users", icon: UsersIcon, component: PlatformUsersSection, group: 0 },
    {
      id: "audit-log",
      label: "Audit log",
      icon: ScrollTextIcon,
      component: PlatformAuditLogSection,
      group: 0,
    },
    {
      id: "master-key",
      label: "Master key",
      icon: KeyRoundIcon,
      component: PlatformMasterKeySection,
      group: 0,
    },
    {
      id: "secret-providers",
      label: "Secret providers",
      icon: LockKeyholeIcon,
      // Behind `T3CODE_FEATURE_SECRETS`: reserved (never visible) while the flag is off.
      component: isSecretsFeatureEnabled ? PlatformSecretProvidersSection : null,
      group: 0,
    },
    {
      id: "ai-gateway",
      label: "AI gateway",
      icon: NetworkIcon,
      component: PlatformAiGatewaySection,
      group: 1,
    },
    {
      id: "sandboxes",
      label: "Sandboxes",
      icon: BoxIcon,
      component: PlatformSandboxesSection,
      group: 1,
    },
    {
      id: "hub-machine",
      label: "Hub machine",
      icon: ServerIcon,
      component: HubMachineSection,
      group: 1,
    },
    {
      id: "hub-defaults",
      label: "Hub defaults",
      icon: SlidersHorizontalIcon,
      component: HubDefaultsSection,
      group: 1,
    },
    reserved("registration", "Registration", UserPlusIcon, 2),
    reserved("keycloak", "Keycloak", KeyRoundIcon, 2),
    reserved("plans", "Plans", SparklesIcon, 2),
    reserved("terms", "Terms", ScrollTextIcon, 2),
    {
      id: "labs",
      label: "Labs",
      icon: FlaskConicalIcon,
      component: PlatformLabsSection,
      group: 3,
    },
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
  return isSettingsSectionAllowed(modal, section.id, context, context.space ?? null);
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

/**
 * `/settings/projects?project=…&machine=…&checkout=…` and its anchor, as the Project modal. The
 * Project moves from the query into the path; machine and checkout stay in the query.
 */
export function oldProjectSettingsUrl(
  pathname: string,
  search: {
    readonly project?: string | undefined;
    readonly machine?: string | undefined;
    readonly checkout?: string | undefined;
  },
  section: ProjectSectionId = "general",
): string | null {
  if (pathname !== "/settings/projects" || !search.project) return null;
  const query = new URLSearchParams();
  if (search.machine) query.set("machine", search.machine);
  if (search.checkout) query.set("checkout", search.checkout);
  const queryString = query.size > 0 ? `?${query}` : "";
  return `/settings/project/${encodeURIComponent(search.project)}/${section}${queryString}`;
}

/**
 * A Space's modal for the Space that is current, as old links and in-app links name it:
 * `/settings/space/current/<section>` stands for the current Space's id.
 */
export const CURRENT_SPACE_SEGMENT = "current";

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
  "/settings/archived": `/settings/space/${CURRENT_SPACE_SEGMENT}/archive`,
  "/settings/scheduled-tasks": `/settings/space/${CURRENT_SPACE_SEGMENT}/scheduled-tasks`,
  "/settings/access": "/settings/user/sessions",
  "/settings/ai-gateway": "/settings/platform/ai-gateway",
  "/settings/threads": "/settings/platform/hub-defaults/threads",
  "/settings/browser": "/settings/platform/hub-defaults/browser",
  "/settings/worktrees": "/settings/platform/hub-defaults/worktrees",
  "/settings/labs": "/settings/platform/labs",
  // Names older than the modals.
  "/settings/integrations": "/settings/platform/hub-defaults/browser",
  "/settings/storage": "/settings/maintenance",
  // Owned resources: the User's own sections. An Organization's anchor goes to its Space settings.
  "/settings/vaults": "/settings/user/vault",
  "/settings/ai-accounts": "/settings/user/ai-accounts",
  "/settings/connections": "/settings/user/machines",
  "/settings/beta": "/settings/platform/labs",
  "/settings/secrets": "/settings/platform/secret-providers",
};

/** Section anchors that moved but are not search results themselves. */
export const MOVED_SECTION_ANCHORS: Readonly<Record<string, string>> = {
  "legacy-features": "/settings/platform/labs",
  "text-generation": "/settings/platform/hub-defaults/threads",
  about: "/settings/user/about",
  "default-vaults": `/settings/space/${CURRENT_SPACE_SEGMENT}/vault`,
  "hub-environments": "/settings/user/machines",
};

/** The anchor prefix of an owner's block on each old page of owned resources, and its section. */
const OWNER_ANCHORS: Readonly<
  Record<string, { readonly prefix: string; readonly section: "vault" | "ai-accounts" }>
> = {
  "/settings/vaults": { prefix: "vault-owner-", section: "vault" },
  "/settings/ai-accounts": { prefix: "ai-accounts-owner-", section: "ai-accounts" },
};

/**
 * An Organization's block of the old Vaults or AI accounts page (`#vault-owner-<Space id>`) is its
 * Space settings. The User's own block, and an id that is not a Space the directory lists (so
 * before it has loaded), stay with the page's own redirect to User settings.
 */
export function oldOwnerAnchorUrl(
  pathname: string,
  hash: string,
  knownSpaceIds: ReadonlySet<string>,
): string | null {
  const anchors = OWNER_ANCHORS[pathname];
  if (anchors === undefined || !hash.startsWith(anchors.prefix)) return null;
  const spaceId = hash.slice(anchors.prefix.length);
  if (!knownSpaceIds.has(spaceId)) return null;
  return `/settings/space/${encodeURIComponent(spaceId)}/${anchors.section}`;
}
