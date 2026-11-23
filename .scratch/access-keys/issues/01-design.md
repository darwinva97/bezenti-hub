# 01 design: issue, use and revoke an access key

Ticket: `01-emitir-usar-y-revocar-una-clave-de-acceso.md`. Spec: `../spec.md` («Qué es una access key», «Quién hace qué», «Validez», «`authorize`», «Lo que recibe el cliente», «Clientes»). The Owner's decisions of 2026-11-23 are final: no in-flight limit of the key's own (the general 16 per gateway key applies), Personal spaces issue keys, no lent accounts in this version.

## What exists and what it means here

- `AiGatewayKeys.authorize` is the one check of `/api/ai/*`. Both of today's kinds act as a User (`GatewayCaller.userId`), and `AiGatewayProxy` keys its pools by that User. `ai_usage` / `ai_usage_daily` take `user_id NOT NULL`.
- `AllowedAiAccounts.accountsIn` already reads a Space's own accounts (the owner's enabled ones) and then the lent ones. It is only reached through "a User who works there".
- `AiUsageRow.userId` is a `UserId` (non-empty). A daily row with `user_id = ''` would make `aiUsage.summary` fail to encode for whoever sees it. Ticket 04 gives access keys their own subject in the view; until then the summary leaves those rows out (below).

## DB: migration `159_AiAccessKeys` (number at integration)

- `ai_access_keys`:
  - `key_id` (`ak_<24 hex>`, PK), `key_hash` (SHA-256 hex, `UNIQUE`), `key_hint` (last 4 characters);
  - `space_id`, `label` (≤ 80), `created_by`, `created_at`;
  - `models_json` (`["*"]` in this ticket), `accounts_json` (NULL = all of the Space's own), `expires_at` (NOT NULL), `limits_json` (`{"total":null,"day":null,"week":null,"month":null}` in this ticket);
  - `last_used_at`, `revoked_at`, `revoked_reason`, `revoked_by`, `updated_at`.
  - Index `(space_id, created_at)`.
- `ALTER TABLE ai_usage ADD COLUMN access_key_id TEXT` (NULL except for access keys).
- The test runs to 158, adds an `ai_usage` row, runs 159. The row keeps every value and gains `access_key_id = NULL`. The hash is unique.

## Contracts (`packages/contracts/src/accessKeys.ts`)

- `ACCESS_KEY_PREFIX = "t3ak_"`.
- `AccessKeyLimits` `{ total, day, week, month }` (each `number | null`; all null here).
- `AccessKey`: what a manager sees, never the key or its hash:
  - `keyId`, `spaceId`, `spaceName`, `label`, `hint`;
  - `createdBy`, `createdByName`, `createdAt`;
  - `expiresAt`, `lastUsedAt`, `revokedAt`;
  - `models`, `accounts`, `limits`.
- `AccessKeyValidity = { days: 1..366 } | { until: ISO instant }`.
- `AccessKeyCreateInput { spaceId, label, validity }`. Tickets 02, 03 and 05 add `models`, `accounts` and `limits`/`unlimited`.
- `AccessKeyCreateResult { created: AccessKey, key: Redacted }`.
- `AccessKeyListInput { spaceId?, includeEnded? }`.
- `AccessKeyListResult { keys, everyone, space: { canManage, subscription } | null }`. `subscription` drives the ToS warning.
- `AccessKeyRevokeInput { keyId }`, which answers the revoked `AccessKey`.
- `AccessKeyError { reason: forbidden | not-found | invalid | limit | storage, message }`.
- WS `accessKeys.list` (`access:read`), `accessKeys.create` and `accessKeys.revoke` (`access:write`).
- Audit target `access_key`:
  - `access_key.create`: `space`, `expiresAt`, `limits`, `models`, `accounts`, `subscription`;
  - `access_key.revoke`: `space`, `reason`, `via`.
  - Primitive values only, so `limits` is `"none"` here, and `models` and `accounts` are `"all"`.

## AccessPolicy

- `accessKey.manage`, decided on a Space:
  - archived → `space-archived`; frozen → `space-frozen`;
  - an Organization: the Owner, else Admins (`ADMIN_ONLY`);
  - a Personal space: its User only (the Owner in their own, not in another's).
- `accessKey.view` (also revoke), decided on a Space:
  - the Owner anywhere;
  - an Organization's Admins, archived or frozen too;
  - a Personal space's User.
- One table of rows in `AccessPolicy.test.ts`.

## `ai/AccessKeys.ts` (service + the table's only writer)

- `create`: label, then validity, computed into `expires_at`. `{days}` gives now + N×24 h. `{until}` must be after now and at most now + 366 days.
  - In one write transaction: the Space read and `accessKey.manage` checked, the live count checked (50: not revoked and not expired more than 30 days ago), insert, then audit (`subscription` = whether `forSpace` holds a subscription).
  - The answer is built from what was written.
- `list({ spaceId?, includeEnded? })`:
  - with a Space: `accessKey.view` there, else `forbidden`;
  - without one: the Owner gets every Space's keys (`everyone: true`); anyone else gets the keys of the Spaces they may view.
  - By default the list hides keys that are revoked or that expired more than 30 days ago.
- `revoke({ keyId })`:
  - the key's Space must allow `accessKey.view`; a key whose Space is gone, only the Owner. Anyone else gets `not-found`.
  - It is idempotent and audited `revoked` by the person.
- `*ForSession`: `CommandActor.resolve` must be a plain `User`, with no `via` and no `spaceLimit`. An agent, the shell or a one-Space session gets `forbidden`.
- Exported functions, so `ai_access_keys` stays in this file:
  - `accessKeyByHash(sql, hash)`: one query for the key, its Space (found, kind, archived, frozen, deleting) and whether a Personal space's User is active;
  - `noteAccessKeyUse(sql, keyId, now)`: at most once a minute.

## `AllowedAiAccounts.forSpace(spaceId)`

- The Space's own enabled accounts, in its order, with no User condition (`accountsIn` with lent off).
- The caller drops `direct`.

## `AiGatewayKeys.authorize`

- `isGatewayKeyShaped` accepts `t3gk_` and `t3ak_` (both + 43 base64url). A `t3ak_` key reads `ai_access_keys` only and decides in this order:
  1. unknown, revoked, or Space gone → 401 `UNKNOWN_KEY`;
  2. expired → 403 «This access key expired on 2026-12-01 18:00 UTC. Ask whoever gave it to you to renew it.»;
  3. Space archived, frozen or being deleted, or a Personal space whose User is disabled or removed → 403 «This access key's Space is archived. It works again if the Space is restored.» (frozen and a disabled User get the same sentence shape; ticket 07 refines the wording);
  4. no gateway account in `forSpace` → 403 «No AI account this access key may use is available now.».
- It then writes `last_used_at` (at most once a minute).
- It returns a `GatewayCaller` with `kind: "access"`, `userId: null`, `accessKeyId`, `spaceId`, `threadId: null`, `allowed` and `chosenAccountId: null`.
- `GatewayCaller.kind` becomes `AiGatewayKeyKind | "access"`, and `userId` becomes `UserId | null`.

## Proxy, activity, usage

- `AiGatewayProxy`:
  - pool subject = `caller.userId ?? "ak:<keyId>"` (readers and slots); `perKey` (16) is unchanged;
  - `planRoute` gets `keyKind: "user"` for an access key.
- `GatewayRequestRecord`: `userId: UserId | null`, plus `accessKeyId?: string | null`.
- `AiUsage.insert`: `user_id = userId ?? ''` and `access_key_id`. Daily and shed rows use `''` as the user.
- `AiUsage.summary` and the thread reads leave out `user_id = ''`, with a comment naming ticket 04. The Space's summary keeps answering.

## Doors

- `RPC_SPACE_ACCESS`: an unscoped `ACCESS_KEYS` rule for the three methods.
- `RpcAuthorization`: `accessKeys.list`, `access:read`.
- `clientRpcPermissions`: `create` and `revoke`, `access:write`.
- `RpcInstrumentation` and `MaskedPaths`: entries.
- `DoorRules`:
  - the `/api/ai/*` rule mentions access keys;
  - a new test: `ai_access_keys` is named only by `AccessKeys.ts` and its migration, the three RPCs are WS only, and only `create` carries `key`.
- `AiAccounts.test.ts`: `RE_AI_DOORS` covers `accessKeys.`, swept in `AccessKeys.test.ts`.

## Shared setup: `@t3tools/shared/aiGatewayAccessKey`

- `accessKeySetup(origin, key | null)`:
  - `claudeCode` (`env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`);
  - `codex` (provider `t3`, `env_key`), plus `codexShell`;
  - `other` (the OpenAI, Anthropic and Gemini base URLs, and the headers);
  - the placeholder «<your access key>».
- No model pinning; ticket 02 adds it.
- `sendsKeyInClear(origin)`: true for `http:` off loopback.

## Web

- `AccessKeysSettings.tsx` (`AccessKeysSection { spaceId }`), under Space settings → AI accounts, for an Organization (below its accounts) and for a Personal space (below the note).
  - It hides itself on `forbidden`.
  - It holds a create form (label; «Valid for N days» or «Valid until <date>», sent as the end of that local day in UTC) and the one-time panel with the key and «Copy setup» (tabs Claude Code / Codex / Other clients).
  - The panel warns when the Hub is `http:` off loopback, and shows the ToS warning when the Space holds a subscription.
  - The list shows label, `…hint`, created by, «Expires …» or «Expired on …», last use, and «Revoke» (with a confirmation).
- `client-runtime` commands: `listAccessKeys`, `createAccessKey`, `revokeAccessKey`.

## Tests

- `ai/AccessKeys.test.ts` (route testkit, fake CLIProxyAPI, Acme's own Organization accounts):
  - Anthropic, OpenAI and Gemini answer through Acme's own accounts, never Globex's nor one lent to Acme;
  - usage is `user_id = ''` with `access_key_id`, and the Space's summary still answers;
  - revoked → 401, and one request in flight finishes;
  - expired → 403 with the date (TestClock), and one admitted before finishes;
  - archived → 403, restored → 200;
  - the door sweep: Member, Guest, Gus, an agent, a one-Space session and `ThreadOwner` neither create, list nor revoke; another Admin does; the Owner revokes in another's Personal space but does not create there; the User creates in their own Personal space;
  - leaks: the database holds only the hash (the key and its body are absent from `ai_access_keys`, `ai_usage` and `audit_log`), and only `create` carries the key;
  - 50 live keys per Space; label and validity bounds.
- `AccessPolicy.test.ts` rows, the migration test, `aiGatewayAccessKey.test.ts`, `gatewayShapes` shape tests, and the `DoorRules`, `RpcAuthorization` and `AuditLog` lists.
