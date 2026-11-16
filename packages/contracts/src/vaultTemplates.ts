/**
 * Template entries (spec «Variables, Secretos sellados y Secret providers», «Template entries"):
 * `{{ NAME }}` and `{{ NAME | filter | … }}` over entries of the same Vault, without logic. The
 * text holds names only, never values. One parser for the web form and the Hub.
 */

/** What a reference may pass its value through, left to right. `path` goes alone. */
const TEMPLATE_FILTERS = ["base64", "base64decode", "urlencode", "json", "trim", "path"] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

export const TEMPLATE_TEXT_MAX_LENGTH = 64 * 1024;
const TEMPLATE_MAX_REFERENCES = 64;

export type TemplatePart =
  | { readonly _tag: "text"; readonly text: string }
  | {
      readonly _tag: "ref";
      readonly name: string;
      readonly filters: ReadonlyArray<TemplateFilter>;
    };

export type ParsedTemplate =
  | { readonly _tag: "parsed"; readonly parts: ReadonlyArray<TemplatePart> }
  | { readonly _tag: "invalid"; readonly message: string };

const NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const ESCAPED_OPEN = '"{{"';
const isFilter = (word: string): word is TemplateFilter =>
  (TEMPLATE_FILTERS as ReadonlyArray<string>).includes(word);

/** The parts of a template, or why it is not one (never quoting more than a short piece). */
export const parseTemplate = (text: string): ParsedTemplate => {
  if (text.length > TEMPLATE_TEXT_MAX_LENGTH) {
    return {
      _tag: "invalid",
      message: `A template is at most ${TEMPLATE_TEXT_MAX_LENGTH / 1024} KiB.`,
    };
  }
  const parts: Array<TemplatePart> = [];
  let literal = "";
  let at = 0;
  let references = 0;
  while (at < text.length) {
    const open = text.indexOf("{{", at);
    if (open === -1) {
      literal += text.slice(at);
      break;
    }
    literal += text.slice(at, open);
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      return { _tag: "invalid", message: "A `{{` is never closed with `}}`." };
    }
    const body = text.slice(open + 2, close).trim();
    if (body === ESCAPED_OPEN) {
      literal += "{{";
      at = close + 2;
      continue;
    }
    const [name = "", ...words] = body.split("|").map((word) => word.trim());
    if (!NAME.test(name)) {
      return {
        _tag: "invalid",
        message: `{{ ${body.slice(0, 40)} }} does not name an entry: use {{ NAME }} or {{ NAME | filter }}.`,
      };
    }
    const filters: Array<TemplateFilter> = [];
    for (const word of words) {
      if (!isFilter(word)) {
        return {
          _tag: "invalid",
          message: `${JSON.stringify(word.slice(0, 40))} is not a filter: use ${TEMPLATE_FILTERS.join(", ")}.`,
        };
      }
      filters.push(word);
    }
    if (filters.includes("path") && filters.length > 1) {
      return { _tag: "invalid", message: `{{ ${name} | path }} takes no other filter.` };
    }
    references += 1;
    if (references > TEMPLATE_MAX_REFERENCES) {
      return {
        _tag: "invalid",
        message: `A template names at most ${TEMPLATE_MAX_REFERENCES} entries.`,
      };
    }
    if (literal.length > 0) parts.push({ _tag: "text", text: literal });
    literal = "";
    parts.push({ _tag: "ref", name, filters });
    at = close + 2;
  }
  if (literal.length > 0) parts.push({ _tag: "text", text: literal });
  return { _tag: "parsed", parts };
};

/** The names a template's parts use, once each, in order of first use. */
export const templateNames = (parts: ReadonlyArray<TemplatePart>): ReadonlyArray<string> => [
  ...new Set(parts.flatMap((part) => (part._tag === "ref" ? [part.name] : []))),
];

/** The names a template takes the Secret file path of (`| path`). */
export const templatePathNames = (parts: ReadonlyArray<TemplatePart>): ReadonlySet<string> =>
  new Set(
    parts.flatMap((part) =>
      part._tag === "ref" && part.filters.includes("path") ? [part.name] : [],
    ),
  );

/** «Preview»: each reference as `[NAME]`, never a value. */
export const previewTemplate = (parts: ReadonlyArray<TemplatePart>): string =>
  parts.map((part) => (part._tag === "text" ? part.text : `[${part.name}]`)).join("");

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 of UTF-8 text without NUL; undefined for anything else. */
const fromBase64 = (text: string): string | undefined => {
  const compact = text.replace(/\s+/g, "");
  if (!BASE64.test(compact)) return undefined;
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.includes("\u0000") ? undefined : decoded;
  } catch {
    return undefined;
  }
};

export type RenderedTemplate =
  | { readonly _tag: "rendered"; readonly text: string }
  /** An input whose value a filter cannot take (`base64decode` of something else). Names only. */
  | { readonly _tag: "failed"; readonly name: string; readonly filter: TemplateFilter };

/**
 * The template with each reference's value through its filters. `input` gives a name's value and,
 * for `path`, its Secret file's path on the machine: the caller resolved every name beforehand.
 */
export const renderTemplate = (
  parts: ReadonlyArray<TemplatePart>,
  input: (name: string) => { readonly value: string; readonly path?: string },
): RenderedTemplate => {
  let text = "";
  for (const part of parts) {
    if (part._tag === "text") {
      text += part.text;
      continue;
    }
    const found = input(part.name);
    let value = found.value;
    for (const filter of part.filters) {
      switch (filter) {
        case "path":
          if (found.path === undefined) return { _tag: "failed", name: part.name, filter };
          value = found.path;
          break;
        case "base64":
          value = toBase64(value);
          break;
        case "base64decode": {
          const decoded = fromBase64(value);
          if (decoded === undefined) return { _tag: "failed", name: part.name, filter };
          value = decoded;
          break;
        }
        case "urlencode":
          value = encodeURIComponent(value);
          break;
        case "json":
          value = JSON.stringify(value).slice(1, -1);
          break;
        case "trim":
          value = value.trim();
          break;
      }
    }
    text += value;
  }
  return { _tag: "rendered", text };
};
