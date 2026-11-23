# 07 design: the key follows its Space

Ticket: `07-la-clave-sigue-a-su-space.md`. Spec: «Ciclo de vida». Builds on 01 (where `authorize` already refuses a key whose Space is archived, frozen or gone, and the request check stays the guard) and 03 (accounts evaluated per request).

## Revocations inside the removal's transaction

- `AccessKeys.revokeAccessKeysWithin(sql, { spaceId }, via)`, exported, so `ai_access_keys` is still written only from `AccessKeys.ts`:
  - revokes every live key of the Space: `revoked_reason = 'space-gone'`, no `revoked_by`;
  - audits each one as `system`: `access_key.revoke` `{ space, reason: space-gone, via }`.
- `AiAccountReachLoss.forgetSpace` (inside `OrganizationLifecycle.delete`'s transaction) calls it with `via: organization.delete`.
- `AiAccountReachLoss.forgetUser` (inside `InstallationUserService`'s removal) calls it for the User's Personal space, with `via: user.remove`.
- A deletion that fails rolls the revocations back with it.

## Migration `161_AccessKeysOfGoneSpaces`

- It revokes (`space-gone`) the live keys of Spaces that no longer exist, in case a deletion before this ticket left any.
- Its test also checks that a live Space's keys stay untouched.

## Refusals

| Case                              | Answer                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Space archived, or being deleted  | 403 «This access key's Space is archived. It works again if the Space is restored.»                                  |
| Personal space of a disabled User | 403 «This access key's Space is not available while its User is disabled. It works again once they are enabled.»     |
| Frozen (removed User)             | 403 «This access key's Space is closed.» Since this ticket a removal revokes the keys anyway, so this is a fallback. |

## Lists

- `AccessKey.spaceState` is one of `open`, `archived`, `frozen` or `gone`.
- An archived Space's list shows its keys and lets whoever views it revoke them. Making and changing keys stay refused there, already since 01 and 06.
- Web: the Owner gets an «Access keys» tab in Settings → AI accounts. It lists every Space's keys with the Space's name and state, and offers «Revoke» but no form.

## Tests (`apps/server/src/ai/AccessKeys.lifecycle.test.ts`, `161_AccessKeysOfGoneSpaces.test.ts`)

- Deleting Acme revokes its keys in the same transaction. A deletion that fails (a trigger refuses it) revokes nothing.
- Removing the User of a Personal space revokes that Space's keys. Disabling them refuses the keys; enabling them again brings the keys back.
- The Admin who issued a key leaves Acme and the key keeps answering; another Admin sees it and revokes it.
- An account deleted, or given to another owner, stops counting from the next request. With none left, the answer is 403.
- The Owner's list of every Space shows an archived Space's keys as `archived`.
