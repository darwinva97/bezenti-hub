import { THEME_CSS_HOOKS, THEME_CSS_MAX_LENGTH } from "./themeCss.ts";
import { BUILT_IN_THEME_IDS } from "./themePalettes.ts";

/**
 * A theme an agent proposes with `t3_theme_propose`: colors, and optionally custom CSS. It is never
 * applied on the Hub; the timeline shows it as a card, and each viewer may apply it to their own
 * browser.
 */
export const THEME_READ_TOOL_NAME = "t3_theme_read";
export const THEME_PROPOSE_TOOL_NAME = "t3_theme_propose";
export const THEME_PROPOSAL_NAME_MAX_LENGTH = 48;
/** WCAG's minimum for user-interface parts (focus rings, buttons) against the canvas. */
const THEME_PROPOSAL_MIN_ACCENT_CONTRAST = 3;

export type ThemeProposalAppearance = "light" | "dark";

/**
 * What a card knows of a proposal's CSS: its size and SHA-256 (hex). The CSS itself stays in the
 * tool call's input, where the browser reads it and checks it against this digest.
 */
export interface ThemeProposalCss {
  readonly length: number;
  readonly sha256: string;
}

export interface ThemeProposal {
  readonly name: string;
  readonly appearance: ThemeProposalAppearance;
  /** `#rrggbb`, lower case. */
  readonly canvas: string;
  readonly accent: string;
  readonly css?: ThemeProposalCss;
}

/** The Hub's HMAC over a proposal (base64url, 32 bytes). Only a sealed proposal keeps its CSS. */
export const THEME_PROPOSAL_SEAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the Hub seals: every field of the proposal, the CSS by size and digest. */
export function themeProposalSealMessage(proposal: ThemeProposal): string {
  return JSON.stringify([
    "t3-theme-proposal/1",
    proposal.name,
    proposal.appearance,
    proposal.canvas,
    proposal.accent,
    proposal.css?.length ?? null,
    proposal.css?.sha256 ?? null,
  ]);
}

function readThemeProposalCss(value: unknown): ThemeProposalCss | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { length, sha256 } = value as Record<string, unknown>;
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length > 0 &&
    length <= THEME_CSS_MAX_LENGTH &&
    typeof sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(sha256)
    ? { length, sha256 }
    : undefined;
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
  const { name, appearance, canvas, accent, css } = value as Record<string, unknown>;
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
  // A malformed CSS record leaves the colors: the card shows them and offers no CSS.
  const cssRecord = readThemeProposalCss(css);
  const proposal: ThemeProposal = {
    name: trimmed,
    appearance,
    canvas: canvas.toLowerCase(),
    accent: accent.toLowerCase(),
    ...(cssRecord === undefined ? {} : { css: cssRecord }),
  };
  return themeProposalProblem(proposal) === null ? proposal : undefined;
}

/** The proposal without its CSS, as a card from an unsealed source shows it. */
export function themeProposalColors(proposal: ThemeProposal): ThemeProposal {
  const { css: _css, ...colors } = proposal;
  return colors;
}

export function themeProposalsEqual(left: ThemeProposal, right: ThemeProposal): boolean {
  return (
    left.name === right.name &&
    left.appearance === right.appearance &&
    left.canvas === right.canvas &&
    left.accent === right.accent &&
    left.css?.length === right.css?.length &&
    left.css?.sha256 === right.css?.sha256
  );
}

/** What an agent needs to propose a look. `t3_theme_read` returns it. */
export const THEME_PROPOSAL_GUIDE = [
  "Propose a new look for T3 Code with `t3_theme_propose`, only when the user asks to change how T3 Code itself looks (not their project's theme).",
  "A proposal has `name`, `appearance` (light or dark), `canvas` and `accent` as #rrggbb. T3 Code derives every other color from those two.",
  "A dark theme needs a clearly dark canvas (about #3a3a3a or darker) and a light theme a clearly light one (about #959595 or lighter). The accent needs at least 3:1 contrast on the canvas.",
  "Nothing changes when you propose. The user sees a card in this thread and applies it to their own appearance with one click; they can undo it there.",
  "You cannot add per-color overrides, and you cannot change anyone's appearance yourself.",
  "",
  `Optional \`css\` (at most ${THEME_CSS_MAX_LENGTH.toLocaleString("en-US")} characters) applies after the app's styles; prefer colors and add CSS only when the user wants more than colors. The card tells the user it carries CSS.`,
  "CSS cannot load or send anything, and a proposal that tries is refused: no url() except an inline data:image/(png|jpeg|gif|webp|avif);base64 or #id, no @import, @font-face, image-set(), image(), src, attr(), expression(), behavior or -moz-binding, and no backslash escapes. At-rules: @media, @supports, @container, @layer, @keyframes.",
  "Use `.dark` or `:root:not(.dark)` for one appearance. If a rule has no effect, add !important.",
  "Stable selectors (other class names change between releases):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "You cannot see the result. Make small changes, then ask the user how it looks.",
  `Built-in themes the user can pick in Settings > Appearance: ${BUILT_IN_THEME_IDS.join(", ")}.`,
].join("\n");
