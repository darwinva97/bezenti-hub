# Design: tickets 06–09 (owned machines and AI accounts)

Branch `feat/owned-machines-ai` (base `public-hub-1`, 59c95bd7f7). Vaults (01–05), 10 and 11 out of scope.

## Owner type

`ResourceOwner` in `packages/contracts/src/ownership.ts` (new, exported from the index):
`{ kind: "user", userId } | { kind: "organization", spaceId }`. Used by AI accounts now, Environments in summaries, and Grants/Vaults later.

## 06: any User joins their own machine

- `AccessPolicy`: `environment.register` (on the Installation) allows every active User; inactive is refused by the existing first check. `DenyReason "missing-installation-permission"` goes.
- `environments.registerOwn` leaves `InstallationPermission`. It was the last literal, so the mechanism goes with it: `PUT …/installation-permissions` (`installationUsersHttp.ts`), `SpaceDirectory.setInstallationPermission`, `setInstallationPermission` and `INSTALLATION_PERMISSION_LABELS` in client-runtime, the column in `UsersDialog.tsx`, and `Principal.installationPermissions`. **This is not additive.** To keep older mobile builds decoding, `UserSummary.installationPermissions` stays as `Schema.Array(Schema.String)` and is always `[]` (marked deprecated). The table stays: plans-and-limits drops it.
- **Migration 139 `RegisterOwnPermissionGone`**: `DELETE FROM installation_permissions WHERE permission = 'environments.registerOwn'`.
- Clients: no "missing permission" message on «Register this machine». «Add machine» shows for every User (web `AddEnvironmentDialog`/`HubEnvironmentsSettings`, mobile `features/environments`). The `viewerMayApprove` doc comment changes.
- Docs: `install.md` («Join a machine…», «Personal spaces and Installation permissions») and `environment-auth.md`.

## 07: Admins dedicate machines to their Organization

The dedicated machine's owner is its Space (`environments.space_id`, `owner_user_id` NULL): **no migration**.

AccessPolicy:

- `environment.dedicate` is decided on the **destination `SpaceResource`**: the Owner or an Admin of that Organization. Refused for archived/frozen Spaces, Personal spaces (`wrong-resource`), Members, Guests, and Admins of another Organization.
- `decideSpaceBound` rename/remove of a dedicated machine: the Owner, or an Admin of its Organization while that Organization is open. If its Space was deleted, only the Owner (as today).
- New action `environment.move` on a new `EnvironmentMoveResource { kind: "environment-move", environment, to: SpaceResource | null }` (`null` = personal). Allowed only with power at both the origin and the destination, the same idea as `decideMove`:
  - Origin: a personal machine needs its owner (the Owner too, but only for their own machine). A dedicated machine needs the Owner or an Admin of its Organization, or only the Owner once its Space is gone.
  - Destination: dedicated needs `environment.dedicate` on the target. Personal means the actor becomes the owner.
  - Result: Admin→Admin between Organizations they run; a personal machine's owner dedicating it to an Organization they administer; an Admin turning a dedicated machine into their own personal machine. **Narrowing:** the Owner can no longer take another User's personal machine (they can still remove it).
- `EnvironmentRegistry`: `register` checks `environment.dedicate` on the target. `changeMode` checks `environment.move`, and refuses a machine with a `pending` or `active` Grant with a new reason, `machine-lent` ("take back its loans first"). Lent Sandboxes' Threads aren't in `threadsOn`, and auto-ending with `owner-changed` would cut off borrowers mid-turn. `dedicatedSpaces(userId)` returns only the Organizations the User may dedicate to, with no up-front Owner check. An empty list means "personal only".
- SSH install: `start` decides `environment.dedicate` on `input.spaceId`. Progress, host-key and cancel are answered only to the User who started the run, so an Admin never sees another person's run. Updating an existing machine over SSH needs `environment.rename`-level power on that machine. `DoorRules.ts` text updated.
- Contract (additive): `HubEnvironmentSummary.owner?: ResourceOwner` (personal → user, dedicated → organization; absent for Hub and Sandboxes) and `canManage?: boolean` (rename/remove/move allowed). `EnvironmentJoinRequestView.dedicatedSpaces` is now also given to Admins (doc only).
- Audit: `environment.register` detail gains `ownerKind` and `ownerId` (`audit.ts` keys).
- Clients: Settings → Environments shows Admins their Organizations' dedicated machines, with rename, remove and «Change organization» limited to Organizations they administer. Mobile gets the same list with the owner. Rename/remove go on mobile only if the mobile screen already has them; otherwise it stays read-only and I flag it.

## 08: AI accounts of a User

**Migration 140 `AiAccountOwners`**:

- `ALTER TABLE ai_accounts ADD owner_kind TEXT NOT NULL DEFAULT 'user' CHECK (owner_kind IN ('user','organization'))` and `owner_id TEXT NOT NULL DEFAULT ''`.
- `UPDATE … SET owner_id = <the Owner's user id>`, falling back to `created_by` only if no Owner row exists.
- Drop `ai_accounts_name_idx`. Add `UNIQUE (owner_kind, owner_id, name COLLATE NOCASE)` and `(owner_kind, owner_id, priority)`.
- Priorities stay as they are: they were all the Owner's, so the order is kept. From now on `priority` is compared only within one owner. New accounts get `MAX(priority) WHERE owner = X` + 1.

AccessPolicy:

- New `AiAccountResource { kind: "ai-account", owner: { kind:"user", userId } | { kind:"organization", space: SpaceResource } }`. Creating is decided on a resource carrying the target owner.
- `aiAccount.manage`:
  - User-owned: only that User. That includes the Owner for their own accounts. The Owner is refused on Ana's (`not-yours`).
  - Organization-owned: the Owner or its Admins, refused when archived or frozen, for the Owner too.
- `aiAccount.allow`: only the Owner, and only on accounts the Owner owns.
- `aiAccount.view` (new): manage, or the Owner on anything (name, provider, owner, status; no details).
- `aiAccount.manage` on the Installation stays Owner-only. It now means Installation-wide gateway things only: everyone's usage (`AiUsage`), the CLIProxyAPI import, the Hub's subscription limits.

**`AllowedAiAccounts`, one rule.** For a Space the User works in (`aiAccount.use`, unchanged):

1. First, the enabled accounts of the Space's owner (Personal space → its User; Organization → it), by their priority.
2. Then the Owner's accounts allowed to the Space or the User, by the Owner's priority, minus duplicates.

Allowance rows on accounts the Owner doesn't own are ignored when read. Gateway (`AiGatewayKeys.authorize` → `accessIn`), picker, the default for a new Thread (`chooseAiAccount`) and the move plan all read this list. I'll check that nothing downstream re-sorts by `priority`, including the failover in `AiGatewayProxy`, client-runtime `aiAccountPicker` and `aiAccountsView`. If something does, it switches to server order. **Widening:** all the Owner's accounts become usable in the Owner's own Personal space without an allowance (grants spec: "allowance al Personal space del Owner → nada"). `AiGatewayRoute.ts` itself doesn't change.

`AiAccounts` service:

- Every write decides on the account's owner. `create`, `loginStart`, `importVertex` and `reorder` take an optional `owner` (default: the caller's own User).
- `reorder` must list exactly that owner's live accounts.
- `importCliproxy` stays Owner-only, importing as the Owner.
- `loginComplete` still requires the User who started the sign-in, and records the target owner.
- Name uniqueness is per owner, `adoptProviderKey` included.
- `ownerSubscriptionLimits` covers only the Owner's own accounts.

`aiAccounts.list`, per caller:

- The accounts they manage, with details. Allowances appear only on the Owner's own.
- For the Owner, everyone else's accounts with no details.
- The accounts usable to them (`usableIn`).

Contract (all additive):

- `AiAccountSummary`: `owner?: ResourceOwner`, `canManage?: boolean`.
- `AiAccountListResult`: `owners?: Array<{ owner, name }>`, the owners the caller may add accounts for. `canManage` keeps its meaning: Owner/Installation controls.
- `owner?` on `AiAccountCreateInput`, `AiAccountLoginStartInput`, `AiAccountImportVertexInput` and `AiAccountReorderInput`.

Scopes: `aiAccounts.create|update|delete|reorder|loginStart|loginComplete|importVertex|importCliproxy` move to `access:write`. `aiAccounts.allow` stays on `settings:write`.

Audit: `ai_account.*` details gain `ownerKind` and `ownerId`.

Clients:

- `AiAccountsSettings`: a «Mine» section for every User, built as a component that takes the owner. Allowances only on the Owner's accounts. The Owner also gets a read-only «Other people's» list.
- The ToS notice drops the "sharing" wording when the owner is a User.
- Mobile: own accounts read-only. `noOwnerControls.test.ts` stays green.

Docs: `ai-gateway.md` («AI accounts», «The AI account of a Thread») and `install.md` («The AI gateway»: adding your own account).

**Grants:** Grants don't lend AI accounts yet: Grants answers `not-lendable` for that kind. When they do, the lender is the account's owner and allowances stay Owner-only until Grants migration 02. No Grants code changes here.

## 09: AI accounts of an Organization

No migration. Same code with an `organization` owner:

- AccessPolicy rows: the Owner and Acme's Admins may manage Acme's accounts. Acme's Members, Globex's Admin, and anyone on an archived Acme may not.
- The usable rule already puts Acme's accounts first for anyone who works in Acme, Guests included (as `thread.create` does).
- Removal from Acme: `aiAccount.use` fails on the next request. Covered by a test; no new code expected.
- UI: one section per Organization the User administers (the Owner: all of them). Members see their Organization's accounts read-only (name, provider, status) via `usableIn`. Mobile is the same, read-only.
- An Organization that is deleted leaves its accounts unusable (its Space is gone). Deleting them is ticket 10.

## Spec open questions

| #      | Question                                      | My answer                                                                       |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| 1      | Personal machine in the owner's Organizations | Yes, only for the owner's own Threads. The current `decideEnvironment` is kept. |
| 6      | AI account order                              | The Space owner's accounts first, then the Owner's allowed ones.                |
| 8      | SSH install for Admins                        | Yes, for their Organization. The kept SSH key stays sealed.                     |
| 2–5, 7 | Vaults and removals                           | Not in these tickets. No objection to the spec's answers.                       |

## New decisions for you to confirm

1. The Owner can no longer change the mode of another User's personal machine.
2. Mode change on a lent machine is refused (`machine-lent`) rather than auto-ending its Grants.
3. The Owner's accounts are all usable in the Owner's own Personal space.
4. `importCliproxy` stays Owner-only.
5. The Installation-permission door is removed (not additive; see 06).
6. No ADR needed: spec + ADR 0005/0010 cover it.

## Tests, red first

| Ticket | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06     | `AccessPolicy.test.ts`: Ana, a permissionless Member, and the Owner register; a disabled User doesn't. `EnvironmentJoin.test.ts`: a Member approves their machine with a strong factor; a disabled User is refused. `139_*.test.ts`.                                                                                                                                                                                                                                                                                                                                                                |
| 07     | `AccessPolicy.test.ts` rows for dedicate, rename/remove and move (every case in the ticket, plus the Owner on Ana's personal machine). `HubWithEnvironments.dedicated.test.ts`: an Acme Admin dedicates with `--dedicated`; an Acme Member runs a Thread there; Globex doesn't see it; a lent machine's move is refused. `HubWithEnvironments.sshInstall.test.ts`: an Admin installs for Acme, a Member is refused, another User can't read the run. `EnvironmentJoin.test.ts`: only administered Organizations are offered. `hubEnvironments.test.ts`: the `owner` field.                          |
| 08     | `140_*.test.ts`: owner assigned, per-owner names, order kept. `AccessPolicy.test.ts` rows. `AiAccounts.test.ts`: Ana creates, reorders and lists; the Owner sees hers without details and can't edit them; Bob sees nothing. `AiGatewayRoute.test.ts`: Ana's account refused for her Acme Thread and used in her Personal space; failover order is owner-first, then allowed. `AiAccounts.subscriptions.test.ts`: a User's sign-in. `RpcAuthorization.test.ts`: a standard session creates. client-runtime `aiAccountsView`/`aiAccountPicker`: sections and server order. Mobile `noOwnerControls`. |
| 09     | `AccessPolicy.test.ts` rows. `AiGatewayRoute.test.ts`: Acme's Thread uses Acme's account; Globex's and an Acme Member's Personal-space Thread don't; after removal from Acme the next request is refused.                                                                                                                                                                                                                                                                                                                                                                                           |

Heavy checks only through `heavy.sh`, targeted files only. Real-Hub proofs (`vp run dev`) are attempted at the end. Whatever can't be run there is reported as not verified.
