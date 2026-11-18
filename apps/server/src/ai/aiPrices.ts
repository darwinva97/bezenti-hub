/**
 * Grants ticket 05: list prices of `api-key` models, shipped with releases, never downloaded (ADR
 * 0007). A price change is a new entry with a later `validFrom`, never an edit; only prices read on
 * a public page, with it and its day. docs: ai-gateway.md, «Estimated cost».
 */
import type { AiAccountProvider } from "@t3tools/contracts";

/** One model's rates from one day on, in USD per million tokens. */
export interface AiPrice {
  readonly provider: AiAccountProvider;
  /** A model name, or a prefix ending in `*`; case-insensitive. The longest match wins. */
  readonly model: string;
  /** First UTC day (`YYYY-MM-DD`) these rates apply. */
  readonly validFrom: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The public page the rates were read from, and when: `<url> (checked YYYY-MM-DD)`. */
  readonly source: string;
}

/** The day the whole table was last checked against the providers' pages. */
export const AI_PRICES_REVIEWED = "2026-11-18";

/**
 * Days before the table existed have no price: nothing says what they cost, and an estimate must
 * not invent one.
 */
const SINCE = AI_PRICES_REVIEWED;

const ANTHROPIC = `https://platform.claude.com/docs/en/about-claude/pricing (checked ${AI_PRICES_REVIEWED})`;
const OPENAI = `https://developers.openai.com/api/docs/pricing (checked ${AI_PRICES_REVIEWED})`;
const GEMINI = `https://ai.google.dev/gemini-api/docs/pricing (checked ${AI_PRICES_REVIEWED})`;
const XAI = `https://docs.x.ai/docs/models (checked ${AI_PRICES_REVIEWED})`;

interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * A model under its own name and its dated snapshots (`<name>-20250929`), never a later model
 * that merely shares the prefix: an unknown model stays unpriced rather than borrowing a price.
 */
const models = (
  provider: AiAccountProvider,
  names: ReadonlyArray<string>,
  rates: Rates,
  source: string,
  validFrom: string = SINCE,
): ReadonlyArray<AiPrice> =>
  names.flatMap((name) =>
    [name, `${name}-20*`].map((model) => ({ provider, model, validFrom, ...rates, source })),
  );

/** Claude: input, 5-minute cache write, cache read, output. */
const claude = (names: ReadonlyArray<string>, rates: readonly [number, number, number, number]) =>
  models(
    "claude",
    names,
    { input: rates[0], cacheWrite: rates[1], cacheRead: rates[2], output: rates[3] },
    ANTHROPIC,
  );

/**
 * Providers whose answers report no cache writes (OpenAI, Gemini, xAI): input, cached input,
 * output. A model listing no cached-input rate gets no discount.
 */
const uncachedWrites = (
  provider: AiAccountProvider,
  source: string,
  names: ReadonlyArray<string>,
  rates: readonly [number, number | null, number],
  validFrom?: string,
) =>
  models(
    provider,
    names,
    { input: rates[0], cacheRead: rates[1] ?? rates[0], cacheWrite: rates[0], output: rates[2] },
    source,
    validFrom,
  );

const openai = (names: ReadonlyArray<string>, rates: readonly [number, number | null, number]) =>
  uncachedWrites("codex", OPENAI, names, rates);

const gemini = (
  names: ReadonlyArray<string>,
  rates: readonly [number, number, number],
  validFrom?: string,
) => uncachedWrites("gemini", GEMINI, names, rates, validFrom);

const xai = (names: ReadonlyArray<string>, rates: readonly [number, number, number]) =>
  uncachedWrites("xai", XAI, names, rates);

export const AI_PRICES: ReadonlyArray<AiPrice> = [
  // Anthropic, first-party API (`claude` api-key accounts). Haiku 5.5 at its prompts-up-to-100k
  // rates; the page prices longer prompts higher.
  ...claude(["claude-fable-5-2", "claude-mythos-5-2"], [8, 10, 0.2, 40]),
  ...claude(["claude-fable-5-1", "claude-mythos-5-1"], [10, 12.5, 0.25, 50]),
  ...claude(["claude-fable-5", "claude-mythos-5"], [10, 12.5, 1, 50]),
  ...claude(["claude-opus-5-5"], [4, 5, 0.2, 20]),
  ...claude(
    ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
    [5, 6.25, 0.5, 25],
  ),
  ...claude(["claude-opus-4-1", "claude-opus-4", "claude-opus-4-0"], [15, 18.75, 1.5, 75]),
  ...claude(["claude-sonnet-5-5"], [2, 2.5, 0.1, 10]),
  ...claude(["claude-sonnet-5"], [2, 2.5, 0.2, 10]),
  ...claude(
    ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4", "claude-sonnet-4-0"],
    [3, 3.75, 0.3, 15],
  ),
  ...claude(["claude-haiku-5-5"], [0.1, 0.125, 0.01, 0.5]),
  ...claude(["claude-haiku-4-5"], [1, 1.25, 0.1, 5]),

  // OpenAI, Standard tier, short context (`codex` api-key accounts).
  ...openai(["gpt-6.2-astra"], [8, 0.4, 40]),
  ...openai(["gpt-6.2-sol", "gpt-6.1-sol"], [2, 0.1, 10]),
  ...openai(["gpt-6-astra"], [10, 1, 50]),
  ...openai(["gpt-6.1-terra"], [1, 0.05, 5]),
  ...openai(["gpt-6-luna"], [0.1, 0.01, 0.5]),
  ...openai(["gpt-6-sol"], [2, 0.2, 10]),
  ...openai(["gpt-5.6-sol"], [4, 0.4, 20]),
  ...openai(["gpt-5.6-terra"], [2, 0.2, 12]),
  ...openai(["gpt-5.6-luna"], [0.2, 0.02, 1.2]),
  ...openai(["gpt-5.5"], [5, 0.5, 30]),
  ...openai(["gpt-5.5-pro", "gpt-5.4-pro"], [30, null, 180]),
  ...openai(["gpt-5.4"], [2.5, 0.25, 15]),
  ...openai(["gpt-5.4-mini"], [0.75, 0.075, 4.5]),
  ...openai(["gpt-5.4-nano"], [0.2, 0.02, 1.25]),
  ...openai(["gpt-5.3-codex", "gpt-5.2"], [1.75, 0.175, 14]),
  ...openai(["gpt-5.2-pro"], [21, null, 168]),
  ...openai(["gpt-5.1", "gpt-5"], [1.25, 0.125, 10]),
  ...openai(["gpt-5-mini"], [0.25, 0.025, 2]),
  ...openai(["gpt-5-nano"], [0.05, 0.005, 0.4]),
  ...openai(["gpt-5-pro"], [15, null, 120]),
  ...openai(["gpt-4.1"], [2, 0.5, 8]),
  ...openai(["gpt-4.1-mini"], [0.4, 0.1, 1.6]),
  ...openai(["o3"], [2, 0.5, 8]),
  ...openai(["o3-pro"], [20, null, 80]),

  // Gemini API, paid Standard tier, text, prompts up to 200k (`gemini` api-key accounts). The
  // page announces the later prices of Gemini 4 Carbon and Argon and of 3.8 and 3.6 Flash.
  ...gemini(["gemini-4-carbon", "gemini-4-argon"], [2, 0.1, 10]),
  ...gemini(["gemini-4-carbon", "gemini-4-argon"], [4, 0.2, 20], "2026-12-01"),
  ...gemini(["gemini-4-hydrogen"], [1.5, 0.075, 7.5]),
  ...gemini(["gemini-3.8-flash", "gemini-3.6-flash"], [0.75, 0.075, 3.75]),
  ...gemini(["gemini-3.8-flash", "gemini-3.6-flash"], [1.5, 0.15, 7.5], "2027-01-01"),
  ...gemini(["gemini-3.5-flash-lite"], [0.3, 0.03, 2.5]),
  ...gemini(["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"], [2, 0.2, 12]),
  ...gemini(["gemini-3.1-flash-lite"], [0.25, 0.025, 1.5]),
  ...gemini(["gemini-3-flash-preview"], [0.5, 0.05, 3]),
  ...gemini(["gemini-2.5-pro"], [1.25, 0.125, 10]),

  // xAI, prompts under 200k tokens (`xai` api-key accounts).
  ...xai(["grok-4.7", "grok-4.6"], [2, 0.5, 6]),
  ...xai(["grok-4.5"], [2, 0.3, 6]),
  ...xai(
    [
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ],
    [1.25, 0.2, 2.5],
  ),
  ...xai(["grok-build-0.1"], [1, 0.2, 2]),
];

/** `claude-opus-4-6[1m]` → `claude-opus-4-6`: a context variant is priced as its model. */
const normalize = (model: string) => {
  const name = model.trim().toLowerCase();
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
};

const matches = (pattern: string, name: string) => {
  const lowered = pattern.toLowerCase();
  return lowered.endsWith("*") ? name.startsWith(lowered.slice(0, -1)) : name === lowered;
};

/**
 * The rates for one account provider's model on one UTC day: of the entries in force that day,
 * the longest matching pattern, then its latest version. Null: no price.
 */
export const priceFor = (
  table: ReadonlyArray<AiPrice>,
  provider: AiAccountProvider,
  model: string,
  day: string,
): AiPrice | null => {
  const name = normalize(model);
  if (name.length === 0) return null;
  let best: AiPrice | null = null;
  for (const price of table) {
    if (price.provider !== provider || price.validFrom > day || !matches(price.model, name)) {
      continue;
    }
    if (
      best === null ||
      price.model.length > best.model.length ||
      (price.model.length === best.model.length && price.validFrom > best.validFrom)
    ) {
      best = price;
    }
  }
  return best;
};

/** Tokens to price; input without what the answer read from the cache. */
export interface PricedTokens {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const costUsd = (price: AiPrice, tokens: PricedTokens): number =>
  (tokens.uncachedInputTokens * price.input +
    tokens.outputTokens * price.output +
    tokens.cacheReadTokens * price.cacheRead +
    tokens.cacheWriteTokens * price.cacheWrite) /
  1_000_000;
