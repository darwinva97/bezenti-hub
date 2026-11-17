import {
  isSettingsSectionAllowed,
  type SpaceSettingsSubject,
} from "@t3tools/client-runtime/settings/modal-visibility";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SETTINGS_MODAL_SECTIONS,
  findSettingsSection,
  oldProjectSettingsUrl,
  isSettingsSectionVisible,
  visibleSettingsSections,
  type SettingsModalId,
  type SettingsVisibilityContext,
} from "./settingsModals";
import {
  SETTINGS_SECTION_LABELS,
  projectSectionForAnchor,
  resolveOldSettingsUrl,
} from "./settingsSearch";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isSecretsFeatureEnabled: false,
}));

/** Every old link, with its anchor, and the place it leads to. A new old URL is a new row. */
const OLD_URLS: ReadonlyArray<readonly [pathname: string, hash: string, to: string]> = [
  ["/settings", "", "/settings/user/general"],
  ["/settings/user", "", "/settings/user/general"],
  ["/settings/general", "", "/settings/user/general"],
  ["/settings/general", "time-format", "/settings/user/general"],
  ["/settings/general", "text-generation-model", "/settings/platform/hub-defaults/threads"],
  ["/settings/appearance", "", "/settings/user/appearance"],
  ["/settings/appearance", "theme", "/settings/user/appearance"],
  ["/settings/appearance", "diff-color-scheme", "/settings/user/diffs"],
  ["/settings/chat", "", "/settings/user/chat"],
  ["/settings/diffs", "", "/settings/user/diffs"],
  ["/settings/keybindings", "", "/settings/user/keybindings"],
  ["/settings/keybindings", "keybinding-sidebar.toggle", "/settings/user/keybindings"],
  ["/settings/snap-shot", "", "/settings/user/snap-shot"],
  ["/settings/about", "", "/settings/user/about"],
  ["/settings/open-source-licenses", "", "/settings/user/about/licenses"],
  ["/settings/archived", "", "/settings/space/current/archive"],
  ["/settings/archived", "archive", "/settings/space/current/archive"],
  ["/settings/scheduled-tasks", "", "/settings/space/current/scheduled-tasks"],
  ["/settings/scheduled-tasks", "scheduled-tasks", "/settings/space/current/scheduled-tasks"],
  ["/settings/connections", "about", "/settings/user/about"],
  ["/settings/connections", "authorized-clients", "/settings/user/sessions"],
  ["/settings/access", "authorized-clients", "/settings/user/sessions"],
  ["/settings/access", "account", "/settings/user/account"],
  ["/settings/connections", "remote-environments", "/settings/user/account"],
  ["/settings/connections", "network-access", "/settings/access"],
  [
    "/settings/source-control",
    "worktree-branch-naming",
    "/settings/platform/hub-defaults/worktrees",
  ],
  ["/settings/storage", "storage-worktrees", "/settings/platform/hub-defaults/worktrees"],
  ["/settings/storage", "", "/settings/maintenance"],
  ["/settings/integrations", "devices", "/settings/devices"],
  ["/settings/beta", "", "/settings/platform/labs"],
  ["/settings/labs", "", "/settings/platform/labs"],
  ["/settings/labs", "legacy-features", "/settings/platform/labs"],
  ["/settings/ai-gateway", "", "/settings/platform/ai-gateway"],
  ["/settings/threads", "", "/settings/platform/hub-defaults/threads"],
  ["/settings/threads", "snooze-options", "/settings/platform/hub-defaults/threads"],
  ["/settings/browser", "", "/settings/platform/hub-defaults/browser"],
  ["/settings/integrations", "", "/settings/platform/hub-defaults/browser"],
  ["/settings/worktrees", "", "/settings/platform/hub-defaults/worktrees"],
  ["/settings/access", "master-key", "/settings/platform/master-key"],
  ["/settings/access", "audit-log", "/settings/platform/audit-log"],
  ["/settings/connections", "hub-sandboxes", "/settings/platform/sandboxes"],
  ["/settings/connections", "sandbox-image", "/settings/platform/sandboxes"],
];

/** `/settings/projects` moves the Project from the query into the path; machine and checkout stay. */
const OLD_PROJECT_URLS: ReadonlyArray<
  readonly [search: Parameters<typeof oldProjectSettingsUrl>[1], hash: string, to: string | null]
> = [
  [{ project: "repo" }, "", "/settings/project/repo/general"],
  [
    { project: "repo", machine: "hub", checkout: "hub:/work/repo" },
    "",
    "/settings/project/repo/general?machine=hub&checkout=hub%3A%2Fwork%2Frepo",
  ],
  [{ project: "local:/work/repo" }, "", "/settings/project/local%3A%2Fwork%2Frepo/general"],
  [{ project: "repo" }, "project-actions", "/settings/project/repo/actions"],
  [{ project: "repo" }, "project-overview", "/settings/project/repo/general"],
  [{ project: "repo" }, "no-such-row", "/settings/project/repo/general"],
  // Without a Project the route itself looks for the Project of the context.
  [{ machine: "hub" }, "", null],
];

const NOT_MOVED: ReadonlyArray<readonly [pathname: string, hash: string]> = [
  ["/settings/user/general", ""],
  ["/settings/projects", "project-defaults"],
  ["/settings/access", ""],
  ["/settings/access", "connections-environment"],
];

const OWNER_ON_DESKTOP: SettingsVisibilityContext = {
  isOwner: true,
  isDesktop: true,
  hasUser: true,
};
const MEMBER_ON_DESKTOP: SettingsVisibilityContext = {
  isOwner: false,
  isDesktop: true,
  hasUser: true,
};
const OWNER_IN_BROWSER: SettingsVisibilityContext = {
  isOwner: true,
  isDesktop: false,
  hasUser: true,
};
const MEMBER_IN_BROWSER: SettingsVisibilityContext = {
  isOwner: false,
  isDesktop: false,
  hasUser: true,
};
const PAIRED_IN_BROWSER: SettingsVisibilityContext = {
  isOwner: false,
  isDesktop: false,
  hasUser: false,
};
const PRINCIPALS = [
  OWNER_ON_DESKTOP,
  MEMBER_ON_DESKTOP,
  OWNER_IN_BROWSER,
  MEMBER_IN_BROWSER,
  PAIRED_IN_BROWSER,
];
const MODALS = Object.keys(SETTINGS_MODAL_SECTIONS) as SettingsModalId[];

describe("old settings URLs", () => {
  it.each(OLD_URLS)("%s#%s leads to %s", (pathname, hash, to) => {
    expect(resolveOldSettingsUrl(pathname, hash)).toBe(to);
  });

  it("leads every old URL to a section that exists and is visible", () => {
    for (const [, hash, to] of OLD_URLS) {
      const [, , modal, objectOrSection, spaceSection] = to.split("/");
      if (modal === "user" || modal === "space" || modal === "platform") {
        // The Space modal names its Space before the section; `current` is the current one.
        const sectionId = modal === "space" ? spaceSection : objectOrSection;
        const section = findSettingsSection(modal, sectionId ?? "");
        expect(section, `${to} (${hash})`).toBeDefined();
        const space = { kind: "organization", isOwn: false, canInvite: true } as const;
        expect(isSettingsSectionVisible(modal, section!, { ...OWNER_ON_DESKTOP, space }), to).toBe(
          true,
        );
      } else {
        expect(SETTINGS_SECTION_LABELS, to).toHaveProperty([to]);
      }
    }
  });

  it.each(OLD_PROJECT_URLS)("/settings/projects %j#%s leads to %s", (search, hash, to) => {
    expect(oldProjectSettingsUrl("/settings/projects", search, projectSectionForAnchor(hash))).toBe(
      to,
    );
  });

  it("leaves other pages out of the Project redirect", () => {
    expect(oldProjectSettingsUrl("/settings/threads", { project: "repo" })).toBeNull();
  });

  it.each(NOT_MOVED)("leaves %s#%s alone", (pathname, hash) => {
    expect(resolveOldSettingsUrl(pathname, hash)).toBeNull();
  });
});

describe("settings modal sections", () => {
  it("never shows a reserved section", () => {
    for (const modal of MODALS) {
      for (const section of SETTINGS_MODAL_SECTIONS[modal]) {
        if (section.component !== null) continue;
        for (const principal of PRINCIPALS) {
          expect(
            isSettingsSectionVisible(modal, section, principal),
            `${modal}/${section.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps ids unique inside a modal, since they are URL segments", () => {
    for (const modal of MODALS) {
      const ids = SETTINGS_MODAL_SECTIONS[modal].map((section) => section.id);
      expect(new Set(ids).size, modal).toBe(ids.length);
    }
  });

  it("leaves the account out of a pairing-link session, which has none", () => {
    expect(visibleSettingsSections("user", PAIRED_IN_BROWSER).map((section) => section.id)).toEqual(
      expect.arrayContaining(["sessions", "general"]),
    );
    expect(
      visibleSettingsSections("user", PAIRED_IN_BROWSER).map((section) => section.id),
    ).not.toContain("account");
  });

  it("shows a Project's sections to everyone who sees the Project", () => {
    for (const principal of PRINCIPALS) {
      expect(visibleSettingsSections("project", principal).map((section) => section.id)).toEqual([
        "general",
        "vaults",
        "machine",
        "defaults",
        "actions",
      ]);
    }
  });

  it("shows Platform only to the Owner, and only its built sections", () => {
    const ids = (principal: SettingsVisibilityContext) =>
      visibleSettingsSections("platform", principal).map((section) => section.id);
    for (const principal of [MEMBER_ON_DESKTOP, MEMBER_IN_BROWSER, PAIRED_IN_BROWSER]) {
      expect(ids(principal)).toEqual([]);
    }
    for (const principal of [OWNER_ON_DESKTOP, OWNER_IN_BROWSER]) {
      expect(ids(principal)).toEqual([
        "users",
        "audit-log",
        "master-key",
        "ai-gateway",
        "sandboxes",
        "hub-defaults",
        "labs",
      ]);
    }
  });

  it("reserves the Platform sections other specs fill in", () => {
    const reservedIds = SETTINGS_MODAL_SECTIONS.platform
      .filter((section) => section.component === null)
      .map((section) => section.id);
    expect(reservedIds).toEqual(["hub-machine", "registration", "keycloak", "plans", "terms"]);
  });

  it("shows User settings to everyone, and SnapShots on the desktop only", () => {
    const ids = (context: SettingsVisibilityContext) =>
      visibleSettingsSections("user", context).map((section) => section.id);
    const everywhere = [
      "account",
      "sessions",
      "general",
      "appearance",
      "chat",
      "diffs",
      "keybindings",
      "about",
    ];
    expect(ids(OWNER_IN_BROWSER)).toEqual(everywhere);
    expect(ids(MEMBER_IN_BROWSER)).toEqual(everywhere);
    expect(ids(MEMBER_ON_DESKTOP)).toEqual([
      "account",
      "sessions",
      "general",
      "appearance",
      "chat",
      "diffs",
      "keybindings",
      "snap-shot",
      "about",
    ]);
  });
});

describe("Space settings sections", () => {
  const ORGANIZATION_ADMIN: SpaceSettingsSubject = {
    kind: "organization",
    isOwn: false,
    canInvite: true,
  };
  const ORGANIZATION_MEMBER: SpaceSettingsSubject = {
    kind: "organization",
    isOwn: false,
    canInvite: false,
  };
  const OWN_PERSONAL: SpaceSettingsSubject = { kind: "personal", isOwn: true, canInvite: false };
  const OTHERS_PERSONAL: SpaceSettingsSubject = {
    kind: "personal",
    isOwn: false,
    canInvite: false,
  };
  const ids = (space: SpaceSettingsSubject | null, principal = MEMBER_IN_BROWSER) =>
    visibleSettingsSections("space", { ...principal, space }).map((section) => section.id);

  it("gives an Organization its Members, and its Invitations to who may invite", () => {
    // The Owner and an Admin may invite; a Member and a Guest read the list and leave.
    const shared = ["scheduled-tasks", "archive"];
    expect(ids(ORGANIZATION_ADMIN, OWNER_IN_BROWSER)).toEqual([
      "general",
      "members",
      "invitations",
      ...shared,
    ]);
    expect(ids(ORGANIZATION_ADMIN)).toEqual(["general", "members", "invitations", ...shared]);
    expect(ids(ORGANIZATION_MEMBER)).toEqual(["general", "members", ...shared]);
  });

  it("gives a Personal space no Members or Invitations, to its User and to the Owner reading it", () => {
    expect(ids(OWN_PERSONAL)).toEqual(["general", "scheduled-tasks", "archive"]);
    expect(ids(OTHERS_PERSONAL, OWNER_IN_BROWSER)).toEqual(["general"]);
  });

  it("shows nothing before the Space is known", () => {
    expect(ids(null)).toEqual([]);
  });

  it.each([
    ["scheduled-tasks", ORGANIZATION_MEMBER, true],
    ["archive", ORGANIZATION_MEMBER, true],
    ["scheduled-tasks", OWN_PERSONAL, true],
    ["archive", OWN_PERSONAL, true],
    // The Owner reads only General and the resource sections of another User's Personal space.
    ["scheduled-tasks", OTHERS_PERSONAL, false],
    ["archive", OTHERS_PERSONAL, false],
    ["vault", OTHERS_PERSONAL, true],
    ["members", OWN_PERSONAL, false],
    ["invitations", ORGANIZATION_MEMBER, false],
    ["invitations", ORGANIZATION_ADMIN, true],
  ] as const)("%s in %j is shown: %s", (sectionId, space, shown) => {
    expect(isSettingsSectionAllowed("space", sectionId, MEMBER_IN_BROWSER, space)).toBe(shown);
  });
});
