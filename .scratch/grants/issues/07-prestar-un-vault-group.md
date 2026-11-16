# 07: Prestar un Vault group

Spec: ../spec.md

**What to build:** Ana presta un grupo de su vault personal a Acme, avisada de que los agentes de Acme podrán leer los Secrets. Un Admin de Acme lo acepta. El grupo aparece enlazado en el vault de Acme y se elige como cualquier grupo. Variables visibles, Secrets solo con nombre. Los cambios llegan al siguiente turno, y los nombres `dangerous` nunca se entregan. Al retirarlo se pide rotar. Las `vault_allowances` del Owner pasan a Grants. Ver spec, «Vault groups prestados» y «Migración de las allowances».

**Blocked by:** 01, 02 (lista de revisión de la migración), owned-resources (Vault groups, Secrets y Variables).

**Status:** ready-for-agent

- [ ] Alcance: `VaultReach` y `EffectiveVaults.forThread` leen los grupos propios del Space más los Grants `active` de `vault-group`. Red-first:
  - [ ] pendiente o terminado no entrega nada;
  - [ ] terminar un Grant corta el siguiente turno;
  - [ ] el borrado de la elección de Space o Project va en la misma transacción (`VaultReachLoss`).
- [ ] Grupo enlazado en el vault del prestatario, de solo lectura: Variables con valor, Secrets con nombre. Elegible en valores por defecto y elecciones de Project, detrás de los grupos propios en el orden por defecto.
- [ ] Red-first: un nombre `dangerous` (`secretNameRisk`) de un grupo prestado no llega al entorno del proceso; el panel «Secrets» lo marca «no entregado: viene de un préstamo».
- [ ] Ninguna puerta devuelve el valor de un Secret prestado (extender `vaults/VaultDoors.test.ts`).
- [ ] Avisos: al dar («los agentes de <Space> podrán leer los Secrets») y al retirar o devolver (lista de Secrets con «Reemplazar»).
- [ ] Migración: `vault_allowances` → Grants `active` del Owner, un Grant por cada grupo en que `owned-resources` convierta el Vault. Los casos «a un User» van a la lista de revisión del ticket 02. Se borran `vault_allowances` y `vaults.allow`.
- [ ] `docs/internals/secrets.md`: reescribir «Who reaches what» con Grants.
- [ ] Prueba real: Ana presta un grupo con una Variable y un Secret, un turno de Acme recibe ambos y el Secret sale enmascarado; Ana cambia la Variable y el siguiente turno la ve; Ana retira y el siguiente turno no recibe nada.
