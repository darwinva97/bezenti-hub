# Spec: Recursos con dueño

Status: ready-for-agent
Map: ../public-hub/map.md (spec 2 de 6, fase 2: «Recursos en fase 2», «Vaults con grupos», «Dueños y préstamos»)
ADRs: 0004 (un Sandbox por Space; nada protege los Secrets de un Space frente a su propio agente), 0005 (AI gateway), 0008 (plataforma abierta con un Owner operador), 0010 (los dueños prestan recursos con Grants), 0011 (las máquinas prestadas corren Sandboxes; la que usa solo su dueño corre nativa), 0012 (los Secrets son de solo escritura; las Variables no)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: Vault, Vault group, Secret, Variable, AI account, External environment, Grant, Steward
Depende de: specs `../vaults/` y `../ai-accounts-and-gateway/` (done); `../identity-and-access/issues/17` (Personal space siempre) antes de los tickets 04 y 08. No depende de `../keycloak-sign-in/`.

## Problem Statement

Hoy todo recurso del Hub es del Owner. Solo el Owner registra AI accounts (`aiAccount.manage` en `apps/server/src/auth/AccessPolicy.ts`, ADR 0005), crea Vaults (`vault.manage`) y dedica máquinas a una Organization (`environment.dedicate`); un User une su propia máquina solo si el Owner le dio el Installation permission `environments.registerOwn` (ticket 08 de `../sandboxes-and-external-environments/`). En una plataforma abierta (ADR 0008) eso no escala: cada persona y cada Organization tiene que poder traer sus propias máquinas, sus API keys y suscripciones y sus secretos sin pedírselo al Owner.

Además los Vaults del spec `../vaults/` no encajan con lo decidido en el mapa:

- un Vault es un conjunto plano de secretos; no hay grupos que sirvan de unidad para prestar (Grants, fase 3);
- el Owner puede revelar cualquier valor (`vaults.reveal`), lo que contradice ADR 0008 y 0012;
- todo valor es un secreto enmascarado; no hay forma de guardar configuración no sensible (`NODE_ENV`, una URL pública) que se vea y se edite;
- los valores son de una línea en la UI (`SecretInput.tsx`) y el enmascarado solo tapa el valor completo: una clave PEM impresa a medias (`head -5 key.pem`) queda en el historial;
- los Secret links y copias solo existen desde el Main vault del Owner hacia otros Vaults.

## Solution

Cada recurso tiene **un dueño: un User o una Organization**, y en esta fase solo se usa en los Spaces de su dueño. Salir de ahí es un Grant (spec `../grants/`).

- **Environments:** cualquier User une sus máquinas personales, sin Installation permission. Los Admins de una Organization dedican máquinas a ella; la máquina dedicada pasa a ser de la Organization. Una máquina personal sigue como hoy: solo la usa su dueño, para sus propios Threads, en cualquiera de sus Spaces (GLOSSARY «External environment», ADR 0011).
- **AI accounts:** cualquier User registra AI accounts suyas (API keys y suscripciones), usables en su Personal space. Los Admins de una Organization registran las de la Organization, usables por quien trabaja en ella. Las del Owner siguen como hoy, con sus allowances, hasta que el spec de Grants las convierta.
- **Vaults:** un Vault por dueño (el personal de cada User, el de cada Organization), con un grupo `default` que no se borra y grupos con nombre. Cada grupo tiene **Secrets** (solo escritura, enmascarados) y **Variables** (visibles, editables, sin enmascarar). Los valores admiten varias líneas y el enmascarado cubre un Secret multilínea impreso entero o en parte. Desaparece «Reveal». El Main vault pasa a ser el vault personal del Owner.
- Los tickets 17, 18 y 19 de `../identity-and-access/` (Personal space siempre, cualquier User crea Organizations, todo en el Space actual) son parte de esta fase y no se repiten aquí.

## User Stories

### Máquinas

1. As a User, I want to join my own machine to the Hub without asking the Owner for a permission, so that I can run my Threads on my hardware.
2. As a User, I want my personal machine to stay mine alone, usable for my own Threads in any of my Spaces, so that nobody else runs work on it.
3. As an Admin of an Organization, I want to dedicate a machine to my Organization from the «Register this machine» page, with `t3 join --dedicated`, or over SSH, so that my team gets a shared VPS without the Owner.
4. As an Admin, I want to rename, remove and move to another Organization I administer the machines dedicated to my Organization, so that I manage them over time.
5. As an Admin, I want to be refused when I try to dedicate a machine to an Organization I am not an Admin of, so that nobody slips a machine into someone else's Organization.
6. As the Owner, I want to keep seeing, renaming and removing every machine, so that I can still operate the platform.

### AI accounts

7. As a User, I want to add my own API key or sign in to my own subscription in Settings → AI accounts, so that my Threads in my Personal space use my account.
8. As a User, I want my AI accounts invisible and unusable to everyone else, Organizations I belong to included, so that nobody consumes them without a Grant.
9. As an Admin, I want to add AI accounts owned by my Organization, so that its Members use them without the Owner's.
10. As a Member, I want my Organization's AI accounts in the composer picker, so that I can use them.
11. As an AI account's owner (a User, or an Organization's Admins), I want to rename, disable, replace the credential of, reorder and delete it, so that I manage it like the Owner does today.
12. As a User, I want my own accounts first and then the ones the Owner allowed me, so that new Threads use mine by default.
13. As the Owner, I want my existing AI accounts and their allowances to keep working as they are, so that nothing breaks before Grants exist.

### Vaults, grupos, Secrets y Variables

14. As a User, I want a personal vault with a `default` group that every Thread in my Personal space receives, so that I keep my own tokens without the Owner.
15. As an Admin, I want my Organization's vault, with its `default` group and named groups, so that I organise its Secrets and Variables.
16. As a vault's editor, I want to create, rename, archive, unarchive and delete named groups, but never delete, rename or archive `default`, so that there is always one place to put things.
17. As a vault's editor, I want to add a Secret, then only replace, rename, describe or delete it, never see it again, so that a value I saved can't leak through the UI (ADR 0012).
18. As the Owner, I want no way to reveal a Secret, mine included, so that the promise holds for everyone.
19. As a vault's editor, I want to add a Variable that I and everyone who receives it can always read and edit, so that I keep non-sensitive configuration next to my Secrets.
20. As a vault's editor, I want to turn a Variable into a Secret, and to be told I can't turn a Secret into a Variable, so that there is no back door to read a Secret.
21. As a vault's editor, I want to paste a multi-line value (a PEM key, a JSON credential) in a text area, so that I don't have to encode it.
22. As a Member, I want a multi-line Secret masked as `[NAME]` in the history whether the agent prints it whole or only some of its lines, so that a printed key never stays in the Thread.
23. As a Member, I want Variables shown with their value in the history and in the Thread's «Secrets» panel, so that I see the configuration my agent has.
24. As an Admin or a Personal space's User, I want to choose which groups of my Space's vault are the Space's defaults and add or remove groups per Project, so that each Project gets what it needs.
25. As the agent, I want `list_secret_names` to tell Secrets from Variables and give me Variables' values, so that I use `$NAME` for Secrets and read configuration directly.
26. As a Member, when the agent asks for a missing secret, I want to save the answer as a Secret in a group of my Space's vault if I may edit it, so that the next Thread has it.

### Migración

27. As the Owner, I want my Main vault to become the `default` group of my personal vault and my other Vaults to become named groups of it, keeping their allowances, so that my Threads keep the same environment.
28. As an Admin, I want each existing Vault of my Organization to become a named group of my Organization's vault, keeping its Space-default and Project choices, so that nothing changes for my Threads.
29. As the Owner, I want every Secret link and copy turned into an independent Secret with the same value, and a one-time notice listing them, so that nothing stops working and I know what no longer follows the original.
30. As the Owner, I want existing AI accounts to become mine, and existing dedicated machines to become their Organization's, so that ownership matches what exists today.

### Bajas y cambios

31. As the Owner, I want removing a User to delete their personal vault and AI accounts and revoke their gateway keys, so that nothing of theirs stays usable.
32. As the Owner, I want deleting an Organization to delete its vault and AI accounts, so that nothing of it remains.
33. As a User, I want moving a Project to another Space to warn me which groups and AI accounts its Threads lose, so that nothing follows a Project into another Space.

### Clientes

34. As a User on web or desktop, I want my vault, my AI accounts and my machines in Settings, and my Organization's in the same pages when I am its Admin, so that I manage everything in one place.
35. As a User on mobile, I want to see my vault and add or replace Secrets and Variables (multi-line included), see my AI accounts and machines, so that I can check them on the go; signing in to a subscription stays on web or desktop.

## Implementation Decisions

### Dueño

- **Un dueño por recurso:** `{ kind: "user", userId }` o `{ kind: "organization", spaceId }`. Tipo compartido en `packages/contracts` (`ResourceOwner`), usado por Vaults, AI accounts y Environments. El spec de Grants presta recursos con este dueño; el de planes cuenta por él.
- **Dónde se usa (fase 2):** un recurso de un User, en su Personal space; uno de una Organization, en esa Organization, por quien trabaja en ella (misma regla que `thread.create`). Las allowances del Owner que ya existen siguen ampliando sus propios recursos hasta que `../grants/` las convierta en Grants aceptados; nadie más puede crear allowances.
- **Excepción deliberada:** una máquina personal no se presta a nadie: la usa solo su dueño, para sus propios Threads, en cualquiera de sus Spaces (regla actual de `decideEnvironment`, GLOSSARY, ADR 0011). Un Grant de máquina es lo que la abre a otros.
- **Quién gestiona:** el User, lo suyo; los Admins de una Organization, lo de ella (también el Owner, que sigue actuando como Admin en toda Organization hasta `../platform-privacy/`). En el Personal space de otro, el Owner sigue en solo lectura: ve nombres y Variables del vault ajeno, nunca edita.
- **Organization archivada o congelada:** sus recursos no se usan ni se editan (las reglas de `inOrganization` ya lo dan). **User desactivado:** igual; al reactivarlo vuelve todo.

### Environments

- `environment.register` (máquina personal): todo User activo. `environments.registerOwn` sale de `InstallationPermission` (`packages/contracts/src/spaces.ts`), de `UsersDialog.tsx` y de `packages/client-runtime/src/spaces/spaceDirectory.ts`; una migración borra sus filas. El límite de máquinas propias llega con `../plans-and-limits/`.
- `environment.dedicate` pasa de decidirse sobre la Installation a decidirse sobre la Organization de destino: el Owner o un Admin de ella. Aplica en `EnvironmentRegistry.ts` (página «Register this machine», `RegisterEnvironmentSurface.tsx`, `t3 join --dedicated`) y en la instalación por SSH (`environments/sshInstall/`), que también pasa a estar abierta a esos Admins.
- Una máquina dedicada ya modela su Space (`EnvironmentResource.space`); eso pasa a ser su dueño. `decideSpaceBound`: renombrar y quitar, el Owner o un Admin de su Organization (hoy solo el Owner). Cambiar de Space o de modo: hace falta poder en el origen y en el destino, como `decideMove` (un Admin mueve entre Organizations que administra; el dueño de una máquina personal la dedica a una Organization que administra y viceversa).
- Sandboxes y la Hub machine no cambian: son del Hub.
- Una máquina dedicada cuya Organization se borra sigue como hoy: la ve y la quita el Owner, nada corre en ella.

### AI accounts

- Migración: `ai_accounts` gana `owner_kind` y `owner_id`. Las que existen pasan al Owner. El índice único de nombre (`ai_accounts_name_idx`) pasa a ser por dueño. La prioridad pasa a ser por dueño (`priority` se compara solo entre cuentas del mismo dueño; las del Owner conservan su orden).
- **AccessPolicy:** `aiAccount.manage` se decide sobre una `AiAccountResource` con su dueño (crear se decide sobre el dueño de destino): el User, lo suyo; Admins y Owner, lo de una Organization. `aiAccount.allow` (allowances heredadas): solo el Owner y solo sobre cuentas suyas. El Owner ve nombre, proveedor, dueño y estado de todas; no edita las de un Personal space ajeno.
- **Scopes:** `aiAccounts.create|update|delete|reorder|login.*|import*` piden hoy `settings:write` (`packages/contracts/src/clientRpcPermissions.ts`), que no está en `AuthStandardClientScopes`. Pasan a `access:write`, como los Vaults; la decisión de quién la toma `AccessPolicy`.
- **Una regla (`AllowedAiAccounts.for(userId, spaceId)`):** cuentas habilitadas del dueño del Space (Personal space → su User; Organization → ella), seguidas de las del Owner con allowance al Space o al User; siempre que el User trabaje en ese Space. Orden: las del dueño del Space por su prioridad, luego las permitidas por la prioridad del Owner. El defecto de un Thread nuevo, el selector y el failover de la gateway (mismo proveedor, mismo modelo) siguen ese orden. Nada más cambia en `AiGatewayRoute.ts`: el prefijo `acct-<id>` ya es por cuenta.
- **Suscripciones de cualquier User:** el mismo inicio de sesión por la Management API de CLIProxyAPI (`subscriptionLogin.ts`). El aviso de ToS se mantiene (IP de datacenter del Hub), sin el texto de «compartir» cuando el dueño es un User y la cuenta solo se usa en su Personal space.
- **Credenciales directas** (`direct`): mismas reglas del spec `../ai-accounts-and-gateway/`; solo llegan a Threads del Space donde la cuenta es usable.
- **Claves de CLI local** (`AiGatewayKeys.ts`): sin cambios; ya se atan a un Space y usan `AllowedAiAccounts`.
- **Uso:** sin cambios en el registro. Ver uso por dueño de cuenta y su atribución es del spec de Grants (ticket 16 de `../ai-accounts-and-gateway/`).

### Vaults: un Vault por dueño, grupos como filas

- **Modelo:** la fila de `vaults` (migración 111) pasa a ser un **grupo**. Migración: tabla renombrada a `vault_groups` (`group_id`), con `owner_kind`, `owner_id`, `is_default`; se quitan `space_id` e `is_main`. «El Vault» de un dueño es el conjunto de sus grupos; no tiene fila propia. `vault_entries`, `vault_allowances`, `space_default_vaults` y `project_vault_choices` pasan a referirse a grupos (`group_id`). Así el grupo es la unidad que el spec de Grants presta, sin otra migración.
- **`default`:** un grupo por dueño (`UNIQUE (owner_kind, owner_id) WHERE is_default = 1`), creado con el User o la Organization (y por la migración para los que ya existen). No se borra, no se renombra, no se archiva. Nombres de grupo únicos por dueño (`COLLATE NOCASE`); `default` reservado.
- **Migración de lo que hay:**
  - El Main vault (`vault-main`) pasa a ser el grupo `default` del Owner. Desaparecen `MAIN_VAULT_ID` y `VaultReach.fixedDefaults` se reescribe sobre `is_default`.
  - Cada otro Vault del Owner pasa a ser un grupo con nombre del Owner, con sus allowances, defaults y choices.
  - Cada Vault de una Organization pasa a ser un grupo con nombre de esa Organization (con sus defaults y choices); su `default` se crea vacío.
  - Un Vault existente llamado `default` se renombra `default (old)`.
  - Archivados siguen archivados.
- **Secret links y copias desaparecen.** La migración copia el valor actual del original en un `value_id` nuevo de la entrada (un link roto se borra), queda `kind` = `own` para todas y se quitan `kind` y `linked_entry_id`. Auditoría `secret.edit` con `op: "unlinked"` por entrada. Settings muestra una vez al Owner la lista de entradas que eran links («now independent: rotating the original no longer changes it»). Compartir un grupo entre Spaces es un Grant (`../grants/`). Los RPCs `vaults.entries.link` y `vaults.entries.copy` se borran.
- **Alcance (`VaultReach.ts`, una regla):** un grupo llega al Space de su dueño (Personal space o la Organization); los grupos del Owner, además, a los Spaces y Users de sus allowances heredadas. `default` es defecto fijo de su Space; los demás grupos del dueño, defectos si se eligen. Las filas de allowance sobre grupos que no son del Owner se ignoran al leer, como hoy.
- **Conjunto efectivo (`EffectiveVaults.ts`):** misma regla y precedencia que hoy (grupos permitidos al User, adds del Project, defectos del Space; `default` primero entre los defectos), sobre grupos. Cada variable lleva grupo, dueño y tipo (`secret` | `variable`).
- **Elegir defectos y choices** (`vault.choose`): en una Organization, sus Admins y el Owner; en un Personal space, su User (hoy lo hace el Owner; pasa a solo lectura ahí).

### Secrets y Variables

- `vault_entries` gana `type` (`secret` | `variable`); las existentes son `secret`. Nombres únicos por grupo entre los dos tipos; mismas reglas de nombre (`secretNameRisk`) para los dos.
- **Secret:** valor en `VaultValueStore` como hoy. Ninguna puerta lo devuelve. Se sustituye, renombra, describe o borra.
- **Variable:** valor en columna `value_text` de `vault_entries`, en claro (no es sensible; la UI lo dice al crearla). Lo ven quienes ven el grupo (`vault.view`); lo editan quienes editan el grupo. No se enmascara ni se recuerda en `thread_secret_values`. Se entrega por `secretEnv` igual que un Secret (sin cambio de contrato del ejecutor: es una lista de nombre y valor).
- **Variable → Secret:** permitido; el valor pasa al almacén cifrado y la columna se vacía en la misma transacción; la UI avisa que lo ya impreso en el historial sigue visible. **Secret → Variable:** rechazado (`secret-is-write-only`): borrar y crear de nuevo.
- **Sin «Reveal»:** se borran `vaults.reveal` (HttpApi en `vaults/http.ts`), `Vaults.authorizeReveal`/`reveal`, la acción `vault.reveal` de `AccessPolicy`, `VAULT_REVEAL` de `DoorRules.ts`, la auditoría `secret.reveal` deja de emitirse (las filas viejas se quedan) y los botones «Reveal» de `VaultsSettings.tsx`. La copia de la clave maestra (`masterKey.backup`) se queda: es del operador y ADR 0008 dice que la garantía es de la aplicación.
- **Nombres peligrosos** (`vault.dangerousName`): en el vault personal, su User confirmando; en el de una Organization, solo el Owner, como hoy.

### Valores multilínea y enmascarado parcial

- Valores: siguen UTF-8 sin NUL, hasta 64 KiB; se aceptan `\n` y `\r\n` y se guardan tal cual. El campo de valor es un área de texto en web y desktop (`SecretInput.tsx` o un componente hermano) y `TextInput multiline` en móvil.
- `secretForms` (`packages/shared/src/secretMasking.ts`) ya cubre el valor entero con LF y con CRLF. Se añade: para un Secret con más de una línea, **cada línea** de al menos 16 caracteres tras quitar espacios de los extremos es también una forma, salvo las líneas de armadura PEM (`-----BEGIN …-----`, `-----END …-----`). Se sustituye por `[NAME]` donde aparezca, también con sangría o en otro orden. Las líneas cortas (la última de un bloque base64) no se tapan solas: se documenta.
- Mismo camino para todo lo que ya enmascara (`maskEvents.ts`, `maskTerminal.ts`, diffs, traspasos, logs): solo cambian las formas. `pendingSuffix` cubre la línea cortada entre trozos de un stream.

### Herramientas del agente

- `list_secret_names` mantiene el nombre (agentes y evals lo conocen) y su regla `OWN_THREAD`. Cada elemento lleva `type` y, solo para Variables, `value`. La descripción cambia: hay que correr el eval `evals/mcp-tool-use` antes y después (evals/README.md) y añadir un caso: el agente usa `$NAME` para un Secret y lee la Variable de la respuesta.
- `request_secret`: «Also save to Vault» ofrece los grupos que quien responde puede editar entre los que llegan al Space del Thread; guarda siempre como Secret. Quién: el User en su Personal space; Admins y Owner en una Organization.
- Sin herramientas MCP nuevas: registrar máquinas y AI accounts lleva credenciales que no deben pasar por un agente; crear grupos no lo pide nadie.

### Bajas y cambio de Space

- **Quitar un User:** se borran sus AI accounts (sale la credencial de CLIProxyAPI por `AiAccountChanges.ts`), sus gateway keys se revocan (ya ocurre) y se borra su vault personal (grupos, entradas, valores). Su Personal space sigue congelado para el Owner. Auditoría con vía `user.remove`.
- **Borrar una Organization:** como hoy con sus Vaults (`OrganizationLifecycle.ts`, `VaultReachLoss.ts`), ahora con grupos, y además sus AI accounts.
- **Mover un Project** (`move-plan`): `vaultsLost` pasa a nombrar grupos; `aiAccountsLost` usa la nueva regla. Las choices de grupos que no llegan al destino se borran (`dropChoicesNotReaching`).
- La pérdida de alcance (`VaultReachLoss.ts`, `AiAccountReachLoss.ts`) se aplica igual al quitar a alguien de una Organization: deja de recibir los grupos y cuentas de ella en el siguiente turno.

### Puertas

| Puerta | Cambio |
| --- | --- |
| WS (`RPC_SPACE_ACCESS`) | `vaults.groups.list/create/update/delete` (sustituyen `vaults.list/create/update/delete`), `vaults.entries.list` (Variables con `value`, Secrets sin), `vaults.entries.put` (con `type`), `vaults.entries.delete`; fuera `vaults.entries.link/copy`. `aiAccounts.*` con dueño. Registro y dedicación de Environments con la nueva regla. |
| HttpApi (`HTTP_ENDPOINT_RULES`) | fuera `vaults.reveal`; la copia de la clave maestra sin cambio |
| MCP (`MCP_TOOL_RULES`) | `list_secret_names` devuelve `value` solo de Variables; `request_secret` guarda en grupos que el que responde edita |
| Executor wire | `secretEnv` incluye Variables; sin cambio de contrato |
| Logs, OTLP | ningún valor de Secret; las Variables pueden aparecer (no son secretas) pero los logs no las añaden a propósito |

### Clientes

- **Web y desktop:** las páginas actuales — Settings → Vaults (`VaultsSettings.tsx`, `VaultChoices.tsx`), AI accounts (`AiAccountsSettings.tsx`), Environments (`HubEnvironmentsSettings.tsx`, `AddEnvironmentDialog.tsx`) — muestran secciones por dueño: «Mine» y una por cada Organization que el User administra (el Owner además ve las demás, con las reglas de arriba). Cada sección es un componente que recibe el dueño, para que `../settings-modals/` lo mueva a los modales de Usuario y de Space sin reescribirlo. La paleta de comandos ya lleva a esas páginas; no hay atajos nuevos.
- **Móvil:** `apps/mobile/src/features/vaults/` (grupos, Secrets y Variables, añadir y sustituir con texto multilínea; Variables visibles), `features/ai-accounts/` (las propias y de sus Organizations, solo lectura como hoy), `features/environments/` (máquinas propias y dedicadas). Iniciar sesión en una suscripción, solo web y desktop.
- Lógica compartida en `packages/client-runtime` (`vaults.ts`, `aiAccountsView.ts`, `hubEnvironments.ts`).

### Auditoría

- Nuevas: `vault_group.create|update|delete` (sustituyen `vault.*` para nuevas filas), `secret.edit` con `type` y `op` (`add`, `replace`, `rename`, `describe`, `delete`, `to-secret`, `unlinked`). Nunca valores, tampoco de Variables.
- `ai_account.create` y `environment.register` llevan el dueño.

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User, un Admin, el Owner, un agente o una máquina por interfaces públicas: RPC WS, HttpApi, herramientas MCP, la gateway `/api/ai/*` y el entorno real del proceso del provider. Red-first en toda regla de permiso.
- **Reparto:** Owner, Ana (User sin Organizations), Admin, Member y Guest de Acme y de Globex. Cada regla se prueba con quien la pasa y quien no.
- **Seams:** `AccessPolicy.test.ts` (filas de la tabla), `Vaults.test.ts`, `EffectiveVaults.test.ts`, `SecretMasker.test.ts` y `packages/shared/src/secretMasking.test.ts` (formas multilínea y PEM a medias), `AiAccounts.test.ts`, `AiGatewayRoute.test.ts` (cuentas usables y orden), `EnvironmentJoin.test.ts`, `HubWithEnvironments.dedicated.test.ts`, `HubWithEnvironments.secretEnv.test.ts`, `VaultDoors.test.ts`, `DoorRules.test.ts`, `RpcAuthorization.test.ts`.
- **Migraciones:** test de migración con una base que tiene Main vault, otro Vault del Owner con allowances, dos Vaults de Acme con defaults y choices, un link vivo, un link roto, una copia y un Vault llamado `default`; y AI accounts con allowances y una máquina dedicada. Comprueba filas y que el conjunto efectivo de cada Thread de prueba no cambia (salvo los links rotos, que ya no se entregaban).
- **Prior art:** `115_VaultReachLoss.test.ts`, `118_AiAccountReachLoss.test.ts`, `ProviderKeyMigration.test.ts`.
- **Prueba real por ticket de interfaz:** Hub dev con datos sembrados (`vp run dev`), provider `Replay (dev)` para turnos, salvo AI accounts, que usan una API key `openai-compatible` contra un servidor falso.

## Out of Scope

- **Grants** (prestar máquinas, AI accounts y grupos a otros Spaces o planes; convertir las allowances del Owner): `../grants/`.
- **Topes y atribución del uso de IA**, ticket 16 de `../ai-accounts-and-gateway/`: `../grants/`.
- **Límites** (máquinas propias, AI accounts, disco): `../plans-and-limits/`.
- **El Owner deja de ver lo ajeno** (nombres y Variables de vaults personales, cuentas y máquinas de otros): `../platform-privacy/`.
- **Modales de Usuario, Space y Proyecto:** `../settings-modals/`.
- **Secrets que solo usa un proceso** (proxy de credenciales): mejora futura.
- **Más de un Vault por dueño.**

## Further Notes

- **Tickets de esta fase escritos en otro sitio**, que no se repiten aquí: `../identity-and-access/issues/17-personal-space-siempre-disponible.md` (bloquea 04 y 08), `18-cualquier-user-crea-organizations.md` (da Organizations con Admins que no son el Owner; sin él, los tickets 02, 03 y 09 solo los ejerce el Owner) y `19-todo-en-el-space-actual.md` (independiente).
- **Riesgo aceptado (ADR 0004):** dentro de un Space no hay aislamiento; un Secret de la Organization lo puede leer el agente de cualquier Member. Las Variables, además, se ven en el historial.
- **Variables en claro en la base:** es lo que las distingue; la UI lo dice al crear una.
- **Docs que cambian:** `docs/internals/secrets.md` («Vaults», «Allowing Vaults», «The effective set», «Masking»: se reescriben, no se añade historia), `docs/internals/ai-gateway.md` («AI accounts», «The AI account of a Thread»), `docs/internals/environment-auth.md` (registro), `docs/user/install.md` («Personal spaces and Installation permissions», «Join a machine to your Hub», «Dedicate a machine to an organization», «The AI gateway», mención a vaults al quitar personas y borrar organizations) y GLOSSARY (quitar «Secret link»; «Main vault» ya está).
- **Orden de tickets:**
  1. Los Secrets dejan de revelarse.
  2. Valores multilínea y enmascarado por líneas.
  3. Vaults con grupos (modelo y migración).
  4. Vault personal de cada User.
  5. Variables.
  6. Cualquier User une sus máquinas.
  7. Los Admins dedican máquinas a su Organization.
  8. AI accounts propias de un User.
  9. AI accounts de una Organization.
  10. Bajas y cambio de Space con recursos con dueño.
  11. Inventario de puertas y pase completo.

## Preguntas abiertas

Decididas con recomendación; el Owner puede reabrirlas.

1. **¿Una máquina personal sigue usable en las Organizations de su dueño?** El mapa dice «un recurso de un User solo se usa en su Personal space», pero GLOSSARY y ADR 0011 conservan la máquina personal para todos los Spaces de su dueño, y quitarlo dejaría Threads de Organizations sin máquina. Recomendación: sí, solo para los Threads propios de su dueño (nadie más la usa); el spec de Grants decide si una Organization puede prohibirlo.
2. **¿Un Vault o varios por dueño?** Recomendación: uno, con grupos; los grupos hacen lo que hacían varios Vaults y son la unidad de Grant. Más Vaults no añade nada que un grupo no dé.
3. **Secret links y copias.** Recomendación: convertirlos en Secrets independientes al migrar, con aviso. Alternativa: mantener los links vivos hasta los Grants de grupos; descartada porque obliga a conservar `kind` y la regla de links solo para la transición.
4. **Umbral de línea para el enmascarado parcial.** Recomendación: 16 caracteres sin espacios de los extremos y sin las líneas de armadura PEM. Más bajo tapa texto normal (líneas cortas de JSON); más alto deja pasar líneas cortas de claves.
5. **Variables en claro en la base.** Recomendación: sí. Alternativa: sellarlas como los Secrets; no protege nada, porque cualquiera que ve el grupo las lee y se imprimen sin enmascarar.
6. **Orden de AI accounts en un Space.** Recomendación: las del dueño del Space primero, luego las permitidas por el Owner. Alternativa: una prioridad global; descartada porque mezcla el orden de dueños distintos.
7. **Quitar un User borra sus recursos.** Recomendación: sí, AI accounts y vault personal se borran al quitarlo (no al desactivarlo). El borrado de cuenta propio de `../platform-privacy/` reutiliza el mismo camino.
8. **Admins e instalación por SSH.** Recomendación: abrirla también a los Admins para su Organization (es la misma puerta que `t3 join --dedicated`); la clave SSH «keep for updates» sigue cifrada en el Hub.
