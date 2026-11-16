# Spec: Planes y límites

Status: needs-triage
Map: ../public-hub/map.md (spec 4 de 6, fase 4)
Decisiones de origen: «Planes y límites», «Owner como operador», «Privacidad» y, en «Decisiones transversales», «Cuotas del Hub», «Responsable (Steward) de una Organization» y «Grants»
ADRs: 0008 (plataforma abierta con un Owner operador que gobierna registro, planes y límites y no lee lo ajeno), 0010 (Grants), 0011 (las máquinas prestadas ejecutan Sandboxes), 0004 (un Sandbox por Space), 0006 (el Hub guarda los Threads)
Vocabulario: `GLOSSARY.md`: Plan, Steward, Grant, Installation permission (desaparece con este spec)
Depende de: `../keycloak-sign-in/` (alta de Users), `../owned-resources/` (máquinas de Users y de Organizations; tickets `../identity-and-access/issues/17` y `18`), `../grants/` (Grants con destino), `../settings-modals/` (modales Usuario, Space y Plataforma)

## Problem Statement

Hoy el Owner reparte lo que puede hacer cada User con dos interruptores por persona, los Installation permissions (`personalSpace.create` y `environments.registerOwn`, tabla `installation_permissions` de la migración 090, diálogo **Users** en `apps/web/src/components/sidebar/UsersDialog.tsx`). El ticket 17 de identity-and-access quita el primero; el 18 deja que cualquiera cree Organizations, sin tope. Nada limita lo que un User gasta en el Hub: cuántas Organizations crea, cuánta gente mete en ellas, cuántas máquinas une, cuánto disco ocupan sus Threads y checkpoints en el Hub, cuánto tráfico pasa por la AI gateway y los previews, ni si su trabajo corre en un Sandbox en la máquina del Hub.

En una plataforma abierta (ADR 0008) eso no escala: el Owner necesita decir «a quien se registra le doy esto» y «a esta persona le doy más», sin abrir lo que cada uno tiene. Y cada User necesita ver cuánto le queda antes de chocar con un límite.

## Solution

Un **Plan** es un conjunto con nombre de límites. Todo User tiene uno; el Owner no tiene ninguno y no tiene límites.

- El Owner crea, edita y borra Plans y elige el **plan por defecto**, que recibe cada User nuevo. Asigna a cada User su Plan en el modal Plataforma.
- Límites de un Plan: Organizations que el User puede tener como Steward, Members por Organization, máquinas propias, disco del Hub, tráfico del Hub por mes y si puede usar un Sandbox en la máquina del Hub. Además, el Owner puede dar Grants a un Plan (por ejemplo, una AI account suya con un tope de tokens), que llegan a todos los Users de ese Plan.
- Los Installation permissions desaparecen: `environments.registerOwn` pasa a ser el límite «máquinas propias». No quedan dos sistemas.
- Cada Organization tiene un **Steward**: quien la creó, transferible a otro Admin que acepta. Los límites de la Organization salen del Plan de su Steward. Las Organizations que ya existen pasan a tener al Owner como Steward.
- Los límites de cantidad se cuentan por **titular**: el Personal space de un User con su Plan, cada Organization con el Plan de su Steward.
- Bajar de Plan o bajar un límite nunca borra nada. Solo impide crear más o empezar turnos nuevos mientras se está por encima, y la UI dice qué límite se alcanzó, cuánto se usa y quién puede cambiarlo.
- El Hub mide el disco y el tráfico de cada Space y los hace cumplir.
- Cada User ve su consumo frente a sus límites; los Admins, el de su Organization; el Owner, el de cada User, solo en números, sin contenido.

## User Stories

### Plans

1. As the Owner, I want to create a Plan with a name, a short description and a value for each limit, so that I can offer different levels of access.
2. As the Owner, I want to leave any limit empty to mean «no limit» and set 0 to mean «none», so that one form covers every case.
3. As the Owner, I want to edit a Plan's limits and have them apply at once to every User on it, so that I change a level in one place.
4. As the Owner, I want to choose which Plan new Users get, so that open registration has a safe default.
5. As the Owner, I want to delete a Plan only after choosing the Plan its Users move to, so that nobody is left without one.
6. As the Owner, I want to be unable to delete the default Plan, so that sign-up always has a Plan to give.
7. As the Owner, I want to assign a User a different Plan from the Platform modal, so that I can give someone more or less.
8. As the Owner, I want to have no Plan and no limits myself, so that I can never lock myself out of my own platform.
9. As the Owner, I want every Plan created, edited, deleted or assigned recorded in the audit log, so that I can trace who changed what.

### Lo que sustituye a los Installation permissions

10. As the Owner, I want «Register their own Environments» to become the Plan limit «own machines», so that there is one place where I decide what a User gets.
11. As the Owner, I want Users who had that permission to keep being able to register machines after the upgrade, so that nothing changes for them on the day it ships.

### Steward

12. As a User who creates an Organization, I want to be its Steward, so that its limits come from my Plan.
13. As a Steward, I want to offer the role to another Admin of the Organization and have it move only when they accept, so that nobody takes on limits or costs without agreeing.
14. As an Admin, I want to accept or decline a Steward offer, so that I decide whether my Plan carries this Organization.
15. As a Steward, I want to be told I must transfer the role before I leave the Organization or stop being Admin, so that the Organization never ends up without a Steward.
16. As the Owner, I want existing Organizations to have me as Steward after the upgrade, so that their limits do not change.
17. As the Owner, I want the Organizations of a User I remove to pass to me as Steward, so that they keep working.
18. As a Member, I want to see who the Steward of my Organization is, so that I know whom to ask when a limit is hit.

### Límites

19. As a User, I want creating an Organization to be refused when I already steward as many as my Plan allows, with the limit named, so that I know why.
20. As an Admin, I want inviting someone to be refused when the Organization has as many Members (plus pending Invitations) as its Steward's Plan allows, so that the limit is clear before anyone accepts.
21. As a User, I want registering a new machine to be refused when I have as many own machines as my Plan allows, so that the limit is clear on the approval screen.
22. As a User whose Plan does not include a Sandbox on the Hub's machine, I want my Threads to be offered only my own or lent machines, with the reason when none exists, so that I know where my work can run.
23. As a Member, I want starting a turn, creating a Thread or a Project to be refused when the Space is over its Hub disk, with how much it uses and its limit, so that I know what to free.
24. As a Member, I want starting a turn or opening a preview to be refused when the Space is over its Hub traffic for the month, with the date it resets, so that I know when it comes back.
25. As a User, I want a running turn never to be cut by a quota, so that I never lose work in the middle.
26. As a User, I want deleting Threads or Projects to lower my Hub disk soon after, so that I can get back under the limit by myself.
27. As a User moved to a smaller Plan, I want everything I have to stay, so that a downgrade never loses work.
28. As an agent acting for a User (MCP, scheduled tasks), I want the same refusal with the same message, so that I can tell the User what happened.

### Grants a un Plan

29. As the Owner, I want to give a Grant (an AI account with a token cap, a machine, a Vault group) to a Plan, so that every User on it gets it without a Grant per person.
30. As a User, I want what my Plan gives me to appear in my Personal space and in the Organizations I steward, so that I can use it without accepting anything.
31. As a User who changes Plan, I want the old Plan's Grants to stop and the new ones to start from my next turn, so that a Plan change is immediate.

### Consumo visible

32. As a User, I want the User modal to show my Plan, each limit and my current use (also for each Organization I steward), so that I see a limit coming.
33. As an Admin, I want the Space modal of my Organization to show its use against its Steward's Plan, so that I can manage it.
34. As a Member of a Space over a quota, I want a notice in the Space that says which quota is full and who can change it, so that I am not surprised when sending a message.
35. As the Owner, I want the Platform modal to list each User with their Plan and their use in numbers (Organizations, Members, machines, disk, traffic per Space), never names of Threads, Projects or files, so that I govern without reading content.

## Implementation Decisions

### Modelo

- **Migraciones nuevas** (las siguientes libres; hoy la última es la 118 y las fases 2 y 3 añadirán más):
  - `plans`: `plan_id`, `name` (único), `description`, `max_organizations`, `max_members_per_organization`, `max_own_machines`, `hub_disk_bytes`, `hub_traffic_bytes_per_month` (enteros; NULL = sin límite, 0 = ninguno), `hub_sandbox` (0/1), `is_default` (índice único parcial: exactamente uno), fechas.
  - `users.plan_id`: NULL solo para el Owner. Se rellena al crear el User en `apps/server/src/persistence/Users.ts` (la inserción de no-Owners), sea por Invitation, Keycloak o Invitation de plataforma: una sola puerta de alta, un solo sitio que pone el plan por defecto.
  - `spaces.steward_user_id` y `spaces.steward_offer_user_id` (solo Organizations; ticket 02).
  - `space_storage_usage` (disco medido por Space; ticket 06) y `hub_traffic_monthly` (tráfico por mes, Space y tipo; ticket 08).
- **Migración de los Installation permissions** (ticket 01):
  - Crea el Plan «Default» (`is_default`): Organizations y Members sin límite (lo que deja el ticket 18), `max_own_machines = 0`, disco y tráfico sin límite, `hub_sandbox = 1` (hoy todo Space tiene Sandbox). Nada cambia para nadie el día que se instala.
  - Si algún User tiene `environments.registerOwn`, crea «Default + own machines» (igual, con máquinas sin límite) y se lo asigna.
  - Asigna «Default» al resto de Users no-Owner y borra la tabla `installation_permissions`. Las filas de `personalSpace.create` que quedaran (ticket 17) se ignoran.
  - En código desaparecen `InstallationPermission` y `SetInstallationPermissionRequest` de `packages/contracts/src/spaces.ts`, `installationPermissions` de `InstallationUser` y de `Principal` (`apps/server/src/auth/AccessPolicy.ts`), el endpoint `installationUsers.setPermission` (`packages/contracts/src/environmentHttp.ts`, `apps/server/src/spaces/installationUsersHttp.ts`), `SpaceDirectory.setInstallationPermission` y `INSTALLATION_PERMISSION_LABELS` de `packages/client-runtime/src/spaces/spaceDirectory.ts`.

### Límites

| Límite | Titular | Qué cuenta | Al alcanzarlo se rechaza |
| --- | --- | --- | --- |
| Organizations | el User | Organizations no archivadas de las que es Steward | crear una Organization, restaurar una archivada, aceptar ser Steward |
| Members por Organization | cada Organization (Plan del Steward) | memberships (Admin, Member, Guest) más Invitations pendientes | crear una Invitation, aceptar una Invitation |
| Máquinas propias | el User; cada Organization (Plan del Steward) | External environments cuyo dueño es ese User o esa Organization; las prestadas cuentan para su dueño, no para quien las recibe | aprobar el join de una máquina nueva |
| Disco del Hub | cada Space | historial de sus Threads, adjuntos y repositorios git del Hub de sus Projects y Threads sin Project | crear un Project o un Thread, empezar un turno, mover un Project o un Thread hacia ese Space |
| Tráfico del Hub por mes | cada Space | bytes de la AI gateway y de los previews atribuidos al Space, en el mes natural UTC | empezar un turno, abrir un preview, una petición de gateway con una clave de CLI local |
| Sandbox en la máquina del Hub | cada Space | sí o no | colocar o arrancar trabajo en el Sandbox de ese Space en la máquina del Hub |

- **Titular de un Space** (una regla, un sitio): el Personal space lo sostiene su User; una Organization, su Steward. Si el titular es el Owner, no hay límites. Servicio nuevo `Plans` (`apps/server/src/plans/Plans.ts`) con `limitsForUser(userId)` y `limitsForSpace(spaceId)`; nada más calcula esto.
- **Comprobar no es autorizar.** `AccessPolicy` sigue diciendo quién puede hacer qué; `PlanLimits.check(limit, subject)` dice si cabe uno más. Las dos se llaman desde el mismo método de servicio. `environment.register` deja de mirar un permiso (`AccessPolicy.ts`, hoy `installationPermissions.has("environments.registerOwn")`) y pasa a «cualquier User activo», con el tope de máquinas en `EnvironmentRegistry.authorizeRegister`.
- **Los turnos.** La comprobación de disco y tráfico va en la entrada única de comandos de cliente (`apps/server/src/orchestration-v2/ThreadMessageIntake.ts`, `dispatchCommand`) para `thread.create` y `message.dispatch`, antes de `commitCommand`: el orquestador sigue puro. Las herramientas MCP, las tareas programadas y sus webhooks tienen que llegar por ahí; el ticket 07 lo comprueba por entrada.
- **Nunca se borra ni se corta.** Lo que ya existe sigue: Organizations, Members, máquinas, Threads, checkpoints. Un turno en marcha termina y sube su checkpoint aunque se pase. Un mensaje ya encolado antes de llenarse la cuota se ejecuta. Las peticiones de gateway de un turno en marcha siguen. Se acepta el exceso que eso produce.
- **Error único:** `PlanLimitReachedError` en `packages/contracts` con `limit`, `used`, `allowed`, `spaceId` (si aplica), `holder` (id y nombre del titular), `planName` y, para el tráfico, `resetsAt`. Cliente, MCP y tareas muestran el mismo mensaje, p. ej. «This Organization has used its Hub disk (5.2 GB of 5 GB). Its Steward, Ada, can free space or change plan.».

### Steward

- Al crear una Organization (ticket 18 de identity-and-access), el creador queda como Steward en la misma operación del servicio.
- La migración pone al Owner como Steward de todas las Organizations existentes, sea o no Member de ellas.
- **Transferir:** el Steward (o el Owner) ofrece el rol a otro Admin de la Organization; queda en `steward_offer_user_id` hasta que ese Admin acepta o rechaza, o quien ofreció lo cancela. Aceptar comprueba el límite de Organizations del que acepta. Una oferta por Organization a la vez.
- **Invariantes:** el Steward es Admin de la Organization (o el Owner). Mientras lo sea, no puede salir de ella, ni quitarle el rol de Admin otro, ni quitarlo: el error dice «Transfer the Steward role first». Quitar a un User de la plataforma pasa sus Organizations al Owner como Steward.
- El Steward no gana permisos sobre los de Admin salvo transferir el rol. Archivar y borrar siguen como los deje `../identity-and-access/` (hoy solo el Owner).

### Disco del Hub

- Lo mide un fiber del Hub cada hora y, con un retraso corto, tras borrar Threads o Projects en un Space. Escribe `space_storage_usage` (`events_bytes`, `attachments_bytes`, `repository_bytes`, `measured_at`).
  - **Historial:** suma de `length(payload_json)` de `orchestration_v2_events` por Thread no borrado, agrupada por el Space del Thread. Borrar un Thread es un evento más (`apps/server/src/orchestration-v2/ThreadDeletion.ts`) y sus eventos se quedan en el log; la cuota deja de contarlos aunque el disco real del Hub no baje (Pregunta abierta 9).
  - **Adjuntos:** tamaño de los archivos de cada Thread en el almacén de adjuntos (`apps/server/src/attachmentStore.ts`).
  - **Checkpoints:** `git count-objects -v` de cada repositorio de `<stateDir>/hub-repositories` (`apps/server/src/checkpointing/HubRepository.ts`), por Project o por Thread sin Project.
- **Borrar libera.** Si no, un Space lleno no tiene salida. Borrar un Thread quita sus refs del repositorio del Hub (`refs/t3/threads/<id>/`, `refs/t3/recovered/<id>/` y los de checkpoint de sus scopes) y sus adjuntos; borrar un Project borra su repositorio. Un `git gc --prune` periódico (los repos usan hoy `gc.auto=0`) recoge lo suelto. Archivar no libera; la UI lo dice.
- El disco de un Sandbox (su checkout y su home) no cuenta aquí: ya tiene su propio tope (`sandbox_limit_defaults`, `space_sandbox_limits`; ver `docs/internals/sandboxes.md`, «Limits»).
- La cuota usa la última medición. Entre mediciones se puede pasar algo; se acepta.

### Tráfico del Hub

- Se cuentan los bytes de petición y respuesta que pasan por la AI gateway (`apps/server/src/ai/AiGatewayProxy.ts`, junto al tap que ya alimenta `AiUsage`) y por los previews servidos por el Hub (`apps/server/src/preview/hubPreviewRoute.ts` y el origen propio de previews), incluidos los frames de WebSocket.
- Atribución: la gateway ya conoce User y Space de cada petición (`ai_usage`); un preview, por su Thread.
- Se acumula en memoria y se escribe en lotes (como el writer de `AiUsage`), nunca una escritura por petición. Un reinicio brusco pierde como mucho el último lote; se acepta.
- `hub_traffic_monthly(month, space_id, kind, bytes)`, `kind` = `gateway` | `preview`. El mes es natural, en UTC.
- Los topes de tokens de una AI account son de los Grants (`../grants/`), no de este límite.

### Sandbox en la máquina del Hub

- Con `hub_sandbox = 0`, el Hub no coloca ni arranca trabajo de ese Space en el Sandbox de su propia máquina (`apps/server/src/sandboxes/Sandboxes.ts`). El Space puede usar máquinas propias o prestadas, también con Sandbox en ellas (ADR 0011).
- El Sandbox que ya existía conserva sus archivos; sus Threads se pueden mover a otra máquina. El Owner lo gestiona como hoy.
- Los topes de CPU, memoria y disco del Sandbox siguen siendo los de hoy (por defecto de la plataforma y por Space), no del Plan (Pregunta abierta 4).

### Grants a un Plan

- `../grants/` define los Grants y sus destinos; este spec añade el destino `plan`. Solo el Owner lo da y no se acepta.
- Un Grant al Plan P llega a todo Space cuyo titular está en P: su Personal space y las Organizations de las que es Steward.
- El tope de un Grant a un Plan se cuenta por Space receptor (cada uno tiene el suyo), no compartido entre todos los Users del Plan.
- Cambiar el Plan de un User, o el Steward de una Organization, es para esos Spaces lo mismo que retirar los Grants del Plan viejo y dar los del nuevo: mismo camino que la retirada de `../grants/`, con efecto en el siguiente turno.

### Consumo visible

- `PlanUsage.forHolder(userId)`: Plan, límites y uso del User (Organizations como Steward, máquinas propias) y de cada Space que sostiene (Members, máquinas, disco por componente con su fecha de medición, tráfico del mes, Sandbox). Solo números y nombres de Spaces.
- **User:** su propio uso, en el modal Usuario, sección «Plan».
- **Admin:** el uso de su Organization, en el modal Space, sin los datos del Steward fuera de esa Organization.
- **Owner:** cualquier User, en el modal Plataforma (lista de Users con Plan y resumen; detalle por User). Nunca títulos de Threads, nombres de Projects ni rutas.
- **Aviso en el Space:** cuando un Space está por encima de disco o tráfico, todos sus Members ven un aviso junto al composer con el límite, el uso, quién es el titular y, para el tráfico, cuándo se reinicia.

### Puertas

Cada puerta nueva declara su regla y los tests de inventario (`apps/server/src/auth/DoorRules.ts`, `DoorRules.test.ts`, `RpcAuthorization.test.ts`) fallan si falta:

- **HttpApi** (`HTTP_ENDPOINT_RULES`), en `packages/contracts/src/environmentHttp.ts`:
  - grupo `plans`: `list`, `create`, `update`, `delete` (solo Owner);
  - `installationUsers.setPlan` (solo Owner), sustituye a `setPermission`;
  - `plans.usage` (el propio User; con `userId`, solo Owner);
  - `spaces.usage` (Admins de la Organization, su Steward y el Owner);
  - `spaces.stewardOffer`, `spaces.stewardOfferAccept`, `spaces.stewardOfferDecline`, `spaces.stewardOfferCancel`.
- **WS, raw routes, MCP:** ninguna puerta nueva. Las herramientas MCP existentes que crean (`t3_project_create`, `t3_thread_launch`, `t3_thread_send`…) devuelven `PlanLimitReachedError`. Gestionar Plans no se ofrece a los agentes: es administración del Owner, como los Users.
- **Gateway:** una clave de CLI local de un Space por encima del tráfico recibe 429 con el límite en el cuerpo.

### Clientes

- **Web y desktop:** modal Plataforma → «Plans» (lista, crear, editar, borrar con Plan de destino, marcar por defecto) y «Users» (Plan de cada uno, cambiarlo, uso). Modal Usuario → «Plan». Modal Space → «Usage» y «Steward» (oferta, aceptar, rechazar, cancelar). Aviso de cuota junto al composer. Errores de límite en cada entrada que crea (sidebar, paleta de comandos, atajos, diálogo de Invitations, aprobación de máquina).
- **Móvil:** pantalla Usuario → «Plan» con uso; pantalla Space → uso, Steward y aceptar o rechazar una oferta; aviso de cuota en el Thread; el Owner ve Users con su Plan y lo cambia. Crear y editar Plans, solo en web y desktop (Pregunta abierta 6).
- Lógica compartida (formatos de bytes, mensaje del error, estado del aviso) en `packages/client-runtime`.

### Auditoría

- Nuevas: `plan.create`, `plan.update`, `plan.delete`, `plan.default`, `plan.assign` (con `source`: `owner` o `billing`, para `../billing/`), `organization.steward.offer`, `organization.steward.accept`, `organization.steward.decline`, `organization.steward.cancel`.
- Detalle permitido: ids y nombres de Plan, User y Organization; valores de límites. Nunca contenido.

### Documentación

- `docs/user/install.md`: «Personal spaces and Installation permissions» se reescribe como «Plans and limits» (qué límite bloquea qué, que bajar no borra, cómo liberar disco). «Spaces and organizations» nombra al Steward.
- `docs/internals/environment-auth.md`: se quitan las menciones a Installation permissions; una frase sobre la regla del titular y sobre que `AccessPolicy` y `PlanLimits` son cosas distintas.
- `GLOSSARY.md`: se borra «Installation permission»; Plan y Steward ya están (los añade el mapa).

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User, un Admin o el Owner por las interfaces públicas (HttpApi, comandos de orquestación, herramientas MCP, la gateway, la ruta de previews) y lo que queda en la base. Red-first en cada límite y en cada regla del Steward.
- **Plans y titular:** tests de `Plans` y `PlanLimits` con Users reales del testkit de `UserAuth` (como `vaults/EffectiveVaults.test.ts`): titular del Personal space y de una Organization, Owner sin límites, NULL frente a 0, cambio de Steward.
- **Migración:** test de la migración con filas reales de `installation_permissions` (como `115_VaultReachLoss.test.ts`): nadie gana ni pierde capacidad.
- **Límites:** una fila por límite y por entrada que lo aplica en el test de su servicio (crear Organization, Invitation, aceptar Invitation, join de máquina, `thread.create`, `message.dispatch`, preview, gateway). Por encima del límite, rechazo con `PlanLimitReachedError`; nada se borra; un turno en marcha termina.
- **Disco:** medición con repositorios git y adjuntos temporales; borrar un Thread baja el disco medido (rojo en `main`). **Tráfico:** bytes contados en una petición de gateway con respuesta en streaming y en un preview con WebSocket.
- **Inventario:** `DoorRules.test.ts` y `RpcAuthorization.test.ts` con las puertas nuevas; el barrido de privacidad del ticket 12 busca títulos y rutas en las respuestas de uso del Owner.
- **Prior art:** `AccessPolicy.test.ts`, `InstallationUsers.test.ts`, `Memberships.test.ts`, `Invitations.test.ts`, `AiUsage.test.ts`, `HubRepository.test.ts`, `HubWithEnvironments.hubRepository.test.ts`, `sandboxLimits.test.ts`.
- **Prueba real por ticket de interfaz** con `test-t3-app` y datos copiados (`vp run migrate-dev-db`): un User en un Plan pequeño choca con cada límite y ve el mensaje; el Owner le cambia el Plan y puede seguir.

## Out of Scope

- **Pagos:** `../billing/`. Aquí solo existe `plan.assign` con `source`.
- **Topes de tokens y coste en USD:** de los Grants (`../grants/`).
- **Borrar o archivar automáticamente** lo que pasa de un límite: nunca.
- **Límites de CPU, memoria o disco del Sandbox por Plan:** siguen en Sandboxes.
- **Avisos por correo** al acercarse a un límite: no hay correo saliente.
- **Planes por Organization** (que una Organization pague su propio Plan): el Plan siempre es de un User.

## Further Notes

- **Por qué por titular y no un cupo común por User:** cada Space se compara con un número, el mensaje nombra un Space concreto y transferir el Steward no mueve consumo entre cupos. El límite de Organizations ya acota cuánto multiplica un User.
- **Riesgo aceptado:** las cuotas de disco y tráfico se pasan algo (medición horaria, lotes de tráfico, turnos que no se cortan). Son cuotas de uso justo, no de seguridad.
- **Rendimiento:** la medición de disco recorre `orchestration_v2_events`. El ticket 06 la mide con datos reales copiados; si tarda más de un segundo, pasa a un contador incremental por Thread.
- **Orden sugerido:** 01 → 02 → (03, 04, 05, 06, 08, 10 en paralelo) → 07 → 09 → 11 → 12.

## Preguntas abiertas

Las recomendaciones son la decisión por defecto y los tickets las asumen; el Owner puede reabrirlas.

1. **¿Cupo por Space o común por User?** Recomendación: por Space (Personal space con el Plan del User; cada Organization con el del Steward), como arriba.
2. **¿Los Guests cuentan como Members?** Recomendación: sí, toda membership cuenta, más las Invitations pendientes, para que aceptar nunca falle por sorpresa.
3. **¿Las Organizations archivadas cuentan?** Recomendación: no; restaurar cuenta como crear.
4. **¿Topes del Sandbox (CPU, memoria, disco) por Plan?** Recomendación: no en esta fase; el Plan solo dice sí o no.
5. **¿El Steward acepta la transferencia o el Owner la impone?** Recomendación: siempre acepta, también si ofrece el Owner; el Owner solo pasa a ser Steward sin aceptar cuando quita a un User.
6. **¿Editar Plans en móvil?** Recomendación: no; el Owner asigna Plans en móvil, pero crearlos y editarlos es un formulario largo de web y desktop.
7. **¿Unidades del disco y el tráfico?** Recomendación: bytes en la base; la UI pide y muestra GB (base 1000, como los proveedores de nube).
8. **¿A dónde llega un Grant a un Plan?** `../grants/` habla de «Grants a un Plan que alcancen al User». Recomendación: a los Spaces que sostiene (su Personal space y las Organizations de las que es Steward), no a toda Organization en la que trabaja; si no, un Member en un Plan alto metería recursos de la plataforma en la Organization de otro.
9. **¿Purgar los eventos de los Threads borrados?** El log de eventos no se borra nunca hoy, así que el disco real del Hub no baja al borrar un Thread. Recomendación: la cuota cuenta solo Threads vivos y el coste del log queda para el Owner; purgar eventos de Threads borrados (que además pide la privacidad del borrado de cuenta) se decide en `../platform-privacy/`.
