import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  ArchiveIcon,
  BotIcon,
  NetworkIcon,
  CalendarClockIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  UserIcon,
  VaultIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  revealSettingsSearchTarget,
  SETTINGS_SECTION_LABELS,
  settingsItemDestination,
  settingsItemPath,
  type SettingsDestination,
  settingsItemSectionLabel,
  settingsNavGroupsFor,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import {
  SETTINGS_MODAL_SECTIONS,
  settingsModalForPathname,
  visibleSettingsSections,
  type SettingsModalId,
} from "./settingsModals";
import { useSettingsVisibility } from "./useSettingsVisibility";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";
import { useSettingsSectionNavigation } from "./useSettingsSectionNavigation";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { usePrimaryActsForInstallation } from "../../environments/primary";

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/diagnostics": WrenchIcon,
  "/settings/providers": BotIcon,
  "/settings/ai-gateway": NetworkIcon,
  "/settings/ai-accounts": KeyRoundIcon,
  "/settings/threads": MessagesSquareIcon,
  "/settings/browser": GlobeIcon,
  "/settings/devices": SmartphoneIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/worktrees": FolderTreeIcon,
  "/settings/connections": ServerIcon,
  "/settings/access": ShieldCheckIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/vaults": VaultIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/labs": FlaskConicalIcon,
  "/settings/archived": ArchiveIcon,
};

// Detail pages without a nav entry highlight the page that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/maintenance",
};

interface SettingsNavEntry {
  /** The path that makes it the open section. */
  readonly key: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly target: SettingsDestination;
  /** Moving to another modal adds a history entry; moving between sections replaces it. */
  readonly replace: boolean;
}

interface SettingsNavGroup {
  readonly heading: string | null;
  readonly entries: ReadonlyArray<SettingsNavEntry>;
}

const userSectionTarget = (section: string): SettingsDestination => ({
  to: "/settings/user/$section",
  params: { section },
});

// The old pages not yet in a modal stay one click away from User settings, and the other way
// round, until their tickets move them. The last ticket removes both entries.
const USER_SETTINGS_ENTRY: SettingsNavEntry = {
  key: "/settings/user",
  label: "User settings",
  icon: UserIcon,
  target: userSectionTarget("general"),
  replace: false,
};
const MORE_SETTINGS_ENTRY: SettingsNavEntry = {
  key: "/settings/connections",
  label: "More settings",
  icon: ServerIcon,
  target: { to: "/settings/connections" },
  replace: false,
};

function legacyNavGroups(actsForInstallation: boolean): ReadonlyArray<SettingsNavGroup> {
  return [
    { heading: null, entries: [USER_SETTINGS_ENTRY] },
    ...settingsNavGroupsFor(actsForInstallation).map((group) => ({
      heading: group.heading,
      entries: group.paths.map((to) => ({
        key: to,
        label: SETTINGS_SECTION_LABELS[to],
        icon: SETTINGS_SECTION_ICONS[to],
        target: { to },
        replace: true,
      })),
    })),
  ];
}

function modalNavGroups(
  modal: "user" | "project",
  visibility: ReturnType<typeof useSettingsVisibility>,
  projectKey: string | undefined,
): ReadonlyArray<SettingsNavGroup> {
  // A Project's sections are its own: without one in the URL there is nothing to open.
  if (modal === "project" && projectKey === undefined) return [];
  const groups: SettingsNavEntry[][] = [];
  let previousGroup: number | null = null;
  for (const section of visibleSettingsSections(modal, visibility)) {
    if (section.group !== previousGroup) groups.push([]);
    previousGroup = section.group;
    groups.at(-1)?.push({
      key: `${modal}/${section.id}`,
      label: section.label,
      icon: section.icon,
      target:
        modal === "user"
          ? userSectionTarget(section.id)
          : {
              to: "/settings/project/$projectKey/$section",
              params: { projectKey: projectKey ?? "", section: section.id },
            },
      replace: true,
    });
  }
  return [
    ...groups.map((entries) => ({ heading: null, entries })),
    ...(modal === "user" ? [{ heading: null, entries: [MORE_SETTINGS_ENTRY] }] : []),
  ];
}

const MODAL_SECTION_ICONS: Readonly<
  Record<"user" | "project", Readonly<Record<string, ComponentType<{ className?: string }>>>>
> = {
  user: Object.fromEntries(
    SETTINGS_MODAL_SECTIONS.user.map((section) => [section.id, section.icon]),
  ),
  project: Object.fromEntries(
    SETTINGS_MODAL_SECTIONS.project.map((section) => [section.id, section.icon]),
  ),
};

/** The modals whose sections are built; the rest still show the old pages. */
function navModalFor(modal: SettingsModalId | null): "user" | "project" | null {
  return modal === "user" || modal === "project" ? modal : null;
}

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ item }: { item: SettingsSearchItem }) {
  const Icon =
    item.modal === undefined
      ? SETTINGS_SECTION_ICONS[item.to]
      : MODAL_SECTION_ICONS[item.modal][item.section];
  if (Icon === undefined) return null;
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navArea = workspaceAreaProps("settings-nav", 0, "Settings sections");
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = validateSettingsScopeSearch(currentSearch);
  const modal = navModalFor(settingsModalForPathname(pathname));
  const { projectKey } = useParams({ strict: false });
  // A section's subpages keep it open: its key is the modal and the section segment of the path.
  const activePath =
    modal === null
      ? (SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname)
      : `${modal}/${pathname.split("/")[modal === "project" ? 4 : 3] ?? ""}`;
  const visibility = useSettingsVisibility();
  // A Member of a Hub does not see the pages only its Owner changes.
  const actsForInstallation = usePrimaryActsForInstallation();
  const navGroups =
    modal === null
      ? legacyNavGroups(actsForInstallation)
      : modalNavGroups(modal, visibility, projectKey);
  const navEntries = navGroups.flatMap((group) => group.entries);
  const sectionNavigation = useSettingsSectionNavigation(
    navEntries.find((entry) => activePath === entry.key || activePath.startsWith(`${entry.key}/`))
      ?.key ??
      navEntries[0]?.key ??
      "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Below md the nav is an icon rail; searching expands it over the page.
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  // Each modal searches only its own sections.
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch).filter(
    (item) => (item.modal ?? null) === modal,
  );
  const results = searchSettings(query, searchableItems);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the find and slash search shortcuts
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      setCompactSearchOpen(true);
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search input DOM node after the compact search opens
  useEffect(() => {
    if (compactSearchOpen) searchInputRef.current?.focus();
  }, [compactSearchOpen]);

  const handleSectionClick = (entry: SettingsNavEntry) => {
    void navigate({
      ...entry.target,
      hash: "",
      replace: entry.replace,
      hashScrollIntoView: false,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    setCompactSearchOpen(false);
    const targetId = item.targetId ?? item.id;
    revealSettingsSearchTarget(targetId);
    if (pathname === settingsItemPath(item) && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    const destination = settingsItemDestination(item, { projectKey });
    if (destination === null) return;
    void navigate({
      ...destination,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <nav
      {...navArea}
      role="navigation"
      className={cn(
        "flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-14",
        compactSearchOpen &&
          "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10 max-md:w-full",
      )}
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                !compactSearchOpen && "max-md:hidden",
              )}
            >
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              {/* Native search inputs clear on Escape even during IME composition. */}
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => setCompactSearchOpen(true)}
                onBlur={() => {
                  if (!isSearching) setCompactSearchOpen(false);
                }}
                placeholder="Search"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "Settings search results" : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem
                    key={item.id}
                    role="presentation"
                    ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                  >
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon item={item} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {settingsItemSectionLabel(item)}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div className="flex flex-col gap-4">
                {compactSearchOpen ? null : (
                  <SidebarMenu className="md:hidden">
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Search settings"
                        onClick={() => setCompactSearchOpen(true)}
                      >
                        <SearchIcon />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                )}
                <div
                  {...sectionNavigation.containerProps}
                  role="tree"
                  aria-label="Settings sections"
                  className="flex flex-col gap-4"
                >
                  {navGroups.map((group, index) => (
                    <div
                      key={group.heading ?? index}
                      role="group"
                      aria-label={group.heading ?? undefined}
                      className="flex flex-col gap-1 max-md:border-t max-md:border-sidebar-border max-md:pt-4 max-md:first:border-t-0 max-md:first:pt-0"
                    >
                      {group.heading ? (
                        // The group carries this label; a heading is not a valid tree child.
                        <h3
                          aria-hidden="true"
                          className={cn(
                            "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
                            !compactSearchOpen && "max-md:hidden",
                          )}
                        >
                          {group.heading}
                        </h3>
                      ) : null}
                      <SidebarMenu role="presentation">
                        {group.entries.map((entry) => {
                          const Icon = entry.icon;
                          const isActive =
                            activePath === entry.key || activePath.startsWith(`${entry.key}/`);
                          return (
                            <SidebarMenuItem key={entry.key} role="presentation">
                              <SidebarMenuButton
                                data-settings-section={entry.key}
                                role="treeitem"
                                tabIndex={sectionNavigation.tabIndexFor(entry.key)}
                                aria-selected={isActive}
                                aria-current={isActive ? "page" : undefined}
                                isActive={isActive}
                                onClick={() => handleSectionClick(entry)}
                              >
                                <Icon />
                                <span
                                  className={cn("truncate", !compactSearchOpen && "max-md:sr-only")}
                                >
                                  {entry.label}
                                </span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}
