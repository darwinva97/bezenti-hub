# 02: El permiso «may use Makita» por Space

**What to build:** El Owner da y quita en Platform → Makita el permiso «may use Makita» a un Admin o Member de una Organization, o al User de un Personal space en el suyo. Quien lo tiene verá Space settings → Makita (el ticket 03 la llena). Ver spec, «El permiso "may use Makita"» y pregunta abierta 2.

**Blocked by:** nada.

**Status:** done (design: `02-design.md`)

**Tipo:** AFK (pregunta abierta 2 decidida el 2026-11-24: por User y Space)

**Tanda:** 1

**Seguridad:** sensible (permisos). Nota de diseño `02-design.md` antes de construir.

Spec: ../spec.md

- [x] Migración `makita_permissions (user_id, space_id, granted_by, granted_at)` con test. No se toca `installation_permissions`.
- [x] `AccessPolicy`: `makita.use` y `makita.view` sobre un Space con la tabla de la spec (Space abierto; Guest nunca; Owner sin fila), tabla en `AccessPolicy.test.ts`.
- [x] WS `makita.permissions.list|grant|revoke` (Owner).
- [x] Perder la Membership deja la fila sin efecto (`makita.use` exige seguir siendo Member); quitar al User del Hub borra sus filas en esa transacción.
- [x] Auditoría `makita.permission.grant|revoke` con `space`.
- [x] Web: Platform → Makita → «Who may use Makita» (User × Space, Grant/Revoke).
- [x] Red-first: un Admin no se da el permiso; un Guest no lo recibe; un Member con permiso en Acme no lo tiene en Globex; tras salir de Acme, `makita.use` en Acme es `not-a-member`.
