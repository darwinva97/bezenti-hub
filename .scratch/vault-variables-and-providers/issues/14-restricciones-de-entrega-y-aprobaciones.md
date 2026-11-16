# 14: Restricciones de entrega y aprobaciones

**What to build:** `deliverTo` por Vault y por entrada (Sandbox, máquinas dedicadas, personales, Hub machine) aplicado en `EffectiveVaults.forThread`, y `requiresApproval` (`owner` | `owner-or-admins`) con solicitudes, espera del turno, decisión en todos los clientes, validez por Thread y User, y revocación. Ver spec, «Restricciones de entrega y aprobaciones».

**Blocked by:** 02

**Status:** needs-triage

- [ ] Migración: `deliver_to` y `requires_approval` en `vaults` y `vault_entries`; `secret_approvals`.
- [ ] Red-first: una entrada `deliverTo: [sandbox, dedicated]` no llega a una máquina personal y aparece como «not delivered on this machine»; mover el Thread la saca del conjunto; una entrada solo puede restringir más que su Vault.
- [ ] Red-first: sin aprobación vigente, el turno espera; denegar o caducar falla el arranque con un error tipado; un Admin no aprueba sus propios Threads; «Revoke approval» la retira en el siguiente arranque.
- [ ] WS `secretApprovals.list|decide|revoke`; notificación en web, desktop y móvil (push).
- [ ] Auditoría `secret.approval.request|decide|revoke`.
- [ ] Tarjeta en el Thread «Waiting for approval to use <NAMES>» y bandeja de aprobaciones para quien aprueba.
