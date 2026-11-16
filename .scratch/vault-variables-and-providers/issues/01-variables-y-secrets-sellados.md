# 01: Variables y Secrets sellados

**What to build:** Cada entrada de un Vault tiene clase (`variable` | `secret`), y un Secret es revelable o sellado. Las Variables se ven y no se enmascaran; los sellados no los revela nadie. Las entradas existentes quedan revelables y las nuevas nacen selladas. Ver spec, «Modelo de una entrada», «Variables» y «Secrets sellados».

**Blocked by:** —

**Status:** needs-triage

- [ ] Migración (siguiente libre): `vault_entries.class`, `vault_entries.revealable` (existentes 1, nuevas 0) y CHECK de las combinaciones válidas para `own`, `copy` y `link`.
- [ ] Red-first: `vaults.reveal` responde `sealed` para un sellado sin leer el valor (comprobado con un almacén que falla si se le pide). Una copia de un sellado es sellada. Un link muestra clase y sellado de su original.
- [ ] Red-first: «Allow reveal» sobre un sellado sin valor nuevo se rechaza; con valor nuevo, se acepta y el antiguo nunca se lee.
- [ ] Red-first: Secret → Variable solo para el Owner y solo si es revelable; si no, con valor nuevo. Variable → Secret, quien edita.
- [ ] Las Variables no entran en `SecretPatterns` ni en `rememberKnownSecrets`, y su `value` viaja en `vaults.entries.list` a quien ve el nombre (también Members y Guests). `DoorRules.test.ts`: ninguna respuesta WS lleva `value` salvo de Variables.
- [ ] Aviso `looks-like-credential` (nombre y valor) al guardar una Variable; no bloquea.
- [ ] Las respuestas de `request_secret` guardadas en un Vault son sellados.
- [ ] Auditoría `secret.edit` con `op`: `seal`, `allow-reveal`, `class`.
- [ ] Web: en «Add a secret to <Vault>», selector «Kind» (Secret, Variable) y casilla «Allow reveal» (desmarcada); lista con «Sealed», «Variable» y el valor de las Variables; «Reveal <NAME>» no aparece en un sellado. Móvil: lo mismo, sin «Reveal».
- [ ] Docs: `docs/internals/secrets.md` («Variables y sellado», lo que sellar no cubre).
