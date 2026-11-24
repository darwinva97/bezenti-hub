# 17: Vista del Owner y ciclo de vida del creador

**What to build:** El Owner ve en Platform → Makita todas las configuraciones del Hub con sus avisos (solapes, «anyone», repositorio sin acceso) y las pausa; las configuraciones siguen al creador según la tabla de la spec (deshabilitado: pausa y se reanuda sola al volver; sale del Space: pausa hasta que otro las adopte); y otro con el permiso en ese Space, o el Owner, adopta una. Ver spec, «Atribución» y pregunta abierta 7 (decidida).

**Blocked by:** 06.

**Status:** needs-triage

**Tipo:** AFK (pregunta abierta 7 decidida el 2026-11-24: adopción explícita y auditada)

**Tanda:** 3

**Seguridad:** sensible. Nota de diseño `17-design.md` antes de construir.

Spec: ../spec.md

- [ ] Escuchar `SpaceDirectory.subscribeUserStatusChanges` (pausa `creator-disabled`, reanudación como `resumeForOwner`) y las bajas de Membership y de User dentro de sus transacciones (`creator-left`).
- [ ] Borrar un Space borra sus configuraciones en la transacción del borrado.
- [ ] `makita.configs.adopt`; auditoría `makita.config.adopt`.
- [ ] Vista general del Owner con avisos.
- [ ] Red-first: cada fila de la tabla de ciclo de vida de la spec; un Admin no adopta sin el permiso; la adopción no reanuda sola.
