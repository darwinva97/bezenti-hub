import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { SidebarUserSettingsItem } from "./SidebarChrome";
import { useCurrentUserName } from "./useCurrentUserName";

vi.mock("./useCurrentUserName", { spy: true });

async function mount(name: string | null) {
  vi.mocked(useCurrentUserName).mockReturnValue(name);
  return render(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarUserSettingsItem onClick={() => undefined} />
      </SidebarMenu>
    </SidebarProvider>,
  );
}

describe("SidebarUserSettingsItem", () => {
  it("says Settings with the User's name as a second line", async () => {
    await using screen = await mount("Bezenti");
    const button = screen.getByRole("button", { name: "Settings (Bezenti)" });
    const text = button.element().textContent ?? "";
    expect(text).toContain("Settings");
    expect(text).toContain("Bezenti");
  });

  it("says only Settings while the User is not loaded", async () => {
    await using screen = await mount(null);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.element().textContent?.trim()).toBe("Settings");
  });
});
