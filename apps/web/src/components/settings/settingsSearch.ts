import { isElectron, isSecretsFeatureEnabled } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";
import {
  MOVED_SECTION_ANCHORS,
  CURRENT_SPACE_SEGMENT,
  OLD_SETTINGS_PATHS,
  SETTINGS_MODAL_LABELS,
  findSettingsSection,
  type ProjectSectionId,
} from "./settingsModals";

/** The pages that still live in the old Settings nav; the rest moved into a modal. */
export type SettingsPath =
  | "/settings/ai-accounts"
  | "/settings/connections"
  | "/settings/secrets"
  | "/settings/vaults";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

/** Where a setting lives: a page of the old nav, or a section of a modal. */
export type SettingsSearchLocation =
  | { readonly to: SettingsPath; readonly modal?: undefined; readonly section?: undefined }
  | {
      readonly modal: "user" | "space" | "project" | "platform";
      readonly section: string;
      /** A page inside the section, such as Hub defaults → Threads. */
      readonly subsection?: string;
      readonly to?: undefined;
    };

export type SettingsSearchItem = SettingsSearchItemBase & SettingsSearchLocation;

interface SettingsSearchItemBase {
  readonly id: string;
  readonly title: string;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly secretsFeatureOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  /** False for a Member of a Hub: its Owner-only pages (`SETTINGS_OWNER_ONLY_PATHS`) are hidden. */
  readonly actsForInstallation?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/ai-accounts": "AI accounts",
  "/settings/connections": "Environments",
  "/settings/secrets": "Secrets",
  "/settings/vaults": "Vaults",
};

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: "Agents",
    paths: ["/settings/ai-accounts"],
  },
  {
    heading: "Connections",
    paths: [
      "/settings/connections",
      "/settings/vaults",
      ...(isSecretsFeatureEnabled ? (["/settings/secrets"] as const) : []),
    ],
  },
];

/** Pages on the Installation as a whole (secrets): only the Owner of a Hub changes them. */
export const SETTINGS_OWNER_ONLY_PATHS: ReadonlySet<SettingsPath> = new Set<SettingsPath>([
  "/settings/secrets",
]);

/** The Settings nav for this session: without the Owner-only pages for a Member. */
export function settingsNavGroupsFor(actsForInstallation: boolean): typeof SETTINGS_NAV_GROUPS {
  if (actsForInstallation) return SETTINGS_NAV_GROUPS;
  return SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    paths: group.paths.filter((path) => !SETTINGS_OWNER_ONLY_PATHS.has(path)),
  })).filter((group) => group.paths.length > 0);
}

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    modal: "user" as const,
    section: "keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`,
        modal: "platform" as const,
        section: "hub-machine",
        subsection: "source-control",
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "Keep worktrees with local changes",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "Delete now",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: "Worktree cleanup",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    scope: "project-defaults",
    searchTerms: [
      "disk storage automatic delete deleted archived threads old inactive merged settled unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Artifacts and logs",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "disk storage delete old browser artifacts screenshots captures rotated logs cleanup retention",
    ],
  },
  {
    id: "project-defaults",
    title: "Project defaults and overrides",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: "Project overview",
    modal: "project",
    section: "general",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "platform-users",
    title: "Users",
    modal: "platform",
    section: "users",
    searchTerms: ["people accounts disable turn off remove sign in owner permissions"],
  },
  {
    id: "audit-log",
    title: "Audit log",
    modal: "platform",
    section: "audit-log",
    searchTerms: ["history who did what invitations roles deletions approvals security"],
  },
  {
    id: "master-key",
    title: "Master key",
    modal: "platform",
    section: "master-key",
    searchTerms: ["encryption secrets vault key rotate recovery"],
  },
  {
    id: "hub-sandboxes",
    title: "Sandboxes",
    modal: "platform",
    section: "sandboxes",
    searchTerms: ["containers podman limits cpu memory disk"],
  },
  {
    id: "sandbox-image",
    title: "Sandbox image",
    modal: "platform",
    section: "sandboxes",
    searchTerms: ["container image build rebuild base"],
  },
  {
    id: "space-members",
    title: "Members",
    modal: "space",
    section: "members",
    searchTerms: ["people team roles admin guest remove reset link organization"],
  },
  {
    id: "space-invitations",
    title: "Invitations",
    modal: "space",
    section: "invitations",
    searchTerms: ["invite people link join organization revoke"],
  },
  {
    id: "space-lifecycle",
    title: "Archive, restore or delete organization",
    modal: "space",
    section: "general",
    searchTerms: ["leave space lifecycle remove"],
  },
  {
    id: "default-model",
    title: "Default model",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    id: "fallback-model",
    title: "Fallback model",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "environment-defaults",
    searchTerms: ["fallback agent provider out of usage new threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    title: "Permissions",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    modal: "user",
    section: "appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    modal: "user",
    section: "appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "Contrast",
    modal: "user",
    section: "appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    modal: "user",
    section: "appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    title: "Diff colors",
    modal: "user",
    section: "diffs",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: "Chat width",
    modal: "user",
    section: "appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    title: "Thread details",
    modal: "user",
    section: "appearance",
    searchTerms: [
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "effort-display",
    title: "Effort display",
    modal: "user",
    section: "appearance",
    searchTerms: ["reasoning effort thinking bars graph word label level composer"],
  },
  {
    id: "math-rendering",
    title: "Render math",
    modal: "user",
    section: "appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    title: "Panel animations",
    modal: "user",
    section: "appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    modal: "user",
    section: "appearance",
    searchTerms: ["dev nightly latest channel artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    title: "Interface font",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: "Code font",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    title: "Separate fonts",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography advanced prompt code terminal font family size individually"],
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    modal: "user",
    section: "appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    modal: "user",
    section: "appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "composer-context",
    title: "Composer context",
    modal: "user",
    section: "appearance",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    modal: "user",
    section: "general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: "Project order",
    modal: "user",
    section: "general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-options",
    title: "Snooze options",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    title: "Snooze until limits reset",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "Resume after usage limits",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "working-shelf",
    title: "Working section",
    modal: "user",
    section: "general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "boring-sidebar",
    title: "Boring sidebar (group by project)",
    modal: "platform",
    section: "labs",
    searchTerms: ["beta folders project tree legacy old classic sidebar"],
  },
  {
    id: "boring-sidebar-multiline",
    title: "Two-line folder rows",
    modal: "platform",
    section: "labs",
    searchTerms: ["beta boring sidebar folder rows multiline branch pull request details"],
  },
  {
    id: "guest-links",
    title: "Guest links",
    modal: "platform",
    section: "labs",
    scope: "environment",
    searchTerms: ["beta share guest invite link teammate watch public address"],
  },
  {
    id: "simlock-hosts",
    title: "Simlock device hosts (alpha)",
    modal: "platform",
    section: "labs",
    scope: "environment",
    searchTerms: ["beta alpha simlock callstack simulator emulator ios android pool lease gateway"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    title: "Compact idle threads",
    modal: "platform",
    section: "hub-machine",
    subsection: "providers",
    scope: "environment-defaults",
    searchTerms: ["claude context compaction idle cache tokens usage summary resume"],
  },
  {
    id: "auto-settle-merged-threads",
    title: "Auto-settle merged threads",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    title: "Keep threads with a PR",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["pull request inactivity auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: "Days of inactivity before auto-settle",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: "Thread notifications",
    modal: "user",
    section: "general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    title: "In-app notifications",
    modal: "user",
    section: "general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    title: "Time format",
    modal: "user",
    section: "general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "Response streaming",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    modal: "user",
    section: "diffs",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    title: "Default diff file state",
    modal: "user",
    section: "diffs",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: "Diff layout",
    modal: "user",
    section: "diffs",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: "Open pull requests and changes panels proactively",
    modal: "user",
    section: "diffs",
    searchTerms: ["proactive automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    title: "Show skills in slash menu",
    modal: "user",
    section: "chat",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: "Rich text composer",
    modal: "user",
    section: "chat",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    title: "Send shortcut",
    modal: "user",
    section: "chat",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: "Follow-up behavior",
    modal: "user",
    section: "chat",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    searchTerms: [
      "installed cli versions newer available codex claude cursor grok fx kiro opencode",
    ],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue threads after restarts",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "New threads",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Submodules",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    title: "Start from remote",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "unpin-confirmation",
    title: "Unpin confirmation",
    modal: "user",
    section: "general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    modal: "user",
    section: "general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    modal: "user",
    section: "general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: "Quit shortcut",
    modal: "user",
    section: "general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    title: "Thread title instructions",
    modal: "platform",
    section: "hub-defaults",
    subsection: "threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    title: "Version",
    modal: "user",
    section: "about",
    searchTerms: ["about release build"],
  },
  {
    id: "cli-command",
    title: "t3 command",
    modal: "user",
    section: "about",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "mobile-app",
    title: "Mobile app",
    modal: "user",
    section: "about",
    searchTerms: ["phone tablet iPhone iPad iOS Android App Store Google Play QR"],
  },
  {
    id: "telemetry-export",
    title: "OpenTelemetry export",
    modal: "platform",
    section: "hub-machine",
    subsection: "diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: "Open source licenses",
    modal: "user",
    section: "about",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    modal: "platform",
    section: "labs",
    searchTerms: ["build plan composer old"],
  },
  {
    id: "legacy-context-window-indicator",
    title: "Context window indicator (legacy)",
    modal: "platform",
    section: "labs",
    searchTerms: ["composer meter usage tokens circle old"],
  },
  {
    id: "keybindings",
    title: "Keybindings",
    modal: "user",
    section: "keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: "SnapShots",
    searchTerms: ["window capture screenshot"],
    modal: "user",
    section: "snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    title: "Include app text",
    modal: "user",
    section: "snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    title: "Capture shortcut",
    modal: "user",
    section: "snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-sound",
    title: "Capture sound",
    modal: "user",
    section: "snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    title: "Capture flash",
    modal: "user",
    section: "snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    title: "Capture animations",
    modal: "user",
    section: "snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    title: "Providers",
    modal: "platform",
    section: "hub-machine",
    subsection: "providers",
    searchTerms: [
      "agents cli codex claude cursor grok fx kiro opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "usage-providers",
    title: "Usage providers",
    modal: "platform",
    section: "hub-machine",
    subsection: "providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "cursor-keychain-usage",
    title: "Cursor account usage",
    modal: "platform",
    section: "hub-machine",
    subsection: "providers",
    searchTerms: ["cursor macOS keychain usage tokens cost limits permission"],
    providerSettingsOnly: true,
    macProviderSettingsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: "Health check interval",
    modal: "platform",
    section: "hub-machine",
    subsection: "providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "device-sources",
    title: "Device sources",
    modal: "platform",
    section: "hub-machine",
    subsection: "devices",
    searchTerms: [
      "device hosts ssh remote mac mini identity key connection eas expo cloud simlock pool gateway local simulators",
    ],
  },
  {
    id: "agent-device-access",
    title: "Agents can use devices",
    modal: "platform",
    section: "hub-machine",
    subsection: "devices",
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: "Use devices",
    modal: "platform",
    section: "hub-machine",
    subsection: "devices",
    targetId: "devices",
    searchTerms: ["device hub simulator emulator ios android install start version"],
  },
  {
    id: "device-platform-support",
    title: "Local simulators",
    modal: "platform",
    section: "hub-machine",
    subsection: "devices",
    targetId: "device-sources",
    searchTerms: ["simulator support xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    title: "Browser profiles",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: "Default browser profile",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: "Browser recording frame rate",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
  },
  {
    id: "browser-recording-key-presses",
    title: "Show key presses in recordings",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: "Show mouse presses in recordings",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: "Open links in",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    title: "Search engine",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom url"],
  },
  {
    id: "pull-request-links-open-in-app",
    title: "Open pull requests in T3 Code",
    modal: "user",
    section: "diffs",
    searchTerms: [
      `pr commit links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    modal: "platform",
    section: "hub-defaults",
    subsection: "browser",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "automatic-pull",
    title: "Automatically pull",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "Remove agent credits when merging",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    title: "Default merge method",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: "Source control",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    targetId: "background-activity",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "Worktree branch naming",
    modal: "platform",
    section: "hub-defaults",
    subsection: "worktrees",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: "Source control writing style",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "Follow change request templates",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "Source control writer model",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    title: "Review guides (beta)",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    searchTerms: ["pull request pr guided review guide tour beta experimental"],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    title: "Review guide model",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    // Hidden until review guides are on, so a search lands on the switch that shows it.
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide brief maintainer"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    title: "Review guide instructions",
    modal: "platform",
    section: "hub-machine",
    subsection: "source-control",
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide preferences taste prompt custom"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "Actions",
    modal: "project",
    section: "actions",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: "Environment icon",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: "Local environment",
    modal: "user",
    section: "machines",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "joined-environment",
    title: "Use this computer as an Environment",
    modal: "user",
    section: "machines",
    searchTerms: ["join hub machine laptop pc run threads here leave t3 join background"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "Network access",
    modal: "user",
    section: "machines",
    subsection: "network",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: "Tailscale HTTPS",
    modal: "user",
    section: "machines",
    subsection: "network",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "WSL backend",
    modal: "user",
    section: "machines",
    subsection: "network",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "connections-environment",
    title: "This machine",
    modal: "platform",
    section: "hub-machine",
    subsection: "maintenance",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "account",
    title: "Your account",
    modal: "user",
    section: "account",
    searchTerms: [
      "sign in methods passkey password authenticator app totp two factor login sign out",
    ],
  },
  {
    id: "authorized-clients",
    title: "Your sessions",
    modal: "user",
    section: "sessions",
    searchTerms: [
      "authorized clients pairing links qr code revoke devices sign out other sessions permissions scopes",
    ],
  },
  {
    id: "remote-environments",
    title: "Hub of this app",
    modal: "user",
    section: "account",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved tailscale"],
    desktopOnly: true,
  },
  {
    id: "pull-request-routing",
    title: "Pull request sharing",
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "secret-providers",
    title: "Secret providers",
    to: "/settings/secrets",
    searchTerms: ["1password vault credentials api key"],
    secretsFeatureOnly: true,
  },
  {
    id: "secret-providers-add",
    title: "Add secret provider",
    to: "/settings/secrets",
    targetId: "secret-providers",
    searchTerms: ["new 1password vault op cli account"],
    secretsFeatureOnly: true,
  },
  {
    id: "ai-gateway",
    title: "AI gateway",
    modal: "platform",
    section: "ai-gateway",
    searchTerms: ["cliproxyapi cli proxy api update roll back version subscriptions"],
  },
  {
    id: "ai-accounts",
    title: "AI accounts",
    to: "/settings/ai-accounts",
    searchTerms: ["api key anthropic openai gemini vertex xai openrouter deepseek allow priority"],
  },
  {
    id: "archive",
    title: "Archived threads",
    modal: "space",
    section: "archive",
    searchTerms: ["restore reopen deleted history projects"],
  },
  {
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    modal: "space",
    section: "scheduled-tasks",
    searchTerms: ["automations recurring cron webhook schedule task run"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/ai-accounts": null,
  "/settings/connections": "connections",
  "/settings/secrets": null,
  "/settings/vaults": null,
};

// Pages of the old nav whose rows moved elsewhere; a link to one follows its anchor.
const SPLIT_LEGACY_PATHS: ReadonlySet<string> = new Set([
  "/settings/source-control",
  "/settings/connections",
  "/settings/access",
]);

/** The URL path of the page or modal section a setting lives on. */
export function settingsItemPath(item: SettingsSearchLocation): string {
  // A Project's own settings need its key; without one the old page finds the Project of the context.
  if (item.modal === "project") return "/settings/projects";
  // A Space's own settings need its id; without one they are the current Space's.
  if (item.modal === "space") return `/settings/space/${CURRENT_SPACE_SEGMENT}/${item.section}`;
  if (item.modal === "platform") {
    if (item.section === "hub-machine" && item.subsection === "diagnostics") {
      return "/settings/platform/hub-machine/maintenance/diagnostics";
    }
    return `/settings/platform/${item.section}${item.subsection === undefined ? "" : `/${item.subsection}`}`;
  }
  return item.modal === undefined ? item.to : `/settings/${item.modal}/${item.section}`;
}

export type SettingsDestination =
  | { readonly to: SettingsPath }
  | { readonly to: "/settings/user/$section"; readonly params: { readonly section: string } }
  | { readonly to: "/settings/platform/$section"; readonly params: { readonly section: string } }
  | {
      readonly to: "/settings/platform/hub-machine/$machineSection";
      readonly params: { readonly machineSection: string };
    }
  | { readonly to: "/settings/platform/hub-machine/maintenance/diagnostics" }
  | {
      readonly to: "/settings/user/machines/$environmentId/$machineSection";
      readonly params: { readonly environmentId: string; readonly machineSection: string };
    }
  | {
      readonly to: "/settings/platform/hub-defaults/$subsection";
      readonly params: { readonly subsection: string };
    }
  | {
      readonly to: "/settings/space/$spaceId/$section";
      readonly params: { readonly spaceId: string; readonly section: string };
    }
  | {
      readonly to: "/settings/project/$projectKey/$section";
      readonly params: { readonly projectKey: string; readonly section: string };
    };

/**
 * The router destination of the page or modal section a setting lives on. A Project's setting
 * goes to the Project of the context and a Space's to the current Space; with none, it has no
 * destination.
 */
export function settingsItemDestination(
  item: SettingsSearchLocation,
  {
    projectKey,
    spaceId,
    primaryEnvironmentId,
  }: {
    readonly projectKey?: string | undefined;
    readonly spaceId?: string | undefined;
    /** This computer's backend on the desktop, whose machine page the Network rows live on. */
    readonly primaryEnvironmentId?: string | null | undefined;
  } = {},
): SettingsDestination | null {
  if (item.modal === undefined) return { to: item.to };
  if (item.modal === "user") {
    if (item.section === "machines" && item.subsection !== undefined) {
      if (primaryEnvironmentId === undefined || primaryEnvironmentId === null) return null;
      return {
        to: "/settings/user/machines/$environmentId/$machineSection",
        params: { environmentId: primaryEnvironmentId, machineSection: item.subsection },
      };
    }
    return { to: "/settings/user/$section", params: { section: item.section } };
  }
  if (item.modal === "platform") {
    if (item.subsection === undefined) {
      return { to: "/settings/platform/$section", params: { section: item.section } };
    }
    if (item.section === "hub-machine") {
      return item.subsection === "diagnostics"
        ? { to: "/settings/platform/hub-machine/maintenance/diagnostics" }
        : {
            to: "/settings/platform/hub-machine/$machineSection",
            params: { machineSection: item.subsection },
          };
    }
    return {
      to: "/settings/platform/hub-defaults/$subsection",
      params: { subsection: item.subsection },
    };
  }
  if (item.modal === "space") {
    if (spaceId === undefined) return null;
    return { to: "/settings/space/$spaceId/$section", params: { spaceId, section: item.section } };
  }
  if (projectKey === undefined) return null;
  return {
    to: "/settings/project/$projectKey/$section",
    params: { projectKey, section: item.section },
  };
}

/** The label of the page or modal section a setting lives on. */
export function settingsItemSectionLabel(item: SettingsSearchLocation): string {
  if (item.modal === undefined) return SETTINGS_SECTION_LABELS[item.to];
  return findSettingsSection(item.modal, item.section)?.label ?? item.section;
}

/** «User · Appearance» for a setting in a modal, «Settings · Providers» for an old page. */
export function settingsItemBreadcrumb(item: SettingsSearchLocation): string {
  const prefix = item.modal === undefined ? "Settings" : SETTINGS_MODAL_LABELS[item.modal];
  return `${prefix} · ${settingsItemSectionLabel(item)}`;
}

/** The section of the Project modal an old `/settings/projects` anchor lives in. */
export function projectSectionForAnchor(hash: string): ProjectSectionId {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = items.find((item) => item.id === hash || item.targetId === hash);
  return anchored?.modal === "project" ? (anchored.section as ProjectSectionId) : "general";
}

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function resolveOldSettingsUrl(pathname: string, hash: string): string | null {
  const moved = OLD_SETTINGS_PATHS[pathname];
  if (moved === undefined && !SPLIT_LEGACY_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    (anchored ? settingsItemPath(anchored) : undefined) ??
    MOVED_SECTION_ANCHORS[hash] ??
    moved ??
    null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? (item.modal === undefined ? SETTINGS_CATEGORY_SCOPES[item.to] : null),
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (availability.actsForInstallation !== false ||
        item.modal !== undefined ||
        !SETTINGS_OWNER_ONLY_PATHS.has(item.to)),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.secretsFeatureOnly || isSecretsFeatureEnabled) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(settingsItemSectionLabel(item)),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

// These rows only exist with separate fonts on, so a search jump to one turns them on.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
]);

export function isAdvancedTypographyTarget(targetId: string): boolean {
  return ADVANCED_TYPOGRAPHY_TARGET_IDS.has(targetId);
}

/**
 * Opens the persisted section a search result lives in before jumping to it, so
 * its row is mounted to scroll to. The terminal reads the same flag, so it must
 * stay on after the jump.
 */
export function revealSettingsSearchTarget(targetId: string): void {
  if (isAdvancedTypographyTarget(targetId)) {
    writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, true, false, Schema.Boolean);
  }
}
