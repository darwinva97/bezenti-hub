# 18: Cualquier User crea sus propias Organizations

**What to build:** Cualquier User de la Installation, no solo el Owner, puede crear Organizations desde **Create organization** en el selector de Space. Quien la crea queda como su Admin y puede invitar a otros a ella. El Owner sigue viendo y pudiendo hacer todo en todas las Organizations, también en las que no creó. Hoy `organization.create` solo lo permite al Owner (`apps/server/src/auth/AccessPolicy.ts`).

**Blocked by:** None (can start immediately).

**Status:** done (rama `feat/identity-17-19`)

Spec: ../spec.md (cambia quién puede crear Organizations; ver «Roles y permisos»)

- [x] `AccessPolicy` permite `organization.create` a todo User activo. Un User desactivado o quitado no puede. Nueva fila en la suite de `AccessPolicy`.
- [x] Crear la Organization y dar al creador la membership `admin` ocurre en una sola operación del servicio, y la acción `create organization` de la auditoría registra quién la creó.
- [x] El creador pasa por la misma regla de Admin que ya existe: con passkey es Admin al momento; con solo contraseña queda como Member hasta que añada una app de autenticación, y la barra lateral se lo indica como hoy. Hay que probar que, mientras tanto, la Organization no queda sin nadie que la administre más allá del Owner.
- [x] **Create organization** aparece en el selector de Space de todo User en web, desktop y móvil, no solo en el del Owner.
- [x] La creación es un método de servicio, así que los agentes la alcanzan por la misma vía si hay o se añade una herramienta MCP para ello, con los permisos del User que inició el turno.
- [x] `docs/user/install.md` («Spaces and organizations») deja de decir que solo el Owner crea organizaciones.

Fuera de alcance: archivar, restaurar y borrar una Organization siguen siendo cosas solo del Owner; nombrar a otros Admins también. Si se quiere que el Admin creador pueda hacerlo en la suya, es otro ticket.
