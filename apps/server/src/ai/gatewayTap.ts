/**
 * The tap an AI gateway answer streams through (spec 4 ticket 04), chunk by chunk, holding back only
 * a bounded tail: strips the account's prefix, filters upstream error words in every streamed shape
 * (SSE events, JSON-array elements) and reads the tokens, without waiting for the end.
 */
import {
  EMPTY_USAGE,
  type GatewayUsage,
  mergeUsage,
  parseJsonText,
  sanitizeUpstreamText,
} from "./gatewayShapes.ts";

/** An unfinished SSE line or JSON element longer than this is passed on as it is. */
const MAX_HELD_CHARS = 1024 * 1024;
/** A plain JSON answer up to this size is read whole for its tokens; past it, only its tail. */
const USAGE_COPY_LIMIT = 1024 * 1024;
const USAGE_TAIL_CHARS = 256 * 1024;

/** An upstream error object with its words filtered and nothing else it carried (ids, metadata). */
const safeError = (error: unknown) => {
  const fields =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    ...(typeof fields.type === "string" ? { type: fields.type } : {}),
    ...(typeof fields.code === "string" || typeof fields.code === "number"
      ? { code: fields.code }
      : {}),
    ...(typeof fields.status === "string" ? { status: fields.status } : {}),
    message: sanitizeUpstreamText(
      String(typeof error === "string" ? error : (fields.message ?? "The AI gateway failed.")),
    ),
  };
};

/** One JSON value of a stream (an SSE event's data, an array element), errors made safe. */
const safeValue = (text: string, value: unknown) => {
  if (value === null || typeof value !== "object" || !("error" in value)) return text;
  const event = value as Record<string, unknown>;
  return JSON.stringify({
    ...(typeof event.type === "string" ? { type: event.type } : {}),
    error: safeError(event.error),
  });
};

/** The last `"usage"`/`"usageMetadata"` object in a tail of text, as far as it closes there. */
const usageInTail = (tail: string): unknown => {
  for (const name of ['"usageMetadata"', '"usage"']) {
    const at = tail.lastIndexOf(name);
    if (at === -1) continue;
    const open = tail.indexOf("{", at + name.length);
    if (open === -1) continue;
    let depth = 0;
    let inString = false;
    for (let index = open; index < tail.length; index += 1) {
      const char = tail[index];
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        const parsed = parseJsonText(tail.slice(open, index + 1));
        return parsed === undefined ? undefined : { [name.slice(1, -1)]: parsed };
      }
    }
  }
  return undefined;
};

/** Words an answer's last event carries; a match is then checked on the parsed value. */
const LAST_EVENT_HINT = /\[DONE\]|message_stop|response\.(?:completed|incomplete)|finishReason/u;

/**
 * Whether one streamed value is the answer's last word: Claude's `message_stop`, OpenAI's `[DONE]`
 * or `response.completed`/`incomplete`, a Gemini candidate with its `finishReason`. Its tokens are
 * all in by then (each shape sends them before or with it).
 */
const isLastEvent = (data: string, value: unknown) => {
  if (data.trim() === "[DONE]") return true;
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (
    event.type === "message_stop" ||
    event.type === "response.completed" ||
    event.type === "response.incomplete"
  ) {
    return true;
  }
  return (
    Array.isArray(event.candidates) &&
    event.candidates.some(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        typeof (candidate as Record<string, unknown>).finishReason === "string",
    )
  );
};

export interface ResponseTap {
  readonly chunk: (bytes: Uint8Array) => Uint8Array;
  readonly end: () => Uint8Array;
  readonly usage: () => GatewayUsage;
  /**
   * A streamed answer's last event went through (ticket 16): its tokens are complete even if the
   * body is cut before it ends, as when a client stops reading at that event.
   */
  readonly answered: () => boolean;
}

/**
 * `sse`: line by line (an unfinished line waits, up to a bound). Otherwise a JSON answer: an array
 * (Gemini's stream without `alt=sse`) element by element, an object passed straight on.
 * `dropUsageChunks`: the Hub asked for OpenAI's final usage chunk; the client did not see it before.
 */
export const makeResponseTap = (input: {
  readonly sse: boolean;
  readonly prefix: string;
  readonly dropUsageChunks?: boolean;
}): ResponseTap => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const prefix = `${input.prefix}/`;
  const strip = (text: string) => text.split(prefix).join("");
  let usage = EMPTY_USAGE;
  let answered = false;
  let pending = "";
  // SSE: the blank line after a dropped event goes with it.
  let dropBlank = false;
  // JSON: `array` once the first character says so; where the scan is in `pending`.
  let mode: "unknown" | "array" | "object" = "unknown";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let scanned = 0;
  let elementStart = -1;
  let copy = "";
  let tail = "";
  let total = 0;

  const sseLine = (raw: string): string | undefined => {
    const line = strip(raw);
    const data = /^data:\s?(.*?)\r?$/u.exec(line)?.[1];
    const lastHint = data !== undefined && LAST_EVENT_HINT.test(data);
    if (data === undefined || (!lastHint && !/usage|"error"/iu.test(data))) {
      if (dropBlank && line.replace(/\r$/u, "") === "") {
        dropBlank = false;
        return undefined;
      }
      dropBlank = false;
      return line;
    }
    dropBlank = false;
    const value = parseJsonText(data);
    if (lastHint && isLastEvent(data, value)) answered = true;
    if (value === undefined) {
      return /"error"/u.test(data)
        ? `data: ${JSON.stringify({ error: { message: "The AI gateway failed." } })}`
        : line;
    }
    usage = mergeUsage(usage, value);
    const event = value as Record<string, unknown>;
    if (
      input.dropUsageChunks === true &&
      Array.isArray(event.choices) &&
      event.choices.length === 0 &&
      event.usage !== undefined
    ) {
      dropBlank = true;
      return undefined;
    }
    const safe = safeValue(data, value);
    return safe === data ? line : `data: ${safe}`;
  };

  const takeSse = (final: boolean) => {
    let end = final ? pending.length : pending.lastIndexOf("\n") + 1;
    // A line that never ends is not held forever: past the bound it goes on as it is.
    if (end <= 0 && pending.length > MAX_HELD_CHARS) end = pending.length;
    if (end <= 0) return "";
    const ready = pending.slice(0, end);
    pending = pending.slice(end);
    const out: Array<string> = [];
    const lines = ready.split("\n");
    lines.forEach((line, index) => {
      const last = index === lines.length - 1;
      if (last && line === "") return;
      const kept = sseLine(line);
      if (kept !== undefined) out.push(last && !ready.endsWith("\n") ? kept : `${kept}\n`);
    });
    return out.join("");
  };

  /** JSON array: every complete element is checked (tokens, errors) before it leaves. */
  const takeArray = (final: boolean) => {
    let out = "";
    let emitted = 0;
    for (let index = scanned; index < pending.length; index += 1) {
      const char = pending[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") {
        depth += 1;
        if (depth === 2 && char === "{") {
          out += strip(pending.slice(emitted, index));
          emitted = index;
          elementStart = index;
        }
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 1 && char === "}" && elementStart !== -1) {
          const text = strip(pending.slice(elementStart, index + 1));
          const value = parseJsonText(text);
          if (value !== undefined) usage = mergeUsage(usage, value);
          if (isLastEvent(text, value)) answered = true;
          out += value === undefined ? text : safeValue(text, value);
          emitted = index + 1;
          elementStart = -1;
        }
      }
    }
    scanned = pending.length;
    if (elementStart === -1 || final || pending.length - elementStart > MAX_HELD_CHARS) {
      out += strip(pending.slice(emitted));
      elementStart = -1;
      emitted = pending.length;
    }
    pending = pending.slice(emitted);
    scanned -= emitted;
    if (elementStart !== -1) elementStart -= emitted;
    return out;
  };

  /** A JSON object: on as it comes, keeping only what could still be the prefix's start. */
  const takeObject = (final: boolean) => {
    pending = strip(pending);
    let hold = 0;
    if (!final) {
      for (let size = Math.min(prefix.length - 1, pending.length); size > 0; size -= 1) {
        if (prefix.startsWith(pending.slice(-size))) {
          hold = size;
          break;
        }
      }
    }
    const ready = pending.slice(0, pending.length - hold);
    pending = pending.slice(pending.length - hold);
    total += ready.length;
    if (copy.length < USAGE_COPY_LIMIT) copy += ready.slice(0, USAGE_COPY_LIMIT - copy.length);
    tail = (tail + ready).slice(-USAGE_TAIL_CHARS);
    return ready;
  };

  const take = (text: string, final: boolean) => {
    pending += text;
    if (input.sse) return takeSse(final);
    if (mode === "unknown") {
      const first = /\S/u.exec(pending)?.[0];
      if (first === undefined && !final) return "";
      mode = first === "[" ? "array" : "object";
    }
    return mode === "array" ? takeArray(final) : takeObject(final);
  };

  return {
    chunk: (bytes) => encoder.encode(take(decoder.decode(bytes, { stream: true }), false)),
    end: () => encoder.encode(take(decoder.decode(), true)),
    usage: () => {
      if (input.sse || mode === "array") return usage;
      const whole = total <= USAGE_COPY_LIMIT ? parseJsonText(copy) : usageInTail(tail);
      return whole === undefined ? usage : mergeUsage(usage, whole);
    },
    // A plain JSON object has no last event: only its end says it is whole.
    answered: () => answered,
  };
};
