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

### Loans that end by themselves

A side that is gone ends its loans in the removal's own transaction (Grants ticket 11; design
`.scratch/grants/issues/11-design.md`), through one path,
[GrantEnding](../../apps/server/src/grants/GrantEnding.ts), whatever the resource's kind:

| What goes                                                 | Reason                        | `via`                 |
| --------------------------------------------------------- | ----------------------------- | --------------------- |
| An AI account deleted                                     | `resource-gone`               | `ai_account.delete`   |
| A Vault group deleted                                     | `resource-gone`               | `vault_group.delete`  |
| A machine removed (or revoked with its User)              | `resource-gone`               | `environment.remove`  |
| An Organization deleted: loans to it / it gave            | `target-gone` / `lender-gone` | `organization.delete` |
| A User removed: loans to their Personal space / they gave | `target-gone` / `lender-gone` | `user.remove`         |

`pending` and `active` loans end, an open `offered` one is cancelled, each audited (`grant.end`
with `reason` and the `system` side, or `grant.cancel`) with `via`. It does what «Take back» does
for the kind: a Vault group's default and choices in the borrowing Space go, audited `vault.choose`
`via: grant.end`; a machine's Sandbox is closed in the same commit (its credential stops there) and
its socket after it; an AI account's next gateway request is refused (deleting one also signals
`AiAccountChanges`). The removals end loans _before_ deleting what the owner had, so the borrower's
lent defaults go audited and each loan keeps its names.

`owner-changed` exists for a resource that stays but is no longer its lender's. Nothing moves an AI
account or a Vault group to another owner, and a lent machine's mode change is refused
(`machine-lent`); a machine dedicated to an Organization while it only had open lending links
cancels them (`via: environment.mode.change`).

Names: `grants.resource_name`, `lender_name` and `target_name` (migration 162) are written from the
live rows on every change of a loan's state; the lists read the live name first, then the kept one,
so an ended loan of a deleted group, a purged AI account or a deleted Organization is still named.
A loan whose Space is gone is decided on its lender's side only (as a link with no destination), so
its lender still sees it. `grants.listReceived` lists `ended` loans too, to whoever sees active
ones there. Migration 162 also ended the live loans of resources earlier Hubs deleted without ending
them, and cancelled their links.

Leaving the destination Organization ends nothing: the lender still takes it back, the Space still
gives it back.

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
**lending link** (Grants ticket 06; design `.scratch/grants/issues/06-design.md`). AI accounts and,
since Grants ticket 15, machines; never a Vault group (its lender's strong factor is asked at giving,
which a link skips).

- A machine's link is made by its owner without a strong factor (as giving it pending), with the
  same rules as giving it (a personal machine, its limits, `host-not-ready` when it said it cannot
  run a Sandbox). Applying it makes the loan active, so it goes the way accepting one does: over
  HTTP, `POST /api/grants/claim-offer` runs `Grants.prepareClaim` (every check but the move), then
  the decider's strong factor (`confirmStrongFactor`), then `claimOffer`, which checks it all again
  and opens the Sandbox (`openLentSandbox`) in the same transaction as the move, through the code
  accepting uses (`requireDecidersFactor`, `madeActive`): a Sandbox that cannot be opened leaves the
  link `offered`. The WS `grants.claimOffer` carries no factor, so it refuses a machine's link
  (`strong-factor-required`); AI accounts' links still apply there. A machine's link dies with the
  machine (revoked, no longer personal, another owner) and with its owner's right to lend it.

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

**Use** (Grants ticket 15): each time `SecretDelivery.resolve` reads a set for a process that starts
(a turn's provider session, a terminal, a setup script), every name it delivers from a lent group
adds one to `vault_grant_usage` (migration 150: Grant, UTC day, the User whose set it is, name).
A name withheld or left out is not counted; names and counts only, never a value nor a Thread. A
count that cannot be written is logged and the process starts anyway. `grants.vaultUsage({ grantId
})` answers a Vault group's loan's rows, newest first (1000 at most, `truncated` past that), to its
lender (`grant.viewGiven`) and to whoever runs the borrowing Space (`grant.return`: its Admins, a
Personal space's User), also once it ended; anyone else is answered as for a missing loan. The rows
are kept as history, like the Grant; a removed User's rows stay, as their AI usage does.

## Doors

- WS: `grants.listGiven`, `grants.listReceived`, `grants.targets`, `grants.reject`,
  `grants.cancel`, `grants.end`, `grants.setLimits` (writes need `access:write`); the Owner's
  `grants.migrationReviews` and `grants.dismissMigrationReview` (allowances that became loans:
  AI accounts in docs/internals/ai-gateway.md, Vault groups in docs/internals/secrets.md); lending
  links' `grants.createOffer` and `grants.claimOffer` (`access:write`) and `grants.readOffer`
  (`access:read`); a lent Vault group's `grants.vaultUsage` (`access:read`).
- HTTP: `POST /api/grants/give`, `POST /api/grants/accept` and `POST /api/grants/claim-offer`. When
  a machine's Grant would become active (accepting it, applying its link, or giving it where the
  lender also decides), or a Vault group is given, the
  request must carry a strong factor (`reauth`: passkey, or password and authenticator code), checked only after Grants
  allowed the change (`prepareGive`/`prepareAccept`/`prepareClaim`) and required again by the change itself, so
  the WS side can never make one active.
- No MCP tool: lending is a person's decision of trust.

## Clients

Web, Settings → AI accounts: **Lend…** on each non-direct account the User manages
(`LendAiAccountDialog`; a subscription shows the provider-terms warning; «Someone else's Space: make
a link» makes a lending link and shows it once). `/grants/offer` (`GrantOfferSurface`) shows a
link's loan, what the lender sees and a subscription's terms, and applies it to a Space the User
picks; a machine's link says what its lender sees and asks the strong factor (an account without a
passkey or authenticator app is sent to Settings → Account). Settings → Environments:
**Lend…** on the User's own personal machines
(`LendMachineDialog`: the Space from `grants.targets`, the limits, what the machine said of itself
and the lender's risks; the strong factor when the loan starts active; «Someone else's Space: make a
link» makes a lending link and shows it once) and the **Loans** section
(`GrantsSettings`: waiting loans to accept with a strong factor or reject, borrowed machines to give
back, lent ones to take back or cancel, with the Sandbox's state and disk; ended ones on both
sides with their day and reason, the borrowing Spaces' under «Ended loans to your Spaces»). A lent
machine shows in
the Space's lists as «Lent to <Space> by <lender>, who sees everything that runs on it»
(`environmentUseDescription`). Vault groups (Grants ticket 07): **Lend…** on each named group the
User manages (`LendVaultGroupDialog`: the warning that the Space's agents, Guests' Threads
included, read its Secrets, and always the strong factor); a waiting group is accepted with
«Also use it as a Space default» (on); a borrowed group is listed read-only in the borrowing
Space's Vault («Lent to this Space») and in its pickers as «Lent by <lender>»; taking one back,
and an ended one, list the Secrets to rotate with **Replace…**. A group's loan's use (ticket 15,
`VaultLoanUsage`: day, User, name, processes) opens from **View use** among the loans lent and
from **Use** on a borrowed one for whoever runs the Space. The Owner's review of migrated
Vault allowances sits in Settings → Vault (`MigratedVaultLoansReview`). The Thread's «Secrets»
panel says which lent names are never delivered, on web and mobile.

Every client words and sorts a loan through `@t3tools/client-runtime/grants-view` (Grants ticket
12; design `.scratch/grants/issues/12-design.md`): limits, states and ended reasons, the warnings,
the lists' sections, the directory's counts and a pasted link's token. Nothing of it is copied into
an app.

- **Waiting loans:** `SpaceSummary.pendingGrants` counts a Space's `pending` loans, only for whoever
  holds `grant.decide` there (absent otherwise). It refreshes with the Space directory: opening the
  selector, a fresh shell snapshot, and after the client decides a loan; no push of its own. Web and
  desktop show it beside each Space in the selector, on its trigger and as «Loans waiting for you»;
  mobile in its Space menu.
- **Palette** (web, desktop): «Lend a resource...» (AI account, Vault group or machine: the Settings
  page whose rows carry **Lend…**), «Loans waiting for you» and «Loans you gave» (Settings → Machines,
  `#grants`). No default shortcut.
- **Desktop:** a lending link is made on the Hub's public URL, else the address the app reaches the
  Hub on (`readHubLinkOrigin`), never the app's own origin. `t3code://grants/offer#token=…`, and a
  link on the Hub's address, open the app's `/grants/offer` (`promptLinkAppPath`, token in the
  fragment only).
- **Mobile** (`apps/mobile/src/features/grants/`): Settings → Loans lists waiting, borrowed, ended
  and lent loans with the same warnings: accept (over HTTP, as web), reject, give back, take back,
  cancel and use. A machine's loan or link needs the strong factor, which mobile does not ask: it
  says to accept or apply it on web or desktop. «Apply a lending link» takes a pasted link, kept in
  memory only. The AI account strip names a lent account «<name> · from <lender>» with its cap use
  (`aiAccountPickerLabel`); the User's machines show a lent one's warning
  (`environmentUseDescription`). Giving a loan with limits stays on web and desktop.
