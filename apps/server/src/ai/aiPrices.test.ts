import { assert, describe, it } from "@effect/vitest";

import { AI_PRICES, type AiPrice, costUsd, priceFor } from "./aiPrices.ts";

const entry = (overrides: Partial<AiPrice>): AiPrice => ({
  provider: "claude",
  model: "claude-test*",
  validFrom: "2026-01-01",
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  source: "test",
  ...overrides,
});

describe("priceFor", () => {
  // Grants ticket 05: a new price never rewrites a day before it.
  it("values each day at the price in force that day", () => {
    const table = [
      entry({ validFrom: "2026-01-01", input: 3 }),
      entry({ validFrom: "2026-12-01", input: 4 }),
    ];
    assert.equal(priceFor(table, "claude", "claude-test-1", "2026-11-30")?.input, 3);
    assert.equal(priceFor(table, "claude", "claude-test-1", "2026-12-01")?.input, 4);
    assert.equal(priceFor(table, "claude", "claude-test-1", "2027-03-01")?.input, 4);
    assert.isNull(priceFor(table, "claude", "claude-test-1", "2025-12-31"));
  });

  it("takes the longest matching pattern, then the latest version", () => {
    const table = [
      entry({ model: "claude-test*", input: 1 }),
      entry({ model: "claude-test-pro*", input: 2 }),
      entry({ model: "claude-test-pro*", validFrom: "2026-06-01", input: 5 }),
    ];
    assert.equal(priceFor(table, "claude", "claude-test-mini", "2026-07-01")?.input, 1);
    assert.equal(priceFor(table, "claude", "claude-test-pro-20260101", "2026-02-01")?.input, 2);
    assert.equal(priceFor(table, "claude", "claude-test-pro-20260101", "2026-07-01")?.input, 5);
  });

  it("matches a name exactly unless it ends in *, ignoring case and a [1m] suffix", () => {
    const table = [entry({ model: "exact-model", input: 7 })];
    assert.equal(priceFor(table, "claude", "Exact-Model", "2026-02-01")?.input, 7);
    assert.equal(priceFor(table, "claude", "exact-model[1m]", "2026-02-01")?.input, 7);
    assert.isNull(priceFor(table, "claude", "exact-model-2", "2026-02-01"));
  });

  it("never prices another provider's account or an unknown model", () => {
    const table = [entry({})];
    assert.isNull(priceFor(table, "codex", "claude-test-1", "2026-02-01"));
    assert.isNull(priceFor(table, "claude", "gpt-unknown", "2026-02-01"));
    assert.isNull(priceFor(table, "claude", "", "2026-02-01"));
  });

  it("ships a table whose entries are all priced, sourced and dated", () => {
    assert.isAbove(AI_PRICES.length, 0);
    for (const price of AI_PRICES) {
      assert.match(price.validFrom, /^\d{4}-\d{2}-\d{2}$/u, price.model);
      assert.match(price.source, /^https:\/\/\S+ \(checked \d{4}-\d{2}-\d{2}\)$/u, price.model);
      for (const rate of [price.input, price.output, price.cacheRead, price.cacheWrite]) {
        assert.isTrue(Number.isFinite(rate) && rate >= 0, price.model);
      }
    }
    // Gemini 3.8 Flash's announced change applies from its day, not before.
    assert.equal(priceFor(AI_PRICES, "gemini", "gemini-3.8-flash", "2026-12-31")?.input, 0.75);
    assert.equal(priceFor(AI_PRICES, "gemini", "gemini-3.8-flash", "2027-01-01")?.input, 1.5);
  });
});

describe("costUsd", () => {
  it("prices each kind of token at its own rate, per million", () => {
    const price = entry({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    const usd = costUsd(price, {
      uncachedInputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 400_000,
    });
    assert.closeTo(usd, 3 + 1.5 + 0.6 + 1.5, 1e-9);
  });
});
