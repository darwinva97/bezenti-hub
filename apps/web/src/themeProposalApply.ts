import { themeCssProblem } from "@t3tools/shared/themeCss";
import { readThemeProposal, type ThemeProposal } from "@t3tools/shared/themeProposal";

import {
  readThemeSelection,
  refreshTheme,
  restoreThemeSelection,
  setAppearanceMode,
  setTheme,
  type ThemeSelection,
} from "./hooks/useTheme";
import {
  checkThemeCss,
  forgetAllThemeCss,
  forgetThemeCss,
  saveThemeCss,
  showThemeCss,
  storedThemeCss,
  storedThemeCssIds,
  themeCssSha256,
} from "./themeCss";
import {
  applyThemeColorPreview,
  createVividThemeColors,
  getCustomThemes,
  installCustomTheme,
  themeColorsMinimumContrast,
  updateCustomTheme,
  type ThemeDefinition,
} from "./themePalette";

/**
 * A proposal acts only in the browser of whoever clicks Apply (a custom theme, selected), so another
 * User viewing the Thread is never restyled. Its CSS, known to the card by size and digest, is read
 * from the tool call's input on Preview or Apply and checked against both and today's rules.
 */

/** WCAG AA for body text; every text role of the derived palette must reach it. */
export const THEME_PROPOSAL_MIN_TEXT_CONTRAST = 4.5;
const APPLIED_STORAGE_PREFIX = "t3code:theme-proposal-applied:v1:";
/** The selection before the first theme with custom CSS was applied, for the ways out. */
export const THEME_BEFORE_CSS_STORAGE_KEY = "t3code:theme-before-css:v1";

/**
 * What every card reads: which proposal, if any, is previewing on the document (there is only one
 * document, so one preview), and a version bumped on every write or removal of an applied record,
 * which lives in localStorage where nothing would tell a card it changed.
 */
export interface ThemeProposalState {
  readonly previewing: string | null;
  readonly recordsVersion: number;
}

let state: ThemeProposalState = { previewing: null, recordsVersion: 0 };
const listeners = new Set<() => void>();

function updateState(next: Partial<ThemeProposalState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeThemeProposals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getThemeProposalState(): ThemeProposalState {
  return state;
}

export type ThemeProposalApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Finds the proposal's CSS in the stored tool call's input: the string whose digest is the one the
 * Hub sealed, so where an adapter put it (top level, under `arguments`, as JSON text) does not
 * matter and nothing else can stand in for it. Then today's rules check it.
 */
export function themeProposalCssFromInput(
  proposal: ThemeProposal,
  input: unknown,
): { readonly ok: true; readonly css: string } | { readonly ok: false; readonly message: string } {
  const expected = proposal.css;
  if (expected === undefined) return { ok: false, message: "This proposal has no custom CSS." };
  let found: string | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (found !== undefined || depth > 4) return;
    if (typeof value === "string") {
      if (value.length === expected.length && themeCssSha256(value) === expected.sha256) {
        found = value;
      } else if (depth < 4 && value.length > expected.length && /^\s*[{[]/.test(value)) {
        try {
          visit(JSON.parse(value), depth + 1);
        } catch {}
      }
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(input, 0);
  if (found === undefined) {
    return { ok: false, message: "The proposal's CSS could not be found in this Thread." };
  }
  const problem = themeCssProblem(found);
  return problem === null
    ? { ok: true, css: found }
    : { ok: false, message: `This CSS is not accepted today. ${problem}` };
}

/** Paints `proposal` (and its checked CSS) without saving it; takes the preview over. */
export function previewThemeProposal(
  itemId: string,
  proposal: ThemeProposal,
  css?: string,
): ThemeProposalApplyResult {
  const checked = cssForProposal(proposal, css);
  if (!checked.ok) return checked;
  applyThemeColorPreview(themeProposalDefinition(proposal).colors, proposal.appearance);
  showThemeCss(checked.css);
  updateState({ previewing: itemId });
  return { ok: true };
}

/** Ends the running preview (only `itemId`'s, when given) and repaints the stored theme. */
export function stopThemeProposalPreview(itemId?: string): void {
  if (state.previewing === null || (itemId !== undefined && state.previewing !== itemId)) return;
  updateState({ previewing: null });
  refreshTheme({ preservePreview: false });
}

/** The same proposal always maps to the same theme, so applying it again updates, not duplicates. */
export function themeProposalThemeId(proposal: ThemeProposal): string {
  const key = `${proposal.name}|${proposal.appearance}|${proposal.canvas}|${proposal.accent}|${proposal.css?.sha256 ?? ""}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `agent-${(hash >>> 0).toString(36)}`;
}

export function themeProposalDefinition(proposal: ThemeProposal): ThemeDefinition {
  return {
    id: themeProposalThemeId(proposal),
    label: proposal.name,
    appearance: proposal.appearance,
    colors: createVividThemeColors(proposal.appearance, proposal.canvas, proposal.accent),
  };
}

export function themeProposalReadable(proposal: ThemeProposal): boolean {
  return (
    themeColorsMinimumContrast(themeProposalDefinition(proposal).colors) >=
    THEME_PROPOSAL_MIN_TEXT_CONTRAST
  );
}

/** The CSS to show with a proposal: none for colors only, else `css` checked against it. */
function cssForProposal(
  proposal: ThemeProposal,
  css: string | undefined,
):
  | { readonly ok: true; readonly css: string | null }
  | { readonly ok: false; readonly message: string } {
  if (proposal.css === undefined) return { ok: true, css: null };
  if (css === undefined) return { ok: false, message: "The proposal's CSS is not loaded." };
  if (css.length !== proposal.css.length || themeCssSha256(css) !== proposal.css.sha256) {
    return { ok: false, message: "This CSS is not the one the agent proposed." };
  }
  const checked = checkThemeCss(css);
  return checked.ok
    ? { ok: true, css }
    : { ok: false, message: `This CSS is not accepted today. ${checked.message}` };
}

interface AppliedRecord {
  readonly themeId: string;
  readonly previous: ThemeSelection;
}

function appliedKey(itemId: string): string {
  return `${APPLIED_STORAGE_PREFIX}${itemId}`;
}

function parseSelection(value: unknown): ThemeSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const { theme, appearanceMode, halves } = value as Record<string, unknown>;
  if (
    typeof theme !== "string" ||
    (appearanceMode !== "light" && appearanceMode !== "dark" && appearanceMode !== "system") ||
    (halves !== null && typeof halves !== "string")
  ) {
    return null;
  }
  return { theme, appearanceMode, halves };
}

function readApplied(itemId: string): AppliedRecord | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(appliedKey(itemId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { themeId, previous } = value as Record<string, unknown>;
    const selection = parseSelection(previous);
    return typeof themeId === "string" && selection !== null
      ? { themeId, previous: selection }
      : null;
  } catch {
    return null;
  }
}

function forgetApplied(itemId: string): void {
  try {
    window.localStorage.removeItem(appliedKey(itemId));
  } catch {}
}

function readThemeBeforeCss(): ThemeSelection | null {
  try {
    return parseSelection(
      JSON.parse(window.localStorage.getItem(THEME_BEFORE_CSS_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return null;
  }
}

function forgetThemeBeforeCss(): void {
  try {
    window.localStorage.removeItem(THEME_BEFORE_CSS_STORAGE_KEY);
  } catch {}
}

/** Whether a selection shows a theme that has custom CSS in this browser. */
function selectionHasCss(selection: ThemeSelection, cssThemeIds: ReadonlySet<string>): boolean {
  if (cssThemeIds.has(selection.theme)) return true;
  if (selection.halves === null) return false;
  try {
    const halves: unknown = JSON.parse(selection.halves);
    return (
      typeof halves === "object" &&
      halves !== null &&
      Object.values(halves).some(
        (themeId) => typeof themeId === "string" && cssThemeIds.has(themeId),
      )
    );
  } catch {
    return false;
  }
}

/** True while this browser shows the theme this card applied, so Undo still means "go back". */
export function themeProposalAppliedHere(itemId: string, proposal: ThemeProposal): boolean {
  if (typeof window === "undefined") return false;
  const record = readApplied(itemId);
  const themeId = themeProposalThemeId(proposal);
  return record !== null && record.themeId === themeId && readThemeSelection().theme === themeId;
}

/** `css` is the proposal's CSS as loaded with themeProposalCssFromInput; checked again here. */
export function applyThemeProposal(
  itemId: string,
  proposal: ThemeProposal,
  css?: string,
): ThemeProposalApplyResult {
  if (typeof window === "undefined") return { ok: false, message: "No browser to apply it in." };
  // A preview marks the document, and a theme set under it would not be painted.
  stopThemeProposalPreview();
  // Read again: a card can come from an old turn, and today's rules decide what applies.
  const valid = readThemeProposal(proposal);
  if (valid === undefined) return { ok: false, message: "This proposal is not a valid theme." };
  if (!themeProposalReadable(valid)) {
    return { ok: false, message: "This theme would be hard to read, so it was not applied." };
  }
  const checkedCss = cssForProposal(valid, css);
  if (!checkedCss.ok) return checkedCss;
  const definition = themeProposalDefinition(valid);
  const previous = readThemeSelection();
  const previousHadCss = selectionHasCss(previous, new Set(storedThemeCssIds()));
  try {
    if (getCustomThemes().some((theme) => theme.id === definition.id)) {
      updateCustomTheme(definition);
    } else {
      installCustomTheme(definition);
    }
    if (checkedCss.css === null) forgetThemeCss(definition.id);
    else saveThemeCss(definition.id, checkedCss.css);
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The theme could not be saved.",
    };
  }
  if (!setTheme(definition.id) || !setAppearanceMode(valid.appearance)) {
    restoreThemeSelection(previous);
    return { ok: false, message: "Your appearance could not be saved in this browser." };
  }
  // The theme may have been selected already; its CSS may be new.
  refreshTheme({ preservePreview: false });
  if (checkedCss.css !== null && !previousHadCss) {
    try {
      window.localStorage.setItem(THEME_BEFORE_CSS_STORAGE_KEY, JSON.stringify(previous));
    } catch {}
  }
  // Applying again while it is shown keeps the selection from before the first Apply.
  const earlier = readApplied(itemId);
  const record: AppliedRecord = {
    themeId: definition.id,
    previous:
      earlier?.themeId === definition.id && previous.theme === definition.id
        ? earlier.previous
        : previous,
  };
  try {
    window.localStorage.setItem(appliedKey(itemId), JSON.stringify(record));
  } catch {}
  updateState({ recordsVersion: state.recordsVersion + 1 });
  return { ok: true };
}

/** Puts back the theme, mode and mix this browser had before the card's Apply, and drops its CSS. */
export function undoThemeProposal(itemId: string): boolean {
  if (typeof window === "undefined") return false;
  stopThemeProposalPreview();
  const record = readApplied(itemId);
  if (record === null) return false;
  const hadCss = storedThemeCss(record.themeId) !== null;
  forgetThemeCss(record.themeId);
  if (!restoreThemeSelection(record.previous)) return false;
  if (hadCss && !selectionHasCss(record.previous, new Set(storedThemeCssIds()))) {
    forgetThemeBeforeCss();
  }
  forgetApplied(itemId);
  updateState({ recordsVersion: state.recordsVersion + 1 });
  return true;
}

/**
 * The way out that CSS cannot hide (the keyboard shortcut, `?safe-theme=1`, signing out): removes
 * every custom theme CSS from this browser and, if a theme with CSS was showing, goes back to the
 * theme from before the first one was applied (or the standard theme).
 */
export function dropThemeCss(): void {
  if (typeof window === "undefined") return;
  if (state.previewing !== null) updateState({ previewing: null });
  const cssThemeIds = new Set(storedThemeCssIds());
  const current = readThemeSelection();
  const before = readThemeBeforeCss();
  forgetAllThemeCss();
  forgetThemeBeforeCss();
  showThemeCss(null);
  if (selectionHasCss(current, cssThemeIds)) {
    const fallback: ThemeSelection = { theme: "system", appearanceMode: "system", halves: null };
    const target = before !== null && !selectionHasCss(before, cssThemeIds) ? before : fallback;
    if (!restoreThemeSelection(target)) refreshTheme({ preservePreview: false });
  } else {
    refreshTheme({ preservePreview: false });
  }
  updateState({ recordsVersion: state.recordsVersion + 1 });
}
