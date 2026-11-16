# Spec: Configuración en cuatro modales

Status: ready-for-agent
Map: ../public-hub/map.md (transversal, en paralelo a la fase 2: «Configuración en modales separados», «Todo en el Space actual»)
ADRs: 0007 (sin servicios externos: los enlaces apuntan a la URL pública del Hub), 0008 (plataforma abierta con un Owner operador)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: User, Owner, Space, Organization, Personal space, Member, Role, Project, Environment, Sandbox, Vault, AI account, Grant, Plan
Depende de: nada para empezar. El ticket 08 espera a los tickets de clientes de `../owned-resources/`.

## Problem Statement

La configuración de Bezenti está repartida en dos sitios que no se parecen. Por un lado, una página Settings heredada de T3 Code (`apps/web/src/routes/_chat.settings.*.tsx`, ~29 rutas, navegación en `SettingsSidebarNav.tsx` y `settingsSearch.ts`) mezcla tres cosas: preferencias de la persona (apariencia, chat, atajos), ajustes de toda la Installation que solo cambia el Owner (AI gateway, proveedores, mantenimiento, clave maestra) y ajustes de una máquina concreta (proveedores, source control, dispositivos, diagnóstico), con un selector de alcance (`project`/`machine`/`checkout` en la URL) y avisos de «solo el Owner cambia esto» (`InstallationSettingsBoundary.tsx`) para tapar la mezcla. Por otro, lo nuevo del Hub vive en diálogos sueltos que cuelgan del Space selector (`OrganizationSettingsDialog.tsx`, `UsersDialog.tsx`, `AuditLogDialog.tsx`), con el registro de auditoría además duplicado en Settings → Access.

Un Member abre Settings y ve páginas que no puede tocar; un Admin no encuentra los Members de su Organization en Settings; el Owner gestiona la plataforma desde un menú del Space selector. Con la plataforma abierta (máquinas, AI accounts y vaults con dueño, Grants, planes) esto empeora: cada recurso nuevo tendría que decidir en qué rincón cae.

## Solution

Cuatro modales, cada uno sobre un objeto, con la misma forma (navegación a la izquierda, secciones a la derecha, Esc vuelve a donde estabas):

- **User settings** (todo User): su cuenta y sesiones, sus preferencias (general, apariencia, chat, diffs, atajos, SnapShots), su vault personal, sus máquinas, sus AI accounts, los Grants que dio y su plan y uso.
- **Space settings** (el Space actual, Organization o Personal space): Members e Invitations, el Vault, las AI accounts y las máquinas del Space (propias o prestadas), los Grants por aceptar, tareas programadas, archivo y ciclo de vida (archivar, restaurar, borrar, salir). Sustituye `OrganizationSettingsDialog`.
- **Project settings** (un Project): general (nombre, icono, Space, archivar, quitar), los vaults y grupos que usa, la máquina donde corre y sus checkouts, valores por defecto y acciones (scripts). Sustituye `/settings/projects` y absorbe `ProjectSettingsPanel`.
- **Platform** (solo el Owner): Users y permisos (sustituye `UsersDialog`), auditoría (`AuditLogDialog`), clave maestra, AI gateway, Sandboxes, la máquina del Hub, los valores del Hub y Labs; y los huecos que llenan otros specs: modo de registro, planes, Keycloak y términos.

Lo que es de una máquina (proveedores, source control, dispositivos, mantenimiento, diagnóstico) se configura en la página de esa máquina, a la que se llega desde donde aparece la máquina: User → Machines, Space → Machines o Platform → Hub machine.

El estado del modal vive en la URL (`/settings/<modal>/…`): los enlaces se comparten, el botón Atrás funciona y las URLs viejas redirigen a su sitio nuevo. En móvil, la pantalla Settings se divide en las mismas cuatro entradas. El escritorio envuelve la web y solo cambia su menú.

Este spec mueve lo que existe y crea los modales; no crea funcionalidades. Las secciones de Grants, planes, Keycloak, registro, términos y borrado de cuenta las añaden sus specs (`../grants/`, `../plans-and-limits/`, `../keycloak-sign-in/`, `../platform-privacy/`) en los huecos que este spec reserva. Las secciones por dueño de Vault, AI accounts y máquinas las construye `../owned-resources/`; aquí solo se montan en su modal.

## User Stories

### Todos

1. Como User, quiero abrir mis ajustes desde mi nombre en la barra lateral, con `mod+,` o desde la paleta de comandos, para cambiar mis preferencias sin pasar por páginas que no son mías.
2. Como User, quiero que cada modal tenga su buscador y que la paleta de comandos encuentre cualquier ajuste de cualquier modal, para llegar a un ajuste sin saber dónde vive.
3. Como User, quiero copiar la URL de una sección y que al abrirla aparezca ese modal en esa sección, para mandar a alguien directo a un ajuste.
4. Como User, quiero que Esc o Atrás cierren el modal y me devuelvan al Thread que tenía abierto, para no perder el sitio.
5. Como User, quiero que mis enlaces y marcadores viejos (`/settings/providers`, `/settings/access#authorized-clients`…) me lleven al ajuste en su sitio nuevo, para que nada se rompa.
6. Como User, quiero no ver secciones que no puedo usar, en vez de páginas con avisos de «solo el Owner», para que mis ajustes sean solo míos.

### User settings

7. Como User, quiero ver y cambiar mis métodos de inicio de sesión (passkey, contraseña, TOTP) y cerrar sesión en **Account**, para gestionar mi cuenta en un solo sitio.
8. Como User, quiero ver y revocar mis sesiones, enlaces de emparejamiento y permisos de esta sesión en **Sessions**, para cortar un dispositivo perdido.
9. Como User, quiero mis preferencias de este dispositivo (General, Appearance, Chat, Diffs, SnapShots) y mis atajos en mi modal, para no confundirlas con las del Hub.
10. Como User, quiero ver mi vault personal, mis máquinas y mis AI accounts en mi modal, para gestionar lo que es mío.
11. Como User de escritorio, quiero los ajustes de este equipo (acceso de red, Tailscale, WSL, «This app») en **Machines → This computer**, para encontrarlos donde están mis máquinas.

### Space settings

12. Como Member, quiero abrir los ajustes del Space actual desde el Space selector o la paleta, para ver quién está y qué recursos tiene.
13. Como Admin, quiero invitar, cambiar Roles, expulsar y crear enlaces de reset en **Members** e **Invitations**, para gestionar mi equipo como hoy pero en su sitio.
14. Como Admin u Owner, quiero archivar, restaurar o borrar la Organization en **General**, y como Member salir de ella ahí mismo, para tener el ciclo de vida junto al resto.
15. Como User, quiero los ajustes de mi Personal space con las mismas secciones que tienen sentido (sin Members ni Invitations), para no aprender dos formas.
16. Como Member, quiero ver el archivo y las tareas programadas del Space actual en su modal, para que todo lo del Space esté en el Space (`../identity-and-access/issues/19`).
17. Como Admin, quiero ver el Vault, las AI accounts y las máquinas de la Organization en su modal, para gestionar lo que es del Space.

### Project settings

18. Como User, quiero abrir los ajustes de un Project desde su menú en la barra lateral, la paleta o un enlace `/projects/<key>`, para cambiar su nombre, icono, vaults, máquina, valores por defecto y acciones.
19. Como User, quiero que el modal del Project tenga secciones (General, Vaults, Machine, Defaults, Actions) en vez de una sola página larga, para ir directo a lo que busco.

### Platform

20. Como Owner, quiero un único modal **Platform** con Users, auditoría, clave maestra, AI gateway, Sandboxes, la máquina del Hub, valores del Hub y Labs, para gobernar la plataforma desde un sitio.
21. Como Owner, quiero que los ajustes de proveedores, source control, dispositivos y mantenimiento del Hub estén en **Platform → Hub machine**, para separarlos de mis preferencias.
22. Como User que no es el Owner, quiero no ver Platform en ningún sitio, y que una URL suya me diga que es solo del Owner, para no tropezar con ella.

### Móvil y escritorio

23. Como User en el móvil, quiero que Settings tenga las cuatro entradas (User, Space, Project, Platform) con las pantallas que ya existen repartidas igual que en la web, para no aprender otra organización.
24. Como Admin en el móvil, quiero ver los Members del Space e invitar con un enlace copiable, para sumar a alguien desde el teléfono.
25. Como User de escritorio, quiero que el menú **Settings…** (`CmdOrCtrl+,`) abra mis ajustes de User, para que el atajo de siempre siga sirviendo.

## Implementation Decisions

### URL y rutas

- Todo modal sigue bajo `/settings/`, para conservar lo que ya funciona: `AppRouteModal` (`apps/web/src/components/AppRouteModal.tsx`), `isAppModalPage` y la vuelta al opener de `apps/web/src/components/sidebar/mainAppLocation.ts`.
- Rutas:
  - `/settings/user/$section`
  - `/settings/user/machines/$environmentId/$section`
  - `/settings/space/$spaceId/$section`
  - `/settings/space/$spaceId/machines/$environmentId/$section`
  - `/settings/project/$projectKey/$section`. Conserva los parámetros `machine` y `checkout` para los overrides por checkout.
  - `/settings/platform/$section`
  - `/settings/platform/hub-machine/$section`
- `/settings` y `/settings/user` van a `/settings/user/general`. `/settings/space` va al Space actual. `/settings/platform` va a `users`. `/projects/$projectKey` (`apps/web/src/routes/projects.$projectKey.tsx`) va a `/settings/project/$projectKey/general`.
- Abrir el modal de un Space o de un Project de otro Space cambia el Space actual a ese, con la misma regla que el ticket 19 de identity-and-access: la barra lateral nunca mezcla Spaces.
- Historial: cambiar de sección dentro de un modal reemplaza la entrada, como hoy (`replace: true` en `SettingsSidebarNav`), así que Atrás cierra el modal. Abrir una subpágina (una máquina, Licencias) o pasar a otro modal añade entrada, y Atrás vuelve a la lista.
- **URLs viejas:** una tabla `ruta vieja + ancla → ruta nueva` sustituye a `movedSettingsPath`, `RENAMED_SETTINGS_PATHS` y `MOVED_SECTION_ANCHORS` (`apps/web/src/components/settings/settingsSearch.ts`) y se queda para siempre. Cuesta poco y cubre marcadores, documentación vieja y notificaciones. Las rutas que necesitan un objeto lo resuelven al redirigir: `?project=` pasa a ser el Project, `?machine=` la máquina, y el Space es el actual. Lo que no se puede resolver va a la sección madre del modal.

### Registro de secciones

- Un único módulo (`apps/web/src/components/settings/settingsModals.ts`) declara, por modal, sus secciones en orden: `id` (segmento de URL), etiqueta, icono, componente y una función de visibilidad `(principal, objeto) → boolean`. Sustituye `SETTINGS_NAV_GROUPS`, `SETTINGS_SECTION_LABELS`, `SETTINGS_OWNER_ONLY_PATHS`, `SETTINGS_HUB_WIDE_PATHS` / `InstallationSettingsBoundary` y `SETTINGS_DEVICE_ONLY_PATHS`. La visibilidad sale del modal y su objeto, así que desaparecen los avisos de «solo el Owner cambia esto».
- Las secciones que llegan con otros specs se declaran como huecos reservados (id, URL y posición), sin componente y no visibles. Ningún modal muestra un marcador vacío. Cada spec dueño añade su componente y enciende la sección.
- Los elementos de búsqueda (`SETTINGS_SEARCH_ITEMS`) pasan a llevar `modal` y `section` en vez de `to`. Un resolutor construye la URL con el Space actual, el Project del contexto o la máquina del contexto. El buscador de cada modal busca solo en ese modal. La paleta (`apps/web/src/components/CommandPalette.tsx`) busca en todos y muestra «User · Appearance», «Space · Members»… Un elemento cuyo modal no es visible para el User (Platform para un Member) no aparece.
- El selector de alcance desaparece (`SettingsScopeSentence.tsx`, el eje `machine` de `settingsScopeAxis.ts` y el alcance «all»). Cada modal fija su objeto: las máquinas tienen su página, Project settings fija el Project y conserva solo el selector de checkout, y los valores comunes a todo el Hub son Platform → Hub defaults.

### Marco común

- `routes/_chat.settings.tsx` sigue siendo el marco (`AppRouteModal`). La navegación lateral (`SettingsSidebarNav.tsx`) se alimenta del registro del modal activo. La cabecera muestra el modal y su objeto («Space settings · Acme», «Project settings · t3code») y el botón de cerrar.
- Cada sección se carga al abrirla (code splitting de las rutas). No se añade sondeo nuevo. El sondeo de 5 s de `HubEnvironmentsSettings` solo corre con su sección abierta, como hoy.
- Las secciones movidas conservan sus componentes y sus `id` de ancla. Lo que hoy es un diálogo (`OrganizationSettingsDialog`, `UsersDialog`, `AuditLogDialog`) pasa a ser el contenido de una sección: se quita el envoltorio `Dialog`, no se reescribe. Las reglas de `docs/internals/web-ui.md` se aplican: primitivas de `components/ui` sin restyle y slots en vez de copiar markup.
- Sin cambios de servidor. La autorización sigue en el servidor (AccessPolicy). La visibilidad en el cliente sale del principal y de los permission atoms que ya existen (`usePrimaryActsForInstallation`, `view.isOwner`, `canInvite` y el Role en la vista de Spaces).

### Clasificación de la página Settings actual

Destino de cada ruta `apps/web/src/routes/_chat.settings.*.tsx` y de cada diálogo. «Máquina» es la página de una máquina: User → Machines → ‹m›, Space → Machines → ‹m› o Platform → Hub machine.

| Ruta o diálogo actual | Contenido (componente) | Destino | Ticket |
| --- | --- | --- | --- |
| `/settings` (layout `_chat.settings.tsx`) | Marco, nav, scope, botón «Restore device defaults» | Marco común; el botón va a User → General | 01 |
| `/settings/general` | `GeneralSettingsPanel`: Notifications, Sidebar, Confirmations, Display (dispositivo) | User → General | 01 |
| `/settings/appearance` | `AppearanceSettingsPanel`, `TypographySettings`, temas | User → Appearance | 01 |
| `/settings/chat` | `ChatSettingsPanel`: Composer, Follow-ups | User → Chat | 01 |
| `/settings/diffs` | `DiffsSettingsPanel`: Diffs, Pull requests | User → Diffs | 01 |
| `/settings/keybindings` | `KeybindingsSettings` | User → Keybindings (hoy son del Hub entero: el Owner edita y los demás leen; ver Preguntas abiertas) | 01 |
| `/settings/snap-shot` | `SnapShotSettings` (solo escritorio) | User → SnapShots (solo escritorio) | 01 |
| `/settings/about` | `AboutSettingsPanel`: App, Legal | User → About | 01 |
| `/settings/open-source-licenses` | `OpenSourceLicenses` | User → About → Licenses (subpágina) | 01 |
| `/settings/access` | `ConnectionsSettings view="access"` | Se divide: | 02, 06, 07 |
| ↳ | `AccountSettingsSection` («Your account») | User → Account | 02 |
| ↳ | «Your sessions» (authorized clients, pairing links) y «Permissions» (`SessionPermissions`) | User → Sessions | 02 |
| ↳ | `MasterKeySettingsSection` | Platform → Master key | 06 |
| ↳ | `AuditLogSettingsSection` | Desaparece: es Platform → Audit log | 06 |
| ↳ | Entorno primario: versión y URL | Máquina → Maintenance (Hub machine en web; This computer en escritorio) | 07 |
| ↳ | Acceso de red, endpoints, Tailscale, WSL (backend local de escritorio) | User → Machines → This computer → Network | 07 |
| `/settings/connections` | `ConnectionsSettings view="environments"` | Se divide: | 07, 08 |
| ↳ | `HubEnvironmentsSettings` («Machines on this Hub») | Personales: User → Machines; dedicadas: Space → Machines | 08 |
| ↳ | `HubSandboxesSettings` | Lista y límites: Platform → Sandboxes. El Sandbox del Space se ve en Space → Machines | 06, 08 |
| ↳ | `SandboxImageSettings` | Platform → Sandboxes | 06 |
| ↳ | «This app» (`LocalEnvironmentSetting`, `JoinedEnvironmentSetting`) | User → Machines → This computer | 07 |
| ↳ | «Hub» guardado (`SavedEnvironmentRows`, `AddEnvironmentDialog`, `KeptSavedConnectionsNotice`) | User → Account («Hub of this app», solo escritorio) | 02 |
| `/settings/providers` | `ProviderSettingsPanel` (por Environment) | Máquina → Providers | 07 |
| `/settings/source-control` | `SourceControlSettingsPanel` | Máquina → Source control. Los valores de repositorio por Project ya están en Project → Defaults | 07 |
| `/settings/devices` | `DevicesSettingsPanel`, `DeviceSourcesSettings` | Máquina → Devices | 07 |
| `/settings/maintenance` | `MaintenanceSettingsPanel`: Updates, Background activity, Diagnostics, Storage | Máquina → Maintenance; la actualización de la app de escritorio, User → About | 07 |
| `/settings/diagnostics` | `DiagnosticsSettings` | Máquina → Maintenance → Diagnostics (subpágina) | 07 |
| `/settings/threads` | `ThreadsSettingsPanel`: New projects, Snooze, Usage limits, Auto-settle, Text generation (del Hub entero) | Platform → Hub defaults → Threads | 06 |
| `/settings/browser` | `BrowserSettingsPanel`: Agent access, Browsing, Recordings (del Hub entero) | Platform → Hub defaults → Browser | 06 |
| `/settings/worktrees` | `WorktreesSettingsPanel` (valores de todos los Projects) | Platform → Hub defaults → Worktrees; el override por Project, Project → Defaults | 05, 06 |
| `/settings/labs` | `LabsSettingsPanel`: Beta, Legacy | Platform → Labs | 06 |
| `/settings/projects` | `ProjectsSettings` → `ProjectSettingsPanel` | Project settings (todas sus secciones); desaparece la página «elige un Project» | 05 |
| `/settings/archived` | `ArchivedThreadsPanel` | Space → Archive (filtrado al Space) | 04 |
| `/settings/scheduled-tasks` | `ScheduledTasksSettings` | Space → Scheduled tasks (filtrado al Space) | 04 |
| `/settings/ai-accounts` | `AiAccountsSettings`, `AiUsageTab`, `LocalCliKeysSection` | Las mías, su uso y las Local CLI keys: User → AI accounts. Las de la Organization: Space → AI accounts | 08 |
| `/settings/ai-gateway` | `AiGatewaySettings` | Platform → AI gateway | 06 |
| `/settings/vaults` | `VaultsSettings`, `VaultChoices` | Mi vault personal: User → Vault. El de la Organization: Space → Vault. Las elecciones de un Project: Project → Vaults | 05, 08 |
| `/settings/secrets` | `SecretsSettingsPanel` tras `T3CODE_FEATURE_SECRETS` | Se borra (lo sustituyen los Vaults); redirige a User → Vault | 12 |
| `/settings/integrations`, `/settings/storage`, `/settings/beta` | Redirecciones de nombres viejos | Entran en la tabla de URLs viejas con el ticket de su destino (→ Platform → Hub defaults → Browser o máquina → Devices, máquina → Maintenance, Platform → Labs); los archivos se borran en el 12 | 06, 07, 12 |
| `OrganizationSettingsDialog` (sidebar) | Members, Invitations, reset links, ciclo de vida, salir | Space → Members, Invitations, General | 03 |
| `UsersDialog` (sidebar) | Users, Installation permissions, desactivar, quitar, reset | Platform → Users | 06 |
| `AuditLogDialog` (sidebar) | Registro de auditoría | Platform → Audit log | 06 |
| `CreateOrganizationDialog` (en `SpaceSelector.tsx`) | Crear Organization | Se queda en el Space selector: es una acción, no un ajuste | — |
| `/usage` (`_chat.usage.tsx`) | Panel de uso | Se queda como modal propio; User → Plan & usage lo enlaza cuando exista | — |

### Secciones de cada modal

Las etiquetas visibles van en inglés, como el resto de la app. Las marcadas «hueco» se reservan aquí y las enciende el spec indicado.

- **User settings:** Account (+ «Connect with Keycloak», hueco de `../keycloak-sign-in/`; + borrar mi cuenta, hueco de `../platform-privacy/`), Sessions, General, Appearance, Chat, Diffs, Keybindings, SnapShots (escritorio), Vault, Machines (subpáginas por máquina; en escritorio, «This computer»), AI accounts, Grants given (hueco, `../grants/`), Plan & usage (hueco, `../plans-and-limits/`), About.
- **Space settings, Organization:** General (nombre, archivar, restaurar, borrar, salir), Members, Invitations, Vault, AI accounts, Machines (dedicadas, el Sandbox del Space y las prestadas cuando existan), Grants to accept (hueco, `../grants/`), Scheduled tasks, Archive.
- **Space settings, Personal space:** General (con el aviso actual de que el Owner lo ve, que `../platform-privacy/` cambiará), Vault, AI accounts, Machines, Grants to accept (hueco), Scheduled tasks, Archive. En las secciones de recursos, lo propio aparece como lista que lleva a User settings, donde se gestiona, y lo prestado lo añade `../grants/`. No tiene Members ni Invitations.
- **Space settings del Personal space de otro User:** solo el Owner lo abre, en solo lectura. Muestra General y las secciones de recursos, como hoy ve ese Space desde el selector, hasta que `../platform-privacy/` lo recorte.
- **Project settings:** General (nombre, icono, pin, archivar, Space y mover, zona de peligro), Vaults (`ProjectVaultsSettings`), Machine (`ProjectPreferredEnvironmentSettings` y Checkouts), Defaults (`ProjectDefaultsSettings` y el override de worktrees), Actions (`ProjectActionsSettings`, scripts).
- **Platform:** Users, Audit log, Master key, AI gateway, Sandboxes (lista, límites e imagen), Hub machine (subpáginas de máquina del Hub), Hub defaults (Threads, Browser, Worktrees), Labs; Registration (hueco, `../keycloak-sign-in/`), Keycloak (hueco, `../keycloak-sign-in/`), Plans (hueco, `../plans-and-limits/`), Terms (hueco, `../platform-privacy/`).
- **Página de máquina** (un componente, `MachineSettings`, montado en las tres rutas de máquina): Providers, Source control, Devices, Maintenance (versión, actualizaciones, actividad de fondo, almacenamiento, Diagnostics como subpágina) y, solo para el backend local del escritorio, Network. Quién la edita sigue igual que hoy (el Owner) hasta que `../owned-resources/` dé la gestión al dueño de la máquina; los demás ven la página en solo lectura o no la ven, según las reglas de hoy.

### Quién ve cada modal

| Modal | Lo abre | Lo que cambia por Role |
| --- | --- | --- |
| User | Todo User con sesión | Nada. Keybindings y la página de máquina siguen las reglas de hoy |
| Space (Organization) | Members, Guests, Admins y el Owner | Members: solo lectura y salir. Admin: invitar, Roles y expulsar (sin tocar Admins). Owner: también Admins, archivar, restaurar y borrar. Las mismas reglas que hoy aplica `OrganizationSettingsDialog` |
| Space (Personal) | Su dueño; el Owner en solo lectura | — |
| Project | Quien ve el Project | Editar según las reglas actuales de `ProjectSettingsPanel` (`canEditGroup`) |
| Platform | Solo el Owner | Otro User que abre su URL ve «Only the Owner of this Hub opens Platform.» y nada más |

### Entradas

| Entrada | User | Space | Project | Platform |
| --- | --- | --- | --- | --- |
| Barra lateral | El botón Settings del pie (`SidebarChrome.tsx`) pasa a ser el nombre del User y abre User settings | — | «Project settings» del menú del Project (`Sidebar.tsx`) | — |
| Space selector (`SpaceSelector.tsx`) | — | «Space settings» (también en el Personal space); «Invite people» abre Space → Invitations | — | «Platform» (Owner); sustituye «Users and permissions» y «Audit log» |
| Paleta | «Open user settings» y todos los ajustes | «Space settings» | «Project settings» (ya existe, contextual) | «Platform» (Owner) |
| Atajo (comando de `packages/contracts/src/keybindings.ts`) | `settings.user`, por defecto `mod+,` | `settings.space`, sin tecla | `settings.project`, sin tecla (Project del contexto) | `settings.platform`, sin tecla |
| Escritorio | El menú **Settings…** (`CmdOrCtrl+,`, `DesktopApplicationMenu.ts`) abre User settings | — | — | — |
| Enlaces dentro de la app | `PermissionUpdateNotice.ts` y el aviso «Set up an authenticator app» del selector → User → Account/Sessions; `CommandPalette` «Connect environment» y `HostedEmptyState.tsx` → User → Machines | `ThreadAutomationsPanel.tsx`, `QueuedRunsControl.tsx`, `TimelineUserMessageRow.tsx` → Space → Scheduled tasks | `ChatView.tsx` (borrador) y `/projects/$projectKey` | `CustomSnoozeDialog.tsx` → Platform → Hub defaults → Threads |
| Enlaces a una máquina | `ModelPickerContent.tsx`, `useComposerSelection.ts`, `SidebarProviderUpdatePill.tsx` (Providers), `GitActionsControl.tsx` y la paleta (Source control) llevan a la página de la máquina del Thread o Project del contexto, y si no la hay, a Platform → Hub machine. Un User que no puede abrirla no ve el enlace | | | |
| `routes/__root.tsx` | La redirección a SnapShots de escritorio → User → SnapShots | | | |

### Agentes y servicios

No hay capacidades nuevas: los modales llaman a los mismos servicios y RPCs que las páginas y diálogos de hoy. Los agentes ya llegan a esas operaciones por MCP donde existen. Este spec no añade herramientas MCP.

### Móvil

- `apps/mobile/src/features/settings/SettingsRouteScreen.tsx` pasa a ser un índice con cuatro filas (User, Space, Project, Platform), más las conexiones que ya muestra. Cada fila abre una pantalla índice con las mismas secciones que la web, limitadas a lo que el móvil ya tiene. Las pantallas existentes se mueven, sin reescribirlas:
  - User: Appearance, Chat (`SettingsFollowUpRouteScreen`), Keyboard (iOS), Microphone, Navigation tabs, General (`SettingsProjectGroupingRouteScreen`), Client storage, AI accounts, Vault, Machines (`SettingsEnvironmentsRouteScreen`, `SettingsEnvironmentDetailRouteScreen`), About, Legal y Licenses.
  - Space: Scheduled tasks, Archive, y Members e Invitations (nuevo en móvil, ticket 10).
  - Project: `SettingsProjectOverviewRouteScreen`, que fija el Project del contexto.
  - Platform (solo Owner): Providers (`SettingsProviderAccountsRouteScreen`), Threads, Worktrees, Source control y Maintenance del Hub (`SettingsServerControlsRouteScreen`), Labs y Diagnostics. Lo que el móvil no tiene (Users, auditoría, clave maestra, AI gateway) se abre en el navegador del sistema con la URL pública del Hub (`/settings/platform/<section>`), según ADR 0007.
- Rutas de `apps/mobile/src/Stack.tsx`: `settings/user/…`, `settings/space/…`, `settings/project/…` y `settings/platform/…`. `settings` sigue siendo el índice. Las rutas viejas no se conservan: solo las enlaza la propia app.
- La lógica de qué secciones ve cada principal es la misma en web y móvil y vive en `packages/client-runtime` (por ejemplo, `client-runtime/src/settings/settingsModalVisibility.ts`). Web y móvil la leen; no se copia.

### Documentación

- `docs/user/` cambia cada «Settings → X» por su ruta nueva («User settings → Appearance», «Space settings → Members», «Platform → Hub machine → Providers»…). Archivos con rutas: `install.md`, `providers-*.md`, `remote-access.md`, `source-control.md`, `project-settings.md`, `thread-sidebar.md`, `composer.md`, `keybindings.md`, `devices.md`, `appearance.md`, `usage.md`, `updating.md`, `background-service.md`, `outside-agents.md`, `telemetry.md`, `open-source-licenses.md`, `cursor.md`, `browser-import.md`, `default-browser.md`, `faq.md`, `guest-links.md`, `keyboard-focus.md`, `permission-modes.md`, `public-hub.md`, `snap-shot.md`. También `install.md` en «Spaces and organizations» y «Audit log», donde habla de «Organization settings», «Users and permissions» y «Audit log» desde el Space selector.
- `docs/internals/` se revisa donde nombra rutas o pantallas de Settings: `mobile-navigation.md`, `mobile-development.md`, `remote.md` y `open-source-licenses.md`. Se reescribe, sin añadir historia.
- Una sección breve en `docs/user/install.md` explica los cuatro modales y cómo se abren, sin describir cada pantalla.

## Testing Decisions

- **Un test bueno** comprueba lo que ve y a dónde llega un User, no la forma del markup. No se prueban etiquetas, iconos ni el cableado de cada sección.
- **Seam 1, registro y redirecciones** (puro, en `settingsModals.test.ts`, que sustituye las partes de `settingsSearch.test.ts` y `settingsScopeNavigation.test.ts` que mueren): una tabla con cada ruta vieja y cada ancla conocida que comprueba que lleva a una sección que existe en el registro. Una ruta vieja nueva es una fila nueva. Otra tabla comprueba la visibilidad: (Owner, Admin, Member, Guest, dueño y no dueño del Personal space) × (modal, sección). Así un hueco reservado nunca es visible y Platform nunca aparece para quien no es el Owner.
- **Seam 2, la lógica compartida de visibilidad** en `packages/client-runtime`: la prueban las filas del Seam 1. No se repite en el móvil.
- **Seam 3, navegador** (`*.browser.test.tsx` con `render` de `apps/web/test/render.tsx`, `router` activo): un solo test del marco. Abre una URL profunda (`/settings/space/<id>/members`), cambia de sección y comprueba que Atrás vuelve al opener y no a la sección anterior. Otro comprueba que un Member que abre `/settings/platform/users` ve el aviso y no la lista. Los tests de navegador que ya existen para los componentes movidos (`KeybindingsSettings`, `ProjectSettingsPanel`, `ScheduledTasksSettings`…) se mueven con ellos y no se duplican.
- **Sin sleeps ni polling**: `expect.element` y `vi.waitFor`.
- **Pase real**: una pasada integrada con `test-t3-app` (web, como Owner y como Member con datos sembrados) y otra con `test-t3-mobile` al cerrar los tickets de móvil. Las capturas antes y después van al PR, no al repo.

## Out of Scope

- Grants dados y por aceptar, préstamos de máquinas, AI accounts y grupos: `../grants/`.
- Planes, plan por defecto, uso del plan y cuotas: `../plans-and-limits/`.
- Keycloak, modo de registro, Invitations de plataforma, vincular con Keycloak: `../keycloak-sign-in/`.
- Términos de uso, borrado y descarga de cuenta, que el Owner deje de ver lo ajeno: `../platform-privacy/`.
- Secciones por dueño de Vault, AI accounts y máquinas, y la gestión de una máquina por su dueño: `../owned-resources/`.
- Atajos por User (hoy los guarda el Hub en un solo archivo): ver Preguntas abiertas.
- Renombrar una Organization y cualquier otra acción que hoy no exista.
- Cambios de servidor, salvo los comandos de atajo nuevos del contrato.

## Further Notes

- «Hit every surface» (AGENTS.md): entradas (barra lateral, Space selector, paleta, atajos, enlaces profundos, menú de escritorio), clientes (web, escritorio, móvil), contratos (comandos de atajo), estados de vuelta (cada modal se cierra con Esc y Atrás; salir de una Organization y archivar/restaurar siguen juntos) y docs. Los proveedores no aplican: la página de máquina muestra los mismos adaptadores que hoy.
- Mientras dura la migración conviven las dos navegaciones: cada ticket que mueve una sección la quita de la nav vieja y deja su ruta vieja como redirección. El ticket 12 quita lo que quede.
- Rendimiento: abrir un modal no carga las secciones de los demás, y el modal no suscribe nada nuevo al socket.

## Preguntas abiertas

Decididas con recomendación; el Owner puede reabrirlas.

1. **¿Atajos por User?** Hoy los guarda el Hub en un único `keybindings.json` (`apps/server/src/keybindings.ts`): si un Member los cambiara, los cambiaría para todos. Recomendación: en este spec, la sección va a User settings con la regla de hoy (el Owner edita y los demás leen, con una línea que lo explica). Overrides por User, encima del archivo del Hub, en un ticket aparte fuera de este spec, porque toca el servidor.
2. **Valores del Hub en Platform.** Threads (snooze, auto-settle, modelo de títulos), Browser y Worktrees son hoy del Hub entero. Recomendación: Platform → Hub defaults. Si alguno debe ser por User (los snooze presets parecen preferencias), se decide aparte. Alternativa descartada: dejarlos en User settings con un aviso de solo lectura, que es justo la mezcla que se quiere quitar.
3. **`mod+,` en la web.** Algunos navegadores se quedan la combinación. Recomendación: usarla por defecto igualmente (en escritorio ya es la del menú), documentar la paleta como alternativa y que se pueda cambiar en Keybindings.
4. **Platform y el ciclo de vida de una Organization en el móvil.** Recomendación: abrir la web del Hub en el navegador del sistema. Pantallas nativas solo si se piden.
5. **`/settings/secrets` (`SecretsSettings`, `T3CODE_FEATURE_SECRETS`).** Funcionalidad de T3 Code detrás de un flag, que los Vaults sustituyen. Recomendación: borrarla en el ticket 12 y redirigir a User → Vault.
6. **Prefijo de URL.** Recomendación: `/settings/<modal>/…` en vez de `/user`, `/space`…, para reutilizar `AppRouteModal` y la vuelta al opener sin máquina nueva.
7. **Abrir el modal de otro Space cambia el Space actual.** Recomendación: sí, con la misma regla que el ticket 19 de identity-and-access. Alternativa descartada: un modal de Space que no es el actual, que mezclaría Spaces.
8. **Redirecciones viejas para siempre.** Recomendación: sí. Es una tabla pequeña y protege enlaces en docs, chats y notificaciones.
9. **Los Members dejan de leer los valores del Hub.** Hoy un Member ve en solo lectura Threads, Browser, Worktrees y Labs. Platform es solo del Owner, así que deja de verlos. Recomendación: aceptarlo; ninguno es una decisión que el Member tome. Si hiciera falta, una línea en el composer o en el Thread explica el efecto (por ejemplo, el auto-settle), no una página.
