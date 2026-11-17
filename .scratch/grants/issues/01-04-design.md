# Design: lending AI accounts (Grants 01–04)

Branch `feat/grants-ai` (base `public-hub-1` 8c6cdd8fef). Extends the machine Grants (135, `Grants.ts`, `decideGrant`): one table, one service, one policy. Migrations **144** (02) and **145** (03); renumber at integration. 01 and 04 need none (`grants` already allows `ai-account`).

## 1. Model (01)

- **Lendable:** a live `ai_accounts` row of type `subscription` or `api-key`; `direct` → `not-lendable`. The lender is the account's owner (`owner_kind/owner_id`, migration 140): a User, or an Organization (`lender_kind='organization'`, `lender_id` = its Space).
- `GrantLimits` gains `AiAccountGrantLimits { kind: "ai-account", tokens: { amount, period } | null, requests: { amount, period } | null }`, `period ∈ day|week|month`. 01 writes `{ tokens: null, requests: null }` (no cap). 03 makes the form require a token cap or an explicit «No cap».
- `GrantResourceRef` becomes a union: `environment` (as today) | `{ kind: "ai-account", aiAccountId }`. `Grants.give/targets/checkGive` branch by kind. `lendable*` per kind; the machine path is unchanged (strong factor stays machine-only).
- **Who (`AccessPolicy`):** `GrantResource.lenderUserId` becomes `lender: { kind: "user", userId } | { kind: "organization", space: SpaceResource | null }`. Lender actions: a User's resource → that User only; an Organization's → its Admins while it is open (the Owner only if Admin there; no operator bypass). The spec's «Steward» does not exist in code yet (only a comment in 138): Admins only, Steward added by plans-and-limits. Destination rules unchanged (Organization Admins / Personal space's User; `viewReceived` Members+Admins see active, pending only deciders). Lending to the lender's own Space (own Personal space, or the Organization that owns the account) → `wrong-resource`. Destination naming: same `knownTargets` as machines (Organizations the acting User is in, Personal spaces of people they share a Space with; any for the Owner).
- **Read rule:** `AllowedAiAccounts` = own accounts of the Space's owner (priority order) ∪ accounts with a Grant `active` to that Space whose Space is not archived, after them, ordered by the Grant's `decided_at` then the lender's priority, minus duplicates (own wins). Each `AllowedAiAccount` gains `via: { kind: "own" } | { kind: "grant", grantId, lenderName, limits }`. Pending, rejected, cancelled, ended give nothing. Read on every call, so ending a Grant refuses the gateway's next request (Thread key: `CHOSEN_NOT_ALLOWED`; User key: the account just disappears from its list).
- **Doors:** give and accept stay on the existing HTTP `POST /api/grants/give|accept` (no strong factor for AI accounts, `prepare*` says so). WS already has `listGiven/listReceived/targets/reject/cancel/end/setLimits`. No new door, no MCP tool. Audit actions already exist; details add `resourceKind: "ai-account"`, cap keys (`tokensAmount`, `tokensPeriod`, `requestsAmount`, `requestsPeriod`) and `via` to the audit allow-list.
- **Clients (web, Settings until the modals land):** «Lend…» on each lendable row of `AiAccountsSettings` the viewer manages (`LendAiAccountDialog`: Space from `grants.targets`; for a subscription the provider-terms warning). `GrantsSettings` lists AI-account Grants beside machines (given / waiting / borrowed, with Revoke / Cancel / Accept / Reject / Return). Picker entries gain `lentBy?: { name }` → «from <lender>».

## 2. Migration of allowances (02) — migration 144 `AiAccountAllowancesToGrants`

For each `ai_account_allowances` row on a live account the Owner owns (rows on anyone else's were already ignored by the read rule since 140):

| Allowance                                                                        | Becomes                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| to the Owner's Personal space, or to the Owner as a User in their Personal space | nothing (already own)                                                                    |
| to a Space that exists                                                           | Grant `active` to it, lender the Owner, `{tokens:null, requests:null}`                   |
| to a User that exists and is not removed                                         | Grant `active` to their Personal space (none if the User is the Owner) + **review rows** |
| to a Space/User that is gone, or on a deleted account                            | dropped                                                                                  |

All migrated Grants get `created_at = decided_at = <migration time>`, `created_by = decided_by = Owner`, and an audit `grant.give` with `via: "migration"`. Then `DROP TABLE ai_account_allowances`.

**Review rows** (`ai_account_grant_reviews`: `account_id, user_id, space_id, used_recently, created_at`, PK of the first three): for each user allowance, one row per Organization the User works in today (Member/Admin/Guest, i.e. where it reached them), with `used_recently` = usage in `ai_usage` of that account in that Space in the last 90 days. Owner-only WS `grants.migrationReviews` / `grants.dismissMigrationReview`; «Lend to <Organization>» calls `grants.give` (starts active if the Owner is Admin there) and the give deletes the matching row in its transaction. Shown to the Owner in Settings → AI accounts (there is no «Platform» screen yet).

Removed with it: `aiAccounts.allow` (contract, ws, `RPC_SPACE_ACCESS`, client-runtime, web UI), `AiAccountReachLoss.dropAllowances` (`forgetUser`/`forgetSpace` keep revoking keys; their Grants end with ticket 11), `aiAccount.allow` in the policy. `ai_account.allow` stays readable in the audit labels.

**Proof:** `144_AiAccountAllowancesToGrants.test.ts` seeds Owner, Ana, Bob, Acme, Globex, a removed User, Spaces/Users gone, a deleted account, and Threads; computes each (User, Space) usable set with the pre-144 rule (frozen SQL copy in the test) at 143, migrates, recomputes with the real `AllowedAiAccounts`, and asserts the sets and order are **identical except** exactly the (account, User, Organization) triples that appear in `ai_account_grant_reviews`.

## 3. Caps in the gateway (03) — migration 145 `AiUsageGrant`

- `GatewayRequestRecord.grantId: GrantId | null`, from the `via` of the account that answered. `ai_usage.grant_id TEXT` (NULL own); `ai_usage_daily` rebuilt with `grant_id TEXT NOT NULL DEFAULT ''` in the primary key and an index `(grant_id, day) WHERE grant_id <> ''`. Old rows keep `''`.
- `ai/GrantCaps.ts`: `check(grantId, limits)` → `ok` | `{ exhausted: "tokens"|"requests", period, resetsAt }`.
  - UTC calendar periods from `Clock` (day; ISO week from Monday; month).
  - Tokens counted: input + output + cache write; cache reads shown, never counted. A request with unknown tokens = 0 tokens, 1 request. Requests counted: every request that reached the account through that Grant (upstream errors too; shed and cap-refused ones never reach an account).
  - Used = `SUM` over `ai_usage_daily` for the Grant from the period start + what `AiUsage`'s writer has queued and not committed (new `AiUsage.unwritten(grantId, fromDay)`: an in-memory tally incremented on enqueue, decremented only after its batch commits — never under-counts).
  - Own accounts (`via: own`) are never checked.
- **Where:** `AiGatewayProxy.forward`, in the candidate loop where the 429 failover already lives (the spec's «step 2 of AiGateway.ts» is here today): before sending to a granted candidate, `check`; exhausted → skip to the next candidate (same provider, serves the model), as a 429 from upstream would. None left → the client's shape, **429**: «The AI account <name> lent to <Space> reached its <daily|weekly|monthly> cap; it resets <ISO date>. Switch AI account.» (the first exhausted Grant's), recorded as shed (no account, no Grant). The check reads one indexed row-set per granted candidate, only for granted accounts.
- **Mid-stream:** nothing is cut. A request admitted below the cap finishes and is counted in full; the cap can thus be passed only by requests already in flight when it was reached (at most the key/User concurrency limits × one answer each), never by a new one. Lowering a cap below what was used exhausts the Grant from the next request (`grants.setLimits`, audited `grant.limits.change`).
- Local CLI keys (User keys bound to a Space) resolve the same `accessIn(user, space)` → same `via` → same Grant.
- **Clients:** give form (token cap required unless «No cap», requests optional, period select); setLimits on given Grants; picker entries gain `cap?: { tokens?: { used, amount, period, resetsAt }, requests?: … }`; the Thread shows the 429 message through the existing turn-error path.

## 4. Usage of a lent account (04)

`aiUsage.summary`: input gains `grantId?`; rows gain `grantId?: GrantId | null` (optional key). Visibility (`AiUsage.viewer`) becomes **own rows ∪ rows of Spaces they administer ∪ rows whose `grant_id` is a Grant they may `grant.viewGiven`** (the Owner: everything, as today):

| Viewer                                               | Sees                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lender (User, or Admins of the lending Organization) | rows of their Grants: by borrowing Space, User, day, model. Never their borrowers' other accounts. Never a `threadId` read (the Grant clause is left out of thread-level reads and of `threadRequests`) |
| Member of the borrowing Space                        | their own rows (unchanged)                                                                                                                                                                              |
| Admin of the borrowing Space                         | their Space's rows (unchanged)                                                                                                                                                                          |
| Owner                                                | all consumption; thread-level reads (`threadId` filter, `threadRequests`) narrowed to their own rows and Spaces they administer (see Q4)                                                                |

Labels: borrowers' names and the target Space's name for the lender's Grants (they already see them in «Loans given»); the account's name for accounts the viewer manages. `GrantsSettings` shows per-Grant totals and a breakdown (Space × User × day × model), with «N requests with unknown tokens» and «usage outside the gateway is not attributed» instead of zeros. «Borrowed» shows the Space's (Admin) or own (Member) usage of that Grant.

## Contract changes

Additive: `AiAccountGrantLimits` in the `GrantLimits` union; `GrantResourceRef` union; `Grant.aiAccount?` (provider, type, cap usage); picker `lentBy?`/`cap?`; `aiUsage` `grantId?` in input and rows; new Owner RPCs for the review list. **Breaking:** `aiAccounts.allow` removed (only web calls it; same release). `AiAccountSummary.allowances` stays in the schema, always empty, marked deprecated, so older mobile builds still decode (precedent: `installationPermissions`). An older client decoding a Grant list with an AI-account Grant would fail on the new limits kind: only web/desktop list Grants today, shipped together.

## Open questions (my recommendation)

1. **«Identical usable set» vs. allowances «to a User».** Literally identical is impossible with Space-only Grants: an allowance to Ana reached her in Acme; a Grant to Acme also reaches Bob. Recommend the spec: Personal-space Grant + review list, and the migration test proves identity for everything else and that the difference is exactly the review list. Alternative: also grant to every Organization she works in (widens to all their Members).
2. **Direct accounts with allowances.** Not lendable going forward. Recommend: migrate them too, as active Grants (keeps the set identical; the Owner had allowed them), shown in «Loans given» as «cannot be lent again». Alternative: drop them into the review list.
3. **Threads that had the ended Grant's account chosen.** Ticket 01 asks to re-choose their account in the Grant's end transaction. That needs an orchestration command per Thread (selections are event-sourced; only the Project move does it, inside its own command). Recommend the existing «allowance taken back» behavior: nothing rewritten; the next request/turn is refused with «This Thread's AI account is no longer allowed here. Switch AI account.» and the composer shows the AI-account select. If you want the re-choice, I'd dispatch `thread.model-selection.set` per Thread right after the commit (not in the same transaction).
4. **Owner and Threads (04).** Today the Owner can read any Thread's per-request usage (`threadId` filter, `threadRequests`). Recommend narrowing those two to the Owner's own rows and the Spaces they administer, as the ticket's red test asks; daily summaries stay «everything».
5. **Review list scope.** Spec: Organizations where the User used it in 90 days. Recommend every Organization they work in, flagged «used in the last 90 days», so nothing narrows silently.
6. Cache reads not counted; requests counted including upstream errors (spec Q3; my reading).

## Tests (red first)

- 01: `AccessPolicy.test.ts` (Member non-Admin can't lend the Org's account; Admin can; Owner can't lend Ana's; Member doesn't see pending); `Grants.test.ts` (ai-account give/accept/reject/cancel/end, every illegal transition for the kind, starts active, `already-granted`, `not-lendable` for direct, `plan-target-unavailable`, own Space → refused); `AllowedAiAccounts`/`AiGatewayRoute.grants.test.ts` with the fake CLIProxyAPI (pending/rejected/ended give nothing, `via`, order; ending refuses the next request); `RpcAuthorization`/`DoorRules` rows; web `aiAccountsView`/picker «from».
- 02: `144_*.test.ts` (each table row above, audit `via: migration`, the identity proof); review list Owner-only, lend starts active when Admin, dismiss.
- 03: `145_*.test.ts` (rebuild keeps rows; PK with `''`); `GrantCaps.test.ts` (periods incl. ISO week/month edges, counted tokens, unknown tokens, unwritten tally); `AiGatewayRoute.caps.test.ts` in openai/anthropic/gemini shapes: new request after cap refused, next period allowed (`TestClock`), failover, 429 message, own account never capped, User key counted, setLimits below usage.
- 04: `AiUsage.test.ts`: lender sees only their Grants' rows and no thread reads; borrower Member doesn't see another Member; Admin sees their Space; Owner sees consumption and no foreign Thread.
- Real proofs (dev Hub with copied data, Replay provider) attempted at the end; anything not run is reported unverified.
