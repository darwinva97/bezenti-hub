# Design: lending links (Grants 06)

Branch `feat/grants06` (base `public-hub-1` 6f1a3b141a). Extends `Grants.ts`, `decideGrant` and the `grants` row (135). One migration, **147** (placeholder; renumber at integration).

## Migration 135's CHECK, and 147

135 has `CHECK (target_id IS NOT NULL OR state = 'offered')`. An unclaimed link has no destination, so **cancelling a link (`offered → cancelled`) breaks the CHECK**. That is why `GrantEnding.endGone` "expires" a removed lender's links instead of cancelling them. 06 needs a lender-side Cancel, so:

- **147 `GrantOffersCancellable`** rebuilds `grants` (SQLite cannot alter a CHECK) as `target_id IS NOT NULL OR state IN ('offered','cancelled')`.
  - Same columns, rows, `offer_token_hash UNIQUE` and the four indexes. No table has an FK to `grants`.
  - The test: rows and indexes survive; a link can become `cancelled` with no destination; `pending`/`active`/`ended` with no destination are still refused.
- `GrantEnding` then **cancels** a removed lender's links (audited `grant.cancel`, as today), and `HubWithEnvironments.ownedRemovals.test.ts` expects `cancelled` instead of an expired `offered`.

## Flows (AI accounts; see Q1)

1. **createOffer** (WS `grants.createOffer {resource, limits}`, write scope).
   - Same lender checks as `give` (`lendable*`, `limitsProblem`, `not-lendable` for `direct`), as a new policy action **`grant.offer`**. `decideLender` handles it: the User owner, or the Organization's Admins while it is open. No destination checks.
   - Inserts `state='offered'`, `target_id NULL`, `offer_token_hash = sha256(32 random bytes)`, `offer_expires_at = now + 7d`, `created_by`. Audits `grant.offer`.
   - Returns `{ grant, path: "/grants/offer#token=<t>", url: <T3CODE_PUBLIC_URL origin>+path | null }`. The client uses `url ?? location.origin + path`. The token is shown **once** and the server never stores it.
2. **readOffer** (WS `{token}`). Needs a signed-in User: no User → `not-allowed`, nothing read.
   - Answers `{status:"invalid"}` alike for unknown, used, cancelled or expired links (Invitations precedent: the link's existence is not confirmed).
   - Otherwise answers `{status:"valid", resource:{kind,name,provider,type}, lender:{kind,name}, limits, expiresAt, spaces:[{...GrantSpaceRef, alreadyGranted}]}`. `spaces` lists only the Spaces where the reader has `grant.decide`, minus the lender's own Space (`wrong-resource`). No ids of the account, no credential, no usage, no other Grants.
3. **claimOffer** (WS `{token, spaceId}`, write scope), in one transaction:
   - re-reads the live link;
   - re-checks the resource (live, same owner as `lender_*`, not `direct`);
   - re-checks that **`created_by` still may `grant.offer`** (an Admin who lost the role, or a disabled/removed creator, kills the link);
   - checks `grant.decide` on `spaceId` (the destination's acceptance rule), not the lender's Space, not archived or frozen;
   - checks `already-granted`.
   - Then `UPDATE … SET state='active', target_kind='space', target_id, decided_at/by=claimer WHERE offer_token_hash=? AND state='offered' AND offer_expires_at>now RETURNING`. Zero rows means it lost a race: invalid. A unique-index conflict maps to `already-granted`.
   - Any refusal rolls back, so the link stays usable for another Space. Audits `grant.accept` with `via:"link"` under the destination Space.
   - The Grant is then an ordinary active Grant: `AllowedAiAccounts`, `GrantCaps` (the link's limits), usage (04), Revoke/Return and auto-end apply unchanged.
4. **Cancel**: the existing `grants.cancel`. `visibleRow`/`summaryOf`/`listGiven` learn that an `offered` row (no target) is decided on the lender's side only. `listGiven` shows open links (`Grant.offer: {expiresAt, expired}`), and expired ones as history.

## Security

- **Who creates:** the resource's lender only (`grant.offer`). The Owner has no bypass. Member, Guest or another Space's Admin on an Organization's account → `not-allowed`.
- **Who redeems:** any signed-in, active User, only into a Space where they hold `grant.decide`: their Personal space, or an Organization where they are Admin. Destination naming (`targetKnown`) is skipped by design: that is the point of a link.
- **One use, 7 days,** fixed. A used link keeps its hash and is answered as invalid. Revocation: Cancel before use, then the usual Revoke after.
- **Never reveals the credential:** read/claim return names, provider/type, limits and a `Grant` summary only, as every Grant list does today. The gateway still keeps the key server-side.
- **Same rules as normal loans:** caps from the link's limits, the destination's decision rule, `already-granted`, `wrong-resource` for the lender's own Space, `not-lendable`, and the ToS warning shown before claiming.
- **Guessing and abuse:**
  - 256-bit tokens, stored only as SHA-256 (lookup by hash, so no timing leak).
  - A `makeSignInThrottle` keyed `grant-offer-user:<userId>` and `grant-offer:<hash>` locks after 5 failures. Unknown tokens count against the User; a dead link counts against itself on claim, never on read.
  - New `GrantErrorReason` `"throttled"`.
- **No leaks of the token:**
  - it travels in the URL **fragment**, so it is never sent in HTTP requests, server logs or the Referer;
  - the web app moves it to sessionStorage and strips it from the address bar;
  - RPC tracing is already disabled for WS;
  - audit details never include the token or its hash (asserted in a test).

## Contracts, doors, audit

- `grants.ts`: `GrantCreateOfferInput/Result`, `GrantReadOfferInput`, `GrantOfferPreview` (valid | invalid), `GrantClaimOfferInput`, `Grant.offer?` (optional key), `"throttled"`.
- `rpc.ts`: three methods. `RPC_SPACE_ACCESS` (GRANTS), `clientRpcPermissions` (create/claim write, read read), `RpcInstrumentation`, and the `ws.ts` handlers. No HTTP and no MCP.
- Policy: `grant.offer` goes in `GRANT_ACTIONS`/`LENDER_ACTIONS`. Audit allow-list: `grant.offer` (resource, lender, limit keys, `expiresAt`); `via` on `grant.accept`. Labels in `spaceDirectory.ts`.

## UI (web/desktop; mobile is ticket 12)

- In `LendAiAccountDialog`, the Space picker gains «Someone else's Space: create a link». It creates the link and then shows the link once with Copy, «Works once, for 7 days». The subscription ToS warning already shows there.
- In «Loans given», an «Open links» group: resource, limits, expiry, Cancel.
- Route `/grants/offer` (under `_chat`, with WS):
  - it shows the summary, «<lender> sees how much each person uses it, never prompts or Threads», the ToS warning for subscriptions, and the Space select (an «already lent here» Space is disabled);
  - Apply then goes to the Space's loans;
  - signed out, the token waits in sessionStorage through sign-in (two small hooks: `_chat` beforeLoad and the sign-in redirect).
- «Waiting for you» already shows the ToS warning (01): it gets a test only.

## Tests (red first)

- `147_*.test.ts`.
- `AccessPolicy.test.ts` `grant.offer`: User owner ✓; Organization Admin ✓; Member, Guest, Owner-not-Admin, another Space's Admin ✗; archived/frozen Organization ✗.
- `GrantOffers.test.ts` (Grants service, real SQLite):
  - used, expired (`TestClock` +7d), cancelled and unknown links all fail, and read answers `invalid`;
  - claim into the target Organization: Admin ✓; Member, Guest, Owner-not-Admin ✗; a Space the claimer is not in ✗; the lender's own Space ✗;
  - a second Grant to the same destination → `already-granted`, and the link still works elsewhere;
  - two concurrent claims → one wins;
  - a direct account → `not-lendable`;
  - the creator demoted, or the account deleted or re-owned → invalid;
  - no session → `not-allowed` and nothing read;
  - the throttle locks after 5;
  - the audit `grant.offer` and `grant.accept via link` carry no token or hash;
  - Cancel by another Admin of the lending Organization ✓, by the claimer ✗.
- `ws`/`DoorRules`/`RpcAuthorization` rows.
- A gateway scenario (`AiGatewayRoute.grants` style, fake CLIProxyAPI): Ana links her subscription, Bob claims into his Personal space, Bob's request uses Ana's account with `grantId`, and after Ana revokes the next request is refused.
- Web: link-page logic test (`grantText`/view model) and the dialog link step.
- The real browser proof (two browsers) is **not run**: the rules say no dev servers. I'll report it unverified.

## Open questions (recommended default first)

1. **Scope: AI accounts only.** A machine link would make an active machine Grant on claim, which needs the claimer's strong factor (HTTP door, as `accept`) and `openLentSandbox`. Vault groups are not lendable until 07. Recommend AI accounts now, with `environment` → `not-lendable` "machines are lent by link later", and a follow-up for machines. Alternative: add HTTP `/api/grants/claim-offer` with `prepareClaim`.
2. **URL form:** `/grants/offer#token=…` (fragment, as `/invite#token=`) instead of the ticket's `/grants/offer/<token>`, to keep the token out of proxy logs and the Referer.
3. **Read reveals one status, `invalid`, for used/expired/cancelled/unknown** (the ticket's red test "reveals nothing"; Invitations precedent). The lender's list says which.
4. **No cap on open links per resource:** each is one-use, expires and is visible and cancellable. Alternative: at most 10 open per resource.
5. **Limits on an open link are fixed:** to change them, cancel and create again. `setLimits` stays pending/active only.
6. **The creator must still be able to lend when the link is claimed** (stricter than the spec's silence). Recommended: a demoted Admin's links die.

**Decided:** 1 AI accounts only (machines: follow-up in the ticket); 2 fragment; 3 one `invalid`, the reason in the lender's list; 4 **at most 10 open links per resource** (`too-many-offers`); 5 fixed limits; 6 yes. Found while building: the web app took any `#token=` outside `/reset` and `/invite` as a pairing credential at start-up, so `/grants/offer` joins that list (else the loan token would go to the pairing endpoint).
