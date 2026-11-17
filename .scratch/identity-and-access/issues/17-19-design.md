# Diseño: tickets 17, 18 y 19 (identity-and-access)

Rama `feat/identity-17-19` sobre `public-hub-1` (9a564c4c76). Aprobado por el team lead con las decisiones de abajo. Migraciones: **137** (17) y **138** (18), los siguientes números libres al integrar (antes 150 y 151).

## Decisiones (team lead)

1. Steward: columna nullable `spaces.created_by_user_id` (migración 138), rellena para las Organizations creadas desde 18, NULL en las que ya existen. También se escribe la entrada de auditoría `organization.create`. Nota en `../../plans-and-limits/issues/02`.
2. Riesgo de Invitations con 18: aceptado; se documenta en `docs/user/install.md`. Se mantiene la regla «el Admin pendiente no invita sin TOTP o passkey», con su test.
3. Nombres de Organization: se rechaza crear (o renombrar) una con el mismo nombre que otra, sin distinguir mayúsculas, quitando espacios a los lados y juntando los repetidos. Solo duplicados exactos; no es un sistema contra suplantaciones.
4. Los Personal spaces ocultos que vuelven a aparecer con 17: aceptado. El Owner corre antes del deploy la consulta de abajo.
5. El Owner sigue viendo en solo lectura los Personal spaces (la privacidad es un spec posterior).
6. El servidor rechaza un Space que no coincide solo cuando el cliente envía `spaceId`.
7. Notas en el spec para las historias sustituidas, y corrección de `install.md`.

### Consulta para producción antes de desplegar 17 (solo lectura)

Lista los Users activos (sin contar al Owner ni a los quitados) que no tienen `personalSpace.create`, cuyo Personal space vuelve a aparecer, con lo que contiene y lo que tiene permitido. Abrir la base de datos en solo lectura, por ejemplo `sqlite3 -readonly <userdata>/statev2.sqlite` o con una copia. `disabled = 1` significa que sigue desactivado y no lo verá hasta que el Owner lo vuelva a activar. Se probó contra un esquema migrado hasta la 123.

```sql
WITH affected AS (
  SELECT u.user_id, u.display_name, u.disabled_at IS NOT NULL AS disabled,
    'personal:' || u.user_id AS space_id
  FROM users u
  WHERE u.is_owner = 0 AND u.removed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM installation_permissions p
      WHERE p.user_id = u.user_id AND p.permission = 'personalSpace.create')
)
SELECT a.user_id, a.display_name, a.disabled,
  (SELECT COUNT(*) FROM projection_projects pr WHERE pr.space_id = a.space_id) AS projects,
  (SELECT COUNT(*) FROM orchestration_v2_projection_threads t
     LEFT JOIN projection_projects pr ON pr.project_id = t.project_id
     WHERE COALESCE(t.space_id, pr.space_id) = a.space_id) AS threads,
  (SELECT COUNT(*) FROM vault_allowances v
     WHERE v.subject_kind = 'space' AND v.subject_id = a.space_id) AS vaults_allowed,
  (SELECT COUNT(*) FROM space_default_vaults d WHERE d.space_id = a.space_id) AS default_vaults,
  (SELECT COUNT(*) FROM ai_account_allowances x
     WHERE x.subject_kind = 'space' AND x.subject_id = a.space_id) AS ai_accounts_allowed,
  (SELECT COUNT(*) FROM environments e WHERE e.space_id = a.space_id) AS machines_or_sandbox
FROM affected a
ORDER BY a.display_name;
```

Una fila con todo a 0 solo recupera un Space vacío. Si hay `vaults_allowed`, `default_vaults` o `ai_accounts_allowed` distintos de 0, el Owner debe revisarlos antes del deploy: vuelven a estar al alcance de ese User.

## 17 · Personal space siempre disponible

**Hoy.** `AccessPolicy.inPersonalSpace` (`apps/server/src/auth/AccessPolicy.ts:425-431`) niega con `missing-installation-permission` si falta `personalSpace.create`. Todo pasa por ahí: `space.view`/`thread.create`/`project.create` (l.763), ítems (l.471), moves (l.532), Sandbox y máquinas dedicadas (l.369, 383) y Vaults permitidos a un Personal space (l.625, 636). `SpaceDirectory.view` no lista el Personal space sin el permiso (`SpaceDirectory.ts:838-852`) y `viewableSpaces` (l.898) lo deja fuera, así que su contenido «desaparece». La fila del Space ya existe para todo User (trigger de la migración `085_PersonalSpaceWithUser.ts`): **no hace falta backfill**.

**Cambio.**

- `inPersonalSpace`: dueño → Allow. Se quita la comprobación del permiso (y el comentario de l.423). No cambia: Owner en solo lectura, «nadie ve uno ajeno», frozen/inactive.
- `InstallationPermission` (`packages/contracts/src/spaces.ts:13`) queda en `["environments.registerOwn"]`. Se actualizan `PERMISSIONS` en `UsersDialog.tsx:34`, `INSTALLATION_PERMISSION_LABELS` (`spaceDirectory.ts:175`) y el comentario de `chooseCurrentSpace`.
- **Migración 137** `DELETE FROM installation_permissions WHERE permission = 'personalSpace.create'`. El CHECK de la 090 se deja como está: plans-and-limits borra la tabla entera después (spec l.96), así que reconstruirla no compensa. Las entradas antiguas de la auditoría se siguen leyendo: `AuditDetail` es un Record de strings.
- Toggle «Use their Personal space»: **se elimina** (no se deja inerte). `setPermission` con el valor viejo pasa a ser un 400 por esquema.
- Personal spaces que el Owner había apagado: **vuelven a aparecer con su contenido** para su dueño. Con ellos se reactivan los Vaults y AI accounts que el Owner permitió a ese Personal space, y su Sandbox puede arrancar en el Hub. Antes del deploy, el Owner corre en prod una consulta de solo lectura: Users sin el permiso que tienen Projects/Threads, o Vaults/AI accounts permitidos a `personal:<id>`.
- DoorRules: sin cambios (`installationUsers.setPermission` sigue siendo OWNER).
- Docs: `docs/user/install.md` §«Personal spaces and Installation permissions» (l.274-281; de paso se corrige que «Register their own Environments… changes nothing yet», que ya no es verdad) y `docs/internals/environment-auth.md:313-317, 339`.

**Red-first.** AccessPolicy.test: las filas `personalCreator`/`ada` (l.44, 112, 282, 1355) pasan a «el dueño sin permisos: Allow en view/thread/project/move»; inactive → Deny. Spaces.test: un invitado recién aceptado y un User quitado de su última Organization listan su Personal space. Test de la migración 137 (borra `personalSpace.create` y deja `registerOwn`). Ajustar `AuditLog.test.ts:217` y `AiGatewayKeys.localCli.test.ts:166`.

## 18 · Cualquier User crea Organizations (seguridad)

**Hoy.** `organization.create` está en `OWNER_ONLY` (`AccessPolicy.ts:249-253`). `SpaceDirectory.createOrganization` (l.1056-1077) inserta el Space **sin membership y sin auditoría**, y devuelve `role:null, canInvite:true` a ciegas. La UI lo controla con `view.canCreateOrganization` (`SpaceSelector.tsx:204`). **El móvil no tiene «Create organization»**, ni siquiera para el Owner.

**Cambio.**

- AccessPolicy: se saca de `OWNER_ONLY` y se añade una rama explícita: `organization.create` sobre `installation` → Allow (inactive ya se niega en l.667).
- `createOrganization`, en **una transacción**: INSERT del Space, `addMembership(admin)` del creador si no es el Owner (el Owner sigue sin fila, como hoy) y `audit.record` con la acción nueva `organization.create` (contrato `audit.ts`: AUDIT_ACTIONS y AUDIT_DETAIL_KEYS `[]`, target space). Después, `changed` + `accessChanged(creador)` para que su shell en vivo incluya el Space nuevo. Devuelve el `SpaceSummary` calculado como en `view` (con `pendingAdmin` si entró solo con contraseña).
- Admin pendiente (solo contraseña): actúa como Member (l.793), así que no invita hasta tener TOTP o passkey. Mientras tanto solo el Owner administra la Organization. Se prueba.
- MCP: no hay herramienta de crear Organizations y no se añade. El método de servicio basta.
- DoorRules: la entrada `spaces.createOrganization` sigue siendo `SPACES`; solo cambia el texto de la regla.
- UI: web/desktop no necesita cambios (ya lee `canCreateOrganization`). En el móvil, la acción «Create organization» en el menú de Space (`home-list-filter-menu.ts`), con su hoja de nombre y `createOrganization` de client-runtime.
- Docs: `install.md:261-262`.

**Red-first.** AccessPolicy: Member/Guest/sin Spaces → Allow; disabled/removed → Deny. Spaces.test: un Member crea una Organization y queda Admin (pendiente si solo tiene contraseña), aparece en su `view`, se registra la entrada de auditoría con su actor, y si falla el INSERT de la membership no queda una Organization huérfana.

**Riesgos.** (1) Sin tope: Organizations ilimitadas, cada una con su Sandbox posible en el Hub y su disco. Aceptable mientras el registro esté cerrado; el tope llega con plans-and-limits/03. (2) **Invitations**: cualquier User, una vez Admin de su propia Organization, crea Users nuevos con una Invitation (el modo por defecto es invitation-only, keycloak spec l.106 y 149). Queda auditado (`invitation.create` con actor) y se cierra con el modo «closed» de keycloak; se documenta. (3) Los nombres no son únicos: alguien puede crear una «Bezenti» falsa para engañar a invitados. Mitigación barata: la vista previa de la Invitation ya nombra a quien invita; verificarlo. (4) El creador no archiva ni borra su Organization: la basura la limpia el Owner.

## 19 · Todo en el Space actual

**Hoy.** El filtro está en `packages/client-runtime/src/spaces/spaceFilter.ts`. Excepciones: Threads y Projects con `spaceId` null salen en todos los Spaces (`matches`, l.~95), el Thread abierto y su cadena se quedan, y el Project de un borrador también (`useSidebarSpaceFilter.ts:37-63`). Toggle «All Spaces»: `Sidebar.tsx:3040-3052`, `currentSpace.ts:49-83`, `SidebarThreadHeader.tsx:18`. El proyecto por defecto de un Thread nuevo usa todos los Projects (`useHandleNewThread.ts:458`, `chatRouteCommands.ts:84`, `startNewThreadInNewTab.ts:29`). Search (`threadSearch.ts`, `OrchestrationV2SearchThreadsInput` l.3795) no tiene Space. Settled va por `projectIds` del Space (`Sidebar.tsx:521-525`), pero el Scratch Project es compartido y sus Threads llevan su propio `spaceId`, así que el contador se cuela. En el servidor, `claimCreation` (`SpaceDirectory.ts:1095-1103`) ignora el `spaceId` pedido si el Project existe. **El móvil tiene selector de Space pero no filtra nada.**

**Cambio.**

- client-runtime: se eliminan `effectiveSpaceFilter`, `showAllSpacesStorageKey` y las excepciones open/keep. Regla nueva `rowSpaceId(row, project, view)`: un `spaceId` null cuenta como el Personal space del Owner (como en el servidor). Solo el Owner ve esas filas: con `isOwner` es `view.personalSpaceId`. Los entornos sin Spaces (locales) no se filtran.
- Navegación: un hook compartido. Abrir un Thread, Project o borrador (enlace, notificación, historial) cuyo Space es otro y aparece en `view.spaces` llama a `selectSpace`. Si no aparece, `not_found` como hoy.
- Crear Project/Thread: `resolveDefaultProjectRef` y el selector de Project reciben solo los Projects del Space (botón, paleta, atajos `chat.new`/`chat.newLocal`, borrador). «Add project» ya envía el Space actual: verificarlo en la paleta y en el móvil.
- Search y Settled: `spaceId` opcional (`optionalKey`) en `OrchestrationV2SearchThreadsInput` y `GetOlderSettledThreadsInput`. El servidor lo **intersecta** con `SpaceVisibility.spaceFilter`, nunca amplía. Se anuncia con una capability nueva; con servidores viejos, el cliente filtra los resultados. La búsqueda de Projects de la paleta usa la misma regla. Las herramientas MCP (`t3_thread_search`) no cambian.
- Servidor: si `claim.spaceId` viene y el Project es de otro Space → `SpaceAccessDeniedError` con `reason: "space-mismatch"`. Sin `spaceId` (agentes, forks, CLI) sigue igual. Docs: `environment-auth.md:304-305`.
- Se quita el toggle «All Spaces» (estado, botón, prop y tests); la clave vieja de localStorage se ignora. Móvil: aplica el mismo filtro por entorno a la lista, búsqueda y Settled.
- DoorRules: sin entradas nuevas; las RPC de búsqueda y Settled ya están cubiertas por `spaceFilter`.

**Red-first.** spaceFilter.test: una fila null solo cuenta en el Personal space del Owner y el Thread abierto de otro Space ya no se queda. Test de navegación: abrir un Thread de otro Space cambia el Space actual. Servidor: `thread.create` con `spaceId` ≠ Space del Project → rechazado; sin `spaceId` → OK. `searchThreads` y `getOlderSettledThreads` con `spaceId`: Threads de Scratch de otro Space excluidos, y un `spaceId` invisible devuelve vacío. Browser test del Sidebar: no existe el botón «All Spaces».

**Riesgos.** El Owner pierde la vista de todo a la vez (lo pide el ticket). El cambio automático de Space al abrir un enlace puede sorprender, pero es el comportamiento pedido. Es el trabajo más grande en el móvil.

## Conflictos y recomendación

1. Spec, historias 19, 34 y 35 → quedan sustituidas. Añadir una nota en `spec.md` que apunte a 17 y 18.
2. Ticket 17 («el Owner lo ve en solo lectura») contra el mapa «Privacidad» (el Owner ve consumo, no contenido) → se mantiene lo actual; lo cambia platform-privacy.
3. Plans-and-limits (l.23, 94): «las Organizations existentes → Steward Owner» asignaría mal las que creen otros Users después de 18 → decidido: columna `spaces.created_by_user_id` (138) y nota en plans-and-limits/02.
4. Ticket 18 pide «Create organization en móvil», pero esa UI no existe → se construye nueva (entra en el alcance).
5. Ticket 19 dice «sin depender del cliente», pero hoy el servidor reasigna en silencio → rechazar solo cuando se envía `spaceId`.
6. `install.md` describe `registerOwn` como inerte y no lo es → se corrige al reescribir la sección.

## Fuera de alcance

Topes y Steward (plans-and-limits), modos de registro (keycloak), archivar/borrar o nombrar Admins por el creador, herramienta MCP de Organizations, Grants, owned-resources/06 (`registerOwn`), privacidad del Owner.

## Cómo quedó 19 (cambios respecto al diseño)

- Search y Settled **no** llevan `spaceId` nuevo al servidor ni capability. En el cliente, un Thread no tiene Space propio (los shells no lo traen) y el servidor pone cada Thread en el Space de su Project. Por eso basta con limitar por Projects: los Threads listados, los resultados de búsqueda (solo cuentan los Threads listados), y los `projectIds` de los conteos de Settled ya antiguos (web y móvil). La Scratch Project no se cuela: sus Threads también toman el Space del Project.
- Regla compartida en `packages/client-runtime/src/spaces/spaceFilter.ts`: `legacySpaceIdOf` (las filas sin Space son del Personal space del Owner), `filterThreadsBySpace`/`filterProjectsBySpace` sin excepciones para lo abierto, y `spaceToFollow`. Web: `useFollowOpenSpace` en la barra lateral. Móvil: `state/space-scope.ts`, por Hub, en la lista, la paleta, el selector de Project de un Thread nuevo, Settled y el cambio al abrir un Thread o borrador.
- Servidor: `claimCreation` rechaza con `space-mismatch` si se envía `spaceId` y no coincide con el Space del Project. Se comprueba después de la visibilidad.
