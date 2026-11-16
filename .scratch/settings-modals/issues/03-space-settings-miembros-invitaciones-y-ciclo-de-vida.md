# 03: Space settings con Members, Invitations y ciclo de vida

**What to build:** El modal del Space en `/settings/space/$spaceId/$section`, que sustituye `OrganizationSettingsDialog.tsx`. El contenido del diálogo se reparte, sin reescribirlo, en **General** (nombre, `LifecycleSection`: archivar, restaurar, borrar; salir), **Members** (lista, Roles, expulsar, enlaces de reset) e **Invitations**. El Personal space abre el mismo modal sin Members ni Invitations, con el aviso actual de que el Owner lo ve. El Personal space de otro User solo lo abre el Owner, en solo lectura. Quedan reservados los huecos Vault, AI accounts y Machines (ticket 08) y Grants to accept (`../grants/`).

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `/settings/space` abre el Space actual. Abrir el de otro Space cambia el Space actual a ese (regla del ticket 19 de `../../identity-and-access/`).
- [ ] La cabecera dice «Space settings · ‹nombre›».
- [ ] Las reglas por Role son las de hoy: Member y Guest leen y salen; Admin invita, cambia Roles y expulsa sin tocar Admins; el Owner nombra y quita Admins y archiva, restaura y borra.
- [ ] Space selector: «Organization settings» pasa a «Space settings» y aparece también en el Personal space; «Invite people» abre Space → Invitations. `OrganizationSettingsDialog.tsx` se borra.
- [ ] Salir de la Organization cierra el modal y recarga los Spaces, como hoy `onLeft`.
- [ ] Nuevo comando de atajo `settings.space` (sin tecla por defecto) y entrada «Space settings» en la paleta.
- [ ] La visibilidad de secciones por principal vive en `packages/client-runtime` (la usa el móvil en el ticket 10). Filas de visibilidad (Owner, Admin, Member, Guest, dueño y no dueño del Personal space) en `settingsModals.test.ts`.
- [ ] Test de navegador: un Member que abre `/settings/space/<id>/members` ve la lista sin acciones de Admin.
