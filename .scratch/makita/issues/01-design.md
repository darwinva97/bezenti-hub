# 01 design: Makita's account and the global switch

Ticket: `01-la-cuenta-de-makita.md`. Spec: `../spec.md` («La cuenta de Makita», «Puertas», «Auditoría», «Parar»). Owner decisions of 2026-11-24 are final; open question 5 (token kind) stays open, so both kinds are accepted with the checks below.

## What changes

- **Migration `163_MakitaAccount`**: `makita_account`, one row (`account_id = 'makita'`, `CHECK`):
  `host` (`github.com`), `login`, `github_user_id` (integer), `token_kind` (`classic` | `fine-grained`), `token_hint` (last 4 characters), `scopes_json` (classic: the `X-OAuth-Scopes` list; fine-grained: `NULL`), `token_expires_at`, `status` (`ok` | `token-invalid` | `rate-limited` | `unreachable`), `checked_at`, `global_paused_at`, `global_paused_by`, `created_by`, `created_at`, `updated_at`. Test: runs to 162, then 163; the check refuses a second row.
- **`ServerSecretStore.MakitaTokenStore`**: its own sealed folder (`secrets/makita/`, purpose `makita-token`, added to `STORE_NAMESPACES` so master key rotation re-seals it). Sealed only: on a joined machine every call fails. One entry, `makita`.
- **`makita/MakitaGitHub.ts`**: Makita's own REST client over the Hub's `HttpClient`, with the GitHub REST URLs and rate-limit rule of `@t3tools/source-control-github` (`gitHubApiUrls`, `isRateLimited`, newly exported). It is **not** `GitHubRest`'s request policy: that one injects Settings → Source Control's credential and, on a 401, invalidates it; Makita's token must never be that credential nor touch it. Tracing of the HTTP client is off (as `GitHubRest` does), so no URL or header reaches a span. Two entry points:
  - `check(token)`: `GET /user` with a candidate token (the save flow);
  - `rest(input)`: a request with the stored token, read from `MakitaTokenStore` here and nowhere else in this ticket. A 401 marks `makita_account.status = 'token-invalid'`.
- **`makita/MakitaAccount.ts`** (the table's only writer besides the 401 mark above): `get`, `set`, `pauseAll`, `resumeAll` and their `*ForSession` twins.
  - `set({ token })`: the prefix decides the kind (`ghp_` classic, `github_pat_` fine-grained; anything else refused: «Paste a personal access token: classic (ghp_…) or fine-grained (github_pat_…).»). Then `GET /user`: 200 with `type: "User"`, else refused (401: «GitHub refused this token.»; unreachable: «Could not reach GitHub to check the token. Try again.»; never stored unchecked). A classic token whose `X-OAuth-Scopes` holds `workflow`, `delete_repo` or any `admin:*` is refused with the spec's sentence. Expiry from `github-authentication-token-expiration` (`YYYY-MM-DD HH:MM:SS UTC` or with an offset), else none. Then the store writes the sealed token, then one write transaction upserts the row and audits `makita.account.update` (`login`, `tokenKind`, `scopes`: the list joined, or `fine-grained`). Replacing works the same; the old token is overwritten.
  - `get({ check? })`: the row as the Owner sees it, with warnings: `token-invalid`, `expires-soon` (< 14 days), `no-repo-scope` (classic with neither `repo` nor `public_repo`), `rate-limited`, `unreachable`. `check: true` («Check now») asks GitHub again with the stored token and updates `status`, `checked_at`, scopes and expiry (a 401 gives `token-invalid`).
  - `pauseAll` / `resumeAll`: set or clear `global_paused_at` / `_by`, idempotent, audited `makita.pause_all` / `makita.resume_all`. Pausing needs a registered account (nothing can run without one). Ticket 06 gives it effect.
- **Contracts** `packages/contracts/src/makita.ts`: `MakitaAccountView` (never the token: login, id, kind, `hint`, scopes, expiry, status, checked, pause, warnings), `MakitaAccountGetInput { check? }`, `MakitaAccountGetResult { account: MakitaAccountView | null }`, `MakitaAccountSetInput { token: Redacted }`, `MakitaError { reason: forbidden | not-found | invalid | github | storage, message }`.

## Who may do it

- `AccessPolicy` gains `makita.manageAccount`, in `OWNER_ONLY`, decided on the Installation only (a Space: `wrong-resource`).
- The four WS RPCs `makita.account.get|set|pauseAll|resumeAll` answer a person's own session only (`CommandActor` a plain `User`, no `via`, no `spaceLimit`): an agent, the Hub's shell and a one-Space session get `forbidden`; a non-Owner gets `forbidden`. Scopes: `get` is `access:read`; `set`, `pauseAll`, `resumeAll` are `access:write` (a credential of the Hub).

## How it is undone

- A wrong token: «Replace token» (same check). A token that leaks: revoke it on GitHub; the next «Check now» shows `token-invalid`. Removing the account entirely is not in the spec's doors; open question for the lead.
- «Stop all Makita work» is undone by «Resume», the Owner's alone.
- Every change audited; the audit carries login, kind and scopes, never the token, its hash or hint.

## Doors added

| Door                                               | Rule                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `makita.account.get`                            | `RPC_SPACE_ACCESS` unscoped `MAKITA_ACCOUNT` («the Owner's own session only, `makita.manageAccount`»), `access:read`, `MaskedPaths` none, instrumentation `server`. |
| WS `makita.account.set` / `pauseAll` / `resumeAll` | same rule, `access:write` in `CLIENT_GUARDED_RPC_SCOPES`. Only `set` takes a token; no answer carries one.                                                          |
| HTTP, raw routes, MCP                              | none.                                                                                                                                                               |

`DoorRules.test.ts`: a new test — the four RPCs are WS only and answer no `token`/`secret`/`hash` field; `MakitaTokenStore` is named only by `ServerSecretStore.ts`, `MakitaAccount.ts` (writes) and `MakitaGitHub.ts` (reads); `makita_account` is named only under `makita/` and by its migration; no tool module names Makita's services.

## Web

Platform → **Makita** (new section, Owner only): the account (login, kind, `…hint`, scopes, expiry, status, last check; «Check now», «Replace token»), the token form with the spec's explanation of scopes (classic: `public_repo` or `repo`, nothing else; fine-grained: only for repositories of the bot or of a GitHub organization it is a member of, with Contents, Issues, Pull requests read and write, Metadata, Checks, Commit statuses and Actions read, Workflows none; the bot as a **Write** collaborator, and the ruleset recommendation), the warnings, and «Stop all Makita work» / «Resume». Same dense-row and dialog style as Access keys.

## Tests (red-first)

`makita/MakitaAccount.test.ts` over the Hub testkit and a fake GitHub (`makita/MakitaGitHub.testkit.ts`, a fake `HttpClient`; ticket 04 extends it with the feeds):

- the Owner registers a classic token: login, id, kind, scopes, expiry, hint; replaces it with a fine-grained one;
- refused: `workflow`, `delete_repo`, `admin:org` scopes; a non-PAT prefix; a 401; an `Organization`/`Bot` account; GitHub unreachable — and nothing is stored;
- an Admin, a Member, an agent, the shell and a one-Space session neither read nor change it, nor pause;
- a 401 on «Check now» sets `token-invalid`; expiry under 14 days warns;
- pause and resume all, audited, idempotent;
- leaks: the token is in no `makita_account` column, no audit row, no answer (encoded JSON), no captured log line; the store file is sealed (not the token's bytes).
- `AccessPolicy.test.ts` rows; migration test; `AuditLog.test.ts` list; `RpcAuthorization` and `DoorRules` sweeps.
