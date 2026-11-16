# 01: Variables y Secrets sellados

**What to build:** Cada entrada de un Vault tiene clase (`variable` | `secret`), y un Secret es revelable o sellado. Las Variables se ven y no se enmascaran; los sellados no los revela nadie. Las entradas existentes quedan revelables y las nuevas nacen selladas. Ver spec, «Modelo de una entrada», «Variables» y «Secrets sellados».

**Blocked by:** —

**Status:** needs-triage

- [ ] Migración (siguiente libre): `vault_entries.class`, `vault_entries.revealable` (existentes 1, nuevas 0) y CHECK de las combinaciones válidas para `own`, `copy` y `link`.
- [ ] Red-first: `vaults.reveal` responde `sealed` para un sellado sin leer el valor (comprobado con un almacén que falla si se le pide). Una copia de un sellado es sellada. Un link muestra clase y sellado de su original.
- [ ] Red-first: «Allow reveal» sobre un sellado sin valor nuevo se rechaza; con valor nuevo, se acepta y el antiguo nunca se lee.
- [ ] Red-first: Secret → Variable siempre con valor nuevo (`needs-new-value` sin él), por quien edita; el camino sin valor (revelable + factor fuerte) queda fuera de este ticket. Variable → Secret, quien edita.
- [ ] Red-first: «Seal» por entrada sobre un revelable (decisión 1); no se deshace sin valor nuevo.
- [ ] Las Variables no entran en `SecretPatterns` ni en `rememberKnownSecrets`, y su `value` viaja en `vaults.entries.list` al Owner, a los Admins y a los Members que ven el nombre; **los Guests no** (decisión 4: ven el nombre y «Variable»; acción `vault.readVariables`). `DoorRules.test.ts`: ninguna respuesta WS lleva `value` salvo de Variables.
- [ ] Aviso `looks-like-credential` (nombre y valor) al guardar una Variable; no bloquea.
- [ ] Las respuestas de `request_secret` guardadas en un Vault son sellados.
- [ ] Auditoría `secret.edit` con `op`: `seal`, `allow-reveal`, `class`.
- [ ] Web: en «Add a secret to <Vault>», selector «Kind» (Secret, Variable) y casilla «Allow reveal» (desmarcada); lista con «Sealed», «Variable» y el valor de las Variables; «Reveal <NAME>» no aparece en un sellado; acciones «Seal», «Allow reveal» y «Make variable» (las dos últimas piden valor nuevo). Móvil y desktop: ticket 16 (fase 1 solo web).
- [ ] Docs: `docs/internals/secrets.md` («Variables y sellado», lo que sellar no cubre).
