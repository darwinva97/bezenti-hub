# 05 design: estimated USD and subscription quota share

Ticket: `05-coste-estimado-y-cuota-de-suscripciones.md`. Spec: «AI accounts prestadas» (Precio, Suscripciones).

## What exists and what it means for this ticket

- `ai_usage` keeps one row per request for 90 days and includes `shape`. `ai_usage_daily` keeps the daily sums with no time limit, keyed by (day, user, space, account, model, grant), and has **no shape**. `AiUsage.summary` reads from the daily table, or from `ai_usage` when given a `threadId`.
- **Input tokens mean different things per shape** (`gatewayShapes.mergeUsage`). In the Anthropic shape, `input_tokens` leaves out cache reads and writes. In the OpenAI and Gemini shapes, `prompt_tokens`/`input_tokens`/`promptTokenCount` include the cached tokens. So pricing the daily `input_tokens` at the input rate would charge Codex/Gemini cache hits at full price, often 5–10× too high. The cost estimate needs the uncached input per daily row.
- `usage/usagePricing.ts` is the desktop transcript pricer, and it downloads LiteLLM. I won't reuse its table (ADR 0007: no downloads) and won't touch it.
- The quota reader already exists: `AiAccounts.quotaWindows(endpoint)` → `usage/cliproxyApi.ts`. It is cached for 5 minutes, keyed by token file, and covers Claude and Codex subscriptions. Each window has `usedPercent`, `resetsAt` and `windowDurationMins`.

## Prices (`apps/server/src/ai/aiPrices.ts`)

- Entries look like `{ provider: AiAccountProvider, model: pattern, validFrom: "YYYY-MM-DD" (UTC), input, output, cacheRead, cacheWrite }`, in USD per million tokens.
  - A pattern is an exact name or a trailing `*` prefix, matched case-insensitively. A `[1m]`-style suffix is stripped before matching.
  - Lookup for (provider, model, day): take the entries whose pattern matches and whose `validFrom <= day`. The longest pattern wins, then the latest `validFrom`. A new version therefore never rewrites a day before it.
- The table also exports `AI_PRICES_REVIEWED` (a date). It is returned in the summary and shown in the UI ("list prices as of …").
- **Seed:** the api-key models the gateway serves today:
  - Claude, via the `claude` provider;
  - OpenAI, via `codex`;
  - Gemini, via `gemini` and the same entries for `vertex`;
  - xAI.

  Each block carries a comment naming the price page it was checked against, checked at implementation time. Claude prices come from the claude-api reference. Anything I can't verify is left out and shows as "no price". `openai-compatible` and `meta` get no entries, because a reseller's price is unknown.

- **What gets priced:** only `api-key` accounts. Rows from subscriptions, from direct accounts, or with no account get `null`. Long-context tiers, batch pricing, regional pricing and priority/fast tiers are ignored: the estimate uses base list prices (see Risks).
- **Formula:** `uncachedInput·input + cacheRead·cacheRead + cacheWrite·cacheWrite + output·output`.

- **Changed during implementation:**
  - **No Vertex prices.** Only AI Studio's Gemini page was read, so Vertex gets no entries ("no price"); the planned default (c) is dropped.
  - **No price before the review day.** Every entry starts on the day it was checked (2026-11-18), so earlier days have no price instead of an invented one.
  - **Scheduled changes:** Gemini's announced 2026-12-01 and 2027-01-01 price changes are in as later versions.
  - **Left out:** Gemini 2.5 Flash and Flash-Lite, because those rows were not in the verbatim page text.

## DB: migration `147_AiUsageUncachedInput` (placeholder number)

- `ALTER TABLE ai_usage_daily ADD COLUMN uncached_input_tokens INTEGER` (nullable; NULL means unknown).
- Backfill from `ai_usage`: per daily key, sum `input` for the anthropic shape and `max(0, input − cacheRead)` for the others. The sums are built once in a temporary aggregation, then applied with `UPDATE … FROM`.
  - Keys that have no per-request rows left stay NULL, so their USD is null and they count as unpriced.
- `AiUsage.insert` and the shed upsert write and add the column. In the upsert, NULL stays NULL.
- `ai_usage` itself does not change: `threadId` reads compute the same value from `shape`.

## Contract (`packages/contracts/src/aiUsage.ts`, all `optionalKey` so older Hubs and clients still decode)

- `AiUsageRow.estimatedUsd: number | null`.
- `AiUsageSummary` gains:
  - `estimatedUsd: number | null`: the sum of the priced rows; null when no row is priced. When the rows are truncated, it comes from a grouped query instead.
  - `unpricedTokens`: the api-key tokens that had no price.
  - `pricesReviewedOn`.
  - `quotaShare` (below).
- `estimatedUsd` stays out of `AiUsageTotals`, so `addAiUsageTotals` and GrantCaps are untouched.
- `client-runtime/aiUsageView.groupUsage` sums USD per group (null if nothing in the group is priced). `formatUsd` gives `$0.42` and `<$0.01`.

## Quota share (subscriptions only)

- Computed only when `input.grantId` is set and that Grant's account is a Claude or Codex subscription.
- Windows come from a narrow new `SubscriptionWindows` service: `windowsOf(accountId) → windows | null`.
  - The live implementation is a new internal `AiAccounts.quotaWindowsOf` on the existing 5-minute cache. It fails soft to null, and no RPC reaches it.
  - Tests use a fake.
- **Which windows:** only those with both `resetsAt` and `windowDurationMins`, and not model-scoped (`seven_day_<model>`, which would need tokens per model family).
- **Window start:** `resetsAt − duration`.
- **Formula:** `share = grantTokens / accountTokens × usedPercent`.
  - Both token counts come from `ai_usage`, with `at >= windowStart`.
  - Tokens counted the same way as the caps: input + output + cache write.
  - `grantTokens` uses the session's `visible` filter. A borrowing Member therefore gets their own share; an Admin or the lender gets the whole Grant's.
- **What is returned:** `{ windowId, label, kind, resetsAt, sharePercent, usedPercent? }`.
  - `usedPercent` (the whole account's percentage) only goes to the lender, who already sees it under AI accounts.
  - Raw account token counts are never returned.
  - With no windows or no readable data, there is no `quotaShare`, and nothing is shown.

## UI (`LoanUsage.tsx`; it covers both "Préstamos dados" and "Prestado a este Space", in web and desktop)

- **api-key loan:** the summary line gets "≈ $X.XX estimated" and, when there is any, "N tokens without a price". The table gets an "Est. USD" column, with "—" for unpriced. Footnote: "Estimated from list prices as of <date> in this Hub's release. Not a bill and not a cap."
- **Subscription loan:** no USD at all. Above the table, one line per window: "Weekly quota: ≈ 12% used by this loan (approx.) · resets <local time>". The lender also sees "(account at 64%)". Hidden when there is no `quotaShare`.
- Mobile is untouched (the ticket names web and desktop).

## Docs

`docs/internals/ai-gateway.md`, new section "Estimated cost":

- the table ships with Hub releases and nothing is downloaded (ADR 0007);
- how to add a price change: a new entry with a later `validFrom`, never editing an old entry's numbers;
- bump `AI_PRICES_REVIEWED`;
- the shape rule for uncached input;
- the quota-share formula and its limits.

## Tests (red-first where marked)

- `aiPrices.test.ts` (pure):
  - **red-first:** two versions of a price for one model; the day before the change keeps the old value and the change day gets the new one;
  - the longest pattern wins;
  - an unknown model gives null;
  - the cost formula.
- `AiUsage.cost.test.ts` (pattern of `AiUsage.grants.test.ts`, with the price table injected through `AiUsageOptions.prices`):
  - **red-first:** api-key rows on both sides of a price change;
  - a subscription row gives null;
  - an unknown model goes to `unpricedTokens`;
  - the anthropic and openai shapes do the cache math differently;
  - the totals when truncated;
  - the `threadId` path.
- `147_AiUsageUncachedInput.test.ts` (pattern of the 146 test): the backfill per shape, and NULL where no per-request rows remain.
- Quota share with the fake windows:
  - the lender gets the share plus `usedPercent`;
  - a borrowing Member gets their own share and no `usedPercent`;
  - api-key loans, missing windows and model-scoped windows give nothing.
- `aiUsageView` grouping test for USD. No new browser test unless the existing `GrantsSettings.browser.test.tsx` makes it cheap.

## Spec ambiguities and my default

1. **Quota share as a "column":** the table covers 30 days per day/User/Space, but the windows are 5 h and 7 d, so a per-row share would be wrong. **Default:** a per-window block above the table, not a column.
2. **Which tokens make up the share:** **Default:** the caps' definition (input + output + cache write), for one meaning of "tokens" across the feature.
3. **Vertex:** the spec has one `provider` per entry. **Default:** keep it singular and fill `vertex` from the Gemini entries with a helper.
4. **Who sees the account-wide percentage:** **Default:** the lender only; the borrower sees only their share.

## Risks

- Prices go stale between releases. Mitigation: the estimate is labelled as one, the review date is shown, and the per-day `validFrom` means a later fix only changes the days it should.
- When CLIProxyAPI translates an answer to another shape, the cache fields may not follow that shape's convention. The answer's shape still decides the parsing, so it's approximate either way.
- Use of a subscription outside this Hub inflates `usedPercent` but not `accountTokens`, so the share is overstated. It is labelled "approx." and documented.
- Pre-existing, outside this ticket: GrantCaps counts OpenAI/Gemini `input_tokens` with cache reads included, so caps on Codex/Gemini loans run hot. The new column could fix this in a follow-up.
