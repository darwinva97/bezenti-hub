# 10: Bajas y cambio de Space con recursos con dueño

**What to build:** Lo que pasa con los recursos con dueño cuando su dueño se va o un Project cambia de Space. Quitar un User borra su vault personal y sus AI accounts y revoca sus gateway keys; borrar una Organization borra su vault y sus AI accounts; mover un Project lista los grupos y AI accounts que sus Threads pierden y borra las choices que no llegan al destino. Desactivar no borra nada y reactivar devuelve todo. Ver spec, «Bajas y cambio de Space».

**Blocked by:** 04, 05, 07, 09.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en el testkit «Hub con Environments»: tras quitar a Ana, sus AI accounts no están en CLIProxyAPI ni en la base, sus valores no están en `secrets/vault-values/` y ninguna fila nombra sus grupos; desactivarla y reactivarla los conserva.
- [ ] Borrar Acme: su vault (grupos, entradas, valores) y sus AI accounts desaparecen; sus máquinas dedicadas siguen como hoy (las ve y quita el Owner).
- [ ] `move-plan`: `vaultsLost` nombra grupos con su dueño y `aiAccountsLost` sigue la nueva regla; caso en `HubWithEnvironments.projectMove.test.ts` de un Project del Personal space de Ana a Acme.
- [ ] Una migración limpia filas que nombren grupos o cuentas de Users ya quitados o Organizations ya borradas (como `115_VaultReachLoss.ts`).
- [ ] Auditoría con vía `user.remove` u `organization.delete`.
- [ ] Docs: `docs/user/install.md` («Disabling and removing people», «Archive, restore or delete an organization», «Move a project to another Space»).
