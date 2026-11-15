# AI gateway: CLIProxyAPI run by the Hub

The Hub runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) as its own child
process and is its only client. Spec: `.scratch/ai-accounts-and-gateway/spec.md`, «CLIProxyAPI
gestionado»; ADR 0005. Code: `apps/server/src/ai/`.

## Where it runs

Only on a Hub (`aiGatewayPlacement` in `AiGateway.ts`, the one rule):

- A joined machine (a Sandbox's server and a dedicated machine included) never runs, downloads
  or prepares it; its status says so.
- `T3CODE_AI_GATEWAY=managed|off` decides where set.
- Otherwise the Owner decides in Settings → AI gateway («Turn on» / «Turn off», audited
  `ai_gateway.enable`, kept in the encrypted store): on by default on a server Hub, off by
  default in the desktop app and on a dev Hub (`vp run dev`).
- Windows (development only; develop in WSL) reports `unsupported`.

## Which release, from where

- Only pinned releases ever run. `cliproxyRelease.ts` lists the pinned versions, oldest first,
  each with the SHA-256 of each production archive (`linux-amd64`, `linux-arm64`,
  `darwin-amd64`, `darwin-arm64`). A new pin comes with a Hub upgrade; keep the one before so
  the Owner can roll back to it. Linux takes the `_no-plugin` build: no code is loaded at run
  time besides the verified binary.
- The download comes only from `https://github.com/router-for-me/CLIProxyAPI/releases/download/v<pinned>/…`,
  read as a stream with a hard 100 MB limit (whatever `content-length` says) and hashed as it
  arrives. A different hash is refused (`CliproxyRefusedError`): nothing is written or run, and
  the Hub does not retry until the Owner acts. Nothing else is asked of GitHub.
- Gunzip runs in libuv's thread pool; the binary (one regular file, `cli-proxy-api`, at the
  top of the archive) is written 0700 to `<stateDir>/ai-gateway/bin/<version>/`, in folders of
  the Hub's user that nobody else may write.
- The record (`active`, `previous`, each with its binary's SHA-256; whether the Owner chose the
  active one; on/off) lives in the encrypted store (`ai-gateway-releases`) and is read and
  written under one lock with every switch. Before every start the binary is hashed again,
  streamed: a file changed on disk is refused, never run; one missing is downloaded again (if
  still pinned). Releases other than `active` and `previous` are deleted.
- At a start the Hub runs the active release if it is still pinned and either the Owner chose
  it (a roll back, or an update to an older pin) or it is the newest pin; otherwise the newest
  pin. So a crash or a Hub restart never undoes the Owner's roll back.

## Running it

- `AiGateway.ts` starts it as `cli-proxy-api -config <path> -local-model` (`-local-model`: its
  embedded model catalogs, never refreshed from the internet), `cwd` and `HOME` its run folder,
  an environment of `PATH`, `HOME` and a start token only (none of the Hub's variables), in its
  own process group, with only stdio passed (Node opens every other descriptor close-on-exec).
  On Linux it runs under `setpriv --pdeathsig KILL`, so it dies with the Hub however the Hub
  ends.
- Each start writes `run-<token>.pid` with the PID, its start time and the binary. At the next
  start a leftover is killed (its whole group) only if that PID still has that start time and
  executable (Linux: `/proc/<pid>/stat` and `exe`; macOS: `ps lstart` and `comm`); a reused PID
  is never touched. Clearing leftovers never stops the Hub from starting: what it cannot do is
  logged.
- Its keys: the management key, random, in the encrypted store; the client key, new at every
  start and kept in memory only, so one a leftover knew is useless.
- The run folder holds `config-<token>.yaml` (0600, one per start, removed when it stops) and
  `auth/` (its `auth-dir`, also its `kv.db`). It is in memory when the platform has a folder
  there (`$XDG_RUNTIME_DIR`, else `/dev/shm`; 0700, never a link or someone else's), else
  `<stateDir>/ai-gateway/run`, which Settings says; there no subscription is loaded (below).
- Config (`cliproxyConfig.ts`, v8 layout, `config-version: 8`): `server.host: 127.0.0.1` on a
  free port the Hub picks, `management.allow-remote: false`, `secret-key` (CLIProxyAPI hashes
  it on start), control panel and panel updates off, one client key, no mDNS discovery,
  plugins (so no plugin store), pprof, usage statistics or request logs.
- Before any key is sent, the Hub checks that its own child (its PID's sockets: `/proc/net/tcp`
  inodes against `/proc/<pid>/fd` on Linux, `lsof -p` on macOS) listens on that port, and only
  on `127.0.0.1`. Another process that took the port first gets nothing; a child listening
  anywhere else is killed and not started again. The check is repeated once it answers.
- Healthy once `GET /v8/management/config` answers 200 with the management key
  (`CliproxyManagement.ts`, the Hub's one client of it). When it stops by itself the Hub starts
  it again after 1 s, doubling to 60 s, back to 1 s after five stable minutes.
- Its stdout and stderr go to the Hub's log as `CLIProxyAPI: …` (`gatewayLogFilter.ts`): the
  Hub's keys, the value of anything named like a credential (`access_token`, `refresh_token`,
  `api_key`, `client_secret`, `key=`, `Authorization`, …) and anything shaped like a token
  (`AIza…`, `ya29.…`, `1//…`, `sk-…`, `ghp_…`, JWTs, bearer) become `[redacted]`.

## Who reaches it

Only the Hub. It listens on `127.0.0.1` only, so a Podman Sandbox (slirp4netns without host
loopback) cannot connect to it (`PodmanSandboxRuntime.test.ts`), nor can a joined machine. A
process of another user on the Hub's machine reaches the port but gets 401 without the keys.

Known limit: CLIProxyAPI runs as the Hub's user, so it could read the Hub's state folder. That
is acceptable only because every binary it runs is pinned in this repository and verified by
the Hub. Running it in its own rootless container or under its own uid is a later hardening
(spec, «Riesgos»). Agents of the Hub machine itself (development) run as the Hub's user too and
could read its run folder; production Hubs run agents in Sandboxes.

## Switching releases

Settings → AI gateway (the Owner's; dropped from a Member's nav) streams the status
(`aiGateway.status`), lists the pinned versions and offers «Update to X» when a newer pin is
there and «Roll back to Y». A switch starts the new release beside the running one, checks its
listeners, its management API and `/v1/models`, records it, and only then stops the old one;
any failure leaves the old one running and the record as it was. An update to anything not
pinned is refused before any download. Audited: `ai_gateway.update` (from, the requested
version, `updated` or `failed`, reason) and `ai_gateway.rollback` (`rolled-back` or `failed`).

## Doors

WS only: `aiGateway.status` (a stream), `aiGateway.checkForUpdates`, `aiGateway.update`,
`aiGateway.rollback`, `aiGateway.setEnabled`, all in `INSTALLATION_RPC_METHODS` (`installation`
in `RpcSpaceAccess`: the Owner's alone, whatever the scopes; the changes also need
`settings:write`). No HttpApi endpoint or MCP tool. The one raw route is the gateway layer
(`/api/ai/*`, below), in `DoorRules.RAW_ROUTE_RULES` and `AMBIENT_COOKIE_RULES`.

## AI accounts (API keys)

`ai/AiAccounts.ts` is the one service; WS `aiAccounts.*` are its doors (spec 4 ticket 02).

- **Where credentials live:** never in the database (migration 112 keeps `ai_accounts` and
  `ai_account_allowances`; `key_hint` holds at most the last four characters, shown to the Owner
  only). Each key is an entry of `ServerSecretStore.AiAccountCredentialStore`:
  `secrets/ai-accounts/<credential id>.sealed`, purpose `ai-account-credential` (its own folder,
  like Vault values). «Replace credential» writes a new id, then the row, then removes the old
  one; the start sweeps credentials no row holds. No answer returns a key, not to the Owner.
- **Into CLIProxyAPI:** only through the Management API (`PATCH /v8/management/config` with the
  whole `api-keys` section, so a disabled or deleted account goes), never a file the Hub writes.
  Each account is under `prefix: acct-<id>` and `routing.force-model-prefix` is on, so only
  `acct-<id>/<model>` is served. CLIProxyAPI keeps them in its own config in the memory folder.
  Every start (crash, update, roll back) is provisioned from the store before it counts as
  running (`AiGateway.setProvisioner`).
- **One bad account never takes the others out:** each is checked before anything is sent; if
  CLIProxyAPI still refuses the set, the Hub sends what it held before, then each other account
  alone, first to last, and only the refused one stays out (`error`, with CLIProxyAPI's reason,
  quoted values and keys removed). A refused account is not sent again unchanged on that gateway.
  A key the store cannot read aborts the change and leaves the gateway as it was. A change that
  fails as a whole is retried after 10 s, doubling up to 5 min. One change and its check have a
  30 s deadline; the lock covers only the change, not the model-list check (`unverified` when the
  list cannot be read). Renames, allowances and order never reach the gateway.
- **A key leaves only once the gateway drops it:** «Replace credential» and «Delete» retire the
  old key (`ai_account_retired_credentials`; a deleted account stays as `removing`, out of every
  list but the Owner's). It leaves the store, with the row, only after a change the gateway
  accepted without it. Until then the call answers `still-live` and the Hub keeps retrying. With
  no gateway running the key is live nowhere and goes at once (`gateway: "not-running"`). The
  Hub's start, before any CLIProxyAPI holds keys, removes every retired key and orphan.
- **Who:** only the Owner, unlimited, manages (`aiAccount.manage` on the Installation, through
  `SpaceDirectory.authorizer`, so an agent limited to one Space manages nothing; the writes are
  also `INSTALLATION_RPC_METHODS`). `aiAccounts.list` gives anyone else name, provider and status
  of what they may use, and where.
- **AllowedAiAccounts** (`ai/AllowedAiAccounts.ts`) is the one rule: enabled accounts allowed to
  the Space or to the User, and none unless the User may work in that Space (`aiAccount.use`:
  whoever may start a Thread there, Guests included). Evaluated on every call. The gateway layer,
  the picker and the move plan ask it; nothing else decides.
- **Models:** `modelsOf(accountId)` reads the gateway's `/v1/models` for the account's prefix,
  cached five minutes.
- Audit: `ai_account.create|update|delete|allow` with provider, type and counts, never a key.

## Subscription AI accounts (OAuth)

Spec 4 ticket 03. The Owner signs in to a subscription (Claude, ChatGPT/Codex, Antigravity, Kimi,
xAI, Devin, Meta) from Settings → AI accounts → «Add subscription», or imports a Vertex service
account. The same `AiAccounts` service, rows, allowances, priority and AllowedAiAccounts as API
keys; `type: subscription`. Pure parts in `ai/subscriptionLogin.ts`.

- **Sign-in:** `aiAccounts.login.start` asks CLIProxyAPI's management API for the provider's page
  (`GET /oauth/auth-url?provider=`) and keeps one pending sign-in on the Hub (a new one replaces
  it): its CLIProxyAPI `state`, the `redirect_uri` the page names, the Owner's User and **session
  id**, 10 minutes, and the gateway it was started on. The page is shown only if it is `https:`.
  Redirect flows (Claude, Codex, Antigravity, Devin): the provider sends the browser to a localhost
  address that does not open (the Hub may be a VPS); the Owner pastes it («Paste the address you
  landed on») into `aiAccounts.login.complete`. Device flows (Kimi, xAI, Meta): the page shows a
  code; «I have signed in» completes, `pending` until the provider says yes.
- **The pasted address** (`checkPastedRedirect`) must have the same scheme, host, port and path as
  that sign-in's `redirect_uri`, no user info, exactly one `state` equal (constant time) to that
  sign-in's, one `code`, and no `error`. It travels Redacted (never logged). The Hub never fetches
  it: CLIProxyAPI gets an address rebuilt from the `redirect_uri` with only `code`, `state` and
  `scope` (`POST /oauth/callback`). Completion is refused (`expired`) from another session, after
  10 minutes, after the gateway restarted, or once done; refused pastes reach nothing.
- **Capture:** once CLIProxyAPI reports `ok` (`GET /oauth/status`), the Hub takes the one new
  token file of that provider it did not hold before the sign-in started (`GET /credentials`,
  `/credentials/download`): none, several, or a token whose `type` is not that provider's is
  refused and the files go. It is sealed under a new token id in its own store
  (`ServerSecretStore.AiAccountTokenStore`: `secrets/ai-account-tokens/tok-<id>.sealed`, purpose
  `ai-account-oauth-token`, covered by key rotation) and the file CLIProxyAPI named is deleted. A
  **new** account starts **disabled**, with «Signed in as <email>», until the Owner checks it and
  turns it on; only then does its token go to the gateway as `acct-<account>-<token id>.json` with
  `prefix: acct-<account>` (`POST /credentials?name=`). **«Sign in again»** compares the new
  identity with the sealed one: if it differs, the new token is held and the call answers
  `identity-mismatch` until the Owner confirms («Use the new account», `confirmIdentity`); then it
  replaces the token under the account's allowances, retiring the old one. Vertex: `POST
  /oauth/import?provider=vertex`, then the same capture (its identity is the service account).
- **Reconcile** (`reconcileTokens`, under the same lock as API keys, at every gateway start before
  it counts as running and after every change; one account failing leaves the others, and never
  fails the API keys): for each subscription the newest copy wins, wherever it is. A copy in
  CLIProxyAPI newer than the sealed one (a refresh, which may rotate the refresh token) is sealed
  again, also just before the file of a disabled or deleted account goes; an older one (a stale
  file a restart left in memory) is replaced by the sealed one. "Newer": the first of
  `last_refresh`, then the access expiry (`expired`…), then `timestamp` that both copies carry and
  that differs; with none, a different copy is CLIProxyAPI's (it is the only writer). Files of
  accounts deleted, disabled or signed in again go, and so does every file that is not the Hub's
  own (`acct-…-tok-….json`), except the new file of the sign-in in progress (its provider's, not
  there when it started, on that gateway, within its 10 minutes). The Hub lists the gateway's
  token files every 10 s and reads tokens back when one changed (and every 5 minutes, and while a
  sign-in is open), and once more when the Hub stops (a finalizer), so a refresh is lost only if
  the machine dies within those 10 s.
- **Import from another CLIProxyAPI** (ticket 15): Settings → AI accounts → «Import from
  CLIProxyAPI» picks the auth files of an old proxy (its `auth-dir`: `claude-…`, `codex-…`,
  `antigravity-….json`, as CLIProxyAPI 8.0.x writes them) and sends them once
  (`aiAccounts.importCliproxy`, contents Redacted, at most 50 files of 64 KB). Pure parts in
  `ai/cliproxyImport.ts`. Each `claude`, `codex` or `antigravity` file with an email and a refresh
  token becomes a subscription exactly as a sign-in leaves it: sealed under a new token id, named
  «Claude|ChatGPT|Antigravity (<email>)», **disabled** with «Signed in as <email>» until the Owner
  turns it on, allowed only to the Owner's Personal space (the Owner then allows it elsewhere).
  Only the keys those sign-ins write are kept (an allowlist: `type`, `email`, the tokens and
  their times, `account_uuid`, `account_id`, `organization_*`, `claude_device_ids`, `project_id`,
  `priority`); everything else goes (`headers`, `prefix`, `disabled`, any spelling of a base or
  proxy URL), so an imported file never chooses where a request or its token goes. An identity the
  Hub already holds (provider and email, and the provider's account or project id when both carry
  one: a token without it matches any) is skipped, whether signed in, imported, or earlier in the
  same files; any other type, a file that is not JSON, or one without an email or refresh token
  is skipped with a reason. The answer says per file what happened, never a token field. No
  gateway call: it works with the gateway off, and the token reaches CLIProxyAPI when the account
  is turned on. Audit `ai_account.create` (`provider`, `type: subscription`, `via: "import"`).
  **One proxy per sign-in:** an OAuth refresh token may live in ONE proxy only. Stop the old
  CLIProxyAPI (or delete its copies of the files) when importing: if both keep running, a refresh
  on either side invalidates the other and the account shows «Needs sign-in again». The form
  says so. (CLIProxyAPI 8.0.67 reads every key the 8.0.3 files carry: `account_uuid`,
  `organization_*`, `claude_device_ids`, `priority`, `project_id`, `expires_in`, `timestamp`,
  `id_token`, `account_id`.)
- **Gateway not running** (off, crashed, restarting) and **before every launch**
  (`AiGateway.setBeforeLaunch`): the Hub reads and removes the memory folder's files directly. A
  newer copy of an account's current token is sealed first; every file that is not an enabled
  account's current token goes, so a deleted or disabled account's token is never left in clear
  and the next CLIProxyAPI never loads it; no sign-in survives its gateway.
- **Unprefixed tokens:** the Hub is CLIProxyAPI's only client and always asks for
  `acct-<id>/<model>`, so a sign-in's own file (no prefix) is never asked for; it lives only until
  it is captured or its sign-in ends, and then goes.
- **Status:** from CLIProxyAPI's credential list: `requires_sign_in` → «Needs sign-in again»,
  `quota_blocked` → «Quota exhausted», `error`/`unavailable` → error (its message, quoted values
  and token shapes removed), else working. The Owner also sees «Signed in as» and, for Claude and
  Codex, the quota windows read by the existing reader (`usage/cliproxyApi.ts`, `api: "v8"`:
  `credentials` and `requests/api-call`) pointed at the managed gateway, cached 5 minutes, only
  windows (nothing derived from the credential).
- **No folder in memory:** decided stricter than API keys. Without `$XDG_RUNTIME_DIR` or
  `/dev/shm` the Hub loads no subscription (their files are deleted from the gateway, the accounts
  show an error, the sealed tokens stay for later) and refuses to start a sign-in or import, so no
  OAuth token is ever on a persistent disk in clear. Settings → AI gateway says so.
- **Delete, disable, «Sign in again»:** the token id is retired (`ai_account_retired_credentials`);
  the file leaves CLIProxyAPI by the next reconcile, and the sealed token leaves the store only
  after a change the gateway accepted without it (ticket 02's guarantee). The provider's own
  refresh token is **not revoked at the provider**: CLIProxyAPI has no call for it, so a token
  copied before the delete keeps working at the provider until the Owner revokes the app there
  (Google, Anthropic or OpenAI account settings).
- **Doors:** WS only, in `INSTALLATION_RPC_METHODS` (the Owner's alone, `settings:write`):
  `aiAccounts.login.start`, `aiAccounts.login.complete`, `aiAccounts.importVertex`,
  `aiAccounts.importCliproxy`;
  `DoorRules.AI_ACCOUNT_SIGN_IN_RULES`. No raw route or HTTP endpoint takes a provider's callback.
  Audit `ai_account.login` (provider, `new`/`again`/`import`, `signed-in`/`failed`, reason) and
  `ai_account.create` for a new one. Tokens never in a log, span, error, answer, the database or
  argv (`AiAccounts.subscriptions.test.ts`; the live pass greps the Hub's home, logs and `ps`).
- **Known limits:** one sign-in at a time per Hub. Two Hub processes over one state folder are not
  supported: the "never older" rule is checked under an in-process lock. ToS risk accepted (ADR
  0005): the form warns on every subscription and, for Antigravity, notes CLIProxyAPI's
  obfuscation (hardened in v8.0.65). **Memory is not a vault:** `/dev/shm` and `$XDG_RUNTIME_DIR`
  are tmpfs, whose pages the kernel may write to swap; a Hub whose swap is not encrypted can leave
  a token on the swap device. Use encrypted swap (or none) on a Hub with subscriptions.
- **Management calls in spans:** the Hub's HTTP spans to CLIProxyAPI carry no query value (a
  sign-in state, a credential name: all redacted), and a refused Vertex import says only its HTTP
  status, never CLIProxyAPI's words, which could quote the key.
- **No callback listener:** CLIProxyAPI 8.0.67 opens no port of its own for an OAuth callback
  (checked with `ss -ltnp` during a redirect sign-in in the live pass): the address the provider
  returns to does not open, and the Owner pastes it.

## The gateway layer: `/api/ai/*`

Spec 4 ticket 04. Every AI request from an agent or a local CLI goes through the Hub's own layer,
never to CLIProxyAPI directly; the Hub's client key never leaves the Hub. `ai/AiGatewayRoute.ts` is
the HTTP door and stays thin (route, key, `authorize`); `ai/AiGatewayProxy.ts` (`forward`) does the
rest, so any other door (ticket 06's relay included) reuses it.

- **Routes** (`gatewayShapes.matchGatewayRoute`, the only paths that exist): OpenAI
  `/api/ai/openai/v1/{chat/completions,responses,models}`, Claude
  `/api/ai/anthropic/v1/{messages,messages/count_tokens,models}`, Gemini
  `/api/ai/gemini/v1beta/models` and `/api/ai/gemini/v1beta/models/<model>:{generateContent,streamGenerateContent}`.
  Each maps to one fixed CLIProxyAPI path; anything else under `/api/ai/` (its management API,
  `/v0`, dot segments, `%2F`, embeddings…) is 404 and reaches nothing. The model lists are answered
  by the Hub: plain names of what the key may use (the Thread's account, or every allowed one).
- **Gateway keys** (`ai/AiGatewayKeys.ts`, migration 113 `ai_gateway_keys`): `t3gk_` + 32 random
  bytes, stored only as SHA-256, revocable. A **Thread key** is for (the Thread's turn owner, its
  Space, the Thread); `issueForThread` revokes the Thread's earlier keys (one per provider session,
  ticket 06 hands it to the agent, with its `providerSessionId`) and it expires after 7 days at
  most. A **User key** is for one Space the User works in (local CLIs, ticket 10, below), at most
  five live per User; `revoke` by its User or the Owner, audited `ai_gateway_key.create|revoke`.
- **Revocation recorded** (`ai/AiGatewayKeyRevocation.ts`, from the domain events and User status
  changes): a provider session that stops or fails (`provider-session.updated`) takes its keys, a
  detach takes that Thread's; a Thread archived or deleted (its account in use forgotten too); a
  User disabled or removed, every key of theirs; a User whose Memberships changed, every key for a
  Space they no longer work in (`space-lost`). A move or a new owner, a removed User and a lost
  Space are also recorded by `authorize` the first time it sees them. The request-time check stays
  the guard.
- **Authentication:** only the key, in `Authorization: Bearer` (every shape), `x-api-key`
  (Claude) or `x-goog-api-key` (Gemini). Two different keys, a key in the query, a session cookie
  or any other credential: 401. The route reads no cookie at all (`AMBIENT_COOKIE_RULES`: refused).
- **Every request is decided again** (`AiGatewayKeys.authorize`, the one rule of the door): the
  key's row (unknown, revoked, expired → 401); its User still active (401); for a Thread key, the
  Thread neither archived nor deleted (401), still in the key's Space (a Project moved → 403), still
  owned by the key's User (403), its Project not moving (503); then `AllowedAiAccounts.for(User,
  Space)` now, gateway accounts only (none → 403). Nothing is cached: an allowance removed, a
  membership ended or an account disabled or deleted fails the next request.
- **Routing** (`gatewayShapes.planRoute`): with a User key, the account the client pinned with
  `acct-<id>/<model>` (must be allowed: else 403); a Thread key may name only its Thread's own
  account (anything else 403: an agent, perhaps prompted to, never moves its Thread to another
  account); else the Thread's (`modelSelection.aiAccountId`; no longer allowed →
  403 «Switch AI account», never a silent fallback), else the first allowed account by global
  priority that serves the model (`AiAccounts.modelsOf`; none → 404). Then the failovers: every
  other allowed account of the **same provider** that serves the same model, by priority. The Hub
  always sends `acct-<id>/<model>`; a double or malformed prefix is 400. A 429 from CLIProxyAPI
  tries the next; none left answers 429 «No allowed AI account for <provider> has quota left;
  switch AI account» in the client's shape.
- **What crosses:** to CLIProxyAPI the rewritten body, the Hub's client key and only `accept`,
  `anthropic-version`, `anthropic-beta`, `user-agent` (no `X-*`, cookie or forwarding header), and
  for Gemini only `alt=sse`; an upstream redirect is never followed (1xx/3xx answer 502). Back: the
  status, `content-type` and the Hub's own `cache-control: no-cache, no-transform` (so compression
  never holds SSE back), the body streamed chunk by chunk through `gatewayTap.makeResponseTap`,
  which holds back at most 1 MiB: it strips the account's prefix, filters the words of an error in
  an SSE event or a JSON-array element (Gemini's stream without `alt=sse`), and reads the tokens
  (SSE events, array elements, a plain answer whole up to 1 MiB, past that its tail). An OpenAI
  chat stream without `stream_options.include_usage` gets it from the Hub, and the usage chunk the
  client did not ask for is dropped. An OpenAI-compatible account (DeepSeek, OpenRouter…) is asked
  with the role `system` where the client said `developer`, in chat `messages` and Responses
  `input`: those upstreams refuse `developer` (422), which Codex sends, and CLIProxyAPI passes the
  role through. An upstream error is answered in the client's shape: the provider's words
  for a 4xx (emails, URLs, keys, token shapes and `acct-…/` removed), a fixed sentence for auth,
  quota and 5xx.
- **Account in use:** `AiGatewayActivity.noteInUse` keeps each Thread's last account and model
  (`ai_gateway_thread_accounts`) and publishes a change (`subscribeAccountsInUse`) for the Thread's
  header (`count_tokens` does not move it); every request ends in one `GatewayRequestRecord`
  (`subscribeRequests`: User, Space, Thread, key, account, provider, model, status, duration,
  failovers, tokens), also one whose answer was never read, which ticket 05 stores as usage.
- **Limits** (`AiGatewayProxyLimits`; no quotas): the body is read first, in its own pool (8 per
  User, 64 per Hub), within 60 s and never 15 s without bytes (408), at most 32 MiB
  (`T3CODE_AI_GATEWAY_MAX_REQUEST_BYTES`, 413), uncompressed (415), and within the Hub's 512 MiB
  of held request bytes, counted three times over for its copies (503). Only then a request slot:
  16 per key, 32 per User, 256 per Hub (429), so one User never takes them all. The answer: 10
  minutes to its first byte, 60 in all, 5 without a byte from upstream, and 2 with a client that
  does not read (bounded backpressure: the next chunk is pulled only once the client took the
  last). Upstream error and 429 bodies are read for at most 10 s and 64 KiB.
- **Logs and spans:** one line and one span (`AiGateway.request`) per request with method, route,
  account, model, status, failovers and tokens; a refusal logs method, matched route and status.
  Never a header, a key, a body or a prompt. The HTTP server's own span is off for `/api/ai/*`
  (`http.ts`), since a client could put a key in the address.
- **Who reaches it:** whoever reaches the Hub's URL: joined machines by it, Sandboxes through their
  Hub socket, which forwards `/api/ai/…` (and still nothing of CLIProxyAPI, which listens on loopback
  only). The key is what decides.

## Local CLI keys (spec 4 ticket 10)

A User points Claude Code or Codex on their own machine at the Hub with a **User key**: Settings →
AI accounts → «Local CLI keys» (web and desktop; every User, not only the Owner).

- **Doors:** WS only, `aiGatewayKeys.list|create|revoke` (`RPC_SPACE_ACCESS` unscoped: decided in
  `AiGatewayKeys` for the session; `list` needs `access:read`, `create` and `revoke`
  `access:write`). They answer only a person's own session: an agent (MCP, `via: agent`), the
  Hub's shell or a session limited to one Space gets `forbidden`, so no agent makes, lists or
  revokes a key. No HTTP endpoint or MCP tool touches them (`DoorRules.test.ts`).
- **Create:** a name (80 characters) and a Space the User works in (AccessPolicy `aiAccount.use`:
  where they may start a Thread; Guests included); without one, their Personal space if they may
  work there, else «Choose a Space». The answer is the only one that carries the key (Redacted on
  the wire's both ends); the Hub keeps its SHA-256. At most five live keys per User.
- **List:** a User's own; the Owner's holds everyone's (`everyone: true`), with each key's User
  and Space names, created and last used (written at most once a minute). Never a key or a hash.
- **Revoke:** its User or the Owner; anyone else's answers `not-found`, as a missing one. The next
  request is refused (401). Audited `ai_gateway_key.revoke` (`revoked`); the Hub's own revocations
  (`space-lost`, `user-inactive`) are audited as `system`.
- **Routing:** with no account named, the first allowed account by global priority that serves the
  requested model (`planRoute`); `acct-<id>/<model>` pins one, only if allowed. Only accounts
  AllowedAiAccounts gives the User in the key's Space, evaluated per request.
- **Leaving the Space:** the next request answers 403 («You no longer work in this key's Space»)
  and the key is revoked for good (`space-lost`), also when the User comes back; the Membership
  watch revokes the unused ones too. A Thread key is never revoked for this: `authorize` runs the
  Thread's own checks first (deleted or archived 401, moved or handed over 403 and revoked), then
  whether its turn owner may work in the Space the Thread is in now; if not, 403 «You cannot work
  in this Thread's Space now», and the same key works again once they can (an Organization
  archived, then restored). One AllowedAiAccounts call (`accessIn`) answers both access and the
  allowed accounts. A key is made in one write transaction (the Hub's SQLite client begins
  writing transactions `IMMEDIATE`) with its Space check, so a Membership ending meanwhile either
  refuses it or is seen by the watch. A removed, disabled or missing User's keys are revoked as `user-inactive` and
  answer 401, whichever watch runs first.
- **Usage:** counted like a Thread's (`ai_usage` with the key's User and Space, no Thread).
- **Setup** (`@t3tools/shared/aiGatewayLocalCli`, the Hub's public URL, else the address the
  client reaches it on): Claude Code `~/.claude/settings.json` with `env.ANTHROPIC_BASE_URL =
  <hub>/api/ai/anthropic` and `env.ANTHROPIC_AUTH_TOKEN = <key>`; Codex `~/.codex/config.toml` with
  `model_provider = "t3"` and `[model_providers.t3]` (`base_url = <hub>/api/ai/openai/v1`,
  `env_key = "T3_AI_GATEWAY_KEY"`, `wire_api = "responses"`) and, apart, the shell line that
  exports the key: never in `config.toml`. Right
  after «Create key» the setup holds the key; «Copy setup» on a listed key holds a placeholder.
- **Accepted risk:** a key lives in the User's files on their own machine, readable by whatever
  runs as them there. It reaches only that User's allowed accounts in one Space, and its use shows
  under them; revoke it from any device.

## Usage (spec 4 ticket 05)

Decisions; the code is `ai/AiUsage.ts` (migration 114, `ai_usage`, `ai_usage_daily`). Recorded and
shown, **never limited**: no quota, cap or block anywhere.

- **One request, one row.** `AiGatewayProxy.forward` ends every request in one
  `GatewayRequestRecord` (its `record` runs once: a retry on another account, a failover and a
  stream the client left are still one). `AiUsage` subscribes to those records and writes each from
  a fiber of its own, so the write is never on a response's path; a failed write is logged and the
  request is already answered. The row and its day's summary are one transaction.
  `count_tokens` is not a request of the log (it uses no model).
- **What is stored:** time, day (UTC), User, Space, Thread (or null), gateway key id, AI account,
  provider, model, shape, HTTP status, duration, failovers, and tokens (input, output, cache read,
  cache write; null when unknown). No prompt, answer, header or key exists in the record to store
  (`AiUsage.test.ts` greps both tables; `DoorRules.test.ts` keeps the tables to `AiUsage.ts`).
- **Unknown tokens:** an answer without `usage`, or one that never finished (client left, cut),
  is counted as a request with unknown tokens (`unknown_requests`), never as zero tokens used. A
  failed request (status 400 or more) is counted as failed and carries no tokens.
- **Daily summary** `(day, User, Space, AI account, model)`: kept for good. Per-request rows: 90
  days, swept at start and every day (`AiUsage.sweep`; the Thread's usage reads them, so it covers
  90 days). A request that reached no account (all out of quota) has account and model `''` in the
  summary.
- **Who sees what** (`AiUsage.summary`, WS `aiUsage.summary`, `RPC_SPACE_ACCESS` unscoped with the
  reason): the Owner (not limited to one Space) everything; an Organization's Admin
  (`AccessPolicy` `aiUsage.viewSpace`, decided on the Space, archived ones included) every row of
  their Organizations plus their own; anyone else only their own rows. An agent bound to one Space
  sees that Space only. A filter (Space, User, account, Thread) only narrows, never widens. Names:
  a User's and a Space's come with the rows they appear in; an AI account's name only for the
  Owner and for whoever may use it somewhere now (else `null`: «Claude account»).
- **Doors:** WS only (`aiUsage.summary`, scope `orchestration:read`). No HttpApi endpoint, raw route
  or MCP tool. Windows are at most 366 days (an impossible date is refused); at most 5000 rows answer (`truncated`, totals still whole).
- **Settings → AI accounts → Usage** (Owner) and the Thread's panel («AI gateway usage») read it.
- **Counted as failed (no tokens):** a refusal after authentication (gateway not running, 415, 429
  limits, body too large or not JSON, no model served, all accounts out of quota) with the account
  last tried or none (account and model `''` in the summary; the model is kept only once the plan
  accepted it), and a request that never got an answer: status 499 when the client left, 502 when the Hub
  itself failed. A limit refusal (429 on a body or request slot) is shed load: it only adds to the
  daily summary (one upsert per key and day per batch), has no row of its own and is logged once,
  by the route.
- **Not counted here:** direct credentials never pass through the gateway (the Thread shows what
  its provider reports); requests refused before authentication (bad key) have no row; model lists
  and `count_tokens` are not requests of the log.
- **The writer** queues at most 10 000 records (the newest beyond are dropped, logged), writes them
  in batches of 200 per transaction, and writes what is still queued when the Hub stops. Token
  counts that are fractions or unsafe integers are treated as unknown. The sweep deletes in
  batches of 5000. `maxRows` cuts the rows, never the totals.

## Agents through the gateway (spec 4 ticket 06)

Decisions; the code is `ai/AiGatewaySessions.ts` (the rule), `environments/AiGatewayRelay.ts`
(the machine's side) and `provider-core/server/instanceEnvironment.ts` (what each driver sets).

- **Who goes through it.** Claude Code, Codex, OpenCode and Pi, on a Hub with a usable AI account
  (not deleted, not disabled, not direct), and always in Sandboxes and dedicated machines, whose
  logins are retired. Never a fallback to a login: no allowed account, an account no longer
  allowed, no allowed account serving the model, a machine before contract 11 or plain HTTP to a
  remote Hub all refuse the session. Unreadable state refuses too.
- **One plan per open, one key per process.** The plan (owner, Space, account) is decided once per
  open, without a key; a running session for another owner or account is not reused, and a busy
  one never serves a turn that must go through the gateway. The key is issued only when a process
  starts, after the shared-process refusal, for the Thread's turn owner; it is revoked when the
  session is released, on any failure or interruption of the open, and at every Hub start (no
  session survives one). A gateway session never serves another Thread.
- **The account shown is the account routed**: the Thread's, else the first allowed by global
  priority that serves the model, as the gateway's `planRoute` picks it. A failover or a switch
  is shown as soon as a request goes to another account (ticket 08, below).
- **The key travels like a secret** (`provider.openSession` only, environment only: never
  arguments, files, logs or the event store). Ambient AI variables are dropped and the gateway's
  set last, so neither the machine nor a Vault overrides them; Vaults refuse those names
  (`AI_GATEWAY_ENV_NAMES`, checked against what the drivers set). Loopback is added to `NO_PROXY`.
- **Project configuration cannot redirect it.** Claude Code gets the base URL and model as flag
  settings, which outrank a project's `.claude/settings*.json` (the key itself never goes there);
  OpenCode runs with `OPENCODE_DISABLE_PROJECT_CONFIG`. Pi loads a project's settings and
  extensions only in a folder the User trusted.
- **The relay** listens on loopback only and forwards the gateway's own routes to the Hub (by the
  Sandbox's socket, or the Hub's https URL), adding, keeping and following nothing.
- **Provider homes** are per Thread and driver, under the machine's state directory: no login or
  setting of the machine's user.
- **Terminals and setup scripts get no key**: a User's shell would carry the Thread's key; local
  CLIs use User keys (ticket 10).

**Accepted risks.** The agent's own process holds the key: anything it runs can read
`/proc/<pid>/environ`, and in a shared Sandbox so can the Space's other processes (ADR 0004).
Codex's default shell policy drops `*KEY*` names; Claude Code's, OpenCode's and Pi's tools inherit the
key (Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` refuses to start without bubblewrap, which a
Sandbox without capabilities cannot run), and a Pi extension of a trusted project runs with it.
A key is worth only its Thread's allowed accounts while its session lives. Provider homes stay on the machine after a Thread is deleted (transcripts,
never the key): removing them needs an executor operation, left for a later ticket.

## Direct credentials: providers without a base URL (spec 4 ticket 07)

Decisions; the rule is `ai/AiGatewaySessions.ts` (`plan` → `direct`, `issueDirect`), the table
`AI_DIRECT_DRIVERS` (contracts, `aiGatewaySession.ts`), the machine side
`provider-core/server/instanceEnvironment.ts` (`applySecretEnv`, `openSessionWithSecrets`).

- **Which agents.** Drivers whose CLI cannot point at the gateway, each with the direct account
  providers it takes and the one variable its credential reaches the process under: Antigravity
  (`gemini` → `GEMINI_API_KEY`, `vertex` → `GOOGLE_API_KEY`, a Vertex AI express key, its «Agent
  Platform» method), Cursor (`CURSOR_API_KEY`), Kiro (`KIRO_API_KEY`), Fx (`AI_GATEWAY_API_KEY`),
  Muse (`meta` → `META_API_KEY`), ACP Registry (Devin only, `DEVIN_TOKEN`) and Grok (`XAI_API_KEY`).
- **Grok stays direct.** Checked with `@xai-official/grok` 1.0.77 against a fake upstream:
  `GROK_CLI_CHAT_PROXY_BASE_URL` routes chat only in session-token mode (`GROK_AUTH_PROVIDER_COMMAND`,
  which then also calls `/v1/user`, `/v1/settings`, `/v1/bundle/archive`); with `XAI_API_KEY` set the
  CLI ignores it and calls `api.x.ai`. `GROK_XAI_API_BASE_URL` with `XAI_API_KEY` does reach a custom
  base (`/v1/models`, `/v1/api-key`, `/v1/chat/completions`): a follow-up ticket
  (`.scratch/ai-accounts-and-gateway/issues/14-grok-por-la-gateway.md`).
- **An AI account of type `direct`** (`aiAccounts.create` with `type: "direct"`): an API key of an
  `AiDirectProvider`, never a subscription login nor a service-account file (refused). Never sent to
  CLIProxyAPI; status «Working». The form says «This credential will be visible to the agent».
- **Same condition as the gateway** (`applies`): once the Hub has any enabled AI account, or always
  in a Sandbox or dedicated machine, a direct driver's Hub turn runs only on a direct account: the
  Thread's choice if it is allowed (AllowedAiAccounts for its turn owner in its Space), else the first
  allowed of a provider the driver takes, by global priority. None → refused («No AI account is
  allowed to you in this Space»); a chosen account not allowed → refused, never another. Never the
  instance's own key or a login of the machine.
- **Delivery** (`provider.openSession` only): the value is read from the store when the process
  starts, remembered by the Thread's masker first (`ai-account:<credential id>`), and sent as one more
  `secretEnv` variable, which wins over a Vault's of the same name, with `secretEnv.aiCredential`
  naming it. The fingerprint holds owner, Space, account and credential id: «Replace credential» or a
  switch means a new process. Terminals and setup scripts never get it (they use
  `SecretDelivery.plan`, which knows no AI accounts). Executor contract **13**: an older machine is
  refused (it would keep its own logins beside the key), by the plan and by the link's guard.
- **On the machine:** `applySecretEnv` with `aiCredential` unsets every ambient AI credential of the
  machine or instance (the gateway's list plus the direct drivers' keys and sign-in hooks, as
  `undefined` so an overlay spread over the instance's environment unsets them too), then sets the
  Thread's set back, a Vault's `GOOGLE_APPLICATION_CREDENTIALS` included (gateway processes keep a
  Vault's too); `openSessionWithSecrets` refuses a credential the adapter does not declare in
  `acceptsAiCredential` (ACP Registry declares it only for Devin, so other registry agents never run a
  Hub turn, and a Devin turn never asks for the sign-in method the instance stored). Cursor passes it
  to the SDK for that session only (`apiKey`; the driver no longer replaces it with the machine's
  sign-in), never the instance's `CURSOR_API_KEY`. Antigravity signs in with it (`gemini-api-key` or
  `agent-platform`) in the Thread's own profile (`<profile>-ai-account/<hex Thread id>`, never one that
  held a Google sign-in; its turn outcome is read there), ignoring the instance's `apiKey`; an
  instance set to «Google account» or «Gemini Enterprise» never starts a Hub turn (`login-method`),
  its Google sign-in (`provider.auth.start`) is refused once AI accounts apply, and it writes no
  titles, commit messages or summaries then (`TextGeneration` picks another model, or says why).
  Settings shows those two methods disabled («Use the Owner's Google account through the AI gateway»).
- **Masked** as `[NAME]` like a Vault value: `SecretMasker` reads `ai-account:` value ids from the AI
  accounts' credential store, so the mask survives reloads and restarts; a replaced or deleted
  credential stays sealed while a Thread that received it lives (AiAccounts keeps it). The Thread's
  «Secrets» panel lists it as «AI account credential» (variable and account name only).
- **Not counted** by the gateway's usage (it never passes through it).

**Accepted risks.** The credential is visible to the agent and to whatever it runs, in its Sandbox
(ADR 0005); revoke it at the provider. Deleting the account does not stop a running process (the
next open refuses). Kiro, Muse, Devin and Grok keep their machine-user login files (only their
variables are unset): the direct key takes precedence in each CLI, but their homes are not per
Thread. Text generation of the other direct drivers (Cursor and the rest) is refused the same way
as Antigravity's once AI accounts apply.

## The AI account of a Thread (spec 4 ticket 08)

Decisions; the rule is `ai/chooseAiAccount.ts` (one chooser, also the session plan's) and
`ai/AiAccountChoice.ts` (the doors and the picker).

- **One door for every transport.** `ThreadManagementService.dispatch` settles the selection's
  `aiAccountId` (`AiAccountChoice.settle`) after the Space is claimed and the Thread placed, for
  `thread.create`, `message.dispatch` (with a selection), `thread.model-selection.set`,
  `provider.switch` and `delegated_task.request` (a child: its parent's owner, Space and machine).
  WS, HTTP, MCP (`t3_thread_launch`, an agent's child Threads) and scheduled tasks all pass there.
  Server work without a User or Space is left to the session plan.
- **The rule** (only where `AiGatewaySessions.applies`): a named account must be in
  `AllowedAiAccounts.for(turn owner, Thread's Space)`, taken by the driver (gateway agents: any
  non-direct account; direct agents: a direct account of a provider they take) and, for the
  gateway, serve the model when its catalog can be read. Else the command is refused
  (`AiAccountChoiceError`: «This AI account is not allowed for this Thread in its Space», «… cannot
  be used by this provider», «… does not serve <model>»): never another account, never a login.
  The check is on the **turn owner** (whom the gateway key acts for), so an Admin cannot put a
  Member's Thread on an account allowed only to the Admin; who may send the command at all is
  still `commandAccess` (`thread.continue`).
- **The default.** No account named: the Thread's own, while its provider instance stays (old
  clients and agents never drop it; if it is no longer allowed the session plan refuses with
  «Switch AI account»); else the first allowed by global priority that the driver takes and that
  serves the model, written into the Thread. None: the selection goes on without one and the plan
  says why when a turn starts; the composer says it before sending.
- **`thread.setAiAccount`** (WS, `RPC_SPACE_ACCESS` `thread`, scope `orchestration:operate`) is
  only sugar: same provider instance → `thread.model-selection.set` (the gateway reads the
  Thread's `modelSelection.aiAccountId` on every request, so the next request goes to the new
  account, even mid-turn; account changes are not a model change for the provider session);
  another instance → `provider.switch` (spec 2 ticket 09's context handoff at the next turn). Both
  go through the door above.
- **The picker** (`aiAccounts.picker {spaceId, environmentId?}`, WS, unscoped with its reason):
  AllowedAiAccounts for the session's User in that Space (nothing, not even names, in a Space they
  do not work in or outside `spaceLimit`), with each gateway account's models (its prefix's
  catalog) and `null` for a direct one; `applies` says whether turns there run on AI accounts.
- **Availability in the clients.** Where `applies`, a gateway or direct agent is ready only with a
  compatible allowed account; its machine login (auth status, sign-in prompts) is ignored; a
  gateway agent lists its accounts' models of its own family (`isModelListedFor`: Claude under
  Claude Code, OpenAI under Codex, the families with no agent of their own under Codex, labeled;
  OpenCode and Pi list all; image, embedding and audio models nowhere). Picker order only: the
  Hub serves any allowed model to any gateway agent.
  None: «No AI account is allowed for you in <Space>». The composer has an «AI account» select
  (the accounts that fit the provider and model, first by priority); mid-Thread it calls
  `thread.setAiAccount`.
- **The header** shows the account in use: `ProviderSessionManager` follows
  `AiGatewayActivity.subscribeAccountsInUse` and re-emits `provider-session.updated` for the live
  session (after a failover, or the first request after a switch). The projection carries the
  account's id, provider and model, **never its name**, since every viewer of the Space reads it:
  each client names it from its own picker, else «<Provider> account». Events written before
  ticket 08 still hold the name they had.
- **Routing** of the Hub's provider switch plan (`ProviderSwitchService`) asks an instance's
  metadata from the Environment that has it when the Hub machine lacks it, as `get` already did.

## Moving a Project and removals (spec 4 ticket 11)

The rule stays `AllowedAiAccounts.for(turn owner, the Thread's Space now)`, checked by the gateway
on every request. What ticket 11 adds is that the records, the Threads' choices and the live
processes agree with it at once, in the write that ends a reach (`ai/AiAccountReach.ts`,
`ai/AiAccountReachLoss.ts`, `orchestration-v2/AiSessionReach.ts`), as Vaults do
(docs/internals/secrets.md, «Losing reach»).

| How reach is lost                                                                            | In the same transaction                                                                                                                                                                                                                                                  | Live processes                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| A Project moves to another Space                                                             | each Thread's commit (`thread.space.move`): its gateway keys revoked (`thread-moved`, the old key answers 401), its `modelSelection.aiAccountId` kept if allowed to its turn owner there, else the first allowed one its driver takes, else none («needs an AI account») | closed after the commit (`reconcileAiSessions`)                                                                                         |
| A User is removed                                                                            | every key of theirs revoked (`user-inactive`, User keys audited `ai_gateway_key.revoke` by the Owner), every allowance to them and to their Personal space dropped (audited `ai_account.allow`)                                                                          | closed after the commit                                                                                                                 |
| An Organization is deleted                                                                   | its Threads go first (their keys with them); then the keys made for its Space (`space-lost`) and its allowances, audited                                                                                                                                                 | ended with its Threads                                                                                                                  |
| An allowance taken back, an account disabled or deleted, a Membership ended, a User disabled | nothing to drop: the next request is refused (a Thread key is refused, never revoked, when its turn owner merely lost access)                                                                                                                                            | a direct credential's process closed (`AiAccountChanges`, the Space directory's watches); a gateway session stays, its requests refused |

- **The move plan** (`POST /api/projects/move-plan`, same door and rule as before) answers
  `aiAccountsLost`: each account a Thread chose that its turn owner may not use in the destination,
  with how many Threads use it. The name only for an account allowed to the Space it leaves (its
  viewers see it there); otherwise `null`, and clients say «<Provider> account». The dialog lists
  them under «AI accounts it loses». A Thread left without one shows the composer's «AI account»
  select (ticket 08).
- **The re-choice** runs only when the Thread's Space in effect changes (one without its own is its
  Project's), inside the Thread's move transaction, which writes nothing if the move is rejected: the allowed set is read there, so an
  allowance taken back meanwhile is seen. The catalogs that pick an account serving the model are
  read before any write (`catalogsFor`); none readable: the first compatible account. The driver is
  the Thread's last session's, else its instance's.
- **Live processes: closed, not restarted** (`AiSessionReach`). Each provider session started on an
  AI account keeps what it was started for (`aiFacts`: turn owner, Space, account; the session
  plan's). A check reads the live sessions from memory, their Threads in one query and the allowed
  accounts once per owner, and releases every session whose Thread is in another Space, has another
  turn owner, is gone, or whose User was removed; a session whose account is merely no longer
  allowed to them there closes only if it holds a direct credential (a gateway key stays refused,
  not revoked, and its request in flight finishes). Each owner's accounts are read on their own,
  once more on a failure, then «not allowed» (fail closed). Requests coalesce (one pending at
  most); they come from a move (also one that failed part way, once anything moved), a removal,
  Membership and User status changes, an account's allowances, disablement or deletion, each
  machine as it connects, and each AI session once it is live (its plan may predate the check). A machine away
  when its session is released is told on its return (`provider.detach`, then `retired`). The next
  turn opens a new process by its fingerprint, which holds the Space. A direct credential is thus
  gone from a process's environment once its reach ends; a gateway key is refused per request anyway.
- **Keys** are still written by `AiGatewayKeys` alone: a move or removal calls `revokeWithin` inside
  its own transaction. A request in flight when its key is revoked finishes; the next is refused.
- Migration **118** (`AiAccountReachLoss`) drops once what earlier Hubs left: allowances to Spaces
  that are gone, to removed Users and their Personal spaces; live keys of removed Users and of
  Spaces that are gone.

**Accepted risks.** Between the commit and the check (milliseconds, or a machine's return), an idle
process still holds its direct credential; it runs no turn of the new Space (that needs a new
process). Whatever such a process started outside its session keeps it, as with terminals. A
Thread whose model no default account serves gets the first compatible one, and its turn says
«does not serve <model>» rather than silently changing model.

## Keys moved from provider instances (spec 4 ticket 09)

Decisions; the rule is `ai/ProviderKeyMigration.ts` (`aiAccountsInUse`, `migrateProviderKeys`), the
settings side `settingsAiCredentials.ts` and `ServerSettingsService` (`setAiCredentialGuard`,
`listProviderCredentials`, `removeProviderCredentials`), the account side
`AiAccounts.adoptProviderKey`, the list `aiAccountCredentialProviderOf` /
`AI_ACCOUNT_CREDENTIAL_FIELDS` (contracts).

- **Which keys.** Provider-instance variables `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `KIRO_API_KEY`,
  `META_API_KEY`, `AI_GATEWAY_API_KEY`, `DEVIN_TOKEN` (marked sensitive or not, a value or a
  secret provider reference; the name in any case) and Antigravity's `apiKey`. Every other variable
  stays on its instance.
- **Only where AI accounts are in use** (`aiAccountsInUse`, the one condition): the server has a
  usable AI account (not deleted, not disabled: what `AiGatewaySessions.applies` asks) or its AI
  gateway is turned on (any state but `off`/`unsupported`; on by default on a server Hub, off by
  default in the desktop app and on a dev Hub). Accounts that cannot be read count as none
  (`ai/usableAiAccounts.ts`). A desktop or dev Hub with neither keeps its keys and saves new ones
  exactly as before; nothing moves.
- **When.** A pass at every start (beside it, not blocking it) and again when the gateway is turned
  on; one pass at a time. It needs the Owner: before one exists nothing moves (the next pass does).
  Only the server does it: no RPC triggers it, and nobody else gains any use of a key, since each
  account is allowed only to the Owner's Personal space until the Owner allows it elsewhere.
- **Which account.** The variable names the provider (`ANTHROPIC_*` → `claude`, `OPENAI_API_KEY`
  → `codex`, `GEMINI_API_KEY` → `gemini`, `XAI_API_KEY` → `xai`, `CURSOR_API_KEY` → `cursor`,
  `KIRO_API_KEY` → `kiro`, `META_API_KEY` → `meta`, `AI_GATEWAY_API_KEY` → `fx`, `DEVIN_TOKEN` →
  `devin`; Antigravity's `apiKey` → `vertex` with «Agent Platform», else `gemini`). Direct when the
  instance's driver is one of `AI_DIRECT_DRIVERS` and the provider takes a direct key, else an API
  key through the gateway. Named «<Provider> (migrated)», then «<Provider> (migrated, <instance>)»,
  then numbered. The same key on two instances is one account.
- **Order: the account first, the removal second.** `adoptProviderKey` seals the key under a new
  credential id, then writes the row (`created_by` the Owner), its one allowance, its ledger row
  and the audit `ai_account.create` (`via: "migration"`, actor `system`) in one transaction. Only
  then `removeProviderCredentials` takes the variable or field off its instance in one settings
  write, if it still holds that value; the settings service's usual path deletes its
  `provider-env-*` / `provider-config-*` secret and rewrites settings.json without it. A stop in
  between leaves the key owned and still on the instance (which Hub turns ignore since tickets 06
  and 07), never live and unowned.
- **Twice is once.** Migration **117** (the next free id after 116: a database that recorded a
  higher id would refuse a lower one added later), `ai_account_migrated_keys` (`source` =
  `env:<instance>:<VARIABLE>` or `field:<instance>:<field>`, the account id; never the key or a hash
  of it). A source already moved whose account still holds the same key is only removed from the
  instance; any other key under it becomes a new account, so a key is never lost. Deleting an
  account deletes its ledger rows.
- **Deleted meanwhile.** The removal asks again, under the settings write lock and right before
  its write, whether the account still exists and holds the key (`AiAccounts.holdsKey`); an
  account the Owner deleted in between leaves its key on the instance.
- **Left on the instance**, named in the log by instance and variable only: a secret provider
  reference that cannot be read within 15 s (read once per pass), a value AI accounts refuse
  (spaces, control characters), or a write a managed policy locks. Settings shows each one on its
  instance («… could not be moved into an AI account», with a link to Settings → AI accounts).
  Values a managed policy supplies are not stored by the Hub and are not moved.
- **Writes refuse them** while AI accounts are in use, in `ServerSettingsService` itself, so every
  door does: WS `server.updateSettings` (patch and provider instance mutation), the MCP tool
  `t3_environment_preferences_update`, and the Hub's own callers. Until the AI accounts layer sets
  the whole condition at boot, a usable account is enough. A write may keep a leftover as stored
  (the redacted echo, the same value or reference, a field read back under the same driver), clear
  it or remove it; adding one (even empty) or changing one fails with `write-ai-credential` («OPENAI_API_KEY is an AI credential: add it in
  Settings → AI accounts.»), naming the variable, never the value. No HttpApi twin exists. The web
  form says it first (with the link), hides Cursor's and Kiro's key fields and Antigravity's
  «API key» once the Hub has an enabled AI account.

**Accepted risks.** `ANTHROPIC_AUTH_TOKEN` (which may be an OAuth token) and a key paired with a
custom `*_BASE_URL` become plain provider API keys; the account then shows an error and the Owner
fixes or deletes it. A Hub whose gateway is on with no account yet refuses new keys before the web
form knows (the Hub's message says where to go).

## Clients: desktop and mobile (spec 4 ticket 12)

**One source.** The picker rules (`resolveAiAccount`, `aiAccountsFor`, `applyAiAccountsToProviders`,
`nameThreadAiAccount`, `deriveThreadAiAccount`), the usage grouping (`groupUsage`, `formatTokens`) and
the account rows (`accountRows`, status words, quota text) live in `packages/client-runtime`
(`ai-account-picker`, `ai-usage-view`, `ai-accounts-view`). Web and mobile import them; the Hub's
commands come from one `createAiGatewayEnvironmentAtoms` on each client.

**Desktop** loads the web bundle, so Settings → AI accounts (accounts, Usage, Local CLI keys),
Settings → AI gateway, the composer's «AI account» select and the Thread header badge are the same
screens. The provider sign-in link is a `target=_blank` https link: the window-open handler sends it
to the system browser (`ElectronShell.test.ts`), and the Owner pastes the address the browser lands
on, as on web.

**Mobile** (read-only, spec story 42): Settings → AI accounts (`SettingsAiAccounts`,
`settings/ai-accounts`) lists the accounts the Hub returns with status, status message and quota,
the last 30 days of usage by AI account, and the User's own Local CLI keys (make, copy the key once
at creation, revoke; the key is a Personal-space key). Above the composer a strip shows the account
in use and the model and, where the Hub says AI accounts decide and more than one fits, lets the
User change it: mid-Thread `thread.setAiAccount` (gated by its `permissionAtom`), on a draft the
choice goes into the draft's model selection. The phone never calls `aiAccounts.login.*`,
`importVertex`, account create/update/delete/allow/reorder or `aiGateway.update|rollback|setEnabled`
(`noOwnerControls.test.ts` scans the mobile source); the Hub refuses them from a Member anyway.
No credential or key hint is shown; mobile follows the Hub's answers and never guesses a role.

**Build for a device** (not run here, no device): `cd apps/mobile && pnpm ios` or `pnpm android`
(prebuild + run), connect to the Hub, open Settings → AI accounts, and open a Thread in a Space
whose accounts allow it.

## Known exception to «no upstream services»

CLIProxyAPI 8.0.67, even with `-local-model`, asks the internet for the latest Antigravity client
version (`antigravity-hub-auto-updater-….run.app`, every 3 h) and the Grok CLI version
(`registry.npmjs.org/@xai-official/grok/latest`). The pinned release has no setting that turns these
off (none among its config keys in the binary), and a proxy scoped to the child
would also carry the providers' own traffic. Accepted as a known exception to ADR 0007: the requests
carry no credential, prompt or account, only the Hub's address. Revisit at each pin update.
