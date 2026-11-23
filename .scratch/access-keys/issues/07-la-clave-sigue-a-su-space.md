# 07: La clave sigue a su Space

**What to build:** Los registros acompañan a la regla de cada petición: borrar una Organization o quitar al User de un Personal space revoca sus access keys en la misma transacción; archivar, congelar o deshabilitar las deja rechazadas y restaurar las devuelve; que quien la emitió deje la Organization o el rol no les hace nada. Ver spec, «Ciclo de vida».

**Blocked by:** 01.

**Status:** done (design: `07-design.md`)

**Tipo:** AFK

Spec: ../spec.md

- [x] Revocación dentro de la transacción del borrado de una Organization y de quitar a un User (`revokeWithin` o su gemela de access keys), `space-gone`, auditada como `system` con `via` (`organization.delete`, `user.remove`).
- [x] Mensajes del 403 de un Space archivado o congelado y de un Personal space de un User deshabilitado.
- [x] La lista de claves de un Space archivado se ve y deja revocar, no crear ni cambiar; la vista del Owner muestra las claves de cada Space con su estado.
- [x] Una migración (número al integrar, o la misma del ticket 01 si van juntas) revoca las claves de Spaces que ya no existen, por si un borrado anterior a este ticket las dejó.
- [x] Red-first («Hub con Environments»):
  - [x] borrar Acme revoca sus claves en la misma transacción (un borrado que falla no revoca nada);
  - [x] quitar al User de un Personal space revoca las de ese Space; deshabilitarlo las rechaza y volver a habilitarlo las devuelve;
  - [x] el Admin que emitió una clave deja Acme y la clave sigue respondiendo; otro Admin la ve y la revoca;
  - [x] una cuenta borrada o pasada a otro dueño deja de contar en la siguiente petición.
- [x] Docs: «Access keys» → ciclo de vida; la tabla «Moving a Project and removals» de `ai-gateway.md` gana las filas de access keys.
