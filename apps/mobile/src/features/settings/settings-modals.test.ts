import { describe, expect, it } from "vite-plus/test";

import {
  platformBrowserUrl,
  settingsModalPages,
  spaceSubject,
  visibleSettingsModals,
  type SettingsModalContext,
} from "./settings-modals";

const OWNER = { isOwner: true, isDesktop: false, hasUser: true };
const MEMBER = { isOwner: false, isDesktop: false, hasUser: true };
const PHONE = { ios: true, navigationCustomization: true };

function context(
  principal: SettingsModalContext["principal"],
  space: SettingsModalContext["space"] = spaceSubject(null, null),
  device = PHONE,
): SettingsModalContext {
  return { principal, space, device };
}

const targets = (modal: Parameters<typeof settingsModalPages>[0], c: SettingsModalContext) =>
  settingsModalPages(modal, c).map((page) => page.target);

describe("which Settings entries a viewer sees", () => {
  it("shows the Owner four entries and a Member three", () => {
    expect(visibleSettingsModals(context(OWNER)).map((entry) => entry.modal)).toEqual([
      "user",
      "space",
      "project",
      "platform",
    ]);
    expect(visibleSettingsModals(context(MEMBER)).map((entry) => entry.modal)).toEqual([
      "user",
      "space",
      "project",
    ]);
  });

  it("lists the Hub's pages in Platform, and nothing of them for a Member", () => {
    expect(targets("platform", context(OWNER))).toEqual([
      "SettingsProviderAccounts",
      "SettingsThreads",
      "SettingsWorktrees",
      "SettingsEnvironmentSourceControl",
      "SettingsEnvironmentMaintenance",
      "SettingsLabs",
      "SettingsDiagnostics",
    ]);
    expect(targets("platform", context(MEMBER))).toEqual([]);
  });

  it("keeps Scheduled tasks and Archive for the viewer's own Space", () => {
    const organization = spaceSubject(
      [{ id: "org", kind: "organization", isOwn: false, canInvite: false }],
      "org",
    );
    const othersPersonal = spaceSubject(
      [{ id: "theirs", kind: "personal", isOwn: false, canInvite: false }],
      "theirs",
    );
    expect(targets("space", context(MEMBER, organization))).toEqual([
      "SettingsScheduledTasks",
      "SettingsArchive",
    ]);
    expect(targets("space", context(OWNER, othersPersonal))).toEqual([]);
  });

  it("falls back to the viewer's own Personal space without a directory", () => {
    expect(targets("space", context(MEMBER))).toEqual([
      "SettingsScheduledTasks",
      "SettingsArchive",
    ]);
  });

  it("leaves out pages the device does not offer", () => {
    const android = { ios: false, navigationCustomization: false };
    const user = targets("user", context(MEMBER, undefined, android));
    expect(user).not.toContain("SettingsKeyboard");
    expect(user).not.toContain("SettingsNavigation");
    expect(targets("user", context(MEMBER))).toContain("SettingsKeyboard");
  });

  it("opens the Project page from its own entry", () => {
    expect(targets("project", context(MEMBER))).toEqual(["SettingsProjectOverview"]);
  });
});

describe("opening Platform in the browser", () => {
  it("points at the Hub's public URL", () => {
    expect(platformBrowserUrl("https://hub.example.com/")).toBe(
      "https://hub.example.com/settings/platform/users",
    );
    expect(platformBrowserUrl(null)).toBeNull();
  });
});
