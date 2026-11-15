import { describe, expect, it } from "vite-plus/test";

import { render } from "../test/render";
import { THEME_PROPOSAL_CSS_WARNING, ThemeProposalCard } from "./components/chat/ThemeProposalCard";
import { ThemeCssSafeModeNotice } from "./components/ThemeCssSafeModeNotice";
import { readThemeSelection, setAppearanceMode, setTheme } from "./hooks/useTheme";
import {
  forgetAllThemeCss,
  hasStoredThemeCss,
  initThemeCssSafeMode,
  storedThemeCss,
  THEME_CSS_STYLE_ELEMENT_ID,
  themeCssSha256,
} from "./themeCss";
import {
  installThemeCssRecoveryShortcut,
  startThemeCssViewerTracking,
  syncThemeCssViewer,
} from "./themeCssRecovery";
import { useCurrentSpace } from "./state/currentSpace";
import { getCustomThemes, removeCustomThemes } from "./themePalette";
import {
  applyThemeProposal,
  dropThemeCss,
  getThemeProposalState,
  THEME_BEFORE_CSS_STORAGE_KEY,
  themeProposalAppliedHere,
  themeProposalCssFromInput,
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

const CSS =
  "[data-css-probe] { color: rgb(1, 2, 3) !important; } @keyframes t3probe { to { opacity: 0.5 } }";
const withCss = (css: string) => ({
  ...NIGHT,
  name: "Night CSS",
  css: { length: css.length, sha256: themeCssSha256(css) },
});
const NIGHT_CSS = withCss(CSS);
const styleElement = () => document.getElementById(THEME_CSS_STYLE_ELEMENT_ID);

const USER_A = { kind: "user", userId: "user-a" } as const;

function resetBrowserTheme() {
  initThemeCssSafeMode("");
  forgetAllThemeCss();
  syncThemeCssViewer(USER_A);
  removeCustomThemes(getCustomThemes().map((theme) => theme.id));
  setTheme("grove");
  setAppearanceMode("light");
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("t3code:theme-proposal-applied:")) window.localStorage.removeItem(key);
  }
  window.localStorage.removeItem(THEME_BEFORE_CSS_STORAGE_KEY);
}

/** An element the test CSS colors, removed when the test ends. */
function cssProbe(): HTMLElement & Disposable {
  const probe = document.createElement("div");
  probe.dataset.cssProbe = "";
  document.body.append(probe);
  return Object.assign(probe, { [Symbol.dispose]: () => probe.remove() });
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

  it("keeps one preview for all cards, and Apply on another card ends it and paints", async () => {
    using _theme = freshBrowserTheme();
    const OCEAN_NIGHT = { ...NIGHT, name: "Ocean Night", accent: "#7aa2f7" } as const;
    await using screen = await render(
      <div>
        <div data-testid="a">
          <ThemeProposalCard itemId="item:a" proposal={NIGHT} actions />
        </div>
        <div data-testid="b">
          <ThemeProposalCard itemId="item:b" proposal={OCEAN_NIGHT} actions />
        </div>
      </div>,
    );
    const a = screen.getByTestId("a");
    const b = screen.getByTestId("b");

    await a.getByRole("button", { name: "Preview" }).click();
    await b.getByRole("button", { name: "Preview" }).click();
    // B took the preview over: A no longer claims it.
    await expect.element(a.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect.element(b.getByRole("button", { name: "Stop preview" })).toBeVisible();

    await a.getByRole("button", { name: "Preview" }).click();
    await b.getByRole("button", { name: "Apply to my appearance" }).click();
    expect(document.documentElement.dataset.themeId).toBe(themeProposalThemeId(OCEAN_NIGHT));
    await expect.element(b.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect.element(a.getByRole("button", { name: "Preview" })).toBeVisible();

    await a.getByRole("button", { name: "Preview" }).click();
    await b.getByRole("button", { name: "Undo" }).click();
    expect(document.documentElement.dataset.themeId).toBe("grove");
    await expect.element(a.getByRole("button", { name: "Preview" })).toBeVisible();
  });

  it("follows its applied record even when the selected theme does not change", async () => {
    using _theme = freshBrowserTheme();
    await using screen = await render(
      <ThemeProposalCard itemId="item:record" proposal={NIGHT} actions />,
    );
    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    await screen.getByRole("button", { name: "Undo" }).click();

    // Picked again in Settings: then Apply records this very theme as the one to go back to.
    setTheme(themeProposalThemeId(NIGHT));
    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    await expect.element(screen.getByRole("button", { name: "Undo" })).toBeVisible();

    await screen.getByRole("button", { name: "Undo" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Apply to my appearance" }))
      .toBeVisible();
    expect(screen.container.querySelector("[role=status]")).toBeNull();
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

describe("custom CSS in a proposal", () => {
  it("applies the CSS through one style element, and Undo removes it and its stored copy", () => {
    using _theme = freshBrowserTheme();
    using probe = cssProbe();
    const before = readThemeSelection();

    expect(applyThemeProposal("item:css", NIGHT_CSS, CSS)).toEqual({ ok: true });
    const id = themeProposalThemeId(NIGHT_CSS);
    expect(id).not.toBe(themeProposalThemeId(NIGHT));
    expect(storedThemeCss(id)).toBe(CSS);
    expect(document.querySelectorAll(`#${THEME_CSS_STYLE_ELEMENT_ID}`)).toHaveLength(1);
    expect(getComputedStyle(probe).color).toBe("rgb(1, 2, 3)");

    expect(undoThemeProposal("item:css")).toBe(true);
    expect(styleElement()).toBeNull();
    expect(storedThemeCss(id)).toBeNull();
    expect(hasStoredThemeCss()).toBe(false);
    expect(readThemeSelection()).toEqual(before);
    expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
  });

  it("removes the style element when another theme is picked, and brings it back with the theme", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    setTheme("ember");
    expect(styleElement()).toBeNull();
    setTheme(themeProposalThemeId(NIGHT_CSS));
    expect(styleElement()?.textContent).toContain("rgb(1, 2, 3)");
  });

  it("re-refuses in the browser what today's rules refuse, and any CSS but the proposal's", () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    const leaky = '[data-css-probe] { background: url("https://evil.example/a") }';
    const escaped = "[data-css-probe] { background: u\\72l(https://evil.example/a) }";
    for (const [proposal, css] of [
      [withCss(leaky), leaky],
      [withCss(escaped), escaped],
      [NIGHT_CSS, `${CSS} `],
      [NIGHT_CSS, undefined],
    ] as const) {
      const result = applyThemeProposal("item:bad-css", proposal, css);
      expect(result.ok).toBe(false);
      expect(styleElement()).toBeNull();
      expect(hasStoredThemeCss()).toBe(false);
      expect(readThemeSelection()).toEqual(before);
    }
  });

  it("finds the CSS in the stored call wherever the adapter put it, by digest alone", () => {
    const found = (input: unknown) => themeProposalCssFromInput(NIGHT_CSS, input);
    expect(found({ ...NIGHT, css: CSS })).toEqual({ ok: true, css: CSS });
    expect(found({ server: "t3-code", tool: "t3_theme_propose", arguments: { css: CSS } })).toEqual(
      { ok: true, css: CSS },
    );
    expect(found(JSON.stringify({ arguments: { css: CSS } }))).toEqual({ ok: true, css: CSS });
    expect(found({ css: `${CSS} ` }).ok).toBe(false);
    expect(found({ note: CSS.toUpperCase() }).ok).toBe(false);
    const leaky = ".x { background: url(https://evil.example/a) }";
    expect(themeProposalCssFromInput(withCss(leaky), { css: leaky })).toMatchObject({
      ok: false,
      message: expect.stringContaining("not accepted today"),
    });
  });

  it("recovers by the keyboard shortcut even when the CSS hides the whole page", () => {
    using _theme = freshBrowserTheme();
    using _shortcut = { [Symbol.dispose]: installThemeCssRecoveryShortcut() };
    const before = readThemeSelection();
    const hideAll = "body { display: none !important; }";
    expect(applyThemeProposal("item:hide", withCss(hideAll), hideAll)).toEqual({ ok: true });
    expect(getComputedStyle(document.body).display).toBe("none");

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Digit0",
        key: ")",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(styleElement()).toBeNull();
    expect(getComputedStyle(document.body).display).not.toBe("none");
    expect(hasStoredThemeCss()).toBe(false);
    expect(readThemeSelection()).toEqual(before);
  });

  it("leaves a theme without CSS alone when the CSS is dropped", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    setTheme("ember");
    dropThemeCss();
    expect(readThemeSelection().theme).toBe("ember");
    expect(hasStoredThemeCss()).toBe(false);
  });

  it("opens with ?safe-theme=1 showing no custom CSS, and offers to remove it", async () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    expect(styleElement()).not.toBeNull();

    initThemeCssSafeMode("?safe-theme=1");
    expect(styleElement()).toBeNull();
    // Repaints in safe mode keep it off.
    setTheme(themeProposalThemeId(NIGHT_CSS));
    expect(styleElement()).toBeNull();

    await using screen = await render(<ThemeCssSafeModeNotice />);
    await screen.getByRole("button", { name: "Remove custom theme CSS" }).click();
    expect(hasStoredThemeCss()).toBe(false);
    expect(readThemeSelection()).toEqual(before);
    await expect
      .element(screen.getByText("Safe theme: no custom theme CSS is saved in this browser."))
      .toBeVisible();

    initThemeCssSafeMode("");
    setTheme(themeProposalThemeId(NIGHT_CSS));
    expect(styleElement()).toBeNull();
  });
});

describe("the theme proposal card with CSS", () => {
  it("says it carries CSS and its size, restyles nothing until clicked, and previews, applies, undoes", async () => {
    using _theme = freshBrowserTheme();
    using probe = cssProbe();
    const before = readThemeSelection();
    let loads = 0;
    await using screen = await render(
      <ThemeProposalCard
        itemId="item:css-card"
        proposal={NIGHT_CSS}
        actions
        loadCssInput={async () => {
          loads += 1;
          return { arguments: { ...NIGHT, css: CSS } };
        }}
      />,
    );
    await expect
      .element(screen.getByText(THEME_PROPOSAL_CSS_WARNING, { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText(`${CSS.length} characters`, { exact: false }))
      .toBeVisible();
    expect(styleElement()).toBeNull();
    expect(loads).toBe(0);

    await screen.getByRole("button", { name: "Preview" }).click();
    await expect.element(screen.getByRole("button", { name: "Stop preview" })).toBeVisible();
    expect(getComputedStyle(probe).color).toBe("rgb(1, 2, 3)");
    expect(readThemeSelection()).toEqual(before);
    await screen.getByRole("button", { name: "Stop preview" }).click();
    expect(styleElement()).toBeNull();

    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    await expect.element(screen.getByRole("button", { name: "Undo" })).toBeVisible();
    expect(getComputedStyle(probe).color).toBe("rgb(1, 2, 3)");
    expect(loads).toBe(1);

    await screen.getByRole("button", { name: "Undo" }).click();
    expect(styleElement()).toBeNull();
    expect(readThemeSelection()).toEqual(before);
  });

  it("applies nothing when the stored call does not hold the proposal's CSS", async () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    await using screen = await render(
      <ThemeProposalCard
        itemId="item:css-missing"
        proposal={NIGHT_CSS}
        actions
        loadCssInput={async () => ({ css: "[data-css-probe] { color: red }" })}
      />,
    );
    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    await expect
      .element(screen.getByText("The proposal's CSS could not be found in this Thread."))
      .toBeVisible();
    expect(styleElement()).toBeNull();
    expect(readThemeSelection()).toEqual(before);
  });

  it("shows a guest the CSS warning and no buttons", async () => {
    using _theme = freshBrowserTheme();
    await using screen = await render(
      <ThemeProposalCard itemId="item:css-guest" proposal={NIGHT_CSS} actions={false} />,
    );
    await expect
      .element(screen.getByText(THEME_PROPOSAL_CSS_WARNING, { exact: false }))
      .toBeVisible();
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  });

  /** A CSS load the test answers when it chooses. */
  function heldLoad() {
    let answer: (input: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    return { load: () => pending, answer: () => answer({ css: CSS }) };
  }

  /** Lets the card's continuation after the answered load run: promise turns only, no clock. */
  async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }

  it("previews once a held load is answered while the card stays (control for the next two)", async () => {
    using _theme = freshBrowserTheme();
    const held = heldLoad();
    await using screen = await render(
      <ThemeProposalCard
        itemId="item:stays"
        proposal={NIGHT_CSS}
        actions
        loadCssInput={held.load}
      />,
    );
    await screen.getByRole("button", { name: "Preview" }).click();
    expect(styleElement()).toBeNull();
    held.answer();
    await settle();
    expect(styleElement()).not.toBeNull();
    expect(getThemeProposalState().previewing).toBe("item:stays");
  });

  it("does not preview when the card left the screen while its CSS was loading", async () => {
    using _theme = freshBrowserTheme();
    const held = heldLoad();
    const screen = await render(
      <ThemeProposalCard
        itemId="item:gone"
        proposal={NIGHT_CSS}
        actions
        loadCssInput={held.load}
      />,
    );
    await screen.getByRole("button", { name: "Preview" }).click();
    await screen.unmount();
    held.answer();
    await settle();
    expect(styleElement()).toBeNull();
    expect(getThemeProposalState().previewing).toBeNull();
    expect(document.documentElement.dataset.themeId).toBe("grove");
    await screen[Symbol.asyncDispose]();
  });

  it("does not apply when the signed-in User changed while its CSS was loading", async () => {
    using _theme = freshBrowserTheme();
    const before = readThemeSelection();
    const held = heldLoad();
    await using screen = await render(
      <ThemeProposalCard
        itemId="item:other-user"
        proposal={NIGHT_CSS}
        actions
        loadCssInput={held.load}
      />,
    );
    await screen.getByRole("button", { name: "Apply to my appearance" }).click();
    syncThemeCssViewer({ kind: "unknown" });
    held.answer();
    await settle();
    expect(styleElement()).toBeNull();
    expect(hasStoredThemeCss()).toBe(false);
    expect(readThemeSelection()).toEqual(before);
  });
});

describe("custom CSS belongs to the User who applied it", () => {
  it("is shown only to that User, and dropped when another User or nobody signs in", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    const id = themeProposalThemeId(NIGHT_CSS);
    expect(styleElement()).not.toBeNull();

    // Not known yet (startup): nothing is shown, nothing is dropped.
    syncThemeCssViewer({ kind: "unknown" });
    expect(styleElement()).toBeNull();
    syncThemeCssViewer(USER_A);
    expect(styleElement()?.textContent).toContain("rgb(1, 2, 3)");

    // Another User signs in on this browser: never shown, and dropped for good.
    syncThemeCssViewer({ kind: "user", userId: "user-b" });
    expect(styleElement()).toBeNull();
    syncThemeCssViewer(USER_A);
    expect(storedThemeCss(id)).toBeNull();
    expect(styleElement()).toBeNull();
  });

  it("is dropped when the session ends some other way and nobody is signed in", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    syncThemeCssViewer({ kind: "none" });
    expect(styleElement()).toBeNull();
    syncThemeCssViewer(USER_A);
    expect(hasStoredThemeCss()).toBe(false);
  });

  it("keeps today's behaviour on a Hub without Users", () => {
    using _theme = freshBrowserTheme();
    syncThemeCssViewer({ kind: "none" });
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    syncThemeCssViewer({ kind: "unknown" });
    syncThemeCssViewer({ kind: "none" });
    expect(styleElement()?.textContent).toContain("rgb(1, 2, 3)");
    // CSS saved with no Users is nobody's: a User signing in later does not get it.
    syncThemeCssViewer(USER_A);
    expect(styleElement()).toBeNull();
    expect(hasStoredThemeCss()).toBe(false);
  });

  it("follows the signed-in User from the Spaces store", () => {
    using _theme = freshBrowserTheme();
    applyThemeProposal("item:css", NIGHT_CSS, CSS);
    syncThemeCssViewer({ kind: "unknown" });
    const stop = startThemeCssViewerTracking();
    try {
      useCurrentSpace.setState({
        environmentId: "env-1" as never,
        view: { userId: "user-a" } as never,
        loadFailed: false,
      });
      expect(styleElement()).not.toBeNull();
      // The session ended some other way (expired, revoked): nobody is signed in.
      useCurrentSpace.setState({ view: null, loadFailed: false });
      expect(styleElement()).toBeNull();
      expect(hasStoredThemeCss()).toBe(false);
    } finally {
      stop();
      useCurrentSpace.setState({ environmentId: null, view: null, loadFailed: false });
    }
  });
});
