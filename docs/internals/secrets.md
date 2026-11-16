# Secrets at rest and the master key

The Hub keeps its secrets in `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`): one
file per name in `<stateDir>/secrets`. Session signing keys, preview-profile HMAC keys, provider and
source-control credentials from Settings (`settingsSecrets.ts`), the SSH key the Owner keeps «for
updates» (`ssh-install-key-<id>`), `request_secret` answers and replay markers all live there. Since
spec 5 («Vaults», ticket 01) every entry is encrypted with a **master key** that lives in a file of
its own. Callers do not know: the store's API (`get`, `set`, `create`, `getOrCreateRandom`,
`remove`) did not change.

## Files

- `<name>.sealed`: an entry sealed with the master key. `<name>.bin`: an entry in clear, from before
  encryption (sealed at the next start) or on a joined machine that never was a Hub. Which is which
  is told **by the name only**, never by the bytes: a random value that happens to start like a
  sealed one is still read as written.
- `master-key.check`: sealed by the key it checks, it records the key file the Hub last started
  with (a command using another `T3CODE_MASTER_KEY_FILE` warns).
- `master-key.backup`: sealed, when the Owner last confirmed a backup of this key. Neither file is
  an entry, so no `set` of any name can write them.
- Every write goes through `atomicFile.ts`: an owner-only `wx` temp file, fsync, rename (replace) or
  link (create only), fsync of the folder. The key file uses the same helper.

## The sealed format

`SecretCipher.ts`, on `node:crypto` only:

```
\0T3S | format (1 byte, 0x01) | key id (8 bytes) | nonce (12 bytes) | ciphertext | GCM tag (16 bytes)
```

- **AES-256-GCM** under a subkey `HKDF-SHA256(master key, info = "t3code <purpose> v1")`: one subkey
  per use (`server-secret` for entries, `key-check`, `backup-record`, `secret-file`; Vault values in
  the database, ticket 02, get their own).
- **A fresh random 96-bit nonce per seal.** Two writes of one value never share bytes. A Hub writes
  a few thousand entries per key, far below the 2³² seals per key where random nonces start to
  matter.
- **Associated data:** the header (format and key id) followed by the purpose and the entry's name.
  A file copied or renamed to another name, or moved to another purpose, does not open.
- **Key id:** the first 8 bytes of `HKDF(master key, "t3code master key id v1")`: a fingerprint that
  names the key without revealing it. It tells "sealed by another key" from "damaged", and lets a
  rotation stop and resume.

## The master key file

- 32 random bytes, written as one line `t3-master-key-v1:<base64url>`: the same text is the
  backup.
- Default `<stateDir>/master.key`; `T3CODE_MASTER_KEY_FILE` puts it elsewhere (off the disk that is
  backed up). It must be an absolute path (or start with `~`): a server and a CLI started from
  different folders would otherwise read different files. It is the only secret of the Hub kept in
  clear.
- Created on first start with mode `0600` (exclusive create: two processes starting together end
  with one key).
- **Permissions**, checked on the open handle at every start (POSIX):
  - owner-only (`0600` or tighter) passes;
  - a file owned by root that others cannot read and group cannot write (`0440`/`0400`, a
    Kubernetes or Docker secret mount shared with the Hub's group) passes: an administrator placed
    it and decides which group reads it, and nobody but root can replace it. `0444`/`0404` (readable
    by everyone) is refused like any other loose mode;
  - anything else stops the startup with «run `chmod 600 <file>`», unless
    `T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1`, for file systems without real modes (drvfs under
    WSL, some NFS mounts), which logs a warning at every start.
  - On Windows mode bits mean nothing: the file inherits the ACL of its folder, which under the
    user's profile (the default state directory) is that user's alone; put
    `T3CODE_MASTER_KEY_FILE` in a folder with the same ACL.
- Never in the database, a log, a span (not even a span's result), an error message or a process
  argument: its bytes sit in a private field of `MasterKey` (inspecting or serialising one shows
  only its id), errors name files and key ids only, the file reader that returns it has no span,
  and `t3 secrets key import` reads the key from a file or stdin, never argv.
- Client file reads and git never serve it: in the key's own folder, `serverInternalPaths.ts` hides
  the key and every name the key could have become: anything starting with `<key name>.` or
  `<key name>~` (`.next`, `.previous`, `.replaced-<id>`, temp files, backups) and any `.swp` file.
  In other folders nothing is hidden for it. Stale temporary key files (which hold a whole key) are
  removed at startup.

## Startup (`MasterKeyFile.openKeyring`)

Two modes:

- **owner**: the server (it holds the server's ownership lock, `serverOwnership.ts`), or a command
  that took that lock because no server runs. It may create the key, seal, re-seal and finish a
  rotation.
- **client**: a command beside a running server (`t3 pair`, `t3 auth`, `t3 secrets key export`…,
  through `ServerSecretStore.layerClient`). It lists names only (no entry is read; the key check
  tells a wrong key), ignores replay markers (the Hub prunes them) and writes nothing. Only if the
  store needs a startup (no key yet, entries in clear, a rotation to finish) and no server runs
  (its runtime record names no live process) does it take the ownership lock, briefly, to run that
  startup itself; a Hub starting meanwhile wins the lock. Otherwise only what touches a secret
  fails, with «Start the Hub, or stop it and run this again».

In order:

1. **Read** `master.key`, `master.key.next`, `master.key.previous`, the list of entries and the key
   check.
2. **No key:** if anything encrypted exists (a sealed entry, the key check, a `.next`/`.previous`
   key), stop: «The master key … is missing … restore it with `t3 secrets key import`». A new key is
   never created over values another one sealed. Otherwise (owner) create the key.
3. **Headers only:** each sealed entry's key id (13 bytes read). One sealed by a key the Hub does
   not have, or a key check that does not open, stops the startup. Nothing was written.
4. **Anything to write?** Entries in clear, entries under another key (a rotation), expired replay
   markers. If not, the startup is done: a normal start reads headers only.
5. **Authenticate before writing:** every live sealed entry is opened in full. A damaged one stops the
   startup before anything is written.
6. **Write:** expired replay markers (older than a day) are dropped, not re-sealed; each entry in
   clear becomes `<name>.sealed` (atomic) and then its `.bin` goes (a `.bin` that already opens as
   a value sealed under the current key, as the branch's first encrypting build wrote them, is
   renamed, never sealed twice); entries removed while the startup ran are skipped; each entry under another key is
   re-sealed in place. Every rewritten entry keeps its modification time, which replay-marker
   pruning reads. A crash leaves every entry either as it was or done; the next start finishes.
7. **Finish a rotation** that stopped (below), rewrite the key check when needed, remove stale
   temporary files in the secrets folder and in the key's folder.

After startup a value found in clear, sealed by an unknown key, or under the wrong name fails to read
(`SecretStoreDecodeError`); the store never accepts a planted plain file as a secret, and never hands
out sealed bytes as a value.

## Backup, import and rotation

- **Backup** (`MasterKeyBackup.ts`, the same for Settings and the CLI):
  1. `export` records `secret.master_key.export` (`via`, `keyId`) in the audit log first; if it
     cannot, the key is not handed out.
  2. The key goes to the Owner: Settings («Download master key backup», after the strong factor in
     the request: a passkey, or password and TOTP code) downloads it as a file; `t3 secrets key
     export` writes it to a new owner-only file (`--output`, fsynced) or to stdout, and fails if the
     write did not complete.
  3. `confirm` records the backup (`master-key.backup`) only once the Owner shows they hold it: the
     key's first 8 characters after `t3-master-key-v1:`. Settings asks the Owner to type them from
     the saved file; the CLI confirms itself once the write succeeded. An interrupted or abandoned
     download leaves the warning on. A rotation makes it come back.
- **Import** (`t3 secrets key import <file>` or `-` for stdin), with the Hub stopped: the key must
  open the secrets here (the key check and every sealed entry), otherwise nothing changes. A key it
  replaces is kept as `master.key.replaced-<id>`, never discarded. Restoring on another server:
  copy the state directory, import the backup, start.
- **Rotation** (`t3 secrets key rotate`), with the Hub stopped (it takes the server's ownership
  lock): writes the new key as `master.key.next`, re-seals every entry and the key check under it
  (each an atomic replace, after authenticating all of them), drops the old backup record, writes
  the old key to `master.key.previous`, then renames `.next` over `master.key`. A crash at any step
  leaves both keys on disk; the next start (or the command again) finishes it. The previous key
  opens values until the Owner deletes the file. Audit `secret.master_key.rotate`.

## HTTP door

`GET /api/vaults/master-key` (`vaults.masterKeyStatus`), `POST /api/vaults/master-key/backup`
(`vaults.masterKeyBackup`, body `{ reauth }`) and `POST /api/vaults/master-key/backup/confirm`
(`vaults.masterKeyBackupConfirm`, body `{ keyId, proof }`): the Owner only (`AccessPolicy` action
`masterKey.backup`), the download with a strong factor in the request. Declared in `DoorRules.ts`. No
WS RPC or MCP tool reaches the key.

## Joined machines

A machine joined to a Hub (its `joined-hub.json` present) that never was a Hub keeps its store in
clear: the Hub writes a Sandbox's credential into the Sandbox's home, which a Podman Sandbox mounts
read-only, and a key stored beside the credential would protect nothing. A machine that was a Hub
(a master key, a key check or a sealed entry in its state directory) keeps its key when it joins
(`t3 join --force`): what it sealed still opens and new values, the credential included, are sealed
too. Without the key its sealed entries are an error, never bytes passed off as values.

## request_secret file answers

A `file` answer is for the agent's own shell, which reads it by path.

- **At rest, the source of truth:** `secrets/files/<id>.sealed`, sealed under its own purpose
  (`secret-file`, the id as associated data), for the whole TTL (24 h). A reboot or a logout loses
  nothing: a request whose file is missing writes it again from the sealed copy, so a command
  holding the path never reads another value.
- **For the agent, in memory where possible:** `SecretFilesDirectory.ts` picks
  `$XDG_RUNTIME_DIR/t3code-secret-files-<hash>`, else `/dev/shm/t3code-secret-files-<hash>` (one per
  state directory). It is created with `mkdir` and checked with `lstat`: a symlink, or a folder
  someone else made, is never used.
- **Without a folder in memory** (macOS and Windows desktop: a single-user local Hub), the answer
  goes to `secrets/delivered/` on the disk, folder `0700`, file `0600`. Each start empties it, the
  sweep removes expired files, and the Hub logs one warning per start that file answers touch the
  disk on this platform. Pasting a secret in chat keeps working there.
- At startup the folder in memory loses half-written files and answers whose sealed copy is gone.
- Answers that earlier versions left in clear in `secrets/files/<id>` are sealed in place one by
  one (keeping their age); one that cannot be read (a dangling symlink, no permission) is logged
  and removed, and never stops the others. No clear copy stays.
- Nothing logs an answer: logs and spans name the request and the count of files, never a value,
  so a path is never logged together with what it holds.
- The path only means something to a shell on the Hub machine: `file` delivery applies only when the
  Hub machine runs agents (development, `T3CODE_HUB_RUNS_AGENTS`, and the desktop app); a Thread in
  a Sandbox or on a joined machine cannot read a path on the Hub.

## Vaults (spec 5, ticket 02)

A Vault is a named set of secrets, each under an environment-variable name. `vaults/Vaults.ts`
is the one service; WS RPCs `vaults.*` and HTTP `vaults.reveal` are its doors.

- **Where values live:** never in the database. Each `own` or `copy` value is an entry of
  `ServerSecretStore.VaultValueStore`: its own folder, `secrets/vault-values/<value id>.sealed`,
  sealed under its own purpose (`vault-value`; `MasterKeyFile.STORE_NAMESPACES` gives each folder
  its purpose, never a name prefix). The store's own names are single file names, so no other
  caller reaches that folder. The startup authenticates them with every other entry, a rotation
  re-seals them, and `t3 secrets key import` refuses a key that does not open them. A joined
  machine (no master key) keeps no Vault value and runs no Vaults: every call answers
  `unavailable` and nothing is written to its database.
- **AI accounts' credentials** (spec 4) use the same scheme in `secrets/ai-accounts/`, purpose
  `ai-account-credential`; see docs/internals/ai-gateway.md.
- **Writes:** every value write goes to a new value id. The row (pointing at it), its version and
  the audit commit in one transaction; only then is the old value removed; if the transaction
  fails, the new value is. A crash between the two leaves a value no row points at, which the
  next start removes (it lists only the Vault values' folder).
- **Metadata** (migration 111): `vaults` (the Main vault is `vault-main`, made at the Hub's start,
  never deleted or renamed), `vault_entries` (`own` | `copy` | `link`, `value_id`; a Secret link
  keeps `linked_entry_id` and is «broken» once its original is gone), `vault_allowances`,
  `space_default_vaults`, `project_vault_choices` (used from ticket 03) and `vault_key_check`.
- **The database's key check** (`vaults/VaultKeyCheck.ts`): a known text sealed with the master key,
  checked first at the start, before anything is written to the database. Written at the first
  start; re-sealed when it opens only with the previous key (after a rotation; `t3 secrets key
  rotate` re-seals it at once); a key that opens the secrets folder but not this check stops the
  Hub: the database and the folder come from different Hubs.
- **Who may** (`AccessPolicy`, `vault.view|edit|manage|reveal` on a `VaultResource`, through
  `SpaceDirectory.authorizer`, decided once per request, which also keeps an agent bound to one
  Space to that Space):
  the Owner does everything and alone creates, renames, archives, deletes and reveals; the Main
  vault and the Owner's other Vaults are the Owner's alone; an Organization's Admins add, replace,
  rename and delete its secrets without reading them; its Members and Guests see names and
  descriptions. A Vault one cannot see answers like a missing one.
- **Links and copies** come only from the Main vault and need editing it (the Owner), so no Vault
  hands a Main vault value to anyone the Owner did not choose. A link reads its original at use, so
  rotating the original changes every link; a copy is sealed again under its own entry. Deleting an
  original with links answers with the links it would break until it is asked again with
  `breakLinks`.
- **Links seen from an Organization:** whoever does not see the Main vault learns nothing of the
  original: not whether it is short (`unmasked`), not its version or rotation (a link row's own
  version never moves), not its name. Its editors (the Owner, the Organization's Admins) see that
  it broke; its Members and Guests do not.
- **Names** (`secretNameRisk` in contracts, compared uppercased): `^[A-Z_][A-Z0-9_]{0,127}$`,
  unique in a Vault. `gateway`: the Hub's own (`T3_*`, `T3CODE_*`, the AI gateway's variables,
  among them the provider homes it sets such as `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), refused for everyone (`reserved-name`); it is checked
  before `dangerous`, so those names are never the Owner's to confirm. `dangerous`: what changes how tools run or whom they trust (process and
  loader options, interpreters' startup options, `GIT_*`, `SSH_*`, proxies and CAs, home, temp,
  shell, `XDG_*`, `BASH_FUNC_*`, and every AI provider's keys and base URLs such as
  `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `GOOGLE_*`): only the Owner (AccessPolicy
  `vault.dangerousName`), with `confirmDangerous`, audited `dangerous: true`. An Admin can neither
  add one, rename into one, nor replace or rename one the Owner set. **Values:** UTF-8 without
  NUL, at most 64 KiB; shorter than 6 characters is kept with a `short-value` warning and marked
  `unmasked` (never masked later).
- **Values out:** only `vaults.reveal` (HTTP), the Owner, after `Vaults.authorizeReveal` and then a
  strong factor in the request; audited `secret.reveal` before the value leaves. Values in arrive
  as `Schema.RedactedFromValue`, so no log, span or error shows them. Every change is audited
  (`vault.create|update|delete`, `secret.edit` with `op`) with names and kinds, never values.

## Variables y sellado («Variables, Secretos sellados y Secret providers», ticket 01)

Each entry is a **Variable** (configuration, shown and never masked) or a **Secret**, and a
Secret is **revealable** or **sealed** (nobody reveals it, not even the Owner).

- **Data** (migration 119, a rebuild of `vault_entries`): `class` (`secret` | `variable`) and
  `revealable` (0 | 1), both NULL on a link, which is what its original is (a broken link counts
  as a sealed Secret). A row written without them is a sealed Secret (the defaults fail closed).
  The entries that existed before stay revealable Secrets. A Variable is never `revealable`. A
  copy takes its original's class and seal (`Vaults.fromMain`; two rows, so no CHECK).
- **Reveal:** `Vaults.revealable` refuses a sealed one with `sealed` before anything else
  happens: before the HTTP door asks for the strong factor (409 `EnvironmentHttpConflictError`)
  and before its value is read. A Variable can still be revealed by the Owner, but no client offers it.
- **Changes** (`vaults.entries.put`, `class` and `allowReveal`), each for whoever edits the Vault:
  - **Seal** (`allowReveal: false`) is one way.
  - **Allow reveal** (`allowReveal: true`) on a sealed Secret, and **Secret → Variable**,
    need a `value` in the same request (`needs-new-value`). The old value is removed unread, as a
    replace does.
  - **Variable → Secret** gives a sealed Secret.
  - A new Secret is sealed unless `allowReveal`.
  - A link's class or seal is changed at its original (`not-linkable`).
  - Audited `secret.edit` with `op` `seal`, `allow-reveal` or `class` (detail `class`), beside
    the usual `replace`.
  - The Secret → Variable change without a new value (revealable + strong factor) is not built.
- **Who reads a Variable's value:** `vault.readVariables`, which is `vault.view` without Guests (an
  invitation can leave the Organization; decision 4). `Vaults.shown` is the one place that reads
  one, for rows of class `variable` only. It is the only `value` a WS answer carries
  (`VaultEntry.value`, in `vaults.entries.list|put|link|copy`; `DoorRules.test.ts` holds both).
  `vaults.threadEnvironment` gives `class`, never a value.
- **`looks-like-credential`** (`looksLikeCredential` in contracts, the same function in the form
  and in the save): a name ending `_TOKEN|_SECRET|_PASSWORD|_KEY|_PAT`; a value starting `ghp_`,
  `github_pat_`, `glpat-`, `sk-`, `xox`, `AKIA` or `-----BEGIN`; a three-part JWT; or 20+
  characters with no spaces, not a URL, with entropy ≥ 4 bits per character. It is a warning and never blocks.
- **Masking:** a Variable is never masked.
  - The effective set carries `class`. `SecretMasker` leaves Variables out of a Thread's and a
    User's maskers, and out of the start's `rememberKnownSecrets`.
  - `SecretDelivery` delivers a Variable with `plain: true` in `secretEnv` and does not record it
    in `thread_secret_values`.
  - The executor (`EnvironmentAgent`) and a terminal's history skip `plain` ones.
  - An executor before this ignores `plain` and masks Variables in its own logs. That is more
    masking, never less, so no contract bump.
  - A Variable that becomes a Secret is masked from then on. What was already stored in clear
    stays as it was.
  - A Secret that becomes a Variable stays masked where it was delivered before.
  - The fingerprint marks Variables, so a class change reaches the next process.
- **What sealing does not cover** (accepted):
  - whoever has the Hub's disk and the master key decrypts the store;
  - the agent that receives a value can print it, and its AI provider sees what it reads.
  - Sealing protects reading through the Hub's UI and APIs.
- **Clients:** web only in this ticket. `entryActions` (client-runtime) offers «Reveal» only on a
  revealable Secret, and also offers «Seal», «Allow reveal», «Make variable» and «Make secret».
  Mobile keeps working with the new fields and will show them in a later ticket.

## Provider entries («Variables, Secretos sellados y Secret providers», ticket 02)

A Provider entry stores where to read its value: a Secret provider from the Owner's
`settings.secretProviders` and a reference. It never stores a value. Why the Hub reads providers
on the Thread's behalf: [ADR 0008](../adr/0008-vault-entries-read-from-secret-providers.md).

- **Data** (migration 120, another rebuild of `vault_entries`): `kind = 'provider'`,
  `provider_id`, `provider_reference` (at most 1024 characters) and `provider_scope_id`. The scope
  stays NULL until ticket 03 adds scopes. A Provider entry holds no `value_id` and is always a
  sealed Secret (CHECK).
- **Who:** only the Owner adds one or changes its reference (`vault.providerEntry`, through
  `vaults.entries.put` with `provider`). There is no UI for it yet. Ticket 03 lets Admins add them
  within the scopes allowed to a Vault. Editors may still delete one.
  - In the list, a Provider entry shows its provider's label; only editors also see its
    reference.
  - It is «broken» for everyone when its provider is gone, or is of a kind this Hub has no driver
    for. A broken entry is not delivered, like a broken link.
  - It cannot be linked or copied (`not-linkable`): «Copy into the Hub» is ticket 08.
  - Reveal answers `sealed` without asking the provider.
- **Driver contract** (`packages/secret-provider-core`):
  - `read` gives each reference either `{ value, expiresAt?, version? }` or a class of error:
    `not-found`, `forbidden`, `unavailable` or `invalid`. It never carries text, because a
    provider's own output (such as `op`'s stderr) can echo what it holds.
  - `test` reports whether the configured sign-in works.
  - 1Password keeps its behaviour: a timeout is `unavailable`, a failed `op` is `not-found`, and
    `test` runs `op whoami`.
  - The settings' `SecretResolver` maps a result back to a value or nothing, and keeps its cache
    for the server's life.
- **Reads** (`vaults/ProviderReads.ts`), the only module that asks a provider for a Vault entry:
  - The reference is checked when saved and again before every read: the driver's `isReference`,
    then no `.`/`..` segments, no empty segment (`//`), no `%2e`/`%2f`/`%5c`, no backslash, no
    control characters. Ticket 03 adds a scope's allowed paths to the same check.
  - Reads are grouped by provider and scope: providers in parallel, one batch each, with a 10 s
    timeout per batch. A batch that times out or dies is `unavailable`, and the cause of a death
    is not logged.
  - Values are cached by `(provider, scope, reference)` until `expiresAt`, or for the provider's
    `refreshIntervalSeconds` (5 minutes by default). Failures are not cached.
  - Concurrent reads of the same reference collapse into one.
  - A provider whose settings change, or that is removed, is dropped from the cache at once.
- **Delivery** (`SecretDelivery`):
  - The plan reads Provider entries through the cache. Each one's value id is
    `delivered:<HMAC-SHA256(key, value)>`. The key is 32 random bytes kept as `vault-fingerprint-key`
    in the store. So the fingerprint changes when a provider rotates the value, and it never holds
    the value or a plain hash of it.
  - If an entry fails, the whole start fails with `SecretProviderReadError { reason, provider,
    scope, entries }`: names only, and nothing of the set is delivered (decision 3).
  - The run fails with code `secret_provider_<reason>` (retryable when `unavailable`). On web and
    desktop the failed run shows «Retry», which sends its message again as a new turn. Mobile:
    ticket 16.
- **Masking:** a delivered value is sealed in `DeliveredValueStore`
  (`secrets/delivered-values/`, purpose `delivered-value`) and recorded as a `delivered:<id>`
  row of `thread_secret_values`. SecretMasker reads it back from that store, so it stays
  `[NAME]` after a rotation.
  - `DeliveredValues` removes a deleted Thread's rows, and every value no other Thread holds, as
    the `thread.deleted` event arrives.
  - At start it also sweeps values that no row holds.
- **Not built yet:** scopes and Settings → Secret providers (03), OpenBao (04), Dynamic secrets
  (06), Provider Variables, and the `secret.read` audit.

## Secret files and Template entries («Variables, Secretos sellados y Secret providers», ticket 05)

- **Data** (migration 122, a rebuild of `vault_entries`):
  - `delivery`: `env`, `file` or `none`.
  - `template_text`: names and literal text only, never a value, so it is stored in clear.
  - `kind = 'template'`.
  - A template holds no value, is never revealable and never `none` (CHECK).
  - «`none` only if a template of the Vault names it» spans rows: it is the put warning
    `not-used-by-template`, not a CHECK.
  - A template's stored `class` (shown in the list) is recalculated in every write to its Vault.
    Delivery recomputes it from its entries as they are then: a Variable only if every one is.
- **Templates** (`packages/contracts/src/vaultTemplates.ts`, one parser for the web and the Hub):
  - Syntax: `{{ NAME }}` and `{{ NAME | f1 | f2 }}`, with the filters `base64`, `base64decode`,
    `urlencode`, `json` (no outer quotes), `trim` and `path`. `path` goes alone. `{{"{{"}}` is
    the only escape.
  - At most 64 KiB and 64 references.
  - When saved, every name must be a non-template entry of the same Vault, and `| path` needs an
    entry delivered as `file`. That entry cannot leave `file` while a template takes its path.
  - Link or copy of a Main vault template: `not-linkable`. Reveal answers `sealed`.
  - Who: whoever edits the Vault (`vault.edit`). Its text is shown like a Variable's value: to
    the Owner, Admins and Members, never to Guests.
  - There is no preview door: the form previews with the shared parser, as `[NAME]`, and reads
    nothing.
- **Effective set** (`EffectiveVaults`):
  - A `none` entry takes no name, so a same-named entry of another Vault still delivers.
  - A template's entries are found by name in its own Vault, even when shadowed or `none`. A
    missing one, a broken link or another template leaves the template out (broken).
  - A dangerous-named template goes only as the Owner last set it, like a Provider entry.
- **Delivery** (`SecretDelivery`):
  - The plan reads a template's Provider entries in the same grouped round. Its value id is
    `template:<HMAC(text, entries' value ids)>`, so a rotation of any entry reopens the session.
    No value is read to plan.
  - Any `file` entry needs the target's executor contract 16 and a root in memory
    (`MachineSecretFiles`: the Hub machine's own, a joined machine's from its hello). Otherwise
    the start fails with `SecretDeliveryError`:
    - `outdated-machine-files` before contract 16;
    - `files-not-in-memory` without a root in memory, naming the entries.
      Nothing is written to a disk, sent, or turned into a variable instead.
  - `filesFolder` is `HMAC(key, "secret-files|<thread root>|<user>")`, cut to 32 hex: the same for
    every process of that Thread root and User on a machine, and unguessable without the Hub's key.
  - `resolve` renders each template with `| path` = `<root>/<filesFolder>/<NAME>`. A filter that
    cannot take its value fails the start (`template`, names only). A provider failure fails it
    whole (decision 3).
  - Masked in the Thread before the process starts: every Secret delivered, the rendered text of a
    Secret template (sealed in `DeliveredValueStore` as `delivered:<id>`), and every Secret entry
    the template took, `none` ones included.
- **Executor contract 16** (`secretEnv.files: [{ name, content, mode, plain? }]`, `filesFolder`,
  hello `secretFilesRoot`, operation `secrets.refreshFiles`):
  - The Hub's last guard (`RemoteEnvironments.invoke`) refuses files to a machine before 14, so
    an older executor never drops them silently.
  - On the machine, `secrets/ThreadSecretFiles.ts` is the only writer:
    - Root: `<$XDG_RUNTIME_DIR | /dev/shm>/t3code-thread-files-<hash(stateDir)>`, only if `statfs`
      says tmpfs or ramfs. It reuses `SecretFilesDirectory`'s `ownFolder`: 0700, no symlink, this
      uid. There is no disk fallback: without a root, every file is refused.
    - Each file is written to a fresh `O_CREAT|O_EXCL|O_NOFOLLOW` name with exactly its mode, then
      renamed over the old one. A link planted at a file's path is replaced, never followed.
    - `materialize` returns the env with each file's path as a `plain` variable instead of its
      content, and a release. A provider session holds the folder for its scope, a terminal or
      setup script until its process exits (`terminal/Manager.ts`). The last release removes it.
    - The whole root is swept at every start.
    - `secrets.refreshFiles` rewrites a held folder in place and never creates one (`not-held`).
      Leases (06) and identity tokens (07) will call it; nothing does yet.
  - The Sandbox's server uses the container's private `/dev/shm` (tmpfs); `podman run` is
    unchanged. The Hub machine and a personal Linux machine use `$XDG_RUNTIME_DIR` or `/dev/shm`.
    All Users of one machine share its uid (ADR 0004).
- **Masking of multiline values** (`secretForms`): the whole value, its CRLF form, and each line of
  20 characters or more without spaces. The base64 and URL forms already cover every value of 6
  characters or more.

## Provider scopes («Variables, Secretos sellados y Secret providers», ticket 03)

A Provider scope sets what Vaults may read through a provider: the provider role the Hub signs in
with (`auth`) and the path prefixes allowed. The Owner decides which Vaults may use each scope.

- **Data** (migration 121):
  - `secret_provider_scopes` (provider, label, `auth_json`, `allowed_paths_json` with at least
    one prefix, `allowed_dynamic_json` for ticket 06, `writable` for ticket 08, `probe_reference`);
  - `vault_provider_scopes` (Vault ↔ scope).
  - `auth` holds only non-secret fields (`role`, `mount`, `method`, `namespace`, `audience`,
    `project`, `environment`, `PROVIDER_SCOPE_AUTH_FIELDS`). Any other key is refused, both by the
    RPC schema and by the service. Credentials per scope (an AppRole secret ID per scope) are
    not part of ticket 04: one provider is connected per identity instead. A kind lays `auth`
    over its config only through `withScopeAuth` (see «OpenBao driver»).
- **Providers themselves** stay in `settings.secretProviders`, behind the existing settings door
  (`server.updateSettings`, the Owner). A definition's `credentialFields` are
  `SettingsSecretValue`s:
  - a literal is sealed in the store as `secret-provider-<id>-<field>` and redacted for clients
    and in `settings.json`, by the same `settingsSecrets` machinery as other credentials;
  - a reference names another provider and is filled in by `ProviderReads` before the driver runs;
  - a credential read from its own provider, directly or in a circle (A → B → A), is refused at
    write.
  - A change is audited `secret_provider.create|update|delete` with the kind and the names of the
    fields that changed, never a value.
- **Who** (`secretProvider.manage`, Installation RPCs, the Owner only):
  - `secretProviders.scopes.list|put|delete|allow`, `secretProviders.test` and
    `secretProviders.impact`.
  - A Vault's editors read `vaults.providerScopes`: the scopes allowed to it, without `auth`, and
    for the Owner also each provider as «Direct».
  - `vault.providerEntry` now means the same as `vault.edit`. Vaults then requires an Admin to
    name a scope (never «Direct») that is allowed to the Vault.
- **The rule** (`providerScopeRules.ts`), checked at save and again before every read:
  - the scope exists, reads the entry's provider, and is allowed to the entry's Vault;
  - the reference is one of the prefixes, or lies under one at a segment boundary (`/`, `#`, `?`),
    case-sensitive. `kv/acme` admits `kv/acme`, `kv/acme/app` and `kv/acme#token`, but not
    `kv/acme-evil` or `KV/acme`. The path tricks of ticket 02 are refused first.
- **Changes that break entries:** narrowing a scope, changing its provider, deleting it, or taking
  it back from a Vault answers with the entries that would break and changes nothing until it is
  sent again with `confirm`. After that those entries are «broken»: listed as such, not delivered,
  and the start does not fail.
- **«Test connection»:** the driver's `test` for sign-in, plus a read of the scope's
  `probe_reference`, which must lie inside the scope's prefixes both when saved and when tested.
  It reads directly (no cache), answers only with classes, and is audited `secret_provider.test`.
- **Web:** Settings → Secrets has «Test connection» per provider, the «Provider scopes» section,
  and on removal a list of what would break. Each Vault has «Add a Provider entry» (choose a
  scope, or «Direct» for the Owner). Mobile comes in ticket 16.

## OpenBao driver («Variables, Secretos sellados y Secret providers», ticket 04)

`packages/secret-provider-openbao` reads KV v1 and v2 from OpenBao or HashiCorp Vault.

- **Config** (`shared/definition.ts`):
  - `address`: an origin, `https://`, or `http://` only to loopback;
  - `namespace?`;
  - `caCert?`: inline PEM, added to `tls.rootCertificates`. There is no field that disables
    verification, and an unknown key such as `tlsSkipVerify` is dropped by the schema;
  - `mounts`: `[{ path, version: 1 | 2 }]`, declared, never discovered;
  - `authMethod` with its fields: `kubernetes` (`authRole`, `tokenFile?`), `jwt` (`authRole`,
    `tokenFile`), `approle` (`roleId`, `secretId`), `token` (`token`), `cert` (`clientCert` as
    inline PEM, `clientKey`); plus `authMount?` and `refreshIntervalSeconds?`.
  - A certificate field that holds a `PRIVATE KEY` is refused.
  - `credentialFields` are `token`, `secretId` and `clientKey`: sealed by `settingsSecrets`, and
    `""` on disk and for clients.
- **References:** `mount/path?version=N#field`.
  - `isReference` checks the syntax: at least two segments, no `.`/`..`/empty segment, a field,
    `N` > 0.
  - `configReferenceProblem` checks the reference against the provider's config: it must lie
    under a declared mount by whole segments (the longest one wins), and `?version` only on v2.
  - `ProviderReads.referenceProblem` asks both when an entry is saved; the driver asks again on
    read (`invalid`).
- **Reads** (`server/driver.ts`):
  - one GET per distinct path and version, concurrency 8. That is `<mount>/data/<path>` for v2
    and `<mount>/<path>` for v1;
  - a field that is a string is returned as is; a number or boolean as text; anything else is
    `not-found`. v2 reads carry `version`.
- **HTTP** (`server/http.ts`): `node:https` with one keep-alive agent per (origin, CA, client
  cert), 5 s per request, at most 1 MiB of body.
  - Status alone classifies: 404 is `not-found` (for a sign-in, `invalid`); 401/403 are
    `forbidden`; 400 is `invalid`; anything else, a timeout, or TLS or network failure is
    `unavailable`.
  - A non-2xx body is never read. Logs carry the operation and the status, never a path, body or
    token.
  - A 3xx is followed once and only to the same origin. A redirect elsewhere is `unavailable` and
    is not followed, so the token never leaves its origin.
- **Tokens** (`server/tokens.ts`), only in memory:
  - one per identity, a hash of address, namespace, CA, method, mount, role, file, and
    credentials. Scopes with the same role share it;
  - a sign-in in flight is shared by every caller;
  - at 2/3 of the lease, a forked fiber renews it (`renew-self`), or signs in again when the token
    is not renewable. Reads go on with the current token meanwhile. An expired token waits for a
    new sign-in.
  - The `token` method signs in by `lookup-self` and cannot sign in again.
  - A 403 on a read is taken as a lost token: at most **one** new sign-in and **one** retry of the
    refused paths per `read`, then `forbidden`. A `token` method does not retry.
- **Files** (`server/fileRoots.ts`): `tokenFile` is typed by the Owner, and the Hub sends what it
  reads to an address the Owner typed. So a file is read only under the operator's
  `T3CODE_SECRET_PROVIDER_FILE_ROOTS`: colon-separated absolute directories, `/var/run/secrets` by
  default, never `/`. The rules:
  - the path is plain: absolute, with no `.`, `..` or empty segment;
  - it lies under a root as written, and again after `realPath`, so a link that escapes is
    refused;
  - it is a regular file of at most 64 KiB, checked by `stat` before it is opened and by `fstat`
    after;
  - a refused file is never opened.
  - It is checked at save, through the driver's `configProblem`, which `serverSettings` runs for
    each kind with a driver, and again at every sign-in (`invalid`).
- **Scope `auth`** (`ProviderReads`): the scope's `auth` (read with `scopeAuthOf`, parsed by
  `authOf`, keeping only the allowed fields) goes through the definition's `withScopeAuth` before
  the driver runs.
  - OpenBao maps `role`, `mount` and `namespace`. It refuses another `method` or any other key.
  - A kind without `withScopeAuth`, or a refusal, makes the scope's reads `invalid`. It never reads
    with the provider's broader identity. A scope whose `auth` cannot be read is `invalid` too.
  - The cache key is the provider's config key, a NUL, and the `auth`. A changed role is read
    again, and a settings change that leaves the provider alone keeps scoped values.
  - «Test connection» for a scope signs in with its `auth`.
- **Tests:**
  - an in-process fake OpenBao over real HTTP/HTTPS/mutual TLS (`test/fakeOpenBao.ts`), using the
    test-only certificates in `test/fixtures/tls` (regenerated by `generate.sh`; their keys
    protect nothing);
  - `openbao.live.test.ts` runs against `bao server -dev` only with
    `T3CODE_TEST_LIVE_OPENBAO=1` and `bao` on the PATH;
  - a run on k3s with Kubernetes auth is left for a person (ticket 18).

## Workload identity («Variables, Secretos sellados y Secret providers», ticket 07, ADR 0009)

The Hub is an OIDC issuer for the work it runs (`apps/server/src/identity/`).

- **Issuer** (`IdentityIssuer.ts`):
  - `T3CODE_IDENTITY_ISSUER`, else `T3CODE_PUBLIC_URL`'s origin;
  - an origin only: `https://` (`http://` to loopback), no path, user, query or fragment;
  - never a request's Host header;
  - without one, identity is off: an identity entry is refused (`identity-no-issuer`), and a
    delivery or a `hub_identity` sign-in gets no token.
- **Keys** (`IdentityKeys.ts`):
  - ES256 (P-256), `kid` the RFC 7638 thumbprint;
  - the private JWK is sealed in `ServerSecretStore` as `identity-signing-<kid>`;
  - the public half and the schedule live in `identity_signing_keys` (migration 123): `publish_at`,
    `sign_from`, `sign_until` (30 days), `retire_at` (7 days after);
  - `maintain` drops retired rows and rows whose sealed half is gone, makes a key when none signs,
    and makes the next one 7 days before the current one ends. It runs before every signature and
    publication, and hourly once any key exists. Keys are made lazily: none until identity is used.
  - **Never exported:** no door or command returns them, and `MasterKeyFile.importKey` deletes the
    `identity-signing-*` seals (same key or not), so a restored Hub makes new keys.
  - Residual risk: an old database copy with its master-key backup opens the keys of that time,
    each valid at most 37 days.
- **Public documents** (`identity/http.ts`, raw routes in `http.ts`):
  - `GET /.well-known/openid-configuration` and `GET /.well-known/jwks.json`;
  - the JWKS is built from an allow-list of members (`kty crv x y kid alg use`); never `d`;
  - `Cache-Control: public, max-age=300`;
  - while `IdentityTokens.inUse` is false (no `identity` entry, and no provider whose definition's
    `hubIdentity` answers, question 12), the route hands the request to `handleStaticAndDevRequest`,
    the same handler as any unknown path, so the answer is identical (`http.test.ts` compares them).
  - Listed in `DoorRules` (`RAW_ROUTE_RULES`, `AMBIENT_COOKIE_RULES`) and `MaskedPaths`.
- **Tokens** (`IdentityTokens.ts`):
  - `iss`, `aud` (one string, never a list), `iat`, `nbf = iat − 60 s`, `exp`, `jti`;
  - a Thread's token: `sub = t3:space:<space id>:project:<project id|->:user:<login>`, plus
    `username`, `groups: ["t3:space:<space id>"]` and the facts read from the rows (`users`,
    `spaces`, `space_memberships`, the Thread's projection, `sandboxes` and
    `dedicated_sandbox_credentials` for `environment_kind`). Never a Vault or entry name.
  - The Hub's token: `sub = t3:hub:<installation>`, `scope` the Provider scope's id or `direct`,
    5 minutes.
  - The audience is only what the Owner saved (the entry or the provider's config). Refused: empty,
    more than 256 characters, spaces or commas, or an origin of the Hub itself.
  - TTL 60 s to 1 h (default 10 min). A token is reused while more than a third of its life is
    left (per Thread, User, machine, entry, audience and TTL; for the Hub, per audience and scope).
  - Each new token is audited as `identity.issue` with `aud`, `sub`, `jti`, `exp` and `thread`,
    actor `system`, never the token.
- **Entries:**
  - `vault_entries.kind = 'identity'` with `identity_audience` and `identity_ttl_seconds`. The CHECK
    makes it a sealed Secret with no value, delivered as a `file`.
  - `vault.identityEntry` is Owner-only, also for an Admin's own Organization Vault, and for
    edits and deletes too.
  - It is never linked or copied out of the Main vault. A template names it only as
    `{{ NAME | path }}`: refused at save, and broken (`EffectiveVaults.templateInputs`) if
    written otherwise.
- **Delivery** (`SecretDelivery`):
  - the planned variable's `valueId` is `identity:<HMAC(entry, audience, TTL)>`, never a token, so
    a new token does not change the fingerprint;
  - `resolve` signs (or reuses) the token, seals it as `delivered:<HMAC>` and remembers it for
    masking, then sends it as a file;
  - with no issuer or key, the whole start fails (`SecretDeliveryError` `identity`);
  - contract < 16 or no folder in memory fails closed, as for any file (ticket 05).
- **Refresh:**
  - each resolve with identity files keeps the folder (machine, `filesFolder`, Thread facts,
    entries) in memory, due at two thirds of the shortest token's life;
  - `IdentityRefresher` calls `SecretDelivery.refreshIdentityFiles` every 10 s with a sender: the
    Hub machine's `ThreadSecretFiles.refresh`, or `secrets.refreshFiles` over a joined machine's
    socket. It is `refreshFiles`' first caller.
  - A due folder is checked against the Thread's effective set (entry, audience and TTL still
    there). Its tokens are re-signed, sealed and remembered for masking before they are sent, and
    only the identity files are rewritten.
  - `not-held` or loss of reach forgets the folder; a failure is retried 30 s later.
  - The folder is per Thread root and User (ticket 05), so it holds the last resolved Thread's
    token.
- **`hub_identity`:**
  - `SecretProviderDefinition.hubIdentity(config)` names the audience. `ProviderReads` signs the
    Hub's token for the group's scope (null: «Direct») and puts it in the config's `identityToken`
    for that driver call alone, «Test connection» included.
  - OpenBao's `hub_identity` method logs in at `auth/<authMount ?? "jwt">/login` with
    `{ role, jwt }`. Its session identity excludes `identityToken`, so a newer JWT is the same
    sign-in.
  - A saved `identityToken` is refused by the driver's `configProblem`.
- **Tests:**
  - `IdentityTokens.test.ts`: `jose` against the served JWKS (wrong `aud`, `exp`, `nbf`, unknown
    `kid`, a 45 s slow clock), rotation with `TestClock`, raw JSON without private members,
    regeneration after a restore, reuse, `inUse`, and no token in logs or audit;
  - `http.test.ts`: identical answer while unused, and the issuer whatever Host is sent;
  - `ServerSecretStore.encryption.test.ts`: the import drops the seals;
  - `Vaults.test.ts`, `SecretDelivery.test.ts`, `ProviderReads.test.ts`,
    `IdentityRefresher.test.ts`, and the OpenBao driver tests;
  - a live k3s run is left for a person (ticket 18).

## Allowing Vaults (spec 5, ticket 03)

Which Vaults may reach a Space or a User is one rule, `vaults/VaultReach.ts`, used by the doors
that choose Vaults and by the effective set:

- **The Main vault** reaches only the Owner's Personal space, where it is always a default (a
  fixed one, «Always» in Settings). It is never allowed to anyone (`main-vault`): its secrets
  reach others only through Secret links or copies.
- **An Organization's Vault** reaches its own Organization, without an allowance, and nothing
  else: allowing it to another Space or to a User is refused (`not-allowed`), so what its Admins
  write stays in their Organization.
- **One of the Owner's other Vaults** reaches the Spaces and Users the Owner allowed it to
  (`vaults.allow`, AccessPolicy `vault.manage`: the Owner; audited `vault.allow`). Taking it back
  never needs the Space or User to exist any more. Taking it back from a Space also drops that
  Space's default and its Projects' choices of it (Projects by `SpaceDirectory.projectSpaceSql`,
  so one from before Spaces counts as the Owner's Personal space's), so allowing it again never
  brings them back unseen. Allowing it to a User shows the shared-Sandbox warning first
  (ADR 0004): only that User's turns, terminals and scripts receive it, but other agents in the
  same Sandbox can read a running process's environment.
- Allowance rows on the Main vault or on an Organization's Vault are ignored when reading, so a
  stray row never widens what a Vault reaches.
- **Who sees and edits the Owner's allowed Vaults** (`AccessPolicy.decideAllowedVault`): whoever
  works in an allowed Space, or is an allowed User, sees its names. An Admin edits its secrets only
  while it reaches nothing but Organizations they run (no User, no Personal space, no other
  Organization). Whom a Vault is allowed to is shown to the Owner alone.

**Choosing** (`vault.choose`, decided on the Space: the Owner anywhere, a Personal space
included; an Organization's Admins while it is open): `vaults.spaceDefaults.set` replaces a
Space's defaults, in order; `vaults.projectChoices.set` adds, removes or clears (`inherit`) one
Vault for a Project. Both accept only Vaults allowed to the Space (`not-allowed`) and are audited
`vault.choose` per effective default or choice changed (`scope`, `choice`, `position`,
`projectId`). An archived Vault never becomes a default or a Project's add; one already a default
may stay or be unchecked. The fixed defaults (`VaultReach.fixedDefaults`: the Main vault in the
Owner's Personal space) are never a Project's add or remove, in the service, in `forThread` and in
the UI. `vaults.choices` shows a Vault's names only to whoever may `vault.view` it. The scratch Project
(Threads without a Project) takes no choices: it spans every Space. `vaults.choices` reads them for
whoever sees the Space.

## The effective set (`vaults/EffectiveVaults.ts`)

`EffectiveVaults.forThread({ threadId, actingUserId })` is the only place that computes which
secrets a turn, a terminal or a script of a Thread receives. Delivery (ticket 04), masking (05),
the agent's list of names (06) and the move plan (07) call it. Recomputed on every call, never
cached: a rotation, a revocation or a Membership that ends takes effect at the next turn or
terminal.

1. The Thread's Space (`SpaceDirectory.placementOf`: the Thread's own, else its Project's) must
   be one the acting User works in, else `forbidden`: nothing is computed for a removed Member.
2. Space side: the Space's defaults, plus the Project's `add`s, minus its `remove`s, all limited to
   the Vaults allowed to that Space now. No choice or default naming a Vault that does not reach
   its Space is kept («Losing reach»: dropped at every loss, again when the Vault is allowed there,
   and once by migration 115 for rows earlier Hubs left).
3. User side: the Vaults allowed to the acting User, whichever Space the Thread is in. Never
   another User's, even in the same Thread or Sandbox.
4. Without archived Vaults, broken Secret links (a link's value and length are its original's),
   and names `secretNameRisk` calls `invalid` or `gateway`, however they got in. `dangerous` names
   are delivered (only the Owner sets them) and marked.

**Precedence for a name several Vaults define:** the User's own Vaults, then the Project's adds,
then the Space's defaults. Within the User's and the Project's, the Owner's order (Settings →
Vaults: the Main vault, then position, then name); within the defaults, the order they were set
in (the Main vault first in the Owner's Personal space). The losers are listed as `shadowed`, and
the Thread's «Secrets» panel says «Wins over …». Precedence only picks among entries already
allowed: it never lets a name in that rule 4 keeps out.

It returns value ids (`VaultValueStore` entries; a link's is its original's), never values: only
delivery reads them. `vaults.threadEnvironment` (WS, the Thread must be visible) computes it for the
caller and strips value and entry ids: each User sees what their own turns would receive.
`DoorRules.test.ts` checks that only `server.ts`, `ws.ts`, `SecretDelivery` and the Project service
(with its layer in `orchestration-v2/runtimeLayer.ts`, move plan only) reach the service and that no
Vault RPC answers a `value` or a `valueId`.

## Delivery as environment variables (`vaults/SecretDelivery.ts`, spec 5 ticket 04)

`SecretDelivery` is the one place that turns the effective set into the environment of one process.
`plan` names what a process would get (names and value ids, and a fingerprint of them) without
reading a value; `resolve` reads the values from `VaultValueStore` only when a process actually
starts, and hands them to the caller, which sends them on at once. Nothing on the Hub keeps them.

**Who receives what** is decided on the Hub, never from a client or an agent:

- a turn: the Thread's owner (`orchestration_v2_projection_threads.owner_user_id`; a child Thread
  speaks for its root's owner), whoever sends the turn. Nobody continues another User's Thread
  (`thread.continue`, also for the Owner and Admins), so another User's own Vaults never reach it.
  A Thread without an owner (from before Users) gets nothing;
- a terminal: the signed-in User who opens or attaches it. Terminals are `work` doors: only the
  Thread's owner passes (`SpaceVisibility.claimWork`), so no User attaches another's shell;
- a setup script on the Hub machine: the Thread's owner.

**The doors** (each calls `SecretDelivery`, `DoorRules.test.ts` lists them):

| Door                                    | Where                                | Field on the wire                  |
| --------------------------------------- | ------------------------------------ | ---------------------------------- |
| A provider session opens                | `ProviderSessionManager.open`        | `provider.openSession` `secretEnv` |
| A terminal opens                        | `ThreadWorkspace.terminalOpen`       | `terminal.open` `secretEnv`        |
| An attach starts a shell (new terminal) | `ThreadWorkspace.terminalAttach`     | `terminal.stream` `secretEnv`      |
| A setup script on the Hub machine       | `ProjectSetupScriptRunner`           | in process                         |
| Choosing a provider session id          | `Orchestrator` (`mayReceiveSecrets`) | none                               |

Dev servers started from a terminal, by the agent or by a script inherit that process's
environment; previews get nothing of their own. MCP tools that run commands do so inside the agent
or a terminal, and so with that process's environment. A moved Thread's setup script on the target
machine (`move.prepare`) and setup scripts of other machines get no secrets yet.

**Rules:**

- a machine that does not serve the Thread's Space (`servesSpace`, spec 3 ticket 12) gets nothing;
- `resolve` on a machine of executor contract 9 or earlier with a non-empty set fails
  (`SecretDeliveryError`, `outdated-machine`, «<machine> needs an update to receive this Thread's
  secrets»): the turn fails with it, a terminal open answers it (`secrets_unavailable`). An empty set
  works as before, and such a machine still reattaches a running shell (the attach goes without
  `cwd`, so it cannot start one). `RemoteEnvironments.invoke` refuses, never strips, any `secretEnv`
  bound for such a machine: the last guard;
- a `dangerous` name is delivered only while the Owner is the last who set it (`updated_by`);
- the fingerprint (sha256 of the User and each name and value id) names the set; an empty set is
  `none`, sent explicitly, so a set that became empty is a change too.

**Provider sessions.** `ProviderSessionManager` plans the set at each open and keeps each live
session's fingerprint; under the session's open lock it decides: the same set reuses the session
(no value read); another set releases the Thread's session and opens a new one, whose values are
read then. A session with a turn or background work under way is never killed for it: it goes on
with what it started with, and the first open after that work ends opens the new one. A process
that holds secrets serves one Thread, and the instance-wide session a shared provider (Codex) uses
for every Thread never gets secrets; this is checked before anything is released. A Thread that may
receive secrets (`mayReceiveSecrets`: one query over the Vaults that could reach its Space or owner,
a superset of the set) gets its own session id. Adapters with `receivesSecretEnv` take a non-empty
set: Claude, Codex, Pi, Muse, OpenCode (its own server per session; not an external `serverUrl`),
and ACP agents whose own runtime starts them with `processEnvironment` (ACP registry agents such as
Replay, Kiro, fx, Grok). Cursor (its SDK runs in the server's process), Antigravity and any adapter
built with a custom runtime refuse a session with secrets (`SecretDeliveryError`, `provider`)
instead of starting without them; with an empty set they work as before.

**Terminals.** The Hub first sends only the set's name (`{ fingerprint }`, or `none` with no
variables). A running shell keeps what it started with; with another set its snapshot says
`secretsStale`, shown as «Secrets changed: reopen to update». A shell that would start answers
`secrets_required`, and the Hub then reads the values and sends them: a reattach to a running shell
reads none. `TerminalManager` never starts a shell that had secrets without the Hub's values (a
restart through an attach included), puts them in the spawn environment only, and keeps only the
fingerprint.

**On the machine** (`EnvironmentAgent`): `secretEnv` goes into the provider adapter
(`openSessionWithSecrets`) or the terminal, and nowhere else: never in arguments (agent scopes
wrap commands without it), files, logs, spans or the idempotency memory (which keeps answers, not
requests).

**What it does not cover (accepted):**

- processes already running keep their environment after a revocation or rotation, until they end
  or are reopened (a Project's move and a User's removal close terminals instead: «Losing reach»);
- in a shared Sandbox any process of the Space can read another's environment
  (`/proc/<pid>/environ`, ADR 0004): per-process delivery keeps one User's secrets out of another's
  processes, not out of reach of a determined agent in the same Space;
- a provider process keeps its environment in memory for its life; Claude's adapter also keeps the
  session's set to start each turn's process with it; a busy session keeps an old set until its
  work ends;
- Codex's own shell policy leaves out variables whose names contain `KEY`, `SECRET` or `TOKEN` from
  the commands it runs, unless its config says otherwise.

**A direct AI account credential** (spec 4 ticket 07) rides the same `secretEnv` of
`provider.openSession` as one more variable (`secretEnv.aiCredential` names it; it wins over a
Vault's of that name), never a terminal's or a setup script's. It is decided by
`AiGatewaySessions`, not by `SecretDelivery`, and masked like a Vault value: `thread_secret_values`
holds it as `ai-account:<credential id>`, which `SecretMasker` reads from the AI accounts' credential
store. See docs/internals/ai-gateway.md, «Direct credentials».

## Masking (`vaults/SecretMasker.ts`, spec 5 ticket 05)

Every secret value that could surface in a Thread's history is stored and shown as `[NAME]`. One
rule, `@t3tools/shared/secretMasking`, and one service on the Hub, `SecretMasker`.

**The rule** (`makeSecretPatterns`). A value is found in every form `secretForms` lists: as
written; with CRLF line ends (a terminal's `onlcr`, a multi-line PEM key); as a JSON string and
with non-ASCII as `\uXXXX`; URL-encoded (upper- and lower-case escapes, `+` for spaces); in hex
(both cases); in standard and URL-safe base64 at the three byte alignments a longer base64 text
can put it in (only the characters that depend on the value alone, at least 8); and base64 or hex
wrapped across lines (MIME, PEM). Values shorter than 6 characters are never masked (open question
3). Overlapping values merge into one `[NAME]`, named after the first in precedence order. Matching
indexes the forms by their first two characters: one map lookup per character of text, however
many values there are (4096 values: about 10 µs for a 1 KB log line, 35 ms to build the index).

**Whose values.** Never another User's: masking with them would let a User type a guess and see
it become `[NAME]`. Two sets:

- **A Thread's** (`forThread`, its root's: a child Thread's tools run in its root's process), for
  its history: events, titles, handoffs, command output, terminals, setup output, checkpoint diffs.
  It holds every value a process of the Thread (or a child) received (`SecretDelivery.resolve`
  calls `remember` before it hands them on; value ids and names, never values, are kept in
  `thread_secret_values`, migration 116) and its owner's effective set now
  (`EffectiveVaults.forThread`), read again every 30 seconds. A Thread whose creation is being
  written uses its owner's set where it will be (`EffectiveVaults.forPlacement`).
- **A User's own** (`forUser`, `forViewer` for the request's principal), for what a User reads
  interactively: files, search, a checkout's diffs and commits, change requests, Git output and
  errors, files served by URL. It is every value of that User's own Threads (their owners' sets and
  what their processes received), cached per User for 30 seconds. A client never picks whose
  values mask: a `threadId` in a file read or search selects the machine, not the values. A call
  no User makes (an internal one) masks nothing.

A value rotated or deleted since stays masked for the Thread's life: `Vaults` does not remove a
value a Thread that is not deleted holds (it stays sealed in `secrets/vault-values/`). Its start
drops the rows of deleted Threads (their tombstone) and of Threads gone for good (never projected,
or purged: no projection and no events, rows older than a day; a Thread missing from the
projections during a rebuild keeps its events and so its rows), then sweeps their values. Values
are decrypted once per value id; loads of one Thread or User are not repeated while one runs. The
User's Threads and a root's children are read through indexes (migration 116).

**Fails closed.** A set is used only when it was read whole; a read that fails is tried twice
more, after 25 and 50 ms (a busy database). If it still fails, nothing unmasked goes anywhere,
and nothing breaks with a defect: an event write fails (nothing is stored, decision R7); a file
read shows `[content hidden: secrets could not be loaded]` (read-only), a search finds nothing, a
diff or change request shows its text hidden (read-only), and text in pieces (command output,
terminal, setup and Git hook output) and errors (any depth, causes and defects too) show
`[output hidden: secrets could not be loaded]`. Output hidden this way stays hidden to the end
of its line once the values can be read again (it may have been the start of one). A set read
whole before (a little old) is used meanwhile; one holding only what was delivered since never
is. A value delivered to a Thread makes its owner's set read again at once (only that User's); a
read of it begun before stores nothing.

**Masked text is never written back.** A read that shows `[NAME]` says so (`masked: true`): the
editor opens it read-only with «This file contains secrets; edit it in a terminal.». A save is
refused (same words) only when it carries one of the User's `[NAME]`s and the file on disk holds
that value there, or cannot be read or checked whole (fails closed); any other save (one that
replaces the line, a plan, a copy) is written. A change request's title, body or comment shown
masked is read-only (`canEdit`, `editChangeRequest` false), and an edit carrying one of the
User's `[NAME]`s is refused, so `[NAME]` never replaces a value on the host.

**Copying files to another machine (decision R2, revised).** "Copy ignored files to another
machine" reads each file with `forCopy: true` and gets it as it is, unmasked, so an `.env`
arrives with its values. Only a caller who may write files (`filesystem:write`) may ask for one
(`ws.ts`): they could print the file in a terminal anyway, and their own values are the only ones
a read masks for them (R1). Every other read to a client is masked for its reader. `ws.test.ts`
proves both guards: the Space rule (a copy needs what a save needs) and the scope (a session with
every scope but `filesystem:write` is refused).

**Where it applies.** The full inventory is `vaults/MaskedPaths.ts`: every WS method, HTTP
endpoint, raw route, MCP tool (as `DoorRules` lists them) and executor operation, each by name,
with no wildcard. `MaskedPaths.test.ts` fails for a door without a rule or a rule without a door,
and calls every door marked masked with the Owner's secret on a «Hub con Environments» Hub,
checking it answers `[OWNER_TOKEN]` (change requests and Git actions through the masking their
services wrap every method in). The real paths are proven once each, below the wrappers:
`GitManager.test.ts` runs a real commit with a real `pre-commit` hook that prints the value and one
that fails with it (hook output `[HOOK_TOKEN]`, the failure without it), and
`PullRequestService.test.ts` reads a change request through the real service over its host stub
(`[PR_TOKEN]`) and refuses an edit carrying it. A real host (GitHub) never answers in tests.

| What                                                          | Set      | Where                                                     |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| Events, the outbox's payloads, a rejected command's error     | Thread's | `EventSink` via `maskingEventWrites`                      |
| Live command output                                           | Thread's | `CommandOutputHub` (`heldText.ts`)                        |
| Terminal output and snapshots                                 | Thread's | `ThreadWorkspace` (`maskTerminal.ts`)                     |
| Checkpoint diffs, handoff summaries                           | Thread's | `CheckpointDiffQuery`, `ThreadMoveService`                |
| Setup-script output and errors                                | Thread's | `WorktreeSetupTracker`, over its last lines               |
| `files.read`, `search.contents`, a save; machines' errors     | User's   | `ThreadWorkspace` (`maskWorkspace.ts`)                    |
| A checkout's diffs and commits (Changes panel), their errors  | User's   | `ReviewService` (`maskCheckoutReads.ts`)                  |
| Git hook output and progress; every Git and VCS failure       | User's   | `GitManager`, `GitWorkflowService` (`maskGitProgress.ts`) |
| Change requests (lists too): every answer and failure         | User's   | `PullRequestService`, guides (`maskPullRequests.ts`)      |
| Review guides as stored (a session's or an MCP caller's User) | User's   | `PullRequestReviewGuides.put` (the generator's)           |
| A checkout's text file served by URL (who asks; media as is)  | User's   | the asset route (`maskAssets.ts`)                         |
| Logs, spans, trace and provider event files                   | process  | every value the process knows (below)                     |
| A terminal's history file                                     | terminal | `TerminalManager`, every value its shells got             |

**Text in pieces** (`heldText.ts` over one `SecretStreamGuard` per stream, for its whole life:
terminals and command output). A piece whose end could be the start of a value's form waits for
the next one (at most 150 ms) and the two go out as one, masked. When nothing follows in time (or
too much is held) the piece goes out with that start as `[NAME]` when it is 6 characters or more,
and the rest of the value is dropped as it comes, however many pieces it takes: no part of the
value is seen (a start shorter than 6 characters already sent makes the rest show as `[NAME]`).
A reload of the
Thread's values, a value delivered meanwhile or a snapshot keeps the guard (a snapshot's end that
starts a value shows as `[NAME]`, its rest is dropped). A history cut at its start (a terminal's
bounded history, a file read cut at its size limit) loses what is left of a value at the cut.

**Search** is filtered first and limited after: the engine is asked for more matches (up to 500),
matches on a line that holds a value, or whose hit is past what a cut line shows (fff cuts lines at
512 bytes and reports such hits with no ranges), are dropped, and then the limit applies and
`truncated` says whether more matched. What a search answers depends only on lines it may show.

**Logs and spans, Hub and joined machine.** A process masks its own logs, spans, trace file and
provider event files with every value it knows (`rememberKnownSecrets`): on the Hub, every Vault
value from its start; on a joined machine, each `secretEnv` it receives. These are the operator's
files, never what a client is shown.

**Not masked (accepted):**

- the AI provider sees a value the agent reads (decision 9); masking protects the Hub's history,
  not the model's context;
- the files on the Thread's machine keep what the agent wrote; only the Hub's view is masked;
- history written before this ticket stays as it was;
- a dev server's pages and sockets proxied as a preview, a browser preview's screen, an MCP app's
  answers, and the AI gateway's traffic: live, to the User who opened them, never stored;
- the Hub repository's Git objects (`/api/git`): checkpoints are kept as written; diffs and reads
  from them are masked when shown;
- the Owner's own diagnostics (trace file, process list) and agent session scan;
- log annotations (`Effect.annotateLogs`) are not rewritten, only messages and causes;
- forms not covered: a value with ANSI codes inside it, shell-quoted (`declare -p`), or in another
  encoding (gzip, other escapes); a binary file served by URL goes as it is;
- a start of a value shorter than 6 characters sent before a pause shows (values shorter than 6
  are never masked); a value typed into a terminal a few characters at a time shows as typed;
- a text file served by URL larger than 16 MiB is refused for a User with values (it cannot be
  checked); media and binary files (a NUL in their first 8 KB) are served as they are, whatever
  their size; a URL opened with no session and no User of its own serves no text;
- the masker's expression index on `json_extract(payload_json, '$.lineage.rootThreadId')` costs
  a JSON parse per projected Thread write: measured (ticket 09, SQLite in Node 26) at about 2.5 µs
  per write for a 2.6 KB payload and 35 µs for 60 KB, against a full scan per lookup without it.
  A VIRTUAL generated column indexes the same expression at the same cost; a STORED one needs a
  rebuild of the Thread projection table. Kept as is;
- a `forCopy` read is unmasked by design (decision R2, revised);
- a Thread's history is masked with its owner's set (decision A), so a User who may type in a
  Thread they do not own (a teammate's, in a shared Space) can type a guess there and see whether
  it comes back as `[NAME]`. Masking hides values from history; it does not keep them from someone
  who can run commands in the Thread (`base64 | rev` defeats it there);
- a review guide is stored masked with the values of the User who generated it; another viewer
  sees those as `[NAME]` too (masked again with their own), so the guide tells them the
  generator's value names, never values;
- project events and a rejected project command's error are not masked: they hold what Users
  typed (titles, scripts) and planner messages, never a Thread's process output.

## Losing reach (`vaults/VaultReachLoss.ts`, spec 5 ticket 07)

Delivery needs nothing to be deleted: `forThread` reads `VaultReach` at every turn, terminal and
script, so whatever stops reaching a Thread is gone from the next one, and a live process with an
older set is handled by its fingerprint (a provider session is reopened at its next turn; a running
shell keeps its environment and says `secretsStale`). What `VaultReachLoss` adds is that no row
keeps naming a reach that is gone, so nothing comes back unseen and nothing of what was deleted
remains. Every way to lose reach, and where it goes:

| How reach is lost                                         | Delivery (next process)                               | Live processes                                                           | Rows dropped (same transaction)                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Project moves to another Space                          | `forThread` reads the new Space                       | its Threads' shells started for the old Space are refused and closed     | its choices of Vaults that do not reach the new Space, each audited `vault.choose` `inherit` under the old Space (`keepProjectChoicesReaching`, one `DELETE … RETURNING`, with the commit of the move: `EventSink.commitProjectCommand` `alsoCommit`) |
| A Project is deleted                                      | its Threads are deleted first                         | —                                                                        | its choices (`forgetProject`, with the commit of the delete)                                                                                                                                                                                          |
| A Vault is taken back from a Space                        | not allowed to the Space                              | stale flag (ticket 04)                                                   | the allowance, that Space's default, its Projects' choices (`forgetSpaceAllowance`)                                                                                                                                                                   |
| A Vault is taken back from a User                         | not allowed to the User                               | stale flag                                                               | the allowance (`forgetUserAllowance`)                                                                                                                                                                                                                 |
| A User is removed from the Installation                   | `forbidden` (no Space of theirs)                      | every shell started with their set is refused and closed, in any Sandbox | every allowance to them and to their (frozen) Personal space, that Space's defaults and its Projects' choices; each allowance audited `vault.allow` `allowed: false` with `subjectName` (`forgetUser`, `InstallationUserService`)                     |
| An Organization is deleted                                | its Threads are deleted first                         | ended with its Threads                                                   | its own Vaults, their entries and values (audited `vault.delete`), allowances to it (audited `vault.allow` `allowed: false`), its defaults, its Projects' choices (`forgetOrganization`, `OrganizationLifecycle.delete`, before its row)              |
| A Vault is deleted                                        | gone                                                  | stale flag                                                               | entries, values, allowances, defaults, choices (`forgetVault`)                                                                                                                                                                                        |
| A Vault is archived, a link broken                        | skipped by `forThread`                                | stale flag                                                               | none: restoring brings it back as the Owner left it                                                                                                                                                                                                   |
| A Membership ends, a User is disabled                     | `forbidden`                                           | stale flag                                                               | none: a disabled User's allowances wait for them                                                                                                                                                                                                      |
| A Member becomes a Guest, or back                         | unchanged: a Guest's Threads receive the defaults too | —                                                                        | none: no reach is lost                                                                                                                                                                                                                                |
| A credential or agent bound to one Space (`spaceLimit`)   | `forThread` answers nothing outside that Space        | —                                                                        | none: the limit is the caller's, not a row                                                                                                                                                                                                            |
| A Thread moves to a machine that does not serve its Space | `servesSpace`: the plan is empty                      | —                                                                        | none                                                                                                                                                                                                                                                  |

**Closing terminals: each shell carries its own facts.** A move and a removal close terminals
rather than flag them, because the new Space's Members (or, in a shared Sandbox, the other Users)
could drive them. Every door that starts a shell passes `TerminalManager.open` /
`attachOutputStream` a required `TerminalStart`: its secrets and its facts, the Space its set was
planned for and the User whose set it is (`SecretPlan.spaceId`/`userId`, the same `forThread` read;
the WS terminal open and attach in `ThreadWorkspace`, setup and settle scripts in
`ProjectSetupScriptRunner`). The machine keeps them with the session and reports them in its
snapshot (`facts`, executor contract 12: `facts` in `terminal.open`/`terminal.stream`).

The Hub (`ThreadWorkspace`) admits a shell only while its facts hold: it reports facts, its User is
not removed, and its Space (when it was planned for one) is its Thread's now. The verdict is cached
per session until the Space directory's `revision` changes (a move, a removal), so typing costs no
query; any failure to read counts as stale. A stale shell is closed with `deleteHistory` (its
scrollback may show the old secrets) and refused (`outside_thread_workspace`); an open or attach of
that id then starts a new shell, once. Typing, resizing or clearing a shell the Hub never admitted
(another door's, or from before this Hub started) is refused until it is attached or opened. A
machine before contract 12 reports no facts: its terminals are refused with «<machine> needs an
update to open this Thread's terminals».

After a move commits (and after a User's removal), `ProjectMoveHooks.reconcileTerminals`
(`ProjectMoveThreads`) sends each connected machine every Thread's Space and the removed Users
(`terminal.reconcile`); `TerminalManager.reconcile` closes, with their history, the shells started
for another Space or a removed User, and listed Threads' shells without facts, checking each again
under its Thread's lock (a shell reopened for the new Space stays). It is fired and forgotten: the
move and the removal do not wait, failures are logged, and it runs again for each machine as it
connects (a new socket), so a machine that was away, older or no longer the Thread's is covered.

A stale close also ends what the shell's session started (`terminal.close` `endSession`, sent by
`ThreadWorkspace`'s stale close; `reconcile` does it itself). The PTY makes the shell a session
leader, so its pid is the session id of every job it started; bash puts each background job
(`npm run dev &`) in its own process group, which the PTY's close never reaches.
`terminal/SessionProcesses.ts` signals the session's process groups, SIGHUP, then SIGTERM, then
SIGKILL after the kill grace, reading `/proc/<pid>/stat` (after its last `)`) again just before
each signal and signalling only groups that still have a live member in that session and whose
live members all have this process's real uid (the `Uid:` line of `/proc/<pid>/status`, not the
owner of `/proc/<pid>`, which shows root for a non-dumpable process such as ssh); a group with a
member of another uid (only possible on a machine running as root) is left and logged, since
`kill(-pgrp)` would reach every member. A group never spans sessions; this process's own session
is never ended. The session id is the last shell's pid, kept after the shell exits, so a stale
close of an exited shell still ends its jobs (unless that pid is now another live shell's). A start
that replaces the last shell for other facts (Space, User) or other secrets than it carried ends
the old shell's session too. A user's normal close, and a restart with the same facts and secrets,
are unchanged: SIGTERM to the shell, whose background jobs live on as before. Accepted risk: a
process that left the session (`setsid`, a daemon) keeps its environment, the same risk as
`/proc/<pid>/environ` in a shared Sandbox; on macOS and Windows (no `/proc` sessions) and on a
machine that predates `endSession`, only the shell and its PTY end. The move dialog says
«Open terminals of its Threads close». After a revocation, live processes keep the ticket 04 rule
(stale flag): nobody new gains control of them.

**Granting clears too.** Allowing one of the Owner's Vaults to a Space drops, in the same
transaction, that Space's default of it and its Projects' choices of it (`clearForGrant`): any such
row can only be left from before, so a grant never brings it back unseen. Migration 115
(`VaultReachLoss`) drops once what earlier Hubs left: Vaults of Organizations that are gone
(their values go at the next start's sweep), allowances to Spaces that are gone or to removed Users, a
removed User's Personal-space allowances, defaults and Project choices,
and defaults and choices of Vaults that do not reach their Space.

**Checks inside the write.** `Vaults.create`, `putEntry` (adding or changing a secret), `linkEntry`,
`copyEntry`, `allow`, `setSpaceDefaults` and `setProjectChoice` check again, inside the transaction that writes,
what they checked before it: the Vault's Organization is not being deleted or frozen, the Space
still exists and takes Vaults, the User is not removed, the Project is still in that Space and each
Vault still reaches it. A move, a removal or an Organization's deletion that commits between the two
wins (`not-found` or `not-allowed`).

**The move plan.** `EffectiveVaults.projectMoveLoss({ projectId, from, to })` runs the Space side
of the rule (`spaceSide`, the same code `forThread` runs) for the Project in each Space and answers
the Vaults received in `from` and not in `to` (`vaultsLost` in `/api/projects/move-plan`, names
only; a User's own Vaults follow the User and are never listed). The move itself reads nothing
more: its choices go with the commit, by SQL. The dialog lists them under «Vaults it loses». The
Project service requires `EffectiveVaults` (a host without it fails to build, never moves without
the warning); it is the only caller outside `server.ts` and `ws.ts`, and never calls `forThread`
(`DoorRules.test.ts`).

Values of deleted entries are removed from `VaultValueStore` once the transaction commits
(`removeValues`, also what `Vaults.delete` uses); one a failure leaves behind is removed at the
next start (`sweepOrphanValues`).

## The agent's names and a missing secret (spec 5 ticket 06)

**`list_secret_names`** (MCP, `OWN_THREAD`). The tool takes no Thread: it answers for the
credential's own Thread, after the same visibility check as `t3_thread_read` (a Thread its User can
no longer see answers `thread_not_found`). The names come from `SecretDelivery.turnNames`, the
names `planTurn` would deliver (the Thread's owner's effective set, a dangerous name only as the
Owner last set it), each with its description and winning Vault: never a value or an id. A Thread
without an owner, or whose owner left its Space, lists nothing. The agents' shared instructions
(`orchestrationInstructions.ts`) say: secrets are environment variables; call `list_secret_names`
and use `$NAME`; never print values; a missing one is asked with `request_secret` and its `name`.
A Thread whose machine does not serve its Space (`servesSpace`, as `plan`) lists nothing.
`DoorRules.test.ts` checks the MCP service calls nothing of `SecretDelivery` but `turnNames`.

**«Also save to Vault».** `request_secret` takes an optional `name` (an env var name), kept on the
card as `secretName`. One rule, `Vaults.saveTargets({ threadId })`: the Vaults the acting User may
edit (`vault.edit`, as Settings → Vaults decides it), not archived, that reach the Thread's Space
(`VaultReach.allowedToSpace`). Never the Main vault from an Organization's Thread, never another
Organization's Vault (an Admin of both included), nothing for a Member or a Guest, whatever is
allowed to them. Its doors:

- `secrets.vaultTargets` (WS, `RPC_SPACE_ACCESS` `thread`): the picker's list, for whoever may
  answer the Thread's cards (`thread.continue`).
- `secrets.answerRequest` with `saveToVault: { vaultId, name }`: a Vault not in that list is
  refused (`vault_not_permitted`) before anything is stored; then `Vaults.putEntry` as the caller
  (the policy again, `secretNameRisk`, audit `secret.edit` with the name, never the value). Names the
  Hub reserves, invalid ones and dangerous ones are refused (`vault_name_invalid`: the card never
  confirms a dangerous name; the Owner adds those in Settings → Vaults); a name already in the
  Vault is `vault_name_taken` (no silent replace), and a value shorter than 6 characters
  (never masked) is `vault_value_short`. Only then the one-use ref, as before. A refused save
  leaves the card pending. Answers run one at a time, so a second answer to a card finds it
  `already_answered`; a card keeps a keyed digest of what it saved (`secret-request-vault-<id>`,
  swept with the answers), so a retry of the same answer after a later step failed goes on, and a
  different value is refused.

Web and desktop show the option once focus enters the card, if the list is not empty: a Vault
picker and the name, checked with `secretNameRisk` as typed. Mobile answers as before (ticket 08).
If recording the answer fails after the Vault entry was written, the entry stays: the User asked
for it.

## Clients: desktop and mobile (spec 5 ticket 08)

No door of its own: clients call the commands of tickets 02-06, gated by each command's
`permissionAtom`, and the Hub decides again.

- **Shared state** (`@t3tools/client-runtime/vaults`): `vaultActions` / `entryActions` (what a
  viewer is offered from the Hub's `canEdit` / `canReveal` plus the session's write grant; a link
  is never replaced, a `dangerous` name only by the Owner; `reveal` is never true on the `mobile`
  surface), `loadVaultOverview`, `entryBadges`, `vaultOwnerLine`, `threadSecretLines`,
  `vaultFailureMessage` (only a Vault's own message is shown; anything else is generic, since a
  transport error could carry what was typed). Web, desktop and mobile all use them.
- **Desktop** renders the web bundle from the Hub (`window.desktopBridge` only changes the HTTP
  layer to a bearer token), so Settings → Vaults, «Reveal» and «Download master key backup» (strong
  factor in the request) are the web components.
- **Mobile:** Settings → Vaults (`SettingsVaults`, `features/vaults/VaultsList.tsx`: Vaults, names,
  badges, «Add secret» / «Replace value» for the Owner and an Organization's Admins), the Thread's
  «Secrets» (`ThreadSecrets.tsx`) and «Also save to Vault» on the `request_secret` card. Inputs are
  secure and cleared after saving. **No «Reveal», no master key:** `noReveal.test.ts` scans
  `apps/mobile/src` for `vaults.reveal`, `revealVaultSecret` and the master key calls.
  Creating, deleting, linking, allowing and defaults stay on web and desktop.

## The door inventory (spec 5 ticket 09)

The rule: a value leaves the Hub only by `vaults.reveal` (the Owner, strong factor), the master
key's backup (the Owner) and `secretEnv` to a process that starts; everything else carries names
or `[NAME]`. Each door is declared, and a test fails for one that is not:

| Doors                                              | Declared in                                         | Test that fails for a new one                        |
| -------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| WS RPCs                                            | `RPC_SPACE_ACCESS`, `MaskedPaths.WS_DOOR_RULES`     | `RpcAuthorization.test.ts`, `MaskedPaths.test.ts`    |
| HTTP endpoints, raw routes, MCP tools              | `DoorRules.ts`, `MaskedPaths.ts`                    | `DoorRules.test.ts`, `MaskedPaths.test.ts`           |
| Executor operations (`secretEnv` on three of them) | `MaskedPaths.EXECUTOR_OPERATIONS`                   | `MaskedPaths.test.ts`, `DoorRules.test.ts` (count)   |
| Modules that read a value                          | `DoorRules.test.ts`: reveal, delivery, masking only | the same (a new reader, a new caller of `readValue`) |
| The Vaults' tables                                 | `DoorRules.test.ts`                                 | the same                                             |
| Doors named after Vaults or secrets                | `vaults/VaultDoors.test.ts`                         | the same (a door neither called there nor elsewhere) |

- **Value sweep** (`vaults/VaultDoors.test.ts`): full Vaults (Main, link, copy, each
  Organization's own, one of the Owner's allowed to Acme and one to a User); the Owner and an
  Admin, a Member and a Guest of Acme and of Globex call every `vaults.*` door, reads and writes,
  the reveal without a strong factor, the master key's status, the audit log and
  `list_secret_names`. No answer or refusal holds a value; none names a secret its caller may not
  see; only the Owner's reveal with a passkey answers one.
- **Guest and read-only views**: a guest link's stream and items show `[OWNER_TOKEN]`
  (`HubWithEnvironments.secretMasking.test.ts`); the read-only snapshots serve the masked store.
- **Leak smoke**: after a turn and a terminal (`secretMasking`), a handoff (`handoff`) and a
  `request_secret` saved to a Vault (`SecretRequestVaults`), no file of the Hub's state (its sealed
  store included), no row, no file of a machine but its checkouts and no `/proc/*/cmdline` holds
  the value. Logs and spans of the real processes are searched by the live pass (the Hub's log,
  its trace file, every process argument on the host and in the Sandboxes).
- Not in the smoke: a setup script on the Hub machine (its shell gets the values in its spawn
  environment only, `terminal/Manager.test.ts`).
