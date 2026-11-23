# 03 design: the AI accounts a key reaches

Ticket: `03-ai-accounts-que-alcanza-una-clave.md`. Spec: «AI accounts que alcanza». Builds on 01 and 02.

## What exists after 01

- `ai_access_keys.accounts_json` exists (NULL means every account the Space owns).
- `authorize` already intersects `AllowedAiAccounts.forSpace` (the Space's own accounts, no lent ones) with `accounts_json` on every request and drops `direct` accounts. It answers 403 «No AI account this access key may use is available now.» when none is left.
- `planRoute` (`keyKind: "user"`) already pins `acct-<id>/` only to an allowed account, and fails over only among allowed accounts of the same provider.

## Contracts

- `AccessKeyCreateInput.accounts`: optional. Absent or `null` means every account the Space owns, now and later. Otherwise it is a list of 1 to 100 ids.
- `AccessKey.reaches`: `null` for «all», or `[{ id, name, inSpace }]`.
  - `name` is the account's name, or null when the row is gone.
  - `inSpace` is false for an account the Space no longer has (disabled, deleted, moved to another owner).
  - The list and the form strike such an account through as «No longer in this Space».

## Server

- `AccessKeys.create`:
  - drops duplicate ids;
  - inside the write transaction, refuses as `invalid` any id that is not a gateway account (`api-key` or `subscription`) the Space owns (`forSpace`): a lent, `direct`, other Space's or unknown account;
  - stores the list;
  - audits `accounts` (`all` or the count) and `subscription`, which now tells whether what this key reaches holds a subscription.
- `shown`: for keys with a list, reads the accounts' names and the Space's current own accounts, which give `reaches`.
- `planRoute`: an access key that pins an account outside its reach gets «This access key may not use that AI account.» (403). `keyKind` gains `access`, which routes as `user` does.
- `/v1/models` and the model check: already limited to the key's accounts, since `caller.allowed` is the intersection.

## Web

- Form: «AI accounts», either «All of this Space's AI accounts» (the default) or a choice among the `modelOptions` accounts, with checkboxes.
- The ToS warning shows when the chosen accounts (or all of them) include a subscription.
- The model catalog follows the chosen accounts.
- List: «All accounts», or the names, with «No longer in this Space» struck through.

## Tests (`apps/server/src/ai/AccessKeys.accounts.test.ts`)

- A key with only A never reaches B:
  - A is pinned and served;
  - B pinned is 403;
  - with A out of quota, the answer is 429 and nothing goes to B, while a «null» key fails over to B.
- With `null`, an account the Space adds later serves the key unchanged. A key made before the Space had any account answers 403 «No AI account…» until then.
- Disabling the key's only account makes the next request 403, and the list shows it «No longer in this Space».
- A `direct` account of the Space is never reachable: it is refused at create, and with `null` a pin to it is 403.
- Create refuses a lent account, a Globex account, an empty list and an unknown id.
