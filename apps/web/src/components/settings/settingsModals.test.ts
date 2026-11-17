import { describe, expect, it, vi } from "vite-plus/test";

import {
  SETTINGS_MODAL_SECTIONS,
  findSettingsSection,
  isSettingsSectionVisible,
  visibleSettingsSections,
  type SettingsModalId,
  type SettingsVisibilityContext,
} from "./settingsModals";
import { SETTINGS_SECTION_LABELS, resolveOldSettingsUrl } from "./settingsSearch";

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
  ["/settings/general", "text-generation-model", "/settings/threads"],
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
  ["/settings/connections", "about", "/settings/user/about"],
  ["/settings/connections", "authorized-clients", "/settings/user/sessions"],
  ["/settings/access", "authorized-clients", "/settings/user/sessions"],
  ["/settings/access", "account", "/settings/user/account"],
  ["/settings/connections", "remote-environments", "/settings/user/account"],
  ["/settings/connections", "network-access", "/settings/access"],
  ["/settings/source-control", "worktree-branch-naming", "/settings/worktrees"],
  ["/settings/storage", "storage-worktrees", "/settings/worktrees"],
  ["/settings/storage", "", "/settings/maintenance"],
  ["/settings/integrations", "devices", "/settings/devices"],
  ["/settings/beta", "", "/settings/labs"],
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
      const [, , modal, sectionId] = to.split("/");
      if (modal === "user") {
        const section = findSettingsSection("user", sectionId ?? "");
        expect(section, `${to} (${hash})`).toBeDefined();
        expect(isSettingsSectionVisible("user", section!, OWNER_ON_DESKTOP), to).toBe(true);
      } else {
        expect(SETTINGS_SECTION_LABELS, to).toHaveProperty([to]);
      }
    }
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

  it("shows Platform only to the Owner", () => {
    for (const principal of PRINCIPALS) {
      for (const section of SETTINGS_MODAL_SECTIONS.platform) {
        expect(isSettingsSectionVisible("platform", section, principal)).toBe(false);
      }
    }
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
