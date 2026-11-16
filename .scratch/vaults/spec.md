# Spec: Vaults

Status: ready-for-agent
Map: ../multi-user-hub/map.md (spec 5 de 6; se construye antes del spec 4)
Decisiones de origen: «Vaults», «Cierre del mapa» (`../multi-user-hub/issues/12`, `16`); investigación `../multi-user-hub/issues/02` (varlock)
ADRs: 0002 (el Hub es la fuente de verdad), 0004 (un Sandbox rootless por Space; nada protege los secretos de un Space frente a su propio agente), 0006 (el Hub guarda los Threads; los Environments ejecutan)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: Vault, Main vault, Secret link
Depende de: specs 1, 2 y 3 (done). El spec 4 «AI accounts y AI gateway» guarda sus credenciales en el almacén cifrado de este spec.

## Problem Statement

Hoy los secretos del Hub viven en `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`): un archivo `<nombre>.bin` por secreto en `<stateDir>/secrets`, con permisos 0700 pero **sin cifrar**. Ahí acaban las claves internas del Hub (firma de sesiones, HMAC de perfiles de preview), las credenciales de los ajustes (`settingsSecrets.ts`: variables de entorno sensibles de cada provider instance, tokens de source control, la `managementKey` de un hub CLIProxyAPI externo), la clave SSH que el Owner guarda con «keep for updates» (spec 3, ticket 10, `ssh-install-key-<id>`) y las respuestas de `request_secret` (`secrets/SecretRequests.ts`). Una copia del disco o de una backup del estado basta para leerlo todo.

Además no hay forma de dar a los agentes de un Space los tokens y API keys que su trabajo necesita. Un Member tiene que pegarlos en el chat (y quedan en el historial), escribirlos en un `.env` del checkout o pedir al Owner que los ponga en las variables de entorno de un provider instance, que entonces llegan a todos los Spaces. Nadie sabe qué secretos tiene cada Space, quién los cambió ni dónde se ven.

## Solution

El Hub cifra todo su almacén de secretos con una **clave maestra** que vive en un archivo aparte de la base de datos y que el Owner puede respaldar. Sobre ese almacén se construyen los **Vaults**: conjuntos con nombre de secretos, cada uno bajo un nombre de variable de entorno.

- El Owner tiene un **Main vault** y es el único que crea Vaults y los permite a Spaces y Users.
- El Vault de una Organization mezcla **Secret links** al Main vault (rotar el original los actualiza), copias independientes y secretos propios.
- Cada Space tiene sus Vaults por defecto; cada Project añade o quita entre los permitidos.
- Los secretos llegan como **variables de entorno** al agente, a las terminales y a los dev servers del Project, en el Sandbox o en la máquina donde corra el Thread. El agente puede **listar los nombres** sin ver los valores.
- Todo valor que aparezca en el historial guardado o mostrado se sustituye por `[NOMBRE]`.
- Solo el Owner revela valores. Los Admins escriben sin leer. Members y Guests ven solo nombres.
- Si el agente pide un secreto que falta, el Owner o un Admin pueden guardar la respuesta en un Vault.

## User Stories

### Almacén cifrado y clave maestra

1. As the Owner, I want every secret the Hub stores to be encrypted at rest with a master key kept outside the database, so that a copy of the database or of the secrets folder reveals nothing.
2. As the Owner, I want the master key created on first start in its own file with owner-only permissions, so that I don't have to set anything up.
3. As the Owner, I want to choose where the master key file lives (`T3CODE_MASTER_KEY_FILE`), so that I can keep it off the disk I back up.
4. As the Owner, I want to download a backup of the master key from Settings after confirming with my strong factor, and to export it with `t3 secrets key export`, so that I can restore the Hub on another server.
5. As the Owner, I want Settings to warn me until I have backed up the master key, so that I don't lose every secret with one disk.
6. As the Owner, I want restoring the state with the wrong or a missing master key to fail with a clear message instead of starting with empty secrets, so that I never overwrite good data by accident.
7. As the Owner, I want to rotate the master key with one command, so that a leaked key file can be replaced.

### Vaults y secretos

8. As the Owner, I want a Main vault that exists from the start, so that I have one place for my own secrets.
9. As the Owner, I want to create, rename, describe, archive and delete Vaults, so that I can organise secrets per client or purpose.
10. As the Owner, I want to add a secret to a Vault under an environment-variable name, with an optional description, so that agents receive it under that name.
11. As the Owner, I want to add to an Organization's Vault a Secret link to a secret of the Main vault, so that rotating the original updates every link.
12. As the Owner, I want to add a copy of a Main vault secret instead, so that later changes to the original don't reach that Organization.
13. As an Admin of an Organization, I want to add, replace and delete secrets in the Vaults allowed to my Organization without seeing their values, so that I can keep them current.
14. As an Admin, I want to be refused when I try to edit the Main vault or a Vault not allowed to my Organization, so that my rights stop at my Organization.
15. As a Member or Guest, I want to see the names and descriptions of the secrets my Threads receive, never their values, so that I know what the agent has.
16. As the Owner, I want to reveal a value only after confirming with my strong factor, with every reveal recorded in the audit log, so that reading a secret is deliberate and traceable.
17. As the Owner, I want every create, edit, link, copy, delete and reveal recorded in the audit log without the value, so that I can trace changes.
18. As the Owner, I want a secret name that is not a valid environment variable, or that the Hub reserves (`PATH`, `HOME`, `T3_*`, the AI gateway variables of spec 4…), to be refused, so that a Vault can't break the agent's environment.

### Permitir y elegir Vaults

19. As the Owner, I want to allow a Vault to Spaces and to Users, so that I decide who may receive it.
20. As the Owner or an Admin, I want to choose which allowed Vaults are the defaults of a Space, so that every Project and Thread there gets them.
21. As an Admin, I want to add or remove, per Project, any Vault allowed to its Space, so that one Project can get extra secrets or drop some.
22. As the Owner, I want the Main vault to be a default only of my own Personal space, so that my own secrets never reach an Organization unless I link them.
23. As a Member, I want the Thread to show which Vaults and secret names it receives, so that I understand its environment.
24. As the Owner, I want two Vaults in the same Thread that define the same name to resolve in a fixed, visible order, so that the result is never a surprise.

### Entrega

25. As a Member, I want my Thread's secrets to reach the agent as environment variables in the Sandbox or on the machine where it runs, so that tools and scripts just work.
26. As a Member, I want my terminals and the dev servers I start for that Project to receive the same variables, so that my app runs with the same configuration as the agent's.
27. As a Member, I want a rotated secret to reach the next turn and the next terminal without restarting anything by hand, so that rotation is painless.
28. As the Owner, I want secrets never passed as process arguments, never written to logs, traces or files of the Hub in clear, so that they can't leak through `ps` or the observability stack.
29. As a User with an older machine, I want a turn that needs secrets on a machine too old to receive them to fail with «update this machine», so that secrets are never silently missing.

### Historial y agente

30. As a Member, I want any secret value that appears in the agent's messages, tool output, terminal output or diffs to be shown and stored as `[NAME]`, so that the history never keeps a value.
31. As a Member, I want the agent to be able to list the secret names it has, so that it uses `$NAME` instead of asking me.
32. As an Admin, when the agent asks for a secret that is missing, I want to answer and save it in one of my Organization's Vaults under a name, so that the next Thread already has it.
33. As a Member, when the agent asks for a missing secret, I want to answer it for this Thread only, as today, so that I am not blocked while an Admin adds it.

### Cambio de Space y bajas

34. As the Owner, I want moving a Project to another Space to warn which Vaults it loses before I confirm, and then to use only the destination's Vaults, so that secrets never follow a Project into another Space.
35. As the Owner, I want removing a Vault's allowance from a Space or a User to stop delivering it from the next turn or terminal, so that revocation is quick.
36. As the Owner, I want deleting an Organization to delete its own Vaults and secrets, so that nothing of it remains.

### Clientes

37. As the Owner or an Admin on web or desktop, I want Settings → Vaults to manage Vaults, secrets, links and allowances, so that I do it in one place.
38. As a Member on web, desktop or mobile, I want to see the names my Thread receives, so that I have the same picture on any device.
39. As the Owner on mobile, I want to see Vaults and names and add or replace a secret, but to reveal values only on web or desktop, so that revealing stays on a device with a strong factor and a large screen.

## Implementation Decisions

### Almacén cifrado: se extiende `ServerSecretStore`, no se sustituye

- **Decisión:** los Vaults no sustituyen `ServerSecretStore`; lo extienden. `ServerSecretStore` sigue siendo la única puerta a los secretos del Hub (los usan la firma de sesiones, los perfiles de preview, `settingsSecrets`, `SecretRequests`, `ProviderCredentialStore`, la instalación por SSH), pero cada entrada pasa a guardarse cifrada:
  - AES-256-GCM con una clave derivada de la clave maestra (HKDF, etiqueta por uso), nonce aleatorio por escritura, y el nombre del secreto como dato autenticado (no se puede mover un archivo cifrado a otro nombre).
  - Formato con cabecera de versión, para poder rotar la clave y cambiar de algoritmo.
  - La API pública (`get`, `set`, `create`, `getOrCreateRandom`, `remove`) no cambia: ningún llamador sabe que hay cifrado.
- **Valores de Vaults:** viven en la base de datos (tablas nuevas), cifrados con la misma clave maestra y el id de la entrada como dato autenticado. Una backup de `state.sqlite` sin la clave no sirve.
- **Clave maestra:**
  - 32 bytes aleatorios en `<stateDir>/master.key` (0600), o en la ruta de `T3CODE_MASTER_KEY_FILE`.
  - Se crea en el primer arranque. Si la base de datos o `secrets/` ya tienen datos cifrados y falta la clave, o la clave no abre un valor de prueba guardado en la base, el Hub **no arranca** y dice por qué. Nunca crea una clave nueva sobre datos cifrados con otra.
  - Al subir de versión, los `.bin` en claro que hay se cifran una vez (escritura atómica, idempotente, en el arranque). Nada se queda en claro.
- **Backup:** `t3 secrets key export` (escribe la clave a un archivo o stdout) y `t3 secrets key import`. En Settings → Vaults, «Download master key backup» solo para el Owner, con confirmación del factor fuerte. Settings muestra un aviso hasta la primera backup. Auditoría `secret.master_key.export`.
- **Rotación:** `t3 secrets key rotate` vuelve a cifrar todo con una clave nueva en una transacción y conserva la anterior como `master.key.previous` hasta que el Owner la borra.
- **Lo que no se cifra:** nada que esté en `ServerSecretStore` queda fuera. El archivo de la clave maestra es el único secreto en claro del Hub.

### Modelo

- Migración **111** (`vaults`):
  - `vaults`: id, nombre, descripción, `spaceId` (nulo para el Main vault y los Vaults del Owner), `isMain`, archivado, fechas, creado por.
  - `vault_entries`: id, `vaultId`, nombre de variable, descripción, tipo (`own` | `copy` | `link`), valor cifrado (para `own` y `copy`), `linkedEntryId` (para `link`), versión, fechas, editado por.
  - `vault_allowances`: `vaultId` y un sujeto (`space` o `user`).
  - `space_default_vaults`: Space y Vault.
  - `project_vault_choices`: Project, Vault y `add` | `remove`.
  - Un valor de prueba cifrado en una fila de metadatos, para comprobar la clave maestra al arrancar.
- **Main vault:** se crea con el Owner. No se borra. Solo el Owner lo edita. Es Vault por defecto solo del Personal space del Owner, y no se puede permitir a otros Spaces ni Users (sus secretos llegan a otros por Secret links o copias).
- **Secret link:** apunta a una entrada `own` o `copy` del Main vault, nunca a otro link. Rotar el original cambia lo que reciben todos los links. Borrar el original pide confirmación y lista los links que se rompen; los links rotos se muestran como «broken» y no se entregan.
- **Copia:** guarda el valor del momento, cifrado de nuevo, sin relación con el original.
- **Nombres:** `^[A-Z_][A-Z0-9_]{0,127}$`, únicos dentro de un Vault. Prohibidos: `PATH`, `HOME`, `USER`, `SHELL`, `PWD`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `T3_*`, `T3CODE_*` y las variables que el spec 4 reserva para la AI gateway (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_BASE_URL`, …; lista compartida en contracts).
- **Valores:** hasta 64 KiB, texto UTF-8 sin NUL. Los valores muy cortos se aceptan con un aviso y no se enmascaran (umbral: pregunta abierta 3, recomendado 6 caracteres).

### Quién hace qué (tabla en `AccessPolicy`)

| Acción                                                                     | Owner                                  | Admin (de la Organization) | Member | Guest |
| -------------------------------------------------------------------------- | -------------------------------------- | -------------------------- | ------ | ----- |
| Crear, borrar, archivar Vaults; permitirlos                                | sí                                     | no                         | no     | no    |
| Editar el Main vault                                                       | sí                                     | no                         | no     | no    |
| Añadir, sustituir, borrar secretos de un Vault permitido a su Organization | sí                                     | sí, sin leer valores       | no     | no    |
| Elegir Vaults por defecto de su Space y por Project                        | sí                                     | sí                         | no     | no    |
| Ver nombres y descripciones de lo que recibe un Thread visible             | sí                                     | sí                         | sí     | sí    |
| Revelar un valor                                                           | sí, con factor fuerte reciente (5 min) | no                         | no     | no    |

- Un Personal space: su dueño ve nombres; el Owner decide qué Vaults recibe (el dueño no edita salvo que sea el Owner).
- Revelar no existe en móvil.
- Una sesión limitada a un Space (credenciales de agente, `spaceLimit` del spec 3) nunca lista ni edita Vaults de otro Space.

### Conjunto efectivo de un turno (una sola regla)

- Un servicio nuevo, `EffectiveVaults`, decide qué variables recibe un turno, una terminal o un script de un Thread. Es el único sitio que lo calcula; entrega, enmascarado, lista de nombres y el plan de mover Project lo llaman.
- Regla:
  1. Vaults por defecto del Space del Thread, más los `add` del Project, menos los `remove` del Project, limitado a los Vaults permitidos al Space.
  2. Más los Vaults permitidos al User que lanza el turno (o que abre la terminal), en cualquiera de sus Spaces.
  3. Sin los archivados ni las entradas con link roto.
- **Orden ante nombres repetidos:** Vaults del User, luego Vaults añadidos por el Project, luego defectos del Space; dentro de cada grupo, el orden que el Owner fija en Settings. La UI del Thread muestra qué Vault gana cada nombre.
- Un Thread sin Project usa los defectos de su Space más los del User.
- El Hub calcula el conjunto en cada turno y en cada apertura de terminal o script; no se cachea entre turnos, así que una rotación o una baja tienen efecto en el siguiente.

### Entrega como variables de entorno

- **Executor contract 9 → 10.** Las peticiones `provider.openSession`, `provider.startTurn` (cuando cambia el conjunto), `terminal.open` y `launch.runSetupScript` llevan un campo nuevo `secretEnv`: lista de nombre y valor. Un ejecutor < 10 no lo entiende: si el conjunto efectivo no está vacío, el Hub rechaza con un error tipado («<máquina> needs an update to receive this Thread's secrets»). Con el conjunto vacío sigue funcionando.
- **En la máquina:**
  - El agente joined pone `secretEnv` en el entorno del proceso del provider, de la terminal o del script, y en ningún otro sitio: ni en argumentos, ni en archivos, ni en sus logs, ni en sus spans.
  - Los dev servers que arranca el agente o una terminal heredan ese entorno; los previews no reciben nada aparte.
  - Si el provider ya corre y el conjunto cambia, el siguiente turno reabre la sesión del provider con el entorno nuevo (los providers no aceptan cambiar el entorno de un proceso vivo); las terminales abiertas conservan el suyo hasta reabrirse, y la UI lo indica («Secrets changed: reopen to update»).
- **Hub machine en proceso** (solo desarrollo, spec 3): misma ruta, mismo campo.
- **Mensaje cifrado en tránsito:** el canal del Environment ya va por TLS (máquinas externas) o por el socket UNIX del Sandbox; no se añade cifrado propio. El campo `secretEnv` se marca como sensible y el registro de frames del wire lo omite.

### Enmascarado `[NOMBRE]`

- Un servicio único, `SecretMasker`, recibe el conjunto efectivo de un Thread y sustituye cada valor por `[NOMBRE]`. Cubre el valor literal y su forma URL-encoded y base64 estándar.
- Dónde se aplica (en el Hub, antes de guardar o enviar):
  - eventos del provider que llegan del ejecutor (mensajes, razonamiento, llamadas y resultados de herramientas) antes de proyectarlos o guardarlos;
  - salida de terminal antes de guardarla en el historial y antes de enviarla a los clientes;
  - diffs de checkpoints y lecturas de archivos que el cliente muestra;
  - resúmenes de traspaso entre máquinas (spec 2) y títulos generados;
  - logs y spans OTLP del Hub y del agente joined (filtro de logs ya existente en `serverLogger.ts`, ampliado con los valores conocidos).
- Lo que no se puede evitar: el proveedor de IA ve un valor si el agente lo lee (decisión 9). El archivo del checkout que el agente escribe con un valor queda con el valor en la máquina; solo su vista en el Hub sale enmascarada.
- Valores rotados: el masker conserva los valores anteriores de un Thread durante su vida, para tapar también lo que el agente imprimió antes de la rotación.

### El agente lista nombres

- Herramienta MCP nueva `list_secret_names`: devuelve nombre, descripción y Vault de cada variable del conjunto efectivo del Thread que llama. Nunca valores. Regla en `MCP_TOOL_RULES`: la del Thread propio (`OWN_THREAD`).
- Las instrucciones de desarrollador del agente (Claude, Codex y demás) añaden una línea: hay secretos como variables de entorno; usa `list_secret_names` y `$NOMBRE`, no los imprimas.

### Guardar un secreto que falta

- `request_secret` (secrets/SecretRequests.ts) ya muestra una tarjeta y guarda la respuesta de un solo uso. Se amplía:
  - Si quien responde es el Owner o un Admin del Space del Thread, la tarjeta ofrece «Also save to Vault» con un selector de los Vaults que puede editar y el nombre (sugerido por el agente).
  - Al guardar, la entrada se crea en ese Vault (auditoría `secret.edit`) y el turno recibe el valor como hoy. Los siguientes turnos lo reciben por el conjunto efectivo, si el Vault aplica al Thread.
  - Members y Guests responden como hoy, sin opción de guardar.

### Cambio de Space de un Project

- El plan de mover (`POST /api/projects/move-plan`, ticket 12 del spec 3) añade `vaultsLost`: los Vaults que hoy recibe el Project por el origen y que el destino no tiene. El diálogo los lista antes de confirmar.
- Al mover, se borran las `project_vault_choices` que nombran Vaults no permitidos al destino. Los turnos y terminales siguientes calculan el conjunto con el Space de destino. El ticket 12 del spec 3 ya detiene los Threads, así que no hay turnos vivos con el conjunto viejo.

### Bajas

- Quitar una allowance: efecto en el siguiente turno, terminal o script.
- Quitar un User de la Installation (spec 1): sus allowances de User desaparecen.
- Borrar una Organization: se borran sus Vaults (`spaceId` = esa Organization), con sus valores. Los Vaults del Owner que tenía permitidos solo pierden la allowance.

### Puertas

Cada puerta nueva se declara donde le toca y el test de inventario de `DoorRules.test.ts` falla si falta:

- **WS RPCs** (`RPC_SPACE_ACCESS`): `vaults.list`, `vaults.create`, `vaults.update`, `vaults.delete`, `vaults.allow`, `vaults.entries.list` (nombres), `vaults.entries.put`, `vaults.entries.delete`, `vaults.entries.link`, `vaults.entries.copy`, `vaults.spaceDefaults.set`, `vaults.projectChoices.set`, `vaults.threadEnvironment` (nombres efectivos de un Thread). Todas con la tabla de arriba.
- **HttpApi** (`HTTP_ENDPOINT_RULES`): `vaults.reveal` (solo Owner con factor fuerte reciente; HttpApi y no WS, para que la respuesta no pase por el canal de suscripciones ni quede en caches de cliente) y `vaults.masterKeyBackup` (solo Owner). Ninguna otra lee valores.
- **Raw routes**: ninguna.
- **MCP** (`MCP_TOOL_RULES`): `list_secret_names` (`OWN_THREAD`); `request_secret` sin cambio de regla.
- **Executor wire:** `secretEnv` solo en las cuatro operaciones citadas, solo hacia la máquina activa del Thread, y omitido en los logs de frames.
- **Logs, OTLP, argumentos de proceso:** test de humo que lanza un turno con un secreto y busca su valor en logs, spans, `ps` de la máquina y archivos del Hub.
- **Cookies ambientales** (`AMBIENT_COOKIE_RULES`): sin rutas nuevas.

### Clientes

- **Web y desktop:** Settings → Vaults.
  - Owner: lista de Vaults, el Main vault arriba; cada Vault con sus entradas (nombre, descripción, tipo, «linked from Main vault», «broken»), allowances, botón «Reveal» con el factor fuerte; aviso de backup de la clave maestra.
  - Admin: los Vaults permitidos a sus Organizations, con «Replace value» y «Delete», sin «Reveal».
  - Space → «Default Vaults»; Project → «Vaults» (añadir o quitar).
  - Thread: panel «Secrets» con los nombres efectivos, qué Vault gana cada uno y si una terminal abierta tiene valores viejos.
  - Tarjeta de `request_secret` con «Also save to Vault».
- **Móvil:** lista de Vaults y nombres, añadir o sustituir un valor (Owner y Admin), panel «Secrets» del Thread. Sin «Reveal».

### Auditoría

- Acciones ya en la allow-list del spec 1: `secret.reveal`, `secret.edit` (detalle `vault`).
- Nuevas: `vault.create`, `vault.update`, `vault.delete`, `vault.allow`, `secret.master_key.export`, `secret.master_key.rotate`.
- Detalle permitido: id y nombre del Vault, nombre de la variable, tipo de entrada. Nunca el valor.

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User, el Owner o una máquina por interfaces públicas: RPC WS, HttpApi, herramientas MCP, el protocolo del Environment y el entorno real del proceso que arranca el agente joined. Red-first en toda regla de seguridad.
- **Almacén cifrado:** tests de `ServerSecretStore` con archivos reales: nada en claro en disco tras escribir; un archivo cifrado renombrado no abre; clave equivocada o ausente con datos cifrados impide arrancar; la migración de `.bin` en claro es idempotente y atómica; rotación.
- **Seam principal:** el testkit «Hub con Environments» (spec 2/3) con el runtime process. Owner, Admin, Member y Guest de dos Organizations:
  - tabla de permisos completa (crear, editar, revelar, permitir) por WS y HttpApi;
  - conjunto efectivo (defectos, `add`/`remove`, allowances de User, nombres repetidos);
  - el proceso del provider, una terminal y un script de setup en la máquina joined reciben `secretEnv`, y un ejecutor con contrato 9 recibe el error;
  - enmascarado en eventos, terminal, diffs y traspasos;
  - `list_secret_names` y `request_secret` con «Also save to Vault»;
  - mover un Project entre Organizations.
- **Inventario:** `DoorRules.test.ts` y `RpcAuthorization.test.ts` con las puertas nuevas.
- **Fugas:** un test de humo busca el valor de un secreto en logs, spans, argumentos de proceso (`/proc/*/cmdline` en la máquina joined) y en todos los archivos del Hub fuera del almacén cifrado.
- **Prior art:** `ServerSecretStore.test.ts`, `RetiredSecrets.test.ts`, `SecretRequests.test.ts`, `AccessPolicy.test.ts`, `AuditLog.test.ts`, `HubWithEnvironments.*.test.ts`, el test de humo de la clave SSH del ticket 10 del spec 3.
- **Prueba real por ticket de interfaz:** en WSL con Podman. Un Hub dev con dos Organizations: el Owner crea un Vault con un Secret link al Main vault, lo permite a Acme, un Member de Acme ve el nombre pero no el valor, el agente de su Thread hace `echo $NOMBRE` y el historial muestra `[NOMBRE]`; el Sandbox de Globex no lo recibe.

## Out of Scope

- **Secretos usados sin que el agente los vea** (proxy de credenciales): mejora futura según «Cierre del mapa».
- **`.env.schema` por Project** y varlock: mejora futura.
- **Backends externos** de secretos para los Vaults (1Password, varlock): decisión 2, sin backends externos. Las referencias de 1Password de los ajustes (`secretReference.ts`) siguen como están, solo para ajustes del Owner. **Reabierto** por la ADR 0008 y el spec `../vault-variables-and-providers/spec.md`.
- **AI accounts y sus credenciales:** spec 4, aunque se guardan en este almacén.
- **Vista de procesos:** spec 6.

## Further Notes

- **Riesgo aceptado (ADR 0004):** dentro de un Space no hay aislamiento. Cualquier proceso del Sandbox puede leer el entorno de otro proceso del mismo usuario (`/proc/<pid>/environ`), así que un secreto entregado a un turno lo puede leer el agente de otro Member del mismo Space. Settings lo dice al permitir un Vault a un User.
- **El proveedor de IA ve los valores que el agente lee.** El enmascarado protege el historial del Hub, no el contexto del modelo.
- **Perder la clave maestra** pierde todos los secretos y obliga a volver a iniciar sesión (las claves de firma también están cifradas). Por eso el aviso de backup.
- **Orden sugerido para los tickets:**
  1. Almacén cifrado y clave maestra.
  2. Vaults, secretos y permisos de edición.
  3. Permitir Vaults y conjunto efectivo.
  4. Entrega como variables de entorno (contrato 10).
  5. Enmascarado `[NOMBRE]`.
  6. El agente lista nombres y guarda secretos que faltan.
  7. Cambio de Space de un Project y bajas.
  8. Clientes: desktop y móvil.
  9. Inventario de puertas y pase completo.

## Preguntas abiertas (decididas)

El Owner aceptó todas las recomendaciones el 2026-11-11; cada «Recomendación» de abajo es la decisión.

1. **¿Un Vault permitido a un User entra en sus turnos dentro del Sandbox compartido de una Organization?** La decisión 3 permite Vaults a Users, pero en un Sandbox compartido otros agentes del Space pueden leer el entorno. Recomendación: sí, solo en los turnos, terminales y scripts de ese User, con el aviso del riesgo al permitirlo.
2. **¿Los Guests reciben los Vaults del Space en sus Threads?** La decisión 6 les deja ver solo nombres; la 7 aplica los defectos a los Threads del Space. Recomendación: sí reciben los defectos (un Guest puede ejecutar Threads), y el Owner o un Admin los quitan por Project si no deben.
3. **Valores cortos.** Enmascarar un valor de 4 caracteres tapa texto normal. Recomendación: enmascarar desde 6 caracteres; por debajo, aceptar con aviso y no enmascarar.
4. **¿Dónde vive la clave maestra por defecto?** Recomendación: `<stateDir>/master.key` con el aviso de backup activo hasta descargarla, y documentar `T3CODE_MASTER_KEY_FILE` para sacarla del disco de backups.
