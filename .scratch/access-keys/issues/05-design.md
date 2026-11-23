# 05 design: token caps

Ticket: `05-topes-de-tokens.md`. Spec: «Topes de tokens», «Lo que recibe el cliente». Builds on 04 (`AccessKeyCaps.usageOf`, the per-subject `unwritten`, the estimate). The Owner decided there is no in-flight limit of the key's own: only the general 16 per gateway key bounds how far in-flight requests can pass a cap.

## Contracts

- `AccessKeyLimits` is `{ total, day, week, month }`. Each field is a whole number from 1 to 10¹², or null.
- `AccessKeyCreateInput` gains optional `limits` and optional `unlimited`.
  - Without `unlimited: true`, at least one cap is required.
  - With it, every cap must be null; caps plus `unlimited` are refused.
  - An uncapped key is therefore always a deliberate choice, as in the Grants form.

## `ai/AccessKeyCaps.ts`

- `check(keyId, limits)` returns `{ usage, exhausted }`.
  - `exhausted` is the first cap reached, checked in the spec's order: total, then month, then week, then day.
  - Each comes as `{ which, amount, used, resetsAt | null }`. The total never resets, so its `resetsAt` is null.
  - It reuses `usageOf`: the daily rows (`COALESCE(uncached, input) + output + cache writes + estimated`) plus the `access-key:<id>` subject in `unwritten`.
  - The periods are `GrantCaps.periodOf` (UTC).
- Messages:
  - total: `capMessage` «This access key used its total token limit (10,000,000). Ask whoever gave it to you to raise it.»;
  - a period: «This access key reached its daily token limit (2,000,000); it resets 2026-11-24 00:00 UTC.» (`weekly`, `monthly`).

## Gateway

- `GatewayCaller.accessKeyLimits` is read by `authorize` on every request, so a changed cap applies from the next request.
- `AiGatewayProxy` checks after the model check and before `planRoute` (nothing has been sent at that point):
  - **Total reached:** 403, recorded as a failed request.
  - **A period reached:** 429, recorded as shed (counts nothing). Headers `retry-after` (seconds to the reset) and `x-should-retry: false`; OpenAI also gets `code: "insufficient_quota"`.
  - `ProxyAnswer.json` gains optional `headers`, which `AiGatewayRoute` passes on.
  - A request admitted below the cap finishes and counts in full.
- `AiGatewayProxy.layer` and `layerWith` provide `AccessKeyCaps`, as they do `GrantCaps`.

## Server

- `AccessKeys.create` checks and stores the limits.
- Audit:
  - `limits` is `none`, or `total=…,day=…,week=…,month=…`, with `-` for no cap;
  - `access_key.create` keeps `unlimited` implicit in `limits: none`.

## Web

- The create form has «Total», «Per day», «Per week» and «Per month» (optional numbers) and a «No token limit» checkbox. The form needs at least one cap or that box.
- The list shows, for each cap: used / cap, what is left, and its reset in local time («never» for the total).

## Tests

- `apps/server/src/ai/AccessKeyCaps.test.ts` (TestClock):
  - the day, ISO week and month roll over at UTC boundaries, and the total never does;
  - total and day reached at once: the total wins;
  - unwritten use counts;
  - cache reads never count; an estimate does.
- `apps/server/src/ai/AccessKeys.caps.test.ts` (route testkit, fake CLIProxyAPI, all three shapes):
  - a daily cap gives 429 with the message, `retry-after` and `x-should-retry: false`, and `insufficient_quota` on OpenAI. With the key's days moved back (the next UTC day), it passes again;
  - the total gives 403 and does not come back the next day;
  - a request in flight when the cap is reached finishes and counts in full; the excess is only what was in flight;
  - create requires a cap or `unlimited`, and refuses both together.
