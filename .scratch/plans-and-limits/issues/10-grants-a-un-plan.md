# 10: Grants a un Plan

**What to build:** El Owner da Grants (AI account con tope, máquina, grupo de Vault) a un Plan. Llegan, sin aceptarlos, al Personal space de cada User del Plan y a las Organizations de las que es Steward. El tope de un Grant a un Plan se cuenta por Space receptor. Cambiar el Plan de un User, o el Steward de una Organization, retira los Grants del Plan viejo y da los del nuevo desde el siguiente turno. Ver spec, «Grants a un Plan».

**Blocked by:** 02; el modelo de Grants y su retirada en `../../grants/`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `Grants.give` deja de rechazar el destino `plan` con `plan-target-unavailable` (`../../grants/spec.md`); sigue siendo solo del Owner y nace `active`.
- [ ] Se rellena el hook «Grants a un Plan que alcancen al User» de la regla de lectura de `../../grants/` (`AllowedAiAccounts`, `VaultReach`/`EffectiveVaults`, `environment.use`): un Grant al Plan P alcanza a los Spaces cuyo titular está en P (`Plans.limitsForSpace` da el Plan), no a cualquier Space donde trabaje el User. No hay un segundo cálculo.
- [ ] `GrantCaps` (`ai/`) cuenta el tope de un Grant a un Plan por Space receptor. Red-first: dos Users del mismo Plan; uno agota su tope y el otro sigue.
- [ ] Red-first: cambiar a un User de Plan quita la AI account del Plan viejo de su siguiente turno y da la del nuevo; una máquina del Plan viejo sigue el camino de retirada de `../../grants/` (sus Threads se paran o se mueven).
- [ ] Transferir el Steward de una Organization cambia sus Grants de Plan igual.
- [ ] Web/desktop: en el modal Plataforma → «Plans», cada Plan lista sus Grants y permite dar o retirar; el modal Usuario → «Plan» lista lo que el Plan da al User.
- [ ] Auditoría: la de `../../grants/` con destino `plan`.
