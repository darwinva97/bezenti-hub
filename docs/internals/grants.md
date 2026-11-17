# Grants

A **Grant** lends one resource to a Space, with limits, until either side ends it. Today only a
User's personal machine is lent (to an Organization or someone's Personal space); AI accounts,
Vault groups and a Plan as destination fit the same row later. Spec: `.scratch/grants/spec.md`;
machines: `.scratch/grants/issues/machines-design.md`.

## The row

`grants` (migration 135): the resource (`resource_kind`, `resource_id`), its lender (the owner when
it was lent), the destination (`target_kind`, `target_id`), `state`, `end_reason` and
`limits_json` (`GrantLimits` in `packages/contracts/src/grants.ts`; a machine's are CPUs, memory,
processes and threads, and disk, each required and at least the Sandbox floors). A partial unique
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

## Who

`decideGrant` in [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts):

- The lender's side (`give`, `cancel`, `revoke`, `setLimits`, `viewGiven`) is the resource's owner
  only. The Owner has no bypass: they lend their own machines and nobody else's.
- A destination must be one the lender can name without a directory of Spaces: an Organization
  they are in, or the Personal space of an active User they share a Space with; the Owner may name
  any (they see every User anyway). Not their own Personal space (their machine already serves
  them there), nothing archived or frozen.
- The destination's side (`decide`, `return`) is an Organization's Admins or a Personal space's
  User. `return` works in an archived Space too. Active Grants are seen by whoever works there (not
  Guests); waiting ones only by whoever decides.
- A Grant someone sees from neither side answers like a missing one.

## Doors

- WS: `grants.listGiven`, `grants.listReceived`, `grants.targets`, `grants.reject`,
  `grants.cancel`, `grants.end`, `grants.setLimits` (writes need `access:write`).
- HTTP: `POST /api/grants/give` and `POST /api/grants/accept`. When a machine's Grant would become
  active (accepting it, or giving it where the lender also decides) the request must carry a
  strong factor (`reauth`: passkey, or password and authenticator code), checked only after Grants
  allowed the change (`prepareGive`/`prepareAccept`) and required again by the change itself, so
  the WS side can never make one active.
- No MCP tool: lending is a person's decision of trust.
