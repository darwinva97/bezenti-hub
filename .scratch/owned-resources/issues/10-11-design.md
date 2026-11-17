# Design: tickets 10–11 (removals, Space moves, door inventory)

Branch `feat/owned-close` (base `public-hub-1`, 8c6cdd8fef). 01–09 and Grants machine lending are built. AI-account lending is being built in parallel (grants 01–04). Here I only make Grant ending kind-agnostic, so their loans end through the same path.

## 10: what happens to owned resources

**The rule.** Removing a User or deleting an Organization deletes what it owns, except machines. Every loan it gave ends with `lender-gone`, and every loan to its Space ends with `target-gone`. Disabling a User or archiving an Organization deletes nothing: its resources stay unused while it is off. Everything runs in the existing transaction, with audit `detail.via = "user.remove" | "organization.delete"`. Work outside the database happens after the commit.

| Case                                                      | Personal/org vault                                                                                                                                                                                                                                                            | AI accounts                                                                                                                                                                                                                                                                                                                                                                                                 | Machines                                                                                                                                                   | Grants given / received                                                                                                                                                                                       | Running turns                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **User removed** (`InstallationUserService`, `removed`)   | **New**: every `owner_kind='user'` group of theirs is deleted through `VaultReachLoss.forgetVault`, `default` included, audited `vault_group.delete`. Their values are removed after the commit (`removeValues`). Allowances, defaults and choices already go (`forgetUser`). | **New**: their accounts are retired in the transaction, with the same SQL as `AiAccounts.remove`: `deleted_at`, `status='removing'`, the credential moved to `ai_account_retired_credentials`, allowances and migrated keys dropped, audit `ai_account.delete`. After the commit, `AiAccounts.syncNow` takes them out of CLIProxyAPI and `AiAccountChanges.changed` runs. Gateway keys are already revoked. | Personal machines: revoked as today (`revokeOwnedBy`), but their loans now end `lender-gone` instead of `resource-gone`. Dedicated machines aren't theirs. | Given: all `pending`/`active` → `ended lender-gone`, and `offered` → `cancelled`, whatever the kind. Received (target `personal:U`): → `target-gone`, and lent Sandboxes close.                               | Already handled: `reconcileTerminals` + `reconcileAiSessions`, plus `AiAccountChanges.changed`.                                          |
| **User disabled**                                         | Kept and unused (AccessPolicy's first check). Reactivating brings it back.                                                                                                                                                                                                    | Kept. `AllowedAiAccounts`/keys refuse an inactive User. Back on reactivation.                                                                                                                                                                                                                                                                                                                               | **Unchanged and pre-existing**: revoked at disable, and they stay revoked when the User comes back (their loans end `resource-gone`). See Q1.              | Received ones stay `active` and unused, like an archived target.                                                                                                                                              | Sessions end, as today.                                                                                                                  |
| **Leaves / removed from an Organization**                 | Nothing of theirs changes. From the next turn they stop receiving Acme's groups (`VaultReach` works per Space and membership).                                                                                                                                                | Acme's accounts stop at the next request. `AiSessionReach` already listens to `membershipsChanged`.                                                                                                                                                                                                                                                                                                         | Their personal machine stays theirs. Their Acme Threads on it are no longer reachable by them (unchanged).                                                 | Loans they gave to Acme stay: the lender is them, not their membership.                                                                                                                                       | Test: the provider session on an Acme account closes, and a terminal with Acme's set closes. If one stays open, it's red and gets fixed. |
| **Organization archived**                                 | Not used or edited (`inOrganization`).                                                                                                                                                                                                                                        | Not used, the Owner included.                                                                                                                                                                                                                                                                                                                                                                               | Dedicated machines: nothing runs (today).                                                                                                                  | Received ones stay `active` and unused (Grants spec). Given ones (AI accounts lent by Acme, grantsai's work) must not be usable while Acme is archived. I'll pass that rule to grantsai.                      | Stopped (`stopRunning`, today).                                                                                                          |
| **Organization deleted** (`OrganizationLifecycle.delete`) | Groups, entries and values deleted (today).                                                                                                                                                                                                                                   | **New**: retired as in the User case, audited with via `organization.delete`.                                                                                                                                                                                                                                                                                                                               | Dedicated machines: unchanged (`spaceId: null`, the Owner sees and removes them).                                                                          | **New**: given → `lender-gone`. Received → `target-gone`, **and their lent Sandboxes close**. Today a Sandbox lent to a deleted Organization keeps a valid credential: **a real bug, found while designing**. | Its Threads are deleted first (today).                                                                                                   |
| **Project moved** (`movePlan` / `move`)                   | `vaultsLost` gains `owner: ResourceOwner` + `ownerName` (additive) and lists groups. `dropChoicesNotReaching` already drops the choices.                                                                                                                                      | `aiAccountsLost` already reads `AllowedAiAccounts` (the new rule). Fix: `name` is now also shown when the account belongs to the source Space's owner (viewers there see it), not only when it is allowed. Lent accounts follow by themselves once grantsai adds them to `AllowedAiAccounts`.                                                                                                               | Unchanged: `needsEnvironment` covers lent/dedicated Sandboxes. A personal machine follows its owner.                                                       | Grants follow Spaces, not Projects: no change.                                                                                                                                                                | Stopped by the move (today).                                                                                                             |

**Shared pieces.**

- `ai/AiAccountRetire.ts`: `retireWithin(sql, actor, owner, via)`, which `AiAccounts.remove` also reuses.
- `grants/GrantEnding.ts`: `endByLender` and `endByTarget`, which return the ended grant ids. The callers close lent Sandboxes through `EnvironmentRegistry.closeLentSandbox`/`lentSandboxClosed`.
- `revoke`/`endGrantsOf` take the reason (`resource-gone` | `lender-gone`).
- No change of contract other than the additive `vaultsLost[].owner/ownerName`.

**Migration 144 `OwnedResourcesGone`** (renumbered at integration if needed), modelled on 115. For removed Users and Organizations with no `spaces` row:

- Delete their groups and every row naming them (entries, allowances, defaults, choices, scopes, notices). The start-up sweep (`sweepOrphanValues`) removes the values.
- Retire their still-live AI accounts with the same SQL as `retireWithin`. The next reconcile takes them out of CLIProxyAPI and deletes the rows.
- End live Grants, `lender-gone` or `target-gone`. Revoke the lent Sandbox `environments` row and delete its `dedicated_sandbox_credentials`.

Test `144_*.test.ts`: a DB at 143 with removed Ana (groups, entries, account, Grant given and received), a deleted Org (leftover group and account, Grant to it), and live Bob/Acme untouched.

**Tests (red first).**

- `HubWithEnvironments.aiRemovals.test.ts` (Hub with Environments testkit). Removing Ana means:
  - her accounts are gone from CLIProxyAPI's fake and from `ai_accounts` after the sync;
  - her values are gone from `secrets/vault-values/`;
  - no row names her groups.

  Disable then enable keeps all of them, and her account works again.

- Deleting Acme: its groups, entries, values and accounts are gone, and the dedicated machine is still listed for the Owner.
- `HubWithEnvironments.lent.test.ts`: Acme deleted → the Grant ends `target-gone` and the lent Sandbox's credential is refused. Ana removed → her Grants end `lender-gone`.
- `HubWithEnvironments.projectMove.test.ts`: a Project goes from Ana's Personal space to Acme. `vaultsLost` names her `default` and a named group with owner Ana, and `aiAccountsLost` names her account. After the move the choices are gone.
- Membership-removal test for terminals and sessions.
- Audit `via` asserted.
- Docs: `install.md`, the three sections.

## 11: door inventory and full pass

**What a «pase completo» proves:** every door that reads or writes an owned resource is called by the whole cast — Owner, Ana, Admin/Member/Guest of Acme and Globex — and by a `spaceLimit` session. For each, the test checks that:

1. no answer, refusal or error carries a Secret value or an AI credential;
2. nobody gets a name, Variable or metadata they may not see (the spec table; the Owner sees names, not values);
3. every write on something not theirs is refused, and the row is unchanged afterwards;
4. a door matching the resource's pattern with no call in the sweep (and no entry in `SWEPT_ELSEWHERE`) fails the test.

**Sweeps.** Each one builds its door list from `WsRpcGroup.requests` + `HTTP_ENDPOINT_RULES` + `RAW_ROUTE_RULES` + `MCP_TOOL_RULES` + `AI_ACCOUNT_SIGN_IN_RULES`, filtered by a regex:

- `VaultDoors.test.ts`: extended with Ana (personal vault, Variable), a `spaceLimit` Acme session, and raw routes.
- New `AiAccountDoors.test.ts` (`/aiAccount|aiGateway|aiUsage|^raw:\/api\/ai/`): list/create/update/delete/reorder/allow/login*/import*, the picker, local-CLI keys, usage, and `/api/ai/*` using another owner's account through a key.
- New `EnvironmentDoors.test.ts` (`/environment|sandbox|grant|sshInstall/`): list, rename, remove, changeMode, dedicate, join approve/deny, SSH install start/status, `grants.*`.

**Leak smoke test** (`HubWithEnvironments.leaks.test.ts`). Ana has a multi-line PEM Secret and a direct API-key account. The test then runs:

- a Replay turn that prints both;
- a terminal `cat`;
- a handoff;
- a `request_secret`.

Then it scans for each line of the PEM (≥16 chars) and for the key in:

- captured logs (test `Logger`);
- spans (in-memory tracer);
- `/proc/<pid>/cmdline` of the Hub and of every child process the test spawned (the machine and the providers);
- every file under the Hub's base dir except the sealed store.

The test reports only booleans and paths, never the values.

**Declarations.** `DoorRules.test.ts` already fails on an undeclared door. I'll check `RPC_SPACE_ACCESS` and `CLIENT_GUARDED_RPC_SCOPES` for every door touched in 01–10, and add a row to `DoorRules` for any I find missing.

**Gaps:** each one gets a red test, a fix, and a **SendMessage to you as soon as it's found**.

**Docs:** `secrets.md` «The door inventory» and `ai-gateway.md` «Doors», rewritten as tables generated by hand from the sweeps.

**Real client.** The `test-t3-app`/`test-t3-mobile` skills need T3's Browser/Device panels, which this agent doesn't have. I'll try `vp run dev` with the seeded Hub. If it can't be driven, the pass is covered by a server-level scenario test with the same steps (Ana joins a machine, adds a key and a PEM, her Thread uses all three, history shows `[NAME]`, she creates an Org, dedicates the machine, adds an account and a Variable, a Member uses them and sees nothing of Ana's), and the client part is reported **not verified**.

## Open questions (my recommendation first)

1. **Disable revokes machines** (pre-existing, before this spec). The ticket says "desactivar no borra nada". I recommend keeping it: a machine credential is a door, and rejoining is cheap. I'd document it as the one exception. The alternative is to make it a suspension restored on enable, which needs a new state.
2. **Values a live Thread received.** `removeValues` keeps a value while a non-deleted Thread holds it, so its masker still hides it, and the Owner can still read the frozen Personal space. Removing Ana doesn't delete her Threads, so a Secret she already used stays sealed on disk until those Threads go. I recommend keeping it, the masking promise. The test then checks that unused values are gone and used ones are held only by `thread_secret_values`. The alternative is to delete them and lose masking on later reads of her Threads.
3. **`offered` Grants of a removed lender** → `cancelled` (there is no end reason without having been accepted). Recommended.
4. **Reason for a removed User's machine loans:** `lender-gone`, not `resource-gone`. Recommended: it says why.
5. **Grants to an archived Organization or a disabled User:** they stay `active` and unused, and restoring brings them back (Grants spec). The lent Sandbox isn't stopped, only unused. I recommend not stopping it: it is the lender's machine and costs only an idle container.
