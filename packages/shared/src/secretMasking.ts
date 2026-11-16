/**
 * Spec 5 ticket 05: the one rule that turns a secret's value into `[NAME]`, in every form
 * {@link secretForms} lists. Values shorter than 6 are never masked (open question 3). Logs and
 * spans use the values this process knows ({@link rememberKnownSecrets}); client output never does.
 */

/** Shorter values are delivered but never masked (the Vault marks them `unmasked`). */
export const MIN_MASKED_SECRET_LENGTH = 6;

/** A line of a multiline value is masked on its own from this length, when it has no spaces. */
const MIN_MASKED_LINE_LENGTH = 20;

/** A base64 or hex run shorter than this is too likely to occur by chance. */
const MIN_ENCODED_LENGTH = 8;

export interface MaskableSecret {
  readonly name: string;
  readonly value: string;
}

/** A stretch of text that holds a value (or overlapping values), named after the first. */
export interface MaskedInterval {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

export interface SecretPatterns {
  /** No value to look for: every call returns its input. */
  readonly isEmpty: boolean;
  /** Every known form of every value replaced by `[NAME]`. */
  readonly mask: (text: string) => string;
  /** Where `text` holds a value's form, merged where they overlap. */
  readonly intervals: (text: string) => ReadonlyArray<MaskedInterval>;
  /**
   * The length of the longest end of `text` that is the start of a value's form, but not a whole
   * one: what the next chunk of a stream could complete. 0 when nothing could.
   */
  readonly pendingSuffix: (text: string) => number;
  /** The name of the value whose form the end of `text` starts ({@link pendingSuffix}), if any. */
  readonly pendingName: (text: string) => string | undefined;
  /**
   * The length of the longest start of `text` that is the end of a value's form, but not a whole
   * one: what is left of a value when text was cut before it (a trimmed history). 0 when none.
   */
  readonly pendingPrefix: (text: string) => number;
  /** Whether `text` holds any value's form. */
  readonly matches: (text: string) => boolean;
  /** The longest form's length (0 when empty). */
  readonly maxFormLength: number;
  /** The names a value masks as. */
  readonly names: ReadonlySet<string>;
}

const BASE64_CORE = /^[A-Za-z0-9+/]+$/;

/** The characters of `bytes`' base64 that depend on `bytes` alone, when `offset` bytes precede. */
const base64Core = (bytes: Uint8Array, offset: 0 | 1 | 2): string => {
  const padded = new Uint8Array(offset + bytes.length);
  padded.set(bytes, offset);
  const encoded = Buffer.from(padded).toString("base64");
  const first = Math.ceil((8 * offset) / 6);
  const end = Math.floor((8 * (offset + bytes.length)) / 6);
  return encoded.slice(first, end);
};

const nonAsciiEscaped = (value: string) =>
  value.replace(/[^ -~]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * The forms of one value the masker looks for: as written; with CRLF line ends (a terminal's
 * `onlcr`); as a JSON string and with non-ASCII as `\uXXXX`; URL-encoded (upper and lower case
 * escapes, and `+` for spaces); in hex; and in standard and URL-safe base64 at the three byte
 * alignments a longer base64 text can put it in. Wrapped base64 is found by {@link makeSecretPatterns}.
 */
export const secretForms = (value: string): ReadonlyArray<string> => {
  if (value.length < MIN_MASKED_SECRET_LENGTH) return [];
  const forms = new Set<string>([value]);
  if (value.includes("\n")) forms.add(value.replace(/\r?\n/g, "\r\n"));
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(nonAsciiEscaped(value));
  try {
    const url = encodeURIComponent(value);
    forms.add(url);
    forms.add(url.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    forms.add(url.replace(/%20/g, "+"));
  } catch {
    // A lone surrogate has no URL encoding; the other forms are still masked.
  }
  const bytes = new TextEncoder().encode(value);
  const hex = Buffer.from(bytes).toString("hex");
  if (hex.length >= MIN_ENCODED_LENGTH) {
    forms.add(hex);
    forms.add(hex.toUpperCase());
  }
  for (const offset of [0, 1, 2] as const) {
    const core = base64Core(bytes, offset);
    if (core.length >= MIN_ENCODED_LENGTH && BASE64_CORE.test(core)) {
      forms.add(core);
      forms.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  // Spec «Variables y secretos sellados», question 6: a multiline value (a file, a PEM, a
  // kubeconfig) is also masked line by line, where a line is long and has no spaces, as printed.
  if (value.includes("\n")) {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_MASKED_LINE_LENGTH && !/\s/.test(trimmed)) forms.add(trimmed);
    }
  }
  return [...forms].filter((form) => form.length >= MIN_MASKED_SECRET_LENGTH);
};

const EMPTY: SecretPatterns = {
  isEmpty: true,
  mask: (text) => text,
  intervals: () => [],
  pendingSuffix: () => 0,
  pendingName: () => undefined,
  pendingPrefix: () => 0,
  matches: () => false,
  maxFormLength: 0,
  names: new Set(),
};

const pairKey = (text: string, at: number) => (text.charCodeAt(at) << 16) | text.charCodeAt(at + 1);

const push = <K, V>(map: Map<K, Array<V>>, key: K, value: V) => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (list.at(-1) !== value) list.push(value);
};

const isBase64Char = (code: number) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47 ||
  code === 45 ||
  code === 95;

/**
 * The patterns of a set of secrets. A form two secrets share masks as the first one's name, so
 * pass them in precedence order. Matching indexes forms by their first two characters, so a text
 * costs one map lookup per character however many values there are.
 */
export const makeSecretPatterns = (secrets: Iterable<MaskableSecret>): SecretPatterns => {
  const nameOf = new Map<string, string>();
  const encoded = new Set<string>();
  for (const secret of secrets) {
    for (const form of secretForms(secret.value)) {
      if (!nameOf.has(form)) nameOf.set(form, secret.name);
      if (form !== secret.value && /^[A-Za-z0-9+/_-]+$/.test(form)) encoded.add(form);
    }
  }
  if (nameOf.size === 0) return EMPTY;
  const forms = [...nameOf.keys()].sort((a, b) => b.length - a.length);
  const maxLength = forms[0]!.length;
  // Longest first in every bucket, so the first hit at a position is the longest form there.
  const byPair = new Map<number, Array<string>>();
  const byFirst = new Map<number, Array<string>>();
  const byLast = new Map<number, Array<string>>();
  for (const form of forms) {
    push(byPair, pairKey(form, 0), form);
    push(byFirst, form.charCodeAt(0), form);
    push(byLast, form.charCodeAt(form.length - 1), form);
  }
  const hasEncoded = encoded.size > 0;

  const rawIntervals = (text: string, into: Array<MaskedInterval>, only?: Set<string>) => {
    for (let at = 0; at + 1 < text.length; at += 1) {
      const bucket = byPair.get(pairKey(text, at));
      if (bucket === undefined) continue;
      for (const form of bucket) {
        if (only !== undefined && !only.has(form)) continue;
        if (text.startsWith(form, at)) {
          into.push({ start: at, end: at + form.length, name: nameOf.get(form) ?? "" });
          break;
        }
      }
    }
  };

  /** Base64 or hex wrapped across lines (MIME, PEM): matched with the line breaks left out. */
  const wrappedIntervals = (text: string, into: Array<MaskedInterval>) => {
    if (!hasEncoded || !text.includes("\n")) return;
    let joined = "";
    const origin: Array<number> = [];
    for (let at = 0; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if ((code === 10 || code === 13) && at > 0 && isBase64Char(text.charCodeAt(at - 1))) {
        continue;
      }
      joined += text[at];
      origin.push(at);
    }
    if (joined.length === text.length) return;
    const found: Array<MaskedInterval> = [];
    rawIntervals(joined, found, encoded);
    for (const interval of found) {
      into.push({
        start: origin[interval.start]!,
        end: origin[interval.end - 1]! + 1,
        name: interval.name,
      });
    }
  };

  const intervals = (text: string): ReadonlyArray<MaskedInterval> => {
    if (text.length < 2) return [];
    const found: Array<MaskedInterval> = [];
    rawIntervals(text, found);
    wrappedIntervals(text, found);
    if (found.length === 0) return found;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Array<MaskedInterval> = [];
    for (const interval of found) {
      const last = merged.at(-1);
      if (last !== undefined && interval.start < last.end) {
        if (interval.end > last.end) merged[merged.length - 1] = { ...last, end: interval.end };
      } else {
        merged.push(interval);
      }
    }
    return merged;
  };

  const mask = (text: string): string => {
    const found = intervals(text);
    if (found.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const { start, end, name } of found) {
      out += `${text.slice(cursor, start)}[${name}]`;
      cursor = end;
    }
    return out + text.slice(cursor);
  };

  const pending = (
    text: string,
  ): { readonly length: number; readonly form: string } | undefined => {
    for (let at = Math.max(0, text.length - maxLength + 1); at < text.length; at += 1) {
      const rest = text.length - at;
      for (const form of byFirst.get(text.charCodeAt(at)) ?? []) {
        if (form.length > rest && form.startsWith(text.slice(at))) return { length: rest, form };
      }
    }
    return undefined;
  };
  const pendingSuffix = (text: string): number => pending(text)?.length ?? 0;
  const pendingName = (text: string): string | undefined => {
    const found = pending(text);
    return found === undefined ? undefined : nameOf.get(found.form);
  };

  const pendingPrefix = (text: string): number => {
    for (let length = Math.min(maxLength - 1, text.length); length > 0; length -= 1) {
      const head = text.slice(0, length);
      for (const form of byLast.get(text.charCodeAt(length - 1)) ?? []) {
        if (form.length > length && form.endsWith(head)) return length;
      }
    }
    return 0;
  };

  return {
    isEmpty: false,
    mask,
    intervals,
    pendingSuffix,
    pendingName,
    pendingPrefix,
    matches: (text) => intervals(text).length > 0,
    maxFormLength: maxLength,
    names: new Set(nameOf.values()),
  };
};

/**
 * `text` masked, its end too: a trailing start of a value at least
 * {@link MIN_MASKED_SECRET_LENGTH} long shows as `[NAME]`, never raw. With `cutAtStart` (text whose
 * beginning was cut off: a trimmed history) what is left of a value at its start is dropped.
 */
export const maskWhole = (
  patterns: SecretPatterns,
  text: string,
  options?: { readonly cutAtStart?: boolean },
): string => {
  if (patterns.isEmpty) return text;
  const body = options?.cutAtStart === true ? text.slice(patterns.pendingPrefix(text)) : text;
  const partial = trailingPartial(patterns, body);
  if (partial.length < MIN_MASKED_SECRET_LENGTH) return patterns.mask(body);
  return `${patterns.mask(body.slice(0, body.length - partial.length))}[${partial.name}]`;
};

/** The start of a value's form at the end of `text`, past its last whole value (never inside one). */
const trailingPartial = (
  patterns: SecretPatterns,
  text: string,
): { readonly length: number; readonly name: string | undefined } => {
  const tail = text.slice(patterns.intervals(text).at(-1)?.end ?? 0);
  return { length: patterns.pendingSuffix(tail), name: patterns.pendingName(tail) };
};

/**
 * Masks a stream's pieces. One whose end could start a value is held; sent anyway, that start shows
 * as `[NAME]` (from {@link MIN_MASKED_SECRET_LENGTH} characters) and the value's rest is dropped.
 * One guard per stream for its life: new values and screen resets keep what was sent in view.
 */
export class SecretStreamGuard {
  private held = "";
  private emitted = "";
  /** The end of what was sent started a value and was sent as `[NAME]`: its rest is dropped. */
  private open = false;
  private patterns: SecretPatterns;

  constructor(patterns: SecretPatterns) {
    this.patterns = patterns;
  }

  /** A new set of values (a reload, a value delivered): what was sent and held stays. */
  setPatterns(patterns: SecretPatterns): void {
    this.patterns = patterns;
  }

  /**
   * The text to send now (masked; possibly empty) and whether the rest is held for the next
   * piece. Held text is never longer than `maxHeld`.
   */
  push(chunk: string, maxHeld: number): { readonly text: string; readonly hold: boolean } {
    let text = this.held + chunk;
    this.held = "";
    if (this.patterns.isEmpty) {
      this.open = false;
      this.remember(text);
      return { text, hold: false };
    }
    let prefix = "";
    // A value begun in what was already sent: its continuation here is masked (or dropped, when
    // its start was already sent as `[NAME]`).
    const boundary = this.emitted.length;
    if (boundary > 0 && text.length > 0) {
      let cut = 0;
      let name: string | undefined;
      for (const interval of this.patterns.intervals(this.emitted + text)) {
        if (interval.start < boundary && interval.end > boundary && interval.end - boundary > cut) {
          cut = interval.end - boundary;
          name = interval.name;
        }
      }
      if (name !== undefined) {
        this.remember(text.slice(0, cut));
        prefix = this.open ? "" : `[${name}]`;
        text = text.slice(cut);
      } else {
        // All of it may still be inside a value begun before (a value in three or more pieces):
        // its middle is never sent.
        const begun = this.patterns.pendingSuffix(this.emitted + text);
        if (begun > text.length && begun >= MIN_MASKED_SECRET_LENGTH) {
          const named = this.open ? "" : `[${this.patterns.pendingName(this.emitted + text)}]`;
          this.remember(text);
          this.open = true;
          return { text: named, hold: false };
        }
      }
    }
    this.open = false;
    if (text.length > 0 && text.length <= maxHeld && this.patterns.pendingSuffix(text) > 0) {
      this.held = text;
      return { text: prefix, hold: true };
    }
    return { text: prefix + this.send(text), hold: false };
  }

  /** What was held, masked (a start of a value as `[NAME]`): sent when nothing followed in time. */
  release(): string {
    const text = this.held;
    this.held = "";
    return this.send(text);
  }

  /** Drops what is held, unsent: the screen was reset to `text` (a snapshot), now in view. */
  seed(text: string): void {
    this.held = "";
    this.emitted = "";
    this.open = false;
    this.remember(text);
    this.open = trailingPartial(this.patterns, text).length >= MIN_MASKED_SECRET_LENGTH;
  }

  get holding(): boolean {
    return this.held.length > 0;
  }

  private send(text: string): string {
    this.remember(text);
    const masked = maskWhole(this.patterns, text);
    this.open = trailingPartial(this.patterns, text).length >= MIN_MASKED_SECRET_LENGTH;
    return masked;
  }

  private remember(raw: string) {
    const keep = Math.max(this.patterns.maxFormLength - 1, 0);
    this.emitted = keep === 0 ? "" : (this.emitted + raw).slice(-keep);
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Every string inside plain objects and arrays masked; anything else (class instances such as
 * dates, numbers, keys) kept. Returns the same reference when nothing changed.
 */
export const maskDeep = <A>(value: A, mask: (text: string) => string): A => {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return mask(node);
    if (Array.isArray(node)) {
      let changed: Array<unknown> | undefined;
      for (let index = 0; index < node.length; index += 1) {
        const next = walk(node[index]);
        if (next !== node[index]) {
          changed ??= [...node];
          changed[index] = next;
        }
      }
      return changed ?? node;
    }
    if (isPlainObject(node)) {
      let changed: Record<string, unknown> | undefined;
      for (const [key, entry] of Object.entries(node)) {
        const next = walk(entry);
        if (next !== entry) {
          changed ??= { ...node };
          changed[key] = next;
        }
      }
      return changed ?? node;
    }
    return node;
  };
  return walk(value) as A;
};

/**
 * An error (a class instance, which {@link maskDeep} leaves alone) with every string field masked,
 * its own `message` and `cause` too, keeping its class. Other values: {@link maskDeep}.
 */
export const maskError = <E>(error: E, mask: (text: string) => string): E =>
  walkError(error, (_key, text) => mask(text), new WeakMap()) as E;

/** Fields that carry what a process or a person wrote (not tags, kinds, ids or codes). */
const ERROR_TEXT_KEYS = new Set([
  "message",
  "detail",
  "stderr",
  "stdout",
  "output",
  "text",
  "error",
  "description",
  "summary",
  "title",
  "body",
  "subject",
  "diff",
  "patch",
  "contents",
  "oldContents",
  "newContents",
  "lineContent",
]);

/**
 * An error whose text fields (message, detail, stderr, ... at any depth, causes too) all read
 * `hidden`: for when the values to mask it with could not be read. Tags and kinds stay.
 */
export const hideErrorText = <E>(error: E, hidden: string): E =>
  walkError(
    error,
    // A bare string (an answer that is only text) is text too.
    (key, text) => (key === undefined || ERROR_TEXT_KEYS.has(key) ? hidden : text),
    new WeakMap(),
  ) as E;

/** Every string in `value`, at any depth (class instances and causes too), through `map`. */
const walkError = (
  value: unknown,
  map: (key: string | undefined, text: string) => string,
  seen: WeakMap<object, unknown>,
  key?: string,
): unknown => {
  if (typeof value === "string") return map(key, value);
  if (typeof value !== "object" || value === null) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const out: Array<unknown> = [];
    seen.set(value, out);
    let changed = false;
    value.forEach((item, index) => {
      const next = walkError(item, map, seen, key);
      if (next !== item) changed = true;
      out[index] = next;
    });
    if (!changed) seen.set(value, value);
    return changed ? out : value;
  }
  if (value instanceof Date || value instanceof Uint8Array) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, copy);
  let changed = false;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if ("value" in descriptor) {
      const next = walkError(descriptor.value, map, seen, name);
      if (next !== descriptor.value) {
        descriptor.value = next;
        changed = true;
      }
    }
  }
  if (!changed) {
    seen.set(value, value);
    return value;
  }
  Object.defineProperties(copy, descriptors);
  return copy;
};

// ── The values this process knows, for its own logs, spans and files ─────────────────────────

/** Bounds memory if a process sees very many values over its life. */
const MAX_KNOWN_SECRETS = 4096;
const known = new Map<string, string>();
let knownPatterns: SecretPatterns = EMPTY;

/**
 * Values this process holds: from now on its logs, spans, trace and provider event files show
 * them as `[NAME]`. Never used for what a client sees (that would mask one User's text with
 * another's values). Short values are ignored.
 */
export const rememberKnownSecrets = (secrets: Iterable<MaskableSecret>): void => {
  let added = false;
  for (const secret of secrets) {
    if (secret.value.length < MIN_MASKED_SECRET_LENGTH || known.has(secret.value)) continue;
    if (known.size >= MAX_KNOWN_SECRETS) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
    known.set(secret.value, secret.name);
    added = true;
  }
  if (added) {
    knownPatterns = makeSecretPatterns(
      [...known].map(([value, name]) => ({ name, value })).reverse(),
    );
  }
};

/** `text` with every value this process knows shown as `[NAME]`. */
export const redactKnownSecrets = (text: string): string => knownPatterns.mask(text);

/** {@link maskDeep} with the values this process knows. */
export const redactKnownSecretsDeep = <A>(value: A): A =>
  knownPatterns.isEmpty ? value : maskDeep(value, knownPatterns.mask);

/** Tests only: forget every known value. */
export const forgetKnownSecretsForTest = (): void => {
  known.clear();
  knownPatterns = EMPTY;
};
