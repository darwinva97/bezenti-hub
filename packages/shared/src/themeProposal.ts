import { BUILT_IN_THEME_IDS } from "./themePalettes.ts";

/**
 * A theme an agent proposes with `t3_theme_propose`: colors only. It is never applied on the Hub;
 * the timeline shows it as a card, and each viewer may apply it to their own browser.
 */
export const THEME_READ_TOOL_NAME = "t3_theme_read";
export const THEME_PROPOSE_TOOL_NAME = "t3_theme_propose";
export const THEME_PROPOSAL_NAME_MAX_LENGTH = 48;
/** WCAG's minimum for user-interface parts (focus rings, buttons) against the canvas. */
const THEME_PROPOSAL_MIN_ACCENT_CONTRAST = 3;

export type ThemeProposalAppearance = "light" | "dark";

export interface ThemeProposal {
  readonly name: string;
  readonly appearance: ThemeProposalAppearance;
  /** `#rrggbb`, lower case. */
  readonly canvas: string;
  readonly accent: string;
}

export const THEME_PROPOSAL_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// A mid-grey canvas leaves the derived surfaces too little room for readable text (the palette
// test in apps/web samples it), so a dark canvas must be clearly dark and a light one clearly light.
const DARK_CANVAS_MAX_LUMINANCE = 0.06;
const LIGHT_CANVAS_MIN_LUMINANCE = 0.3;

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function themeProposalContrast(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Why a proposal would be hard to read, or null. The app derives every other color from canvas and
 * accent, solving text for contrast; these are the two things that derivation cannot fix.
 */
export function themeProposalProblem(proposal: ThemeProposal): string | null {
  const luminance = relativeLuminance(proposal.canvas);
  if (proposal.appearance === "dark" && luminance > DARK_CANVAS_MAX_LUMINANCE) {
    return `The canvas ${proposal.canvas} is too light for a dark theme. Use a darker canvas or appearance "light".`;
  }
  if (proposal.appearance === "light" && luminance < LIGHT_CANVAS_MIN_LUMINANCE) {
    return `The canvas ${proposal.canvas} is too dark for a light theme. Use a lighter canvas or appearance "dark".`;
  }
  const contrast = themeProposalContrast(proposal.canvas, proposal.accent);
  if (contrast < THEME_PROPOSAL_MIN_ACCENT_CONTRAST) {
    return `The accent ${proposal.accent} has a contrast of ${contrast.toFixed(2)}:1 on the canvas; it needs at least ${THEME_PROPOSAL_MIN_ACCENT_CONTRAST}:1.`;
  }
  return null;
}

/**
 * Reads a proposal from a tool result, keeping only its known fields. A proposal that is malformed
 * or hard to read yields nothing, so an old card never applies what today's rules refuse.
 */
export function readThemeProposal(value: unknown): ThemeProposal | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { name, appearance, canvas, accent } = value as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    (appearance !== "light" && appearance !== "dark") ||
    typeof canvas !== "string" ||
    typeof accent !== "string" ||
    !THEME_PROPOSAL_HEX_PATTERN.test(canvas) ||
    !THEME_PROPOSAL_HEX_PATTERN.test(accent)
  ) {
    return undefined;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > THEME_PROPOSAL_NAME_MAX_LENGTH) return undefined;
  const proposal: ThemeProposal = {
    name: trimmed,
    appearance,
    canvas: canvas.toLowerCase(),
    accent: accent.toLowerCase(),
  };
  return themeProposalProblem(proposal) === null ? proposal : undefined;
}

export function themeProposalsEqual(left: ThemeProposal, right: ThemeProposal): boolean {
  return (
    left.name === right.name &&
    left.appearance === right.appearance &&
    left.canvas === right.canvas &&
    left.accent === right.accent
  );
}

/** What an agent needs to propose a look. `t3_theme_read` returns it. */
export const THEME_PROPOSAL_GUIDE = [
  "Propose a new look for T3 Code with `t3_theme_propose`, only when the user asks to change how T3 Code itself looks (not their project's theme).",
  "A proposal is colors only: `name`, `appearance` (light or dark), `canvas` and `accent` as #rrggbb. T3 Code derives every other color from those two.",
  "A dark theme needs a clearly dark canvas (about #3a3a3a or darker) and a light theme a clearly light one (about #959595 or lighter). The accent needs at least 3:1 contrast on the canvas.",
  "Nothing changes when you propose. The user sees a card in this thread and applies it to their own appearance with one click; they can undo it there.",
  "You cannot add CSS, fonts, images or per-color overrides, and you cannot change anyone's appearance yourself.",
  `Built-in themes the user can pick in Settings > Appearance: ${BUILT_IN_THEME_IDS.join(", ")}.`,
].join("\n");
