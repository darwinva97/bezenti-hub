# Diseño: prestar una máquina personal (01a + 08 + 09 + 10)

Spec: ../spec.md. Caso real: el Owner presta su VPS 86 (máquina personal `Contabo-Personal86`, usuario Linux `t3hub`, Podman 5.4 rootless, systemd de usuario con linger) al Personal space de Grecia, con límites, y lo retira cuando quiera. Rama `feat/grants-machines`. Migraciones 135–137 (138–139 libres).

## 1. Modelo y migraciones

- **135_Grants** (01a). Tabla `grants` como en el spec: `grant_id`, `resource_kind` (CHECK con los tres tipos para que AI accounts y Vault groups encajen luego; el servicio solo acepta `environment` y responde `not-lendable` al resto), `resource_id`, `lender_kind`/`lender_id` (hoy siempre `user` = `environments.owner_user_id` de una máquina `mode='personal'`; Organizations llegan con owned-resources), `target_kind` (`space`|`plan`), `target_id`, `state` (`pending`|`active`|`rejected`|`cancelled`|`ended`; `offered` existe en el CHECK para los enlaces del 06), `end_reason`, `limits_json`, `offer_token_hash`/`offer_expires_at` (nulos), `created_*`, `decided_*`, `ended_*`. Índice único parcial: un `pending|active` por (recurso, destino).
- `limits_json` de `environment` = `{ cpus, memoryBytes, pids, diskBytes }` (**`pids` añadido al spec**: fork bomb), decodificado con Schema en `packages/contracts/src/grants.ts` y validado con `invalidLimitsReason` (suelos de `sandboxLimits.ts`, `pids ≥ 64`).
- **136_LentSandboxes** (08). Reconstruye `environments` (SQLite no cambia un CHECK; patrón 106): `mode` gana `'lent'`; columnas `grant_id`, `host_environment_id`, `sandbox_host_json` (lo que informa la máquina, ver §3). Nueva rama del CHECK: `kind='sandbox' AND mode='lent' AND owner_user_id IS NULL AND space_id IS NOT NULL AND grant_id IS NOT NULL AND host_environment_id IS NOT NULL AND credential_hash IS NULL` (su credencial vive en `dedicated_sandbox_credentials`, que ya va por `environment_id` y rota). Id del Environment: `lent:<grantId>` (nunca `sandbox:`, que `sandboxSpaceOf` lee como Sandbox del Hub).
- **137_LentSandboxDisk** (09). `environments.last_disk_json` `{ usedBytes, measuredAt, failures }` para filas `lent`, más `host_free_bytes`/`host_total_bytes` en `sandbox_host_json` de la máquina.
- Por qué `kind='sandbox'`: `AiGatewaySessions.isolatedMachine` y `spaceRefusalOf` ya lo tratan como aislado y ligado a un Space. Coste: revisar las 4 consultas `kind = 'sandbox'` que significan «Sandbox del Hub» (`EnvironmentRegistry` lista y `:1700`, `EnvironmentReturnService:137`, ciclo de vida de `Sandboxes`) y añadirles `mode = 'sandbox'`. Test red-first: un Environment `lent` no aparece en Settings → Sandboxes ni lo para la inactividad del Hub.

## 2. Ciclo de vida y quién hace qué

- `Grants` (`apps/server/src/grants/Grants.ts`): `give`, `accept`, `reject`, `cancel`, `end` (`revoked` el prestador / `returned` el destino), `setLimits`, `listGiven`, `listReceived`. Tabla de transiciones probada (cada ilegal → `illegal-transition`). Uso los nombres del spec, no `offered/accepted/withdrawn/returned` (ver Conflictos).
- `accept` de un Grant de máquina (o `give` que nace `active` porque el prestador decide en el destino) crea **en la misma transacción** la fila `lent:<grantId>` y audita. `end` la marca terminada (§5).
- **AccessPolicy** (tabla probada): `grant.give/cancel/revoke/setLimits/viewGiven` sobre el recurso → solo el `owner_user_id` activo de la máquina personal no revocada (el Owner como operador no presta máquinas ajenas). `grant.decide/return` sobre el destino → Admins de la Organization o dueño del Personal space. `grant.viewReceived`: Members ven `active`, `pending` solo quien decide. `environment.use` sobre `lent:*` = `decideSpaceBound` (Admins y Members, no Guests) **y** Grant `active`.
- **Destinos sin enlaces (06 fuera):** el selector ofrece los Spaces donde el prestador es Member/Admin **y los Personal spaces de Users con los que comparte un Space** (el Owner: cualquier User activo). No expone nada nuevo (ya se ven en listas de miembros) y siempre nace `pending` salvo que el prestador decida en el destino.
- **Factor fuerte al aceptar:** aceptar (o dar con nacimiento `active`) un Grant de máquina va por HttpApi `POST /api/grants/accept` con `reauth` y `UserDirectory.confirmStrongFactor` (passkey o TOTP), como `vaults/http.ts`. La RPC WS `grants.accept` responde `strong-factor-required` para `environment`. Sin factor fuerte inscrito: error que lleva a inscribirlo.

## 3. Lado de la máquina

- **Host de Sandboxes por Space junto al servidor nativo.** Se parte `superviseDedicatedSandbox` en (a) `superviseSandbox(entry)`: bucle de un Sandbox (create → start → espera → backoff, 3 caídas/10 min = failed), sin `follow`/`becomePersonal`; y (b) `reconcileSandboxes(desired)`: un `FiberMap` por `sandboxId` que arranca, reinicia con límites/credencial nuevos e interrumpe+borra lo que sale de la lista. La personal monta `LentSandboxHost` como capa extra junto a `JoinedHub.layer` (el servidor nativo del dueño no cambia). La dedicada se queda como está en este corte (usa el mismo (a)); migrarla a (b) llega con owned-resources.
- **Preguntar al Hub:** `POST /api/environments/self` con la credencial propia de la máquina, al arrancar, cada 60 s y tras cada fin de un servidor de Sandbox (el Hub no da órdenes; una retirada ya mata el socket al anular la credencial, así que el sondeo solo pesa para Grants nuevos y límites). Un host sin runtime listo no arranca nada pero sigue informando.
- **`/self` compatible, sin subir el contrato:** respuesta **aditiva** `lent?: [{ grantId, environmentId, spaceId, limits, credential }]`; `spaceId`, `limits` y `sandboxCredential` se quedan para las dedicadas. Petición con payload **opcional** `{ sandboxHost?, sandboxes? }`. Un host viejo no lo manda (estado «desconocido»: el Grant se crea y avisa) y un Schema Struct ignora claves de más al decodificar. Solo si hiciera falta un cambio en el hello/wire se sube `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION` a **17**.
- **`sandboxHost`** = `{ ready, reason, limitSupport: { cpus, memory, pids, note }, hostCpus, hostMemoryBytes, hostFreeBytes, hostTotalBytes, reportedAt }`: Podman rootless + imagen (`dedicatedRuntimeFromConfig`), `hostExposure` y `podmanLimitSupport` (detección de cgroups ya hecha). El Hub lo guarda en la máquina; `give` con `ready:false` → rechazado con el motivo.
- **Credenciales:** cada respuesta emite por Grant una credencial nueva en `dedicated_sandbox_credentials` (`environment_id = lent:<grantId>`, `space_id` del prestatario; la anterior vale hasta su primer uso o 10 min). `checkCredential` ya devuelve `holder: "sandbox"` con su Space. Red-first: la credencial de la máquina presentada como `lent:*` → rechazada; la del Sandbox no sirve para `/self`, `leave` ni para conectar como la máquina personal; la de Acme no conecta como Globex ni lee su git.
- **Nombres:** `sandboxId = lent-<grantId>` (uno por Grant, nunca reutilizado: un Grant nuevo al mismo Space tiene home nuevo), runtime con `rootDir = <baseDir>-lent-sandboxes` → contenedor `t3-lent-<grantId>`. No choca con `t3-sandbox-<space>` (Hub) ni `t3-dedicated-<space>`, y la limpieza de Podman filtra por la etiqueta de `rootDir`, así que ningún runtime toca los contenedores de otro.
- **Límites:** `fitLimitsToHost(grant.limits, hostCapacity)` en cada arranque; `podmanLimitArgs` ya pasa `--pids-limit`, `--memory`, `--cpus` según lo que el host aplica. Si falta un controlador (en WSL `wsl -e` el user slice delega solo `memory pids` y sin bus va a cgroupfs: nada se aplica) el host lo informa y la UI lo dice («En esta máquina no se aplica: CPU»).
- **Disco (09):** el host mide cada home prestado con `measureWithDu` cada `T3CODE_SANDBOX_DISK_CHECK_SECONDS` y lo manda en `sandboxes[]`; tres fallos seguidos cuentan como «por encima». Con el disco libre del host bajo `minHostFreeBytes` el host **para** los Sandboxes prestados (el trabajo nativo del dueño sigue) y el Hub rechaza turnos en todos ellos.
- **Exposición del host:** misma regla que una dedicada: con algo escuchando fuera de loopback, `ready:false` con la lista. Variable `T3CODE_SANDBOX_HOST_PORTS` (alias de `T3CODE_DEDICATED_HOST_PORTS`). Cada puerto listado aparece en el formulario de dar como «lo alcanzan los Sandboxes prestados». El VPS 86 no estará listo hasta que sus servicios escuchen en 127.0.0.1 o se listen (ver Conflictos).

## 4. Enrutado de Threads

- `boundSpaceOf`: añadir `mode IN ('dedicated','lent')`. `spaceRefusalOf`: rama `kind='sandbox'` ya compara el Space; añadir refusal `lent-ended` cuando el Grant no está `active` (mensaje: «Se retiró el préstamo de esta máquina. Mueve el Thread a otro Environment»).
- Disco/host: en el inicio de turno (donde hoy se comprueba el disco de los Sandboxes del Hub) error tipado `LentSandboxDiskFullError { usedBytes, limitBytes }` o `LentHostDiskLowError`; terminales y lectura de archivos siguen.
- Clientes: `placeableEnvironments` ofrece `lent:*` solo a Threads de su Space y como preferido de sus Projects, nunca por defecto (`previewThreadPlacement`); distintivo «de <prestador> · ve lo que corre aquí».
- Gateway: al ser `kind='sandbox'` cuenta como aislada → solo claves `kind='thread'` (por Thread, rotan por sesión), nunca la de User. Así el dueño ve como mucho la clave de cada Thread que corre allí.

## 5. Retirar / devolver (10)

- `grants.end` (transacción): Grant `ended` → nuevos turnos rechazados (`lent-ended`); Threads cuyo Active environment es `lent:<id>` → `released` (109); auditoría. Effect posterior: interrumpe turnos en curso, espera su checkpoint ≤ 2 min, luego borra la fila de `dedicated_sandbox_credentials`, pone `revoked_at` y cierra el socket. Máquina desconectada: anula al momento.
- **Parar siempre, mover a elección:** nada se mueve solo. La vista del Grant ofrece «Mover» / «Mover todos» con `ThreadMoveService` (hub-thread-store 08) desde el último checkpoint subido. Aviso previo: «los cambios a mano desde el último turno pueden perderse».
- El host, en la siguiente respuesta sin ese Grant, para el contenedor y borra home, estado y log (`runtime.delete`), y al arrancar borra todo `lent-*` que no esté en la lista.
- `environment.remove` de la máquina termina sus Grants con `resource-gone`; borrar el Space destino, con `target-gone` (mismo camino).

## 6. UI web (Settings, hasta que lleguen los modales)

- **Prestar…** en la fila de la máquina personal (Settings → Environments): destino, límites (CPU, memoria, PIDs, disco; por defecto `BUILT_IN_DEFAULT_LIMITS` recortados al host), aviso de sobrecompromiso (suma de Grants > memoria o disco del host), estado `sandboxHost` y qué límites no se aplican. **Avisos al prestador:** una fuga del contenedor da al prestatario tu usuario Linux (y los otros Sandboxes prestados); su tráfico sale con tu IP y alcanza tu LAN; puertos listados.
- **Por aceptar** (Space): recurso, prestador, límites, qué se aplica, y el aviso del spec («<Prestador> controla esta máquina y puede ver todo lo que corre en ella: archivos, procesos, los Secrets que reciban los turnos y la clave de la gateway de cada Thread»). Aceptar abre el diálogo de reautenticación (passkey/TOTP).
- **Préstamos dados / Prestado a este Space:** estado, Sandbox (running/failed y motivo), CPU, memoria, disco usado/límite, «Retirar»/«Devolver», editar límites. El prestador nunca ve Threads.

## 7. Puertas y auditoría

- WS `RPC_SPACE_ACCESS` + `CLIENT_GUARDED_RPC_SCOPES`: `grants.listGiven/listReceived/give/reject/cancel/end/setLimits`, `grants.accept` (no-máquina). HttpApi (`DoorRules`): `POST /api/grants/accept` (factor fuerte), `/api/environments/self` (payload y respuesta nuevos). MCP: nada. Logs/OTLP: nunca credenciales de Sandbox.
- Auditoría: `grant.give/accept/reject/cancel/end` (`reason`, lado), `grant.limits.change`; detalle: tipo, id y nombre del recurso, prestador, destino, límites.

## 8. Tests (red-first)

- `Grants.test.ts`: cada transición ilegal; nace `active`; índice único. `AccessPolicy.test.ts`: filas de §2 (Member no Admin, Guest, Owner con máquina ajena, prestatario de otro Space). Migraciones 135–137 con el patrón de `106_DedicatedMachines.test.ts` (filas viejas intactas, CHECK rechaza `lent` sin `grant_id`).
- `HubWithEnvironments.lent.test.ts` (runtime process): máquina personal de Ana con Grants a Acme y Globex; turnos en cada Sandbox; Ana sigue nativa; credenciales cruzadas rechazadas; git route; `boundSpaceOf`; disco con medidor falso (rechaza y desbloquea al subir el límite); retirada con turno en marcha (checkpoint, `released`, credencial muerta) y host que borra el home; mover un Thread. Sin esperas: drenar el worker.
- `LentSandboxHost.test.ts`: reconciliación con runtime falso (alta, cambio de límites, baja, `lent-*` huérfanos).
- **Podman real:** WSL tiene Podman 3.4.4 rootless (cgroup v2, pero sin bus de usuario en `wsl -e` → cgroupfs). El grupo `PodmanSandboxRuntime.test.ts` añade: dos Sandboxes prestados no leen el home del otro ni el del dueño, y no hay choques de nombre con uno del Hub. Los límites de memoria y PIDs se prueban con `skipIf(!limitSupport.pids)`; en WSL se saltan, así que la prueba real de límites (fork bomb acotada, OOM) se hace en el VPS 86 como `t3hub`. Prueba real del ticket: Replay provider en el Sandbox prestado en WSL, retirada con turno en marcha.

## 9. Riesgos

- **Aceptados (documentados en la UI y `docs/user/`):** el dueño ve todo (archivos, procesos, Secrets, claves de Thread); todos los Sandboxes comparten el UID del dueño (fuga = cuenta del dueño y los demás prestatarios); salida a Internet sin filtro con la IP del dueño y LAN alcanzable; disco medido, no impuesto (se puede pasar entre dos mediciones).
- **Mitigados:** `pids` y memoria (si hay delegación; si no, se dice); turnos rechazados por disco propio y disco del host bajo, y parada de los prestados en el host; nada de 0.0.0.0 sin listar; credencial por Grant que rota y muere al retirar; claves de gateway por Thread; factor fuerte al aceptar.
- **Recomendado, fuera de código:** en el VPS, prestar desde un usuario Linux dedicado (ya es `t3hub`, separado de `maka`/root): una fuga no llega a los otros servicios.

## 10. Fuera de alcance

AI accounts y Vault groups prestados (02–07), enlaces (06), Plan como destino (`plan-target-unavailable`), máquinas de Organization y dedicadas como host de lista (owned-resources), móvil y paleta (12), fin por `lender-gone` (11), proxy de salida que filtre LAN/host (posible ticket «red estricta»: `--network=none` + CONNECT por el socket del Hub), cuota de disco real (XFS project quota).

## Conflictos con el spec / el encargo

1. **Estados:** el encargo dice `offered/accepted/withdrawn/returned/ended`; el spec, `pending/active/rejected/cancelled/ended` + `end_reason revoked|returned`. Sigo el spec (mismo significado).
2. **Destino Personal space de Grecia sin enlaces:** el spec lo resuelve con enlaces (06). Propongo Personal spaces de co-miembros (y cualquiera para el Owner) como destino; alternativa: traer el 06 solo para máquinas.
3. **Factor fuerte:** el spec (pregunta 7) recomienda no; el encargo lo exige. Lo pongo al aceptar y al dar con nacimiento `active`.
4. **`/self`:** el spec cambia `spaceId` por `sandboxes[]`; propongo campo aditivo `lent[]` y sin contrato 17, dejando la dedicada como está (el doc dice hoy que Hub y dedicadas no guardan compatibilidad).
5. **Sandbox por Grant** (`lent-<grantId>`), no `dedicated-<S>` por Space; `pids` añadido a `limits_json`.
6. **ADRs:** 0008 y 0009 ya existen (vault providers, workload identity). Escribiré «Las máquinas prestadas corren Sandboxes» (el 0011 del spec) con el siguiente número libre al escribirlo (hoy **0010**) y una nota de renumeración en la ADR y en el spec; el de Grants (0010 del spec) lo coordina quien lo escriba (otros agentes trabajan en paralelo en owned-resources/grants).
7. **VPS 86:** con la regla de exposición no quedará `ready` hasta limpiar o listar sus servicios en 0.0.0.0 (el usuario dijo que la limpiará). Bajar la regla para máquinas personales lo descarto: el contenedor llega a esos puertos como desde el propio host, saltándose cortafuegos y listas por IP.
