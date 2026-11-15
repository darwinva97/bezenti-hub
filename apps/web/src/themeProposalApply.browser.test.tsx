import { describe, expect, it } from "vite-plus/test";

import { render } from "../test/render";
import { ThemeProposalCard } from "./components/chat/ThemeProposalCard";
import { readThemeSelection, setAppearanceMode, setTheme } from "./hooks/useTheme";
import { getCustomThemes, removeCustomThemes } from "./themePalette";
import {
  applyThemeProposal,
  themeProposalAppliedHere,
  themeProposalThemeId,
  undoThemeProposal,
} from "./themeProposalApply";

import "~/index.css";

const NIGHT = {
  name: "Night Terminal",
  appearance: "dark",
  canvas: "#0b0f0c",
  accent: "#3ddc84",
} as const;

function resetBrowserTheme() {
  removeCustomThemes(getCustomThemes().map((theme) => theme.id));
  setTheme("grove");
  setAppearanceMode("light");
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("t3code:theme-proposal-applied:")) window.localStorage.removeItem(key);
  }
}

/** A known theme for one test, put back when it ends. */
function freshBrowserTheme(): Disposable {
  resetBrowserTheme();
  return { [Symbol.dispose]: resetBrowserTheme };
}

describe("applying a theme proposal in this browser", () => {
  it("selects the proposal's theme and mode, and Undo puts back what was there", () => {
    using _theme = freshBrowserTheme();
    window.localStorage.setItem("t3code:theme-halves:v1", JSON.stringify({ dark: "ocean" }));
    const before = readThemeSelection();

    expect(applyThemeProposal("item:1", NIGHT)).toEqual({ ok: true });
    const id = themeProposalThemeId(NIGHT);
    expect(readThemeSelection()).toMatchObject({ theme: id, appearanceMode: "dark", halves: null });
    expect(document.documentElement.dataset.themeId).toBe(id);
    expect(themeProposalAppliedHere("item:1", NIGHT)).toBe(true);

    expect(undoThemeProposal("item:1")).toBe(true);
    expect(readThemeSelection()).toEqual(before);
    expect(themeProposalAppliedHere("item:1", NIGHT)).toBe(false);
  });

  it("applies an old proposal again without duplicating its theme", () => {
    using _theme = freshBrowserTheme();
    expect(applyThemeProposal("item:old", NIGHT)).toEqual({ ok: true });
    expect(undoThemeProposal("item:old")).toBe(true);
    expect(applyThemeProposal("item:old", NIGHT)).toEqual({ ok: true });
    expect(applyThemeProposal("item:copy", { ...NIGHT })).toEqual({ ok: true });
    expect(
      getCustomThemes().filter((theme) => theme.id === themeProposalThemeId(NIGHT)),
    ).toHaveLength(1);
  });

  it("does not offer Undo once the viewer picked another theme", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:1", NIGHT);
    setTheme("ember");
    expect(themeProposalAppliedHere("item:1", NIGHT)).toBe(false);
  });

  it("refuses what today's rules refuse, even from an old turn", () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    const result = applyThemeProposal("item:bad", { ...NIGHT, canvas: "#fafafa" });
    expect(result.ok).toBe(false);
    expect(readThemeSelection()).toEqual(before);
  });
});

describe("the theme proposal card", () => {
  it("changes nothing when it appears, applies on click, and undoes", async () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    await using screen = await render(
      <div style={{ width: 360 }}>
        <ThemeProposalCard itemId="item:card" proposal={NIGHT} actions />
      </div>,
    );
    expect(readThemeSelection()).toEqual(before);

    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    expect(readThemeSelection().theme).toBe(themeProposalThemeId(NIGHT));

    await screen.getByRole("button", { name: "Undo" }).click();
    expect(readThemeSelection()).toEqual(before);
    await expect
      .element(screen.getByRole("button", { name: "Apply to my appearance" }))
      .toBeVisible();
  });

  it("previews without saving, and stops the preview", async () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    await using screen = await render(
      <ThemeProposalCard itemId="item:preview" proposal={NIGHT} actions />,
    );
    await screen.getByRole("button", { name: "Preview" }).click();
    expect(document.documentElement.dataset.themeId).toBe("__preview");
    expect(readThemeSelection()).toEqual(before);
    await screen.getByRole("button", { name: "Stop preview" }).click();
    expect(document.documentElement.dataset.themeId).toBe("grove");
  });

  it("shows a guest the proposal with no buttons", async () => {
    using _theme = freshBrowserTheme();
    await using screen = await render(
      <ThemeProposalCard itemId="item:guest" proposal={NIGHT} actions={false} />,
    );
    await expect.element(screen.getByText("Night Terminal")).toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("fits a phone-width column without overflowing", async () => {
    using _theme = freshBrowserTheme();
    await using screen = await render(
      <div style={{ width: 320 }}>
        <ThemeProposalCard
          itemId="item:narrow"
          proposal={{ ...NIGHT, name: "A theme name that is as long as forty-eight ch" }}
          actions
        />
      </div>,
    );
    const card = screen.container.querySelector<HTMLElement>("[data-theme-proposal-card]")!;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  });
});
