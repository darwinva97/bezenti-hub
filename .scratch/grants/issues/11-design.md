# Design: loans that end by themselves (Grants 11)

Branch `feat/grants-11-13` (base `public-hub-1` 2d1c73d379). Migration **162**.

## What already ends, what does not

Already in place (owned-resources 10, Grants 10): a deleted Organization ends loans to it
(`target-gone`) and loans it gave (`lender-gone`); a removed User likewise (their Personal space,
their loans); a removed machine ends its loans (`resource-gone`, hand-written in
`EnvironmentRegistry.endGrantsOf`). All in the removal's transaction, through
`GrantEnding.endGone` except the machine.

Holes:

1. **AI account deleted** (`AiAccounts.remove`): its loans stay `active`. They lend nothing (the
   read rule skips deleted accounts), but both sides see a live loan of a missing account.
2. **Vault group deleted** (`Vaults.remove`): same; and the borrower's default/choices of it go
   silently (`forgetVault`) instead of audited as at «Return».
3. **Machine removed**: its open lending links stay `offered` (dead only at read); its `grant.end`
   audit has no `via`.
4. **Names**: an ended loan of a deleted group, a purged AI account or a deleted Organization shows
   no resource, lender or Space name (rows gone).
5. **Lists**: «Lent to this Space» lists only `pending`/`active`; a lender never sees a loan whose
   Space was deleted (the policy cannot read a missing Space, so the row is hidden).
6. Removing a User or deleting an Organization deletes its Vault groups _before_ ending their
   loans: the borrower's lent defaults vanish unaudited and the ended loan has no name.

## Decisions

- `GrantEnding.endGone` gains a third side, `{ resource: { kind, id } }`, ending with
  `resource-gone`, `via` `ai_account.delete`, `vault_group.delete` or `environment.remove`. It is the
  one path for every system end: `pending`/`active` → `ended` (a Vault group's lent default and
  choices dropped and audited by `forgetLentReach`, as «Return»), `offered` → `cancelled`; the caller
  closes machine Sandboxes (`closeLentSandbox`, then `lentSandboxClosed`) and signals
  `AiAccountChanges` as «Retirar» does (`AiAccounts.remove` already signals).
- Called inside `AiAccounts.remove`'s transaction, inside `Vaults.remove`'s before `forgetVault`, and
  in place of the hand-written `endGrantsOf` UPDATE.
- **Owner change** (`owner-changed`): nothing changes a resource's owner today. AI accounts and
  Vault groups never move; a lent machine's mode change is refused (`machine-lent`, Grants 10).
  Conservative: keep the refusal; a mode change of a machine with only open links cancels them
  (`via: environment.mode.change`), since a link of a machine its maker no longer owns is dead.
  The reason stays in the contract for a future transfer.
- **Names survive** (migration 162): `grants.resource_name`, `lender_name`, `target_name`, written
  from the live rows on every change of state (Grants' `move`, `GrantEnding`); lists read the live
  name first, then the stored one. A destination that is gone is shown from `target_id` and
  `target_name` (kind from the `personal:` prefix). Backfilled for every row; the migration also
  ends live loans whose resource is already gone (deleted account or group, revoked machine) and
  cancels their open links, like 144.
- **Order in removals**: User removal and Organization deletion end loans before deleting the
  owner's Vault groups.
- **Lists**: `listReceived` adds `ended` loans to whoever sees active ones there (`grant.viewReceived`,
  not Guests). `listGiven`/lender actions: a loan whose destination Space is gone is decided on the
  lender's side only (as a link with none), so its lender still sees it.
- **Not ended**: archiving or freezing the destination (stays `active`, unused, used again once
  restored); the lender leaving the destination Organization.
- Web «Loans»: ended loans show their reason and date on both sides («Ended loans» under the
  borrowed ones).

## Tests (red first)

`environments/HubWithEnvironments.grantEnding.test.ts` (Hub with the gateway): each case leaves no
reach (`AllowedAiAccounts`, `EffectiveVaults`, the lent Sandbox's credential) and audits `grant.end`
with its reason; names survive in both lists; the lender leaving Acme and Acme archived keep the
loan. `GrantEnding` via the machine's open link. Migration 162 with the 144 pattern.
