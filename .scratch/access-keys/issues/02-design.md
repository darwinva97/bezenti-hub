# 02 design: allowed models

Ticket: `02-modelos-permitidos.md`. Spec: «Modelos permitidos». Builds on 01 (`01-design.md`).

## Contracts (`packages/contracts/src/accessKeys.ts`)

- `AccessKeyModelEntry`: 1 to 256 characters, no spaces or control characters, `*` only as the last character (`claude-sonnet-*`) or alone (`*`, «All models»).
- `AccessKeyModels`: 1 to 50 entries.
- `AccessKeyCreateInput.models` becomes required.
- Pure functions, in contracts so the server, the web and the shared setup read one rule:
  - `accessKeyModelAllowed(entries, requested)`:
    - case-insensitive;
    - `requested` is compared without an `acct-<id>/` prefix (the account rule decides the pinned account) and without a trailing `[…]` suffix such as `[1m]`;
    - an exact name admits only itself, a `prefix*` pattern admits what starts with the prefix, `*` admits everything;
    - an invalid entry admits nothing.
  - `accessKeyAllowsAllModels(entries)`.
- WS `accessKeys.modelOptions { spaceId }` → `{ accounts: [{ id, name, provider, type, models }] }`.
  - It lists the Space's own gateway accounts (`forSpace`, without `direct`) and the models each one serves (`AiAccounts.modelsOf`).
  - It needs `accessKey.manage`. Ticket 03's account picker reads the same answer.

## Server

- `AccessKeys.create`:
  - validates and normalizes `models`: duplicates are dropped case-insensitively, and `*` among others becomes `["*"]`;
  - stores them;
  - audits `models` (`all` or the count).
- `GatewayCaller.allowedModels`: the access key's entries; null for a gateway key.
- `AiGatewayProxy.forward`:
  - **`/v1/models`** (all three shapes): the catalogs of the key's accounts, filtered by `accessKeyModelAllowed`. A pattern is never listed as a name.
  - **A request**: after the model is parsed and before `planRoute`, a model the key may not use is answered 403 and recorded without an account. The message is «This access key may not use X. It may use: a, b, …»: the allowed models the key's accounts serve, at most 10, then «…». When none is served, it names the entries.
  - **Error shapes**: Anthropic `permission_error`; OpenAI `type: permission_error, code: "model_not_allowed"` (`errorBody` gains an optional OpenAI `code`); Gemini `PERMISSION_DENIED`.
  - An allowed model that no account serves gets today's 404 from `planRoute`.

## Shared setup

- `accessKeySetup(origin, key, models)` takes the models the key may use that its accounts serve.
- Claude Code: `env.ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`.
  - Each alias gets the model of its family if there is one, else the first allowed one, with `claude*` models first.
  - `ANTHROPIC_MODEL` gets Sonnet's, else Opus's, else the first.
- Codex: `model = "<first gpt*/o* model, else the first>"`.
- With no model known, nothing is pinned.

## Web

- The create form has a «Models» field:
  - «All models» (explicit), or a choice from the Space's catalog grouped by family;
  - «Add pattern» for a typed entry, validated by the same rule.
- The list shows each key's models.
- The setup pins from `modelOptions` ∩ the key's models.

## Tests

- `packages/contracts/src/accessKeys.test.ts`: a table for `accessKeyModelAllowed` (case, `acct-<id>/`, `[1m]`, exact name versus a dated version, pattern, `*`, invalid entries) and for entry validity.
- `apps/server/src/ai/AccessKeys.models.test.ts`:
  - `claude-sonnet-*` lets `claude-sonnet-5-5` through and refuses `claude-opus-5-5` in all three shapes, pinned with `acct-<id>/` too, with each shape's code;
  - `/v1/models` lists no Opus, which an Acme account does serve;
  - an allowed but unserved model gets 404;
  - creating with an empty list or a `*` in the middle is refused;
  - `modelOptions` is the Admin's, and a Member is refused.
- `packages/shared/src/aiGatewayAccessKey.test.ts`: pinning with lists that have no Haiku, or no Opus.
