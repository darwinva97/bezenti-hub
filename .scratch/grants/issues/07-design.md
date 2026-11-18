# Design: lending a Vault group (Grants 07)

Branch `feat/grants07` (base `public-hub-1` b3bf1f08ab). Extends Grants (`Grants.ts`, `decideGrant`) to `resource_kind = 'vault-group'`. Migration **149** (after 147 and 148 of grants 05 and 06). Approved with decisions 1–6 below.

## Flows

- **Give:** «Lend…» on a group's row → `grants.targets` → HTTP `POST /api/grants/give` with `{ kind: "vault-group", vaultGroupId }`. Warning: «Agents of <Space> (Guests' Threads included) can read this group's Secrets: they receive them as environment variables.» Lender = the group's owner (a User, or an Organization's Admins). `default` and archived groups → `not-lendable`.
- **Accept:** target's Admins / Personal space's User; starts active when the lender also decides there. Accepting does not deliver anything by itself; the dialog offers «Also use it as a Space default» (on by default, `useAsDefault`, appended last, audited `vault.choose` `via: grant.accept`).
- **Edit:** the lender edits the group as usual; the next turn, terminal or script sees it (`forThread` per call).
- **End:** «Revoke» (lender) / «Return» (target) via `Grants.end`; in the same transaction `VaultReachLoss.forgetLentReach` drops that Space's default and its Projects' choices of the group, each audited `vault.choose` `via: grant.end`. Also from `GrantEnding.endGone`. `clearForGrant` when a loan becomes active.

## Read rule and delivery (same path as own Vaults)

- `VaultReach.reachesSpaceSql`: own Space, or a named group with an `active` Grant to that Space. Feeds `allowedToSpace`, `dropChoicesNotReaching`, `stillReaching`, `choices`, `mayReceiveSecrets`. Pending, rejected, cancelled, ended give nothing.
- Order: own groups first, then lent ones by `decided_at`. `ReachRow` / `EffectiveVariable` carry `grantId`.
- EffectiveVaults → SecretDelivery.plan/resolve → `secretEnv` → SecretMasker remembers (`thread_secret_values`). No new value path.
- The User side (`allowedToUser`) is gone: it only read `vault_allowances`. `VaultSource "user"` is kept in the contract, never sent.

## What the borrower sees (AccessPolicy)

`VaultResource.lentTo` replaces `allowedSpaces`/`allowedUsers`; `decideLentVault` is tried when the owner side denies: whoever works in an open Space it is lent to → `vault.view`; Admins/Members (Personal space's User) → `vault.readVariables`; Guests names only; never edit/manage/dangerousName/providerEntry/identityEntry. `vaults.list` adds `borrowed`. A session limited to a Space reads groups lent to it (`SpaceDirectory.withinLimit`). **Narrowing (accepted):** Acme's Admins no longer edit an Owner group allowed to Acme alone.

## Dangerous names and lent machines

- `dangerous` names of a lent group are withheld before precedence (the Space's own entry still wins), whoever set them, the Owner included; `withheld[{ name, vaultId, vaultName, reason: "lent-dangerous" }]` in `vaults.threadEnvironment`; the panel says «not delivered: from a loan».
- On a lent machine (Sandbox `mode = 'lent'`) lent entries are withheld unless the group is that machine's owner's own (`lent-machine`) — decision 2.

## Revocation and running Threads

Next process gets nothing; live processes keep the ticket 04 rule (provider session reopened at next turn by fingerprint, running shell flagged `secretsStale`). History stays masked (`ThreadSecretValues`). The lender sees `Grant.vaultGroup.toRotate` (Secrets not added or replaced since the end, by audit order) with «Replace»; on «Return» the borrower is told the lender will be asked to rotate.

## Limits, strong factor, audit

- `VaultGroupGrantLimits { kind: "vault-group" }`; `setLimits` refused.
- Strong factor on every vault-group give, never on accept — decision 1.
- Audit: `grant.*` with `resourceKind: "vault-group"`; `vault.choose` with `via` (`grant.accept`, `grant.give`, `grant.end`, `migration`). Never values.
- Usage counter («which Space used what»): out of 07, ticket 15 — decision 3.

## Leak tests and the `request_secret`/handoff gap

07 adds no value path but widens exposure (a non-Owner's Secrets reach other people's Threads). In 07: `saveTargets` excludes lent groups; `VaultDoors.test.ts` sweeps a group of Ana's lent to Acme across the cast and after the loan ends; `SecretDelivery.test.ts` checks a lent Secret is delivered, its dangerous name not, and it stays masked after revocation (the handoff masks with the same Thread masker).

## Migration 149 `VaultAllowancesToGrants`

Allowance on a `default` or on a group not the Owner's → dropped; to the Owner's Personal space → nothing; to a live Space → active Owner Grant; to a live User → Grant to their Personal space (none for the Owner), plus a chosen default there, plus review rows (`vault_group_grant_reviews`) for each Organization they work in without a Grant of that group. Deduplicated per (group, Space). Audited `grant.give via: migration`; `DROP TABLE vault_allowances`. Proof: frozen pre-149 effective sets (golden) vs post-149 `EffectiveVaults`, identical except the review triples plus two listed cases (a Project's `remove` now holds; the Owner in another User's Personal space) and listed winner changes where the old winner was the User side.

## Decisions

1. Strong factor on every vault-group give: yes. 2. Withhold on lent machines: yes (`lent-machine`). 3. Usage counter: ticket 15. 4. Guests' Threads receive lent defaults like own ones; the warning says so. 5. Accept doesn't auto-add; the dialog offers it (on). 6. `resource-gone` stays in ticket 11.
