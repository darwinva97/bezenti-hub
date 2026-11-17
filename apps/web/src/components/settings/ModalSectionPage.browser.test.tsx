import { startTransition, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ModalSectionPage } from "./ModalSectionPage";

const gate = vi.hoisted(() => ({
  release: undefined as undefined | (() => void),
}));

vi.mock("./useSettingsVisibility", () => ({
  useSettingsVisibility: () => ({ isOwner: true, isDesktop: false, hasUser: true, space: null }),
}));

vi.mock("./settingsModals", async () => {
  const { lazy } = await import("react");
  const Fast = () => <p>Fast section</p>;
  const slow = new Promise<{ default: () => React.ReactElement }>((resolve) => {
    gate.release = () => resolve({ default: () => <p>Slow section</p> });
  });
  const sections = {
    fast: { id: "fast", label: "Fast", icon: () => null, component: Fast, group: 0 },
    slow: { id: "slow", label: "Slow", icon: () => null, component: lazy(() => slow), group: 0 },
  } as const;
  return {
    findSettingsSection: (_modal: string, id: keyof typeof sections) => sections[id],
    isSettingsSectionVisible: () => true,
  };
});

function Harness() {
  const [sectionId, setSectionId] = useState("fast");
  return (
    <>
      {/* The router moves the URL inside a transition, as this does. */}
      <button type="button" onClick={() => startTransition(() => setSectionId("slow"))}>
        Go
      </button>
      <ModalSectionPage modal="user" sectionId={sectionId} fallback={null} />
    </>
  );
}

it("does not keep the old section on screen while the next one loads", async () => {
  await using screen = await render(<Harness />, { router: false });
  await expect.element(page.getByText("Fast section")).toBeVisible();

  await page.getByRole("button", { name: "Go" }).click();

  await expect.element(page.getByRole("status", { name: "Loading section" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Fast section");

  await act(() => gate.release?.());
  await expect.element(page.getByText("Slow section")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Loading section");
});
