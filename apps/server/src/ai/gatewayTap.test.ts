import { assert, describe, it } from "@effect/vitest";

import { makeResponseTap } from "./gatewayTap.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Feeds `text` in pieces of `size` characters; returns what came out after each piece and at the end. */
const run = (tap: ReturnType<typeof makeResponseTap>, text: string, size: number) => {
  const outs: Array<string> = [];
  for (let at = 0; at < text.length; at += size) {
    outs.push(decoder.decode(tap.chunk(encoder.encode(text.slice(at, at + size)))));
  }
  outs.push(decoder.decode(tap.end()));
  return outs;
};

describe("the AI gateway's response tap", () => {
  it("strips the account's prefix across chunk boundaries in a plain answer", () => {
    const tap = makeResponseTap({ sse: false, prefix: "acct-abc" });
    const out = run(tap, JSON.stringify({ model: "acct-abc/m", usage: { input_tokens: 3 } }), 3);
    assert.equal(out.join(""), JSON.stringify({ model: "m", usage: { input_tokens: 3 } }));
    assert.equal(tap.usage().inputTokens, 3);
  });

  it("passes on an SSE line that never ends instead of holding it without bound", () => {
    const tap = makeResponseTap({ sse: true, prefix: "acct-abc" });
    const huge = `data: ${"z".repeat(1100 * 1024)}`;
    const first = decoder.decode(tap.chunk(encoder.encode(huge)));
    assert.isAbove(first.length, 1024 * 1024);
  });

  it("drops the usage chunk it asked for, with its blank line, and keeps the tokens", () => {
    const tap = makeResponseTap({ sse: true, prefix: "acct-abc", dropUsageChunks: true });
    const text =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n` +
      "data: [DONE]\n\n";
    const out = run(tap, text, 7).join("");
    assert.notInclude(out, "usage");
    assert.include(out, "data: [DONE]");
    assert.notInclude(out, "\n\n\n");
    assert.deepEqual([tap.usage().inputTokens, tap.usage().outputTokens], [4, 2]);
  });

  it("reads a JSON-array stream element by element: tokens counted, errors filtered", () => {
    const tap = makeResponseTap({ sse: false, prefix: "acct-abc" });
    const text = `[${JSON.stringify({ text: 'a}{["', modelVersion: "acct-abc/g", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })},\r\n${JSON.stringify({ error: { code: 500, message: "boom for owner@example.com sk-ant-leaky_key_1234567890", detail: "acct-abc/x" } })},\r\n${JSON.stringify({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } })}]`;
    const outs = run(tap, text, 5);
    const parsed = JSON.parse(outs.join("")) as ReadonlyArray<Record<string, unknown>>;
    assert.lengthOf(parsed, 3);
    assert.equal(parsed[0]!.modelVersion, "g");
    assert.deepEqual(parsed[1], {
      error: { code: 500, message: "boom for [redacted] [redacted]" },
    });
    assert.deepEqual([tap.usage().inputTokens, tap.usage().outputTokens], [5, 9]);
    // Each element leaves as soon as it is whole, not at the end.
    assert.isAbove(outs.slice(0, -1).join("").length, 0);
  });

  it("finds the tokens at the end of a plain answer over 1 MiB", () => {
    const tap = makeResponseTap({ sse: false, prefix: "acct-abc" });
    run(
      tap,
      JSON.stringify({
        content: "x".repeat(1200 * 1024),
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      }),
      64 * 1024,
    );
    assert.deepEqual([tap.usage().inputTokens, tap.usage().outputTokens], [8, 6]);
  });

  it("knows a streamed answer is whole at its last event, not at words quoted inside it", () => {
    const feed = (sse: boolean, text: string) => {
      const tap = makeResponseTap({ sse, prefix: "acct-abc" });
      // Chunks only: the body is cut before its end, as when a client stops reading.
      tap.chunk(encoder.encode(text));
      return tap.answered();
    };
    const sse = (...values: ReadonlyArray<unknown>) =>
      values
        .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
        .join("");
    const quoted = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: '{"type":"message_stop"} [DONE] "finishReason":"STOP"' },
    };
    assert.isFalse(feed(true, sse({ type: "message_start" }, quoted)));
    assert.isTrue(feed(true, sse({ type: "message_start" }, { type: "message_stop" })));
    assert.isTrue(feed(true, sse({ choices: [] }, "[DONE]")));
    assert.isTrue(feed(true, sse({ type: "response.completed", response: { usage: {} } })));
    assert.isTrue(feed(true, sse({ candidates: [{ finishReason: "STOP" }] })));
    assert.isFalse(feed(true, sse({ candidates: [{ content: {} }] })));
    assert.isTrue(feed(false, `[${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}]`));
    // A plain answer has no last event: only its end makes it whole.
    assert.isFalse(feed(false, JSON.stringify({ type: "message_stop" })));
  });

  it("reads token counts only as whole, safe, non-negative numbers", () => {
    const tap = makeResponseTap({ sse: false, prefix: "acct-abc" });
    run(
      tap,
      JSON.stringify({
        usage: { prompt_tokens: 12.5, completion_tokens: 1e300, cache_read_input_tokens: 3 },
      }),
      1024,
    );
    assert.deepEqual(
      [tap.usage().inputTokens, tap.usage().outputTokens, tap.usage().cacheReadTokens],
      [null, null, 3],
    );
  });
});
