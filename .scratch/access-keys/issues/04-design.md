# 04 design: usage per access key

Ticket: `04-uso-por-clave-de-acceso.md`. Spec: «Uso», «Topes de tokens» (answers with no known usage). Builds on 01–03.

## Migration `160_AiUsageAccessKey`

- `ai_usage_daily` is rebuilt, the way 146 did it:
  - `access_key_id TEXT NOT NULL DEFAULT ''` joins the primary key;
  - new column `estimated_tokens INTEGER NOT NULL DEFAULT 0`;
  - every other column, value and index is copied as it was;
  - new index `ai_usage_daily_access_key_idx (access_key_id, day) WHERE access_key_id <> ''`.
- Ticket 01 wrote access-key requests into the daily rows with `user_id = ''` and no key. Those rows are rebuilt per key from the per-request rows (`ai_usage.access_key_id`).
  - That is right as far as `ai_usage` still holds those requests (90 days).
  - Their 429 load refusals are lost, since they were never per-request rows.
- The test copies daily rows and checks every value is kept, that `''` is the default, and that the access-key rows are rebuilt by key.

## Estimate for answers with no known usage (access keys only)

- `AiGatewayProxy` counts:
  - the request body's bytes;
  - the bytes delivered to the client (the answer stream after the tap).
- When an access key's request ends with status < 400, reached an account, is not `count_tokens`, and its usage has no input or output count (cut before the last event, or no `usage` at all), `GatewayRequestRecord.estimatedTokens` is the larger of:
  - the tokens the tap had read (`input + output + cache writes`, e.g. Anthropic's `message_start`);
  - `ceil(request bytes / 4) + ceil(delivered bytes / 4)`.
- It still counts as `unknown_requests`.
- The `ai_usage_daily.estimated_tokens` column gets it; Grants keep counting 0.

## `AiUsage`

- `insert` writes `access_key_id` and `estimated_tokens` into the daily row. Shed requests are summed per key too.
- `summary`:
  - the ticket-01 filter `user_id <> ''` goes away;
  - an access key's rows are visible to whoever has `accessKey.view` in its Space. That means the Owner, an Organization's Admins (who already see whole Spaces) and a Personal space's User (new: `access_key_id <> '' AND space_id IN (their key Spaces)`); a Member does not see them;
  - a new input filter, `accessKeyId`, only narrows.
- Contracts:
  - `AiUsageRow.userId` becomes `UserId | null`;
  - the row gains `accessKeyId` and `estimatedTokens`;
  - `AiUsageTotals.estimatedTokens` (optional);
  - `AiUsageLabels.accessKeys` (`{ id, label }`), read through `AccessKeys.accessKeyLabels`, so only `AccessKeys.ts` names `ai_access_keys`.
- `client-runtime/aiUsageView`:
  - grouping by «User» shows access keys as «Access key: <label>»;
  - `usageNotes` says «≈N tokens estimated for answers cut short».

## Usage per key in the list: `ai/AccessKeyCaps.ts` (ticket 05 adds the caps)

- `usageOf(keyIds)`: one query over `ai_usage_daily` by `access_key_id`. Per key:
  - counted tokens (uncached input + output + cache writes + estimated) for today, this ISO week, this month (UTC, `GrantCaps.periodOf`) and in total;
  - cache reads, requests, unknown requests and estimated tokens.
  - `AiGatewayActivity.unwritten` is added on top: it goes from per Grant to per subject (`grant:<id>`, `access-key:<id>`).
- `AccessKey.usage` (optional): those numbers and each period's reset.

## Web

- Usage tab:
  - an «Access key» filter when the summary names any keys;
  - «Access key: <label>» rows under «User»;
  - the «≈» estimate in the notes.
- The access key list shows, per key: tokens today, this week, this month and in total, cache reads apart, and «N without usage (≈M estimated)».

## Tests (`apps/server/src/ai/AccessKeys.usage.test.ts`, `160_AiUsageAccessKey.test.ts`)

- An answer cut before its last event adds estimated tokens, not 0, and counts as unknown. A whole answer adds no estimate.
- Visibility:
  - a Member of Acme does not see the usage of Acme's keys;
  - the Admin does, under «Access key: <label>»;
  - a Personal space's User sees their keys' usage;
  - a filter only narrows (Globex's member filtering by an Acme key gets nothing).
- The list shows each key's tokens today and in total.
