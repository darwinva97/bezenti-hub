# Grants

A **Grant** lends one resource to a Space, with limits, until either side ends it. Today a User's
personal machine, an AI account (a User's or an Organization's, for the AI gateway) and a named
Vault group (a User's or an Organization's) are lent; a Plan as destination fits the same row
later. Spec: `.scratch/grants/spec.md`; machines: `.scratch/grants/issues/machines-design.md`; AI
accounts: `.scratch/grants/issues/01-04-design.md`; Vault groups:
`.scratch/grants/issues/07-design.md`.

## The row

`grants` (migration 135, rebuilt by 148): the resource (`resource_kind`, `resource_id`), its lender (the owner when
it was lent), the destination (`target_kind`, `target_id`), `state`, `end_reason` and
`limits_json` (`GrantLimits` in `packages/contracts/src/grants.ts`; a machine's are CPUs, memory,
processes and threads, and disk, each required and at least the Sandbox floors; an AI account's are
its caps, tokens and requests per day, ISO week or month, each `null` for no cap; a Vault
group's are none, `{ "kind": "vault-group" }`). A partial unique
index keeps at most one `pending` or `active` Grant per resource and destination. Ended rows stay:
they are the history.

## Transitions

[Grants](../../apps/server/src/grants/Grants.ts) changes a row only along `TRANSITIONS`:

| Change          | From                 | To                                                               | Who (AccessPolicy)              |
| --------------- | -------------------- | ---------------------------------------------------------------- | ------------------------------- |
| give            | (new)                | `pending`, or `active` when the lender also decides there        | `grant.give`                    |
| createOffer     | (new)                | `offered`, no destination (a lending link)                       | `grant.offer`                   |
| claimOffer      | `offered`, unexpired | `active` in the Space it is applied to                           | `grant.decide` there            |
| accept / reject | `pending`            | `active` / `rejected`                                            | `grant.decide`                  |
| cancel          | `offered`, `pending` | `cancelled`                                                      | `grant.cancel`                  |
| end             | `active`             | `ended` (`revoked` by the lender, `returned` by the destination) | `grant.revoke` / `grant.return` |
| setLimits       | `pending`, `active`  | (same)                                                           | `grant.setLimits`               |

Anything else is `illegal-transition`. Each change re-reads the row in its transaction, moves it
only from the state it read (a concurrent change loses with «changed meanwhile») and is audited
there (`grant.give`, `grant.accept`, `grant.reject`, `grant.cancel`, `grant.end` with `reason` and
`side`, `grant.limits.change`), never with a credential.

A side that is gone ends its loans in the removal's own transaction
([GrantEnding](../../apps/server/src/grants/GrantEnding.ts), whatever the resource's kind): a
deleted Organization ends every live loan to it with `target-gone` and every one it gave with
`lender-gone`. `pending` and `active` loans end, an `offered` one is cancelled, each audited by the
`system` side with `via` (`organization.delete`). A machine's Sandbox for an ended loan is closed in
the same commit (its credential stops there) and its socket after it. Removing the machine itself
ends its loans with `resource-gone`.

A loan to an archived (or frozen) Organization, or to the Personal space of a turned-off User,
stays `active` and unused: its Sandbox runs no turn and takes no Thread (`spaceRefusalOf` answers
`space-closed`, the same guard every session opened on it passes), and serves again once restored.

## Who

`decideGrant` in [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts):

- The lender's side (`give`, `offer`, `cancel`, `revoke`, `setLimits`, `viewGiven`) is the resource's owner
  only: a User, or an Organization's Admins (`GrantResource.lender`). The Owner has no bypass: they
  lend their own resources and nobody else's. An archived or frozen Organization gives nothing new
  but its Admins still take back what it lent; a gone one lends nothing.
- A destination must be one the lender can name without a directory of Spaces: an Organization
  they are in, or the Personal space of an active User they share a Space with; the Owner may name
  any (they see every User anyway). Not the owner's own Space (what they own already serves them
  there: a User's Personal space, an Organization itself), nothing archived or frozen.
- The destination's side (`decide`, `return`) is an Organization's Admins or a Personal space's
  User. `return` works in an archived Space too. Active Grants are seen by whoever works there (not
  Guests); waiting ones only by whoever decides.
- A Grant someone sees from neither side answers like a missing one.

## AI accounts

Only an `api-key` or `subscription` account is lent (`direct` → `not-lendable`: its credential
would go to the agent and its use is not counted). `AllowedAiAccounts` reads, on every call, the
Space owner's own accounts, then the accounts an `active` Grant lends to that Space (oldest
decision first, then the lender's priority), each with `via` (`own`, or `grant` with its id, the
lender's name and caps); own wins over lent. A Grant lends nothing while its lender is disabled or
removed, while the lending Organization is archived, frozen or gone, or once the account changed
owner. Ending a Grant thus refuses the gateway's next request: a Thread still naming the account is
told «Switch AI account», as when any account stops being usable there (nothing is rewritten). The
picker names a lent account «<name> · from <lender>». Accepting one needs no strong factor.

## Lending links

To lend to a Space the lender cannot name (no directory of Spaces exists), the lender makes a
**lending link** (Grants ticket 06; design `.scratch/grants/issues/06-design.md`). Only AI accounts
for now: a machine's loan made active needs its decider's strong factor, which a link does not ask
for yet.

- `grants.createOffer` (`grant.offer`: the lender's side only, no destination) writes an `offered`
  row with no destination, the loan's limits, `offer_expires_at` seven days on and
  `offer_token_hash`, the SHA-256 of 32 random bytes. The token is answered once, as
  `/grants/offer#token=<token>` (on `T3CODE_PUBLIC_URL` when set, else the client's origin): the
  fragment never reaches a server, a log or a Referer. At most ten open links per resource
  (`too-many-offers`). Audited `grant.offer`, never with the token or its hash.
- `grants.readOffer` needs a signed-in User. A used, cancelled, expired or unknown link, one whose
  account was deleted or changed owner, or one whose maker can no longer `grant.offer` it (an Admin
  who lost the role, a User turned off) is just `invalid`. Otherwise: what is lent, by whom, with
  which limits, and the reader's Spaces where they hold `grant.decide` (never the lender's own),
  each flagged `alreadyGranted`. No ids, no credential, no usage.
- `grants.claimOffer` re-checks all that in one transaction, then the destination's rule
  (`grant.decide`, not archived or frozen, not the lender's own Space) and `already-granted`, and
  moves the row to `active` in that Space only while it is still `offered` and unexpired: of two
  people applying it at once, one gets it. A refusal leaves the link usable elsewhere. Audited
  `grant.accept` with `via: link`. From there it is an ordinary loan.
- Guessing: an unknown token counts against the User, applying a dead link against that link
  (`signInThrottle`: five free, then 30 s doubling to 15 min, `throttled`). Reading a dead link
  counts against nobody.
- The lender sees each link in their given loans (`Grant.offer`: `open`, `expired`, `used`,
  `cancelled`) and cancels an open one (`grants.cancel`). A link with no destination is decided on
  the lender's side only. Migration 148 lets a link with no destination be `cancelled` (135 allowed
  a missing destination only while `offered`); a removed lender's links are cancelled too.
- The web app leaves `/grants/offer`'s `#token=` alone at start-up (it is not a pairing
  credential), keeps it in the tab's sessionStorage through signing in, and drops it from the
  address bar.

## Vault groups

Only a named group, not archived, is lent (`default` or archived → `not-lendable`): a `default` is
its owner's Space's fixed default. Giving one always needs a strong factor, pending or active (its
Secrets reach the borrower's agents); accepting needs none, and may also make it the Space's last
default (`useAsDefault`, audited `vault.choose` `via: grant.accept`; the same on a give that starts
active). `VaultReach` reads, on every call, the Space's own groups and the named groups an `active`
Grant lends there; a lent group is read-only there (names; Variables for Admins and Members), its
dangerous names never delivered, and nothing of it reaches a machine lent to the Space unless it is
that machine's owner's own. Ending a loan drops that Space's default and its Projects' choices of
the group in the same transaction (`VaultReachLoss.forgetLentReach`), and tells the lender which
Secrets to rotate (`Grant.vaultGroup.toRotate`, to `grant.viewGiven` alone). `setLimits` is refused
(there are none). Details: docs/internals/secrets.md, «Who reaches what».

## Doors

- WS: `grants.listGiven`, `grants.listReceived`, `grants.targets`, `grants.reject`,
  `grants.cancel`, `grants.end`, `grants.setLimits` (writes need `access:write`); the Owner's
  `grants.migrationReviews` and `grants.dismissMigrationReview` (allowances that became loans:
  AI accounts in docs/internals/ai-gateway.md, Vault groups in docs/internals/secrets.md); lending
  links' `grants.createOffer` and `grants.claimOffer` (`access:write`) and `grants.readOffer`
  (`access:read`).
- HTTP: `POST /api/grants/give` and `POST /api/grants/accept`. When a machine's Grant would become
  active (accepting it, or giving it where the lender also decides), or a Vault group is given, the
  request must carry a strong factor (`reauth`: passkey, or password and authenticator code), checked only after Grants
  allowed the change (`prepareGive`/`prepareAccept`) and required again by the change itself, so
  the WS side can never make one active.
- No MCP tool: lending is a person's decision of trust.

## Clients

Web, Settings → AI accounts: **Lend…** on each non-direct account the User manages
(`LendAiAccountDialog`; a subscription shows the provider-terms warning; «Someone else's Space: make
a link» makes a lending link and shows it once). `/grants/offer` (`GrantOfferSurface`) shows a
link's loan, what the lender sees and a subscription's terms, and applies it to a Space the User
picks. Settings → Environments:
**Lend…** on the User's own personal machines
(`LendMachineDialog`: the Space from `grants.targets`, the limits, what the machine said of itself
and the lender's risks; the strong factor when the loan starts active) and the **Loans** section
(`GrantsSettings`: waiting loans to accept with a strong factor or reject, borrowed machines to give
back, lent ones to take back or cancel, with the Sandbox's state and disk). A lent machine shows in
the Space's lists as «Lent to <Space> by <lender>, who sees everything that runs on it»
(`environmentUseDescription`). Vault groups (Grants ticket 07): **Lend…** on each named group the
User manages (`LendVaultGroupDialog`: the warning that the Space's agents, Guests' Threads
included, read its Secrets, and always the strong factor); a waiting group is accepted with
«Also use it as a Space default» (on); a borrowed group is listed read-only in the borrowing
Space's Vault («Lent to this Space») and in its pickers as «Lent by <lender>»; taking one back,
and an ended one, list the Secrets to rotate with **Replace…**. The Owner's review of migrated
Vault allowances sits in Settings → Vault (`MigratedVaultLoansReview`). Mobile and the command
palette come later (Grants ticket 12); the Thread's «Secrets» panel already says which lent names
are never delivered, on both.
