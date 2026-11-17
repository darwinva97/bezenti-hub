import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const preload = vi.hoisted(() => ({
  modal: vi.fn(),
  section: vi.fn(),
}));

vi.mock("./settingsModals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsModals")>()),
  preloadSettingsModal: preload.modal,
  preloadSettingsSection: preload.section,
}));

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

const renderNav = () =>
  render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/user/general" />
    </SidebarProvider>,
    { router: "/settings/user/general" },
  );

it("starts loading the modal's sections when it opens", async () => {
  await using _screen = await renderNav();
  await expect.element(page.getByRole("treeitem", { name: "Appearance" })).toBeVisible();
  expect(preload.modal).toHaveBeenCalledWith("user");
});

it("preloads a section on hover and on focus", async () => {
  await using _screen = await renderNav();
  const appearance = page.getByRole("treeitem", { name: "Appearance" });
  await appearance.hover();
  expect(preload.section).toHaveBeenCalledWith("user", "appearance");

  preload.section.mockClear();
  const chat = page.getByRole("treeitem", { name: "Chat" });
  chat.element().focus();
  expect(preload.section).toHaveBeenCalledWith("user", "chat");
});

it("marks the clicked section active at once, before the route has moved", async () => {
  // The test router has no settings routes, so the pathname prop stays on General: only the
  // nav's own immediate state can make Appearance active.
  await using _screen = await renderNav();
  await expect
    .element(page.getByRole("treeitem", { name: "General" }))
    .toHaveAttribute("aria-current", "page");

  await page.getByRole("treeitem", { name: "Appearance" }).click();

  await expect
    .element(page.getByRole("treeitem", { name: "Appearance" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(page.getByRole("treeitem", { name: "General" }))
    .not.toHaveAttribute("aria-current", "page");
});
