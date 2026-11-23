# 06 design: renew, extend and change caps

Ticket: `06-renovar-ampliar-y-cambiar-topes.md`. Spec: «Validez», «Topes de tokens», «Auditoría». Builds on 02, 03 and 05: the same validations, applied again.

## Contracts and door

- `AccessKeyUpdateInput` takes `keyId` plus any of `label`, `validity`, `models`, `accounts` (null = all), `limits` and `unlimited`.
- WS `accessKeys.update` answers the `AccessKey`. It needs `access:write` (`CLIENT_GUARDED_RPC_SCOPES`) and is decided in `AccessKeys` with `accessKey.manage`, for a person's own session only. It is added to `RPC_SPACE_ACCESS`, `RpcInstrumentation`, `MaskedPaths`, the `DoorRules` and `AiAccounts` door lists, and the client-runtime commands.
- Audit `access_key.update`:
  - fields: `space`, `changed` (the changed fields' names, comma-separated), the new `expiresAt` and `limits` (as at create), and `via: renew` when only the expiry changed;
  - never the key, its hash or its hint.

## `AccessKeys.update`

All of it runs in one write transaction:

1. Read the row. If it is missing, or the actor lacks `accessKey.view` on its Space, answer `not-found`.
2. Check `accessKey.manage`. Without it (a non-manager, an archived or frozen Space), answer `forbidden`. An Owner who only reads someone else's Personal space is refused here too.
3. A revoked key gets `invalid`: «A revoked key is not renewed or changed: make a new one.»
4. Compute the new values, with the create rules:
   - validity: at most 366 days from the change, and an expired key works again;
   - models (02), accounts (03, only the Space's own gateway accounts), caps or `unlimited` (05);
   - a label.
5. With nothing changed, answer the key as it is, with no write and no audit.
6. Otherwise `UPDATE … WHERE key_id = ? AND updated_at = <what was read>`. Zero rows means another change won meanwhile, and the answer is `invalid` «This key changed meanwhile. Try again.» The `IMMEDIATE` transaction makes that rare; the guard keeps the change based only on what was read.
7. Audit, then answer the row with its use.

- It takes effect from the next request, because `authorize` reads the row each time. The key itself does not change, so the setup stays the same.
- Renewing does not reset the total: «Used 8.1M of 10M total» is shown, and the issuer raises the total to give more.

## Web

- Each listed key that is not revoked has «Renew» and «Edit», for whoever may manage the Space. Expired keys stay in the list for 30 days, and show «Renew».
- «Renew»: a new validity (days or a date), «Used X of Y total», and the option to raise the total.
- «Edit»: label, models, accounts and caps, in the same pickers as the form.

## Tests (`apps/server/src/ai/AccessKeys.update.test.ts`)

- Renewing an expired key makes it work with the same key, audited `via: renew`.
- Lowering the daily cap below what is used refuses the next request; raising the total brings the service back.
- Removing a model refuses it on the next request; changing the accounts and the label takes effect.
- A revoked key is not renewed; a Member, Gus, an agent and the Admin of an archived Space cannot; a key outside the actor's view answers `not-found`.
- With no change, nothing is written or audited; a validity over 366 days is refused.
