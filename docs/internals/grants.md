# Grants

A **Grant** lends one resource to a Space, with limits, until either side ends it. Today a User's
personal machine and an AI account (a User's or an Organization's, for the AI gateway) are lent;
Vault groups and a Plan as destination fit the same row later. Spec: `.scratch/grants/spec.md`;
machines: `.scratch/grants/issues/machines-design.md`; AI accounts:
`.scratch/grants/issues/01-04-design.md`.

## The row

`grants` (migration 135): the resource (`resource_kind`, `resource_id`), its lender (the owner when
it was lent), the destination (`target_kind`, `target_id`), `state`, `end_reason` and
`limits_json` (`GrantLimits` in `packages/contracts/src/grants.ts`; a machine's are CPUs, memory,
processes and threads, and disk, each required and at least the Sandbox floors; an AI account's are
its caps, tokens and requests per day, ISO week or month, each `null` for no cap). A partial unique
index keeps at most one `pending` or `active` Grant per resource and destination. Ended rows stay:
they are the history.

## Transitions

[Grants](../../apps/server/src/grants/Grants.ts) changes a row only along `TRANSITIONS`:

| Change          | From                 | To                                                               | Who (AccessPolicy)              |
| --------------- | -------------------- | ---------------------------------------------------------------- | ------------------------------- |
| give            | (new)                | `pending`, or `active` when the lender also decides there        | `grant.give`                    |
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

- The lender's side (`give`, `cancel`, `revoke`, `setLimits`, `viewGiven`) is the resource's owner
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

## Doors

- WS: `grants.listGiven`, `grants.listReceived`, `grants.targets`, `grants.reject`,
  `grants.cancel`, `grants.end`, `grants.setLimits` (writes need `access:write`); the Owner's
  `grants.migrationReviews` and `grants.dismissMigrationReview` (allowances that became loans,
  docs/internals/ai-gateway.md).
- HTTP: `POST /api/grants/give` and `POST /api/grants/accept`. When a machine's Grant would become
  active (accepting it, or giving it where the lender also decides) the request must carry a
  strong factor (`reauth`: passkey, or password and authenticator code), checked only after Grants
  allowed the change (`prepareGive`/`prepareAccept`) and required again by the change itself, so
  the WS side can never make one active.
- No MCP tool: lending is a person's decision of trust.

## Clients

Web, Settings → AI accounts: **Lend…** on each non-direct account the User manages
(`LendAiAccountDialog`; a subscription shows the provider-terms warning). Settings → Environments:
**Lend…** on the User's own personal machines
(`LendMachineDialog`: the Space from `grants.targets`, the limits, what the machine said of itself
and the lender's risks; the strong factor when the loan starts active) and the **Loans** section
(`GrantsSettings`: waiting loans to accept with a strong factor or reject, borrowed machines to give
back, lent ones to take back or cancel, with the Sandbox's state and disk). A lent machine shows in
the Space's lists as «Lent to <Space> by <lender>, who sees everything that runs on it»
(`environmentUseDescription`). Mobile and the command palette come later (Grants ticket 12).
