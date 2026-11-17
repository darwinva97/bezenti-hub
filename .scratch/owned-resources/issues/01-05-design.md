# Design: tickets 01–05 (owned vaults)

Branch `feat/owned-vaults` (base `public-hub-1`, 3355e369f0). Tickets 06–09 already built; 10 and 11 out of scope. The ticket text wins over the spec where they differ: `class` stays (no `type`/`value_text`), `kind` stays minus `copy`/`link`, Provider/template/identity entries stay Owner-only. Commit order and migration ids: **141** (01), **142** (03), **143** (04). 02 and 05 have no migration.

## 01: Secrets are no longer revealed

- **Migration 141 `VaultEntriesSealed`**: `UPDATE vault_entries SET revealable = 0 WHERE revealable = 1`. The column stays (the CHECKs use it); code stops reading it. Test: a revealable Secret becomes sealed; a Variable and a link don't change.
- Server: remove the HTTP door `vaults.reveal` (`vaults/http.ts`), `Vaults.authorizeReveal`/`reveal`, the `vault.reveal` action (and its `VAULT_ACTIONS` entry), `VAULT_REVEAL` in `DoorRules.ts` and `HTTP_ENDPOINT_RULES`, the `MaskedPaths` row. `put` loses `allowReveal`; every Secret write is sealed. Audit stops writing `secret.reveal` (old rows still render).
- Secret → Variable keeps requiring a new value (`needs-new-value`, already in `Vaults.ts`). It isn't refused, because it never exposes the old value. Docs say so; there is no `secret-is-write-only`.
- `DoorRules.test.ts`: "only `SecretDelivery`/`SecretMasker` read a Secret's value; a Variable's value is also read by `Vaults.list` behind `vault.readVariables`".
- Contracts: remove `vaults.reveal` from `EnvironmentHttpApi`, `VaultRevealRequest/Result`, `allowReveal`, `VaultEntry.sealed`, `VaultSummary.canReveal`, and the `sealed` `VaultErrorReason`. **Breaking for old clients**: their entry list stops decoding (`sealed` missing). That's accepted because 03 breaks their Settings → Vaults anyway, and the five tickets ship in one deploy.
- Web/desktop: remove Reveal, Confirm and reveal, Value of NAME, Hide, Allow reveal and the 60 s timer. Mobile: `noReveal.test.ts` stays green.

## 02: Multi-line values and per-line masking

- `secretForms` already adds per-line forms for multi-line values (≥ 20 chars, no inner whitespace). Change: the threshold goes to **16 chars after trimming the ends**, and PEM armor lines (`-----BEGIN …-----`, `-----END …-----`) are excluded explicitly. CRLF and indentation are already covered by `split(/\r?\n/)` + `trim()`. `pendingSuffix` covers line forms because they are ordinary forms. I'll add a stream case to `SecretMasker.test.ts`.
- Red tests: a PEM value whose lines are 16–19 chars (masked only after the change), 4-space indentation, CRLF, armor lines not masked, lines under 16 not masked.
- `HubWithEnvironments.secretEnv.test.ts`: a value with LF and one with CRLF reach the process environment byte for byte.
- Web/desktop: `SecretInput` gets a textarea mode (cleared after save, never re-shown). Mobile: `TextInput multiline`. `request_secret` cards (web and mobile) accept multiple lines.

## 03: Vaults with groups

**Migration 142 `VaultGroups`.** Ids are preserved (`group_id` = old `vault_id`), so re-pointing other tables only means renaming the column. Children are rebuilt first and `vaults` is dropped last, because `PRAGMA foreign_keys = ON`.

1. `CREATE TABLE vault_groups (group_id PK, owner_kind CHECK IN ('user','organization'), owner_id, name, description, is_default INT 0/1, position, archived_at, created_at, updated_at, created_by, CHECK (is_default = 0 OR archived_at IS NULL))`. Plus `UNIQUE (owner_kind, owner_id, name COLLATE NOCASE)`, `UNIQUE (owner_kind, owner_id) WHERE is_default = 1`, and an owner index.
2. Rows, with O = the Owner's `user_id`:
   - `vault-main` → `(user, O, 'default', is_default 1)`. If no Owner row exists, the Main vault can hold nothing (only the Owner adds), so it is deleted with its rows. The start-up ensure (below) creates the default later.
   - Other `space_id IS NULL` vaults → `(user, O, name)`, with allowances unchanged.
   - `space_id = <org>` vaults → `(organization, space_id, name)`.
   - Any of these named `default` (NOCASE) → `default (old)`.
   - Then insert an empty `default` for every Organization (not deleted) that lacks one. Archived groups stay archived.
3. `vault_entries` rebuilt with `group_id`. `kind IN ('own','provider','template','identity')`, no `linked_entry_id`, `class`/`revealable` NOT NULL. The 119–123 CHECKs are rewritten without `link`.
   - **Live link** (original exists in the Main vault, isn't a link, and has a `value_id`): becomes `own`, with `value_id` = the original's, `class` and `unmasked` from the original, `revealable` 0, and the link's own `delivery` (that is what it was delivered with, so the effective set is unchanged).
   - **Broken link** (no original, or an original without a value): deleted.
   - **Copy**: becomes `own` (it already has its own value).
   - Each converted entry gets a `system` row `secret.edit` `{op:"unlinked", from:"link"|"copy"}`. Each broken link gets `secret.edit` `{op:"delete", reason:"broken-link"}`.
   - Converted links go into a new **`vault_unlinked_notices`** table (entry, group, name, original's name) for the Owner's one-time notice.
4. Rebuild `vault_allowances`, `space_default_vaults`, `project_vault_choices` and `vault_provider_scopes` with `group_id REFERENCES vault_groups`, copying rows as they are. `thread_secret_values` names no vault; `grants` has no `vault-group` rows. Drop `vaults`.

**Value sharing.** An SQL migration can't copy a sealed file, so a converted link first shares its original's `value_id`. At Hub start, `Vaults` runs an idempotent **unshare**: for every `value_id` held by more than one entry, all but one entry get a new sealed copy (read → write → `UPDATE`). This is the spec's "new value_id". As a defense, `VaultReachLoss.removeValues` keeps a value that is still held by any entry (today it only checks Threads). With that, replacing or deleting the original never removes the shared value.

**Start-up.** `ensureMainVault` becomes `ensureDefaultGroups`: an idempotent `INSERT … WHERE NOT EXISTS` for the Owner and every live Organization (every live User from 04). Creating an Organization (`SpaceDirectory`) inserts its default in the same transaction. `MAIN_VAULT_ID` goes.

**Reach (`VaultReach`), one rule.**

- A group reaches the Space of its owner: Org → that Org; user U → `personal:U` (only the Owner has user groups until 04).
- The Owner's groups also reach the Spaces of their allowances, and Users through user allowances (`allowedToUser`). Allowances are never valid on a `default`, and allowance rows on groups not owned by the Owner are ignored.
- The **fixed default** of Space S is the `default` of S's owner. That reproduces today's Main vault exactly.
- New: the Owner's named groups now also reach the Owner's Personal space without an allowance. They are choosable there but not received unless chosen, so the effective set doesn't change.
- `mayReceiveSecrets` (SecretDelivery SQL) and `forgetOrganization`/`forgetVault` are rewritten on the same rule.

**Effective set.** Same precedence (User's allowed groups, Project adds, fixed default, chosen defaults). Each variable also carries the group's owner. Templates compose entries of their own group; a group is exactly an old Vault, so no template breaks.

**AccessPolicy (03 rows; 04 adds the personal rows).** `VaultResource = { kind:"vault", owner: {kind:"user", userId, isInstallationOwner} | {kind:"organization", space|null}, isDefault, allowedSpaces, allowedUsers }`.

- `vault.manage` (create/rename/describe/archive/delete groups): the Owner on their own groups and every Organization's; the **Admins of the owning Organization (new)**. On `isDefault` it is refused for everyone with **`default-group`** (checked before the Owner shortcut). The default can't be renamed, described, archived or deleted.
- `vault.edit`: Admins on their Org's groups; others on the Owner's groups via allowances, as today. `vault.view`/`vault.readVariables`: as today, on groups.
- `vault.providerEntry`: as today (Admins through a scope). `vault.identityEntry` and `vault.dangerousName`: the Owner only.
- `vault.allow`: the Owner, on their own non-default groups. `vault.choose`: unchanged in 03.

**Contracts (`vaults.ts`).**

- `VaultId` → `VaultGroupId` (same string ids).
- `vaults.groups.list/create/update/delete` replace `vaults.list/create/update/delete`.
- `VaultGroupSummary`: `owner: ResourceOwner`, `ownerName`, `isDefault`. `spaceId`, `spaceName`, `isMain` and `canReveal` go.
- `create` takes `owner: ResourceOwner`.
- Remove `vaults.entries.link/copy`, `VaultEntryFromMainInput`, `linkedFrom`, `breakLinks`/`brokenLinks`, `copy`/`link` from `VaultEntryKind`, and the `main-vault`/`not-linkable` reasons. Add the `default-group` reason.
- `VaultChoiceOption.isMain` → `isDefault`.
- Notice: `VaultGroupListResult.unlinked?` (Owner only) and a new `vaults.unlinkedNotice.dismiss`.
- **Wire field names `vaultId`/`vaultName` stay** in entries, choices, allow, `threadEnvironment` and `request_secret`. They now name a group.
- **Breaking**: old clients' Settings → Vaults fails (the RPCs are gone). Their Thread «Secrets» panel and `request_secret` keep working, because those fields are unchanged and the new ones are optional.
- `RPC_SPACE_ACCESS`, `CLIENT_GUARDED_RPC_SCOPES`, `MaskedPaths` and `DoorRules` are updated.

**Clients.**

- Settings → Vaults has sections by owner (each section is a component taking an owner). The `default` group has no rename/archive/delete. The Owner sees a one-time notice of unlinked entries.
- `VaultChoices` picks groups. The Thread panel (web and mobile) and mobile Vaults show group and owner. `request_secret` offers groups.

## 04: Every User's personal vault

- **Migration 143 `PersonalVaults`**: a `default` for every non-removed User without one.
- `Users.ts` (create, accept Invitation) inserts it in the same transaction, through a shared SQL helper in `persistence/` so persistence doesn't depend on `vaults/`. `ensureDefaultGroups` also covers live Users.
- Reach: a non-Owner User's groups reach only `personal:U`, with no allowances. Test: Ana's Thread in Acme doesn't get her personal `default`; her Personal-space Thread does.
- **AccessPolicy, user-owned group of U ≠ Installation Owner:**
  - U has view, readVariables, edit, manage (not on `default`), and dangerousName (confirmed, as the Owner today).
  - providerEntry and identityEntry: denied for everyone (Owner-only, and the Owner doesn't edit others' vaults).
  - **Owner: view + readVariables only** (`personal-space-read-only` otherwise).
  - Everyone else: denied. Inactive or removed users: denied (existing first check).
- `vault.choose` in a Personal space goes to its User only, the Owner included in their own. In someone else's, the Owner gets `personal-space-read-only`. Organizations are unchanged (Owner + Admins, while open). Existing defaults the Owner chose in others' Personal spaces stay, and now their User can change them.
- `request_secret` in a Personal-space Thread offers its User their groups.
- Clients: a «Mine» section for every User, and the Personal-space defaults picker for its User.

## 05: Variables (what's missing)

- First I'll check what `vault-variables-and-providers` 01 already built and note it in the commit.
- `list_secret_names`: each item gets `type` (from `class`) and `value` for Variables only (additive). The source is the effective set the process receives. Red test in `OrchestratorMcpService.test.ts`: a Variable returns its value; a Secret, a Provider entry, a template using any Secret and an identity entry never do. Add the new tool description and the developer-instructions line.
- Thread «Secrets» panel: Variables with their value (a new optional `value` on `VaultThreadVariable`, read through `vault.readVariables`), Secrets name-only. A test proves a Secret's value never reaches the client.
- UI copy: «Secret» / «Variable», with the Variable described as «Visible to everyone who receives this group», and «Make secret» with its warning, on web, desktop and mobile.
- Audit `secret.edit` gets `type` and `op` (`add|replace|rename|describe|delete|to-secret`). It never carries a value.

## How I prove the effective set is unchanged

`142_VaultGroups.test.ts` seeds the DB at 141 with:

- the Main vault;
- an Owner vault allowed to Acme and to a User;
- two Acme vaults with defaults and Project choices;
- a live link to a Secret, a live link to a Variable, a broken link and a copy;
- a vault named `default`;
- a Provider entry with a scope, a template and an identity entry.

**Before**: a frozen SQL copy of today's rule in the test (like 115's `REACHES`), plus link resolution, gives for each test Thread and acting User (Owner/Acme Admin/allowed User/Globex) the set of (name, vault id, source, class, delivery, value id or provider or identity).

**After**: migrate, then run the real `EffectiveVaults.forThread` on the migrated DB and compare the same projection. They are expected to be identical; the broken link wasn't delivered before either. The only addition is the empty org `default` in `vaults[]`, which is allowed and asserted.

Row assertions cover owners, names (`default (old)`), the default index, allowances, defaults and choices kept, the scopes table, the audit rows and the notice rows. The unshare is tested separately in `Vaults.test.ts`: two entries end with distinct value ids whose sealed contents are equal, compared as a boolean so no value is ever printed.

## Tests (red-first per ticket)

- **01**: `VaultDoors.test.ts` (no door returns a revealable Secret's value), `141` test, AccessPolicy/DoorRules rows.
- **02**: `secretMasking.test.ts`, `SecretMasker.test.ts` (chunked stream), `HubWithEnvironments.secretEnv.test.ts` (LF/CRLF).
- **03**: `142` test, `AccessPolicy.test.ts` (Admin/Member/Guest of Acme and Globex × manage/edit/default-group/identity/provider), `Vaults.test.ts` (groups CRUD, default protection, unshare, notice), `EffectiveVaults.test.ts` rewritten on groups plus the `default` case, `VaultReachLoss.test.ts`, `SecretRequestVaults.test.ts`, `VaultDoors`/`DoorRules`/`RpcAuthorization`.
- **04**: `143` test, AccessPolicy rows (Ana/Admin/other User/Owner), `EffectiveVaults.test.ts` (personal reach), Users creation test (default in the same transaction).
- **05**: `OrchestratorMcpService.test.ts`, thread panel test, audit test.
- Web/mobile: the existing component tests are updated, and web typecheck runs.

## Open questions (my recommendation first)

1. **Per-line masking rule.** The ticket says ≥ 16 chars after trimming, excluding PEM armor. Should lines with inner spaces count? I recommend **no**: keep the earlier rule that a masked line has no inner whitespace, and only lower 20 → 16. Masking spaced lines would turn JSON boilerplate (`"type": "service_account",`) into `[NAME]` everywhere.
2. **Wire field names.** I recommend keeping `vaultId`/`vaultName` in payloads and renaming only the brand type and the four group RPCs. Renaming every field to `groupId` would also break old clients' Thread panel and `request_secret`, for no behaviour gain.
3. **Converted link's `delivery`.** I recommend the link's own delivery, which is what was delivered. The other choice is the original's.
4. **Unlinked notice storage.** I recommend a table plus a dismiss RPC (works across devices). The alternative, client-side dismissal, would show the notice again on every device.
5. **Owner's named groups in the Owner's Personal space without an allowance.** I recommend yes, as the spec says (they're choosable, not received unless chosen).
6. **Description of `default`.** I recommend making `default` fully immutable at the group level, so `vault.manage` is denied. The other choice is to allow describing it.

## What I likely can't verify here

- The `evals/mcp-tool-use` before/after run (it needs model credentials; I'll try and report).
- The "Prueba real" runs on a seeded `vp run dev` Hub with a browser. I'll cover them with server-level tests and say so.
