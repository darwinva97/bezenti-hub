import { readThemeProposal, type ThemeProposal } from "@t3tools/shared/themeProposal";

import {
  readThemeSelection,
  restoreThemeSelection,
  setAppearanceMode,
  setTheme,
  type ThemeSelection,
} from "./hooks/useTheme";
import {
  createVividThemeColors,
  getCustomThemes,
  installCustomTheme,
  themeColorsMinimumContrast,
  updateCustomTheme,
  type ThemeDefinition,
} from "./themePalette";

/**
 * An agent's theme proposal acts only in the browser of whoever clicks Apply: it adds a custom theme
 * to this browser's library and selects it, exactly as picking a theme in Settings does. Nothing is
 * sent to the Hub, so another User viewing the same Thread is never restyled.
 */

/** WCAG AA for body text; every text role of the derived palette must reach it. */
export const THEME_PROPOSAL_MIN_TEXT_CONTRAST = 4.5;
const APPLIED_STORAGE_PREFIX = "t3code:theme-proposal-applied:v1:";

/** The same proposal always maps to the same theme, so applying it again updates, not duplicates. */
export function themeProposalThemeId(proposal: ThemeProposal): string {
  const key = `${proposal.name}|${proposal.appearance}|${proposal.canvas}|${proposal.accent}`;
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

interface AppliedRecord {
  readonly themeId: string;
  readonly previous: ThemeSelection;
}

function appliedKey(itemId: string): string {
  return `${APPLIED_STORAGE_PREFIX}${itemId}`;
}

function readApplied(itemId: string): AppliedRecord | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(appliedKey(itemId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { themeId, previous } = value as Record<string, unknown>;
    if (typeof themeId !== "string" || typeof previous !== "object" || previous === null) {
      return null;
    }
    const { theme, appearanceMode, halves } = previous as Record<string, unknown>;
    if (
      typeof theme !== "string" ||
      (appearanceMode !== "light" && appearanceMode !== "dark" && appearanceMode !== "system") ||
      (halves !== null && typeof halves !== "string")
    ) {
      return null;
    }
    return { themeId, previous: { theme, appearanceMode, halves } };
  } catch {
    return null;
  }
}

function forgetApplied(itemId: string): void {
  try {
    window.localStorage.removeItem(appliedKey(itemId));
  } catch {}
}

/** True while this browser shows the theme this card applied, so Undo still means "go back". */
export function themeProposalAppliedHere(itemId: string, proposal: ThemeProposal): boolean {
  if (typeof window === "undefined") return false;
  const record = readApplied(itemId);
  const themeId = themeProposalThemeId(proposal);
  return record !== null && record.themeId === themeId && readThemeSelection().theme === themeId;
}

export type ThemeProposalApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function applyThemeProposal(
  itemId: string,
  proposal: ThemeProposal,
): ThemeProposalApplyResult {
  if (typeof window === "undefined") return { ok: false, message: "No browser to apply it in." };
  // Read again: a card can come from an old turn, and today's rules decide what applies.
  const valid = readThemeProposal(proposal);
  if (valid === undefined) return { ok: false, message: "This proposal is not a valid theme." };
  if (!themeProposalReadable(valid)) {
    return { ok: false, message: "This theme would be hard to read, so it was not applied." };
  }
  const definition = themeProposalDefinition(valid);
  const previous = readThemeSelection();
  try {
    if (getCustomThemes().some((theme) => theme.id === definition.id)) {
      updateCustomTheme(definition);
    } else {
      installCustomTheme(definition);
    }
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
  return { ok: true };
}

/** Puts back the theme, mode and mix this browser had before the card's Apply. */
export function undoThemeProposal(itemId: string): boolean {
  if (typeof window === "undefined") return false;
  const record = readApplied(itemId);
  if (record === null) return false;
  if (!restoreThemeSelection(record.previous)) return false;
  forgetApplied(itemId);
  return true;
}
