/**
 * Custom CSS in a theme proposal must never load or send anything (a url() on an attribute selector
 * leaks what is on screen). A text check on the raw CSS: the Hub runs it on proposing, the browser
 * again before Preview or Apply. Stricter than upstream 42057b82d0: refused whole, and no backslash.
 */

/** Upstream's limit (e82050b8b9). A proposal travels inline in the tool call. */
export const THEME_CSS_MAX_LENGTH = 50_000;

const CSS_WHITESPACE = "[ \\t\\n\\r\\f]*";
const RASTER_DATA = "data:image\\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]*";
const FRAGMENT = "#[A-Za-z0-9_-]+";
/**
 * The url() forms that load nothing: an inline raster image (`data:`, base64) or a reference to an
 * element of the page (`#id`, as SVG filters and masks use). Nothing may come before `data:` or
 * `#` inside the quotes: a leading space (or U+00A0) would make the address relative to the Hub.
 */
const LOCAL_URL = new RegExp(
  `url\\(${CSS_WHITESPACE}(?:"(?:${RASTER_DATA}|${FRAGMENT})"|'(?:${RASTER_DATA}|${FRAGMENT})'|${RASTER_DATA}|${FRAGMENT})${CSS_WHITESPACE}\\)`,
  "gi",
);

/** Words that load, run or bind something, or read the page into the style. */
const REFUSED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\/, "a backslash (a CSS escape can spell any blocked word)"],
  [/@import/i, "@import"],
  [/@font-face/i, "@font-face"],
  [/image-set\(/i, "image-set()"],
  [/(?<![\w-])src\(/i, "src()"],
  [/(?<![\w-])src[ \t\n\r\f]*:/i, "src:"],
  [/(?<![\w-])image\(/i, "image()"],
  [/cross-fade\(/i, "cross-fade()"],
  [/(?<![\w-])(?:-moz-)?element\(/i, "element()"],
  [/(?<![\w-])attr\(/i, "attr()"],
  [/expression\(/i, "expression()"],
  [/(?<![\w-])behavior[ \t\n\r\f]*:/i, "behavior"],
  [/-moz-binding/i, "-moz-binding"],
];

/**
 * At-rules that only group or animate rules. Any other (@namespace, @property, @counter-style,
 * @page, a future one) is refused, so a new at-rule that fetches is refused by default.
 */
const THEME_CSS_ALLOWED_AT_RULES: ReadonlySet<string> = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "keyframes",
  "-webkit-keyframes",
]);
const AT_RULE = /(?:^|[\s{};/])@([A-Za-z-][\w-]*)/g;

function refusedWord(text: string): string | null {
  for (const [pattern, word] of REFUSED) {
    if (pattern.test(text)) return word;
  }
  if (/url\(/i.test(text.replace(LOCAL_URL, ""))) {
    return "url() other than an inline data:image (png, jpeg, gif, webp, avif; base64) or #id";
  }
  return null;
}

/**
 * Why `css` cannot be part of a theme proposal, or null. It checks the raw text, comments and
 * strings included: a blocked word inside a comment is refused too, which costs a theme nothing.
 */
export function themeCssProblem(css: string): string | null {
  if (css.trim().length === 0) return "The CSS is empty; leave `css` out instead.";
  if (css.length > THEME_CSS_MAX_LENGTH) {
    return `The CSS has ${css.length.toLocaleString("en-US")} characters; a proposal holds at most ${THEME_CSS_MAX_LENGTH.toLocaleString("en-US")}.`;
  }
  const word = refusedWord(css);
  if (word !== null) return `The CSS uses ${word}, which can load or send something.`;
  for (const match of css.matchAll(AT_RULE)) {
    const name = match[1]!.toLowerCase();
    if (!THEME_CSS_ALLOWED_AT_RULES.has(name)) {
      return `The CSS uses @${name}; only @media, @supports, @container, @layer and @keyframes are accepted.`;
    }
  }
  return null;
}

/** Whether one parsed declaration value could load or send something. The browser drops it. */
export function themeCssValueRefused(value: string): boolean {
  return refusedWord(value) !== null;
}

/** A property that can load or bind something whatever its value. */
export function themeCssPropertyRefused(property: string): boolean {
  return /^(?:src|behavior|-moz-binding)$/i.test(property.trim());
}

/**
 * Selectors that theme CSS may rely on. Other class names are Tailwind utilities and change
 * between releases. themeCssHooks.test.ts in apps/web fails when one of these leaves the source.
 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-slot="sidebar"]', styles: "app sidebar" },
  { selector: '[data-slot="sidebar-inner"]', styles: "sidebar surface" },
  { selector: "[data-thread-item]", styles: "sidebar thread row" },
  { selector: "[data-chat-header]", styles: "chat header" },
  { selector: '[data-workspace-area="conversation"]', styles: "chat area, behind the messages" },
  { selector: ".messages-timeline-scroll", styles: "chat scroller" },
  { selector: "[data-timeline-row-kind]", styles: 'chat row, such as ="message" or ="work"' },
  { selector: '[data-message-role="user"]', styles: "user message row" },
  { selector: '[data-message-role="assistant"]', styles: "assistant message row" },
  { selector: ".chat-markdown", styles: "assistant text" },
  { selector: ".chat-markdown-codeblock", styles: "code block" },
  { selector: "[data-chat-composer-form]", styles: "composer" },
  { selector: '[data-slot="composer-host"]', styles: "composer card" },
  { selector: ".composer-tiptap", styles: "composer text" },
  { selector: "[data-thread-details-card]", styles: "thread details card" },
  { selector: "[data-thread-terminal-drawer]", styles: "terminal drawer" },
  { selector: "[data-settings-page-scroll]", styles: "settings page" },
  { selector: '[data-slot="button"]', styles: "button" },
  { selector: '[data-slot="input"]', styles: "text input" },
  { selector: '[data-slot="switch"]', styles: "switch" },
  { selector: '[data-slot="select-trigger"]', styles: "select" },
  { selector: '[data-slot="dialog-popup"]', styles: "dialog" },
  { selector: '[data-slot="popover-popup"]', styles: "popover" },
  { selector: '[data-slot="menu-popup"]', styles: "menu" },
  { selector: '[data-slot="tooltip-popup"]', styles: "tooltip" },
  { selector: '[data-slot="scroll-area-scrollbar"]', styles: "overlay scrollbar" },
  { selector: '[data-slot="scroll-area-thumb"]', styles: "overlay scrollbar thumb" },
] as const;
