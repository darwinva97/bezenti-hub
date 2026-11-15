import { sha256 } from "@noble/hashes/sha2";
import {
  themeCssProblem,
  themeCssPropertyRefused,
  themeCssValueRefused,
} from "@t3tools/shared/themeCss";

/**
 * A proposal's custom CSS, in this browser only: by theme id in its own localStorage key (never
 * exported, synced or sent to the Hub), shown through one `<style>` element this module owns. It
 * gets only CSS that passed the text check and a re-check of every rule parsed in a detached sheet.
 */

export const THEME_CSS_STYLE_ELEMENT_ID = "t3-theme-css";
export const THEME_CSS_STORAGE_KEY = "t3code:theme-css:v1";
const THEME_CSS_SAFE_MODE_PARAM = "safe-theme";

export type ThemeCssCheck =
  | { readonly ok: true; readonly css: string }
  | { readonly ok: false; readonly message: string };

export function themeCssSha256(css: string): string {
  return Array.from(sha256(new TextEncoder().encode(css)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// ── Safe mode: `?safe-theme=1` loads the app with no custom theme CSS for this page's life.

let safeMode = false;
const safeModeListeners = new Set<() => void>();

/** Reads the address once, at load; a later navigation keeps safe mode until the page reloads. */
export function initThemeCssSafeMode(search: string): void {
  safeMode = new URLSearchParams(search).get(THEME_CSS_SAFE_MODE_PARAM) === "1";
  if (safeMode) showThemeCss(null);
  for (const listener of safeModeListeners) listener();
}

export function themeCssSafeMode(): boolean {
  return safeMode;
}

export function subscribeThemeCssSafeMode(listener: () => void): () => void {
  safeModeListeners.add(listener);
  return () => {
    safeModeListeners.delete(listener);
  };
}

// ── The check in the browser.

type RuleParent = Pick<CSSStyleSheet, "cssRules" | "deleteRule">;

const defined = <T>(name: string): T | undefined =>
  (globalThis as unknown as Record<string, T | undefined>)[name];

/** Rule kinds that only group, select or animate. Every other kind is deleted. */
function allowedGroup(rule: CSSRule): boolean {
  for (const name of [
    "CSSMediaRule",
    "CSSSupportsRule",
    "CSSContainerRule",
    "CSSLayerBlockRule",
    "CSSStyleRule",
  ]) {
    const kind = defined<abstract new () => CSSRule>(name);
    if (kind !== undefined && rule instanceof kind) return true;
  }
  return false;
}

function isKind(rule: CSSRule, name: string): boolean {
  const kind = defined<abstract new () => CSSRule>(name);
  return kind !== undefined && rule instanceof kind;
}

function stripDeclarations(rule: CSSRule): void {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return;
  for (let index = rule.style.length - 1; index >= 0; index--) {
    const property = rule.style.item(index);
    if (
      themeCssPropertyRefused(property) ||
      themeCssValueRefused(rule.style.getPropertyValue(property))
    ) {
      rule.style.removeProperty(property);
    }
  }
}

function stripRules(parent: RuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    if (isKind(rule, "CSSKeyframesRule")) {
      for (const frame of (rule as CSSKeyframesRule).cssRules) stripDeclarations(frame);
    } else if (allowedGroup(rule)) {
      stripDeclarations(rule);
      // A style rule holds nested rules too (CSS nesting).
      if ("cssRules" in rule && "deleteRule" in rule) stripRules(rule as unknown as RuleParent);
    } else if (isKind(rule, "CSSNestedDeclarations")) {
      stripDeclarations(rule);
    } else if (!isKind(rule, "CSSLayerStatementRule")) {
      parent.deleteRule(index);
    }
  }
}

/**
 * Parses CSS where nothing can load (a constructed sheet ignores @import and is never adopted),
 * deletes every rule and declaration the checks refuse, and returns what is left as text.
 */
export function serializeCheckedThemeCss(css: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  stripRules(sheet);
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
}

/** Today's rules, applied to CSS from any card, however old: the text check, then the parse. */
export function checkThemeCss(css: string): ThemeCssCheck {
  const problem = themeCssProblem(css);
  if (problem !== null) return { ok: false, message: problem };
  if (typeof CSSStyleSheet === "undefined") {
    return { ok: false, message: "This browser cannot check custom CSS." };
  }
  let checked: string;
  try {
    checked = serializeCheckedThemeCss(css);
  } catch {
    // CSSOM refuses some deletions (a @namespace while style rules remain): refuse it whole.
    return { ok: false, message: "This CSS could not be checked." };
  }
  // The serializer writes what it parsed; that text must pass the same rules.
  const again = checked.trim() === "" ? null : themeCssProblem(checked);
  if (again !== null) return { ok: false, message: again };
  return { ok: true, css: checked };
}

// ── The one element.

let shownCss: string | null = null;

/** Shows `css` as the page's custom theme CSS, or removes it (null). Refused CSS removes it. */
export function showThemeCss(css: string | null): void {
  if (typeof document === "undefined") return;
  const next = safeMode || css === null || css.trim() === "" ? null : css;
  const existing = document.getElementById(THEME_CSS_STYLE_ELEMENT_ID);
  if (next === null) {
    existing?.remove();
    shownCss = null;
    return;
  }
  if (next === shownCss && existing !== null) return;
  const checked = checkThemeCss(next);
  if (!checked.ok) {
    existing?.remove();
    shownCss = null;
    return;
  }
  const element = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
  element.id = THEME_CSS_STYLE_ELEMENT_ID;
  element.dataset.t3ThemeCss = "";
  element.textContent = checked.css;
  // Last in <head>, so it applies after the app's own styles.
  if (element.parentNode !== document.head || element !== document.head.lastElementChild) {
    document.head.append(element);
  }
  shownCss = next;
}

// ── Storage: theme id to CSS, this browser only.

function readLibrary(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(THEME_CSS_STORAGE_KEY) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const library: Record<string, string> = {};
    for (const [themeId, css] of Object.entries(value)) {
      if (typeof css === "string") library[themeId] = css;
    }
    return library;
  } catch {
    return {};
  }
}

function writeLibrary(library: Record<string, string>): void {
  if (Object.keys(library).length === 0) {
    window.localStorage.removeItem(THEME_CSS_STORAGE_KEY);
  } else {
    window.localStorage.setItem(THEME_CSS_STORAGE_KEY, JSON.stringify(library));
  }
}

export function storedThemeCss(themeId: string): string | null {
  const library = readLibrary();
  return Object.hasOwn(library, themeId) ? library[themeId]! : null;
}

export function hasStoredThemeCss(): boolean {
  return Object.keys(readLibrary()).length > 0;
}

export function storedThemeCssIds(): ReadonlyArray<string> {
  return Object.keys(readLibrary());
}

/** Throws when this browser's storage refuses the write. */
export function saveThemeCss(themeId: string, css: string): void {
  writeLibrary({ ...readLibrary(), [themeId]: css });
}

export function forgetThemeCss(themeId: string): void {
  const library = readLibrary();
  if (!Object.hasOwn(library, themeId)) return;
  delete library[themeId];
  try {
    writeLibrary(library);
  } catch {}
}

export function forgetAllThemeCss(): void {
  try {
    window.localStorage.removeItem(THEME_CSS_STORAGE_KEY);
  } catch {}
}

// Last, after every binding above exists: safe mode is read before the theme first paints.
if (typeof window !== "undefined") initThemeCssSafeMode(window.location.search);
