# Spec: Grants (préstamos)

Status: ready-for-agent
Map: ../public-hub/map.md (fase 3: spec 3 de 6)
Decisiones de origen: «Dueños y préstamos», «Vaults con grupos» y «Decisiones transversales» (Grants, Topes de IA) del mapa; análisis de atribución en `../ai-accounts-and-gateway/issues/16-el-uso-de-ia-no-se-ve.md` (Comments)
ADRs: 0004 (un Sandbox rootless por Space), 0005 (suscripciones por la AI gateway), 0006 (el Hub guarda los Threads; los Environments ejecutan), 0007 (sin servicios de upstream), 0008 (plataforma con Owner operador), 0010 (los dueños prestan recursos con Grants), 0011 (las máquinas prestadas corren Sandboxes), 0012 (Secrets de solo escritura)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: Grant, Plan, Steward, Vault group, Secret, Variable, Sandbox, External environment
Depende de: `../owned-resources/` (quién es dueño de cada Environment, AI account y Vault group, y que un recurso solo se usa en el Space de su dueño). Toca: `../hub-thread-store/` (mover un Thread, ticket 08), `../sandboxes-and-external-environments/` (máquinas dedicadas, `DedicatedHost`), `../ai-accounts-and-gateway/` (gateway, `AiUsage`, ticket 16). Lo deja a: `../plans-and-limits/` (quién usa un Grant a un Plan), `../settings-modals/` (dónde viven las pantallas).

## Problem Statement

Tras `owned-resources`, cada User y cada Organization es dueño de sus máquinas, AI accounts y Vault groups, pero solo los usa en su propio Space. No hay forma de que Ana ponga su VPS o su API key a trabajar para Acme, ni de que Acme preste una suscripción a un cliente, ni de compartir un grupo de Secrets personales con el equipo.

Lo único parecido son las «allowances» del Owner: `ai_account_allowances` (migración 112) y `vault_allowances` (migración 111), que leen `ai/AllowedAiAccounts.ts` y `vaults/VaultReach.ts`. No tienen límites, no se aceptan, solo las da el Owner, y una allowance «a un User» lo sigue a cualquier Space en el que trabaje (`subject_kind = 'user'`). El uso de IA se registra (`ai/AiUsage.ts`, migración 114), pero sin saber por qué préstamo se consumió, sin topes y sin precio. Las máquinas dedicadas (`environments/DedicatedHost.ts`) sirven a un solo Space.

## Solution

Un **Grant** es una fila: un dueño presta **un recurso** (Environment, AI account o Vault group) **a un destino** (un Space o un Plan) con límites, y lo puede retirar cuando quiera. Una regla por tipo de recurso lee los Grants activos en el mismo sitio donde hoy se leen las allowances, que desaparecen.

- **Ciclo de vida:** `pending` → `active` → `ended`, con `rejected` (el destino dice que no) y `cancelled` (el prestador lo retira antes de que lo acepten). Un Grant a una Organization lo acepta un Admin de ella; a un Personal space, su dueño; a un Plan no se acepta (lo da solo el Owner). Si quien presta también puede aceptar en el destino, el Grant nace activo. Lo terminan el prestador («Retirar»), el destino («Devolver») o el sistema (recurso, destino o prestador que desaparecen).
- **Quién presta:** el dueño del recurso. Si es una Organization, sus Admins o su Steward.
- **Destinos que no son tuyos:** un Space del que formas parte se elige de una lista. Para cualquier otro, el prestador crea un **enlace de préstamo** (un uso, 7 días) que el receptor abre y aplica a un Space suyo; así nadie ve un directorio de Spaces ajenos.
- **AI accounts:** solo por la gateway (las de tipo `direct` no se prestan). Tope en tokens por periodo (día, semana o mes) y, si se quiere, en peticiones; la gateway lo aplica en cada petición. El prestador ve cuánto gastó cada Space y User prestatario; el prestatario, lo suyo. Coste estimado en USD con una tabla de precios versionada; las suscripciones muestran tokens y su parte de la cuota. Prestar una suscripción muestra un aviso corto de los términos del proveedor.
- **Vault groups:** el grupo aparece enlazado en el vault del Space prestatario. Los cambios llegan al siguiente turno, las Variables se ven y los Secrets nunca. Al retirarlo se avisa de que hay que rotar.
- **Environments:** la máquina aloja un Sandbox por cada Space prestatario, con los límites de CPU, memoria y disco del Grant. Se avisa al prestatario de que el dueño de la máquina ve lo que corre allí. Al retirarla, sus Threads se paran y se ofrecen para mover.
- **Migración:** las allowances de hoy pasan a Grants ya activos del Owner.

## User Stories

### Dar, aceptar y retirar

1. As a User, I want to lend one of my AI accounts, Vault groups or machines to a Space I belong to, choosing it from a list, so that my team can use it.
2. As an Admin or the Steward of an Organization, I want to lend the Organization's resources to another Space, so that the Organization can share what it owns.
3. As a Member who is not an Admin, I want lending the Organization's resources to be refused, so that only those who run it decide.
4. As a User, I want to create a one-use lending link for a Space I am not in, so that I can lend to anyone without seeing a directory of Spaces.
5. As someone who opens a lending link, I want to choose which of my Spaces receives it (my Personal space, or an Organization where I am Admin), with the same warnings as an acceptance, so that receiving is one step.
6. As an Admin of an Organization, I want to see Grants waiting for acceptance with lender, resource, limits and warnings, and accept or reject each one, so that nothing enters the Organization without us.
7. As a User, I want Grants to my Personal space to wait for my acceptance, so that nobody puts a machine or a Secret into my space unasked.
8. As a lender, I want a Grant to a Space where I can accept to start active at once, so that I don't accept my own offer.
9. As a lender, I want to see every Grant I or my Organization gave, with state, limits and usage, and to change limits, cancel a pending one or revoke an active one, so that I stay in control.
10. As an Admin of the receiving Space (or owner of the Personal space), I want to return an active Grant, so that we can stop using something we no longer want.
11. As a Member, I want to see which resources my Space has borrowed, from whom and with which limits, so that I know what I am using.
12. As the Owner, I want to give Grants to a Plan without acceptance, so that a Plan can include platform resources.
13. As a borrower, I want Grants to end by themselves when the resource, the lender or my Space disappears, and to see why, so that nothing is left dangling.

### AI accounts prestadas

14. As a lender, I want to cap a Grant in tokens per day, week or month, and optionally in requests, so that a borrower can't drain my account.
15. As a borrower, I want a request over the cap to fail over to another allowed account of the same provider, or to fail with a message saying which Grant hit its cap and when it resets, so that I'm never confused.
16. As a borrower, I want the AI-account picker to show how much of each Grant's cap is used, so that I can plan.
17. As a lender, I want to see tokens, requests and estimated cost per borrowing Space and User, by day and model, never prompts or Threads, so that I know who uses my account.
18. As a borrower, I want to see my own usage of a borrowed account and, as an Admin, my Space's, so that we know what we consume.
19. As a lender of a subscription, I want a short warning that the provider's terms forbid sharing and the account may be suspended, so that I lend knowingly.
20. As a lender of a subscription, I want usage shown as tokens and the borrower's share of the quota window when the provider reports it, never an invented price, so that the numbers are honest.
21. As a lender, I want direct-credential AI accounts refused for lending, so that a lent credential never leaves the Hub.

### Vault groups prestados

22. As a User, I want to lend a group of my personal vault to an Organization I belong to, with a warning that its agents can read the Secrets, so that the team uses my keys knowingly.
23. As an Admin, I want an accepted group to appear linked in our vault, choosable as a default or per Project like our own groups, so that it works like any group.
24. As a Member, I want to see a lent group's Variables and the names of its Secrets, never Secret values, so that I know what my turn gets.
25. As a lender, I want my edits to reach the borrower's next turn, so that rotating is one action.
26. As a lender, I want revoking to warn that values may have been read and to list the Secrets to rotate, so that I close the leak properly.
27. As an Admin of the borrowing Space, I want names that could change how a process runs (`secretNameRisk` `dangerous`) never delivered from a lent group, so that a lender can't hijack our turns.

### Máquinas prestadas

28. As a User, I want to lend my machine to a Space with CPU, memory and disk limits, so that it serves the team without being taken over.
29. As an Admin, I want the acceptance to warn that the machine's owner can see everything that runs there (files, processes, Secrets delivered to turns), so that we accept knowingly.
30. As a Member, I want a borrowed machine in my Space's Environment selector and as a Project's preferred Environment, never as the default, so that I choose it deliberately.
31. As a borrower, I want my Space's work to run in its own Sandbox on that machine, isolated from other borrowers and from the owner's own work, so that other Spaces can't read it.
32. As a lender, I want to keep using my machine natively while it hosts borrowed Sandboxes, so that lending doesn't change how I work.
33. As a borrower, I want a Sandbox over its disk limit to refuse new turns with a clear error and delete nothing, so that I can clean up.
34. As a lender, I want to see each borrowed Sandbox's state and resource use, so that I know what my machine is doing.
35. As a borrower, I want a revoked or returned machine's Threads stopped, kept, and offered to move to another Environment, so that no history is lost.
36. As a lender, I want the borrowers' Sandboxes and files deleted from my machine when a Grant ends, so that nothing of theirs stays with me.

### Migración

37. As the Owner, I want today's allowances of AI accounts and Vaults to become active Grants on upgrade, so that nobody loses access.
38. As the Owner, I want a one-time list of what an allowance «to a User» lost by becoming a Grant to their Personal space, with a one-click way to lend it to those Organizations, so that I decide what widens.

### Clientes y agentes

39. As a User on web or desktop, I want «Lend…» from the resource, the User modal (Grants given), the Space modal (Grants received and waiting) and the command palette, so that every entry point leads there.
40. As an Admin on mobile, I want to see, accept, reject, return and revoke Grants and see their usage, so that I can decide on the go.
41. As an Admin, I want a badge on the Space when Grants wait for acceptance, on every client, so that I notice them.

## Implementation Decisions

### Modelo (una tabla)

- Migración nueva (número al implementar; las fases 2 y 3 se escriben en paralelo) `grants`:
  - `grant_id`, `resource_kind` (`environment` | `ai-account` | `vault-group`), `resource_id`;
  - `lender_kind` (`user` | `organization`), `lender_id`: el dueño del recurso al darlo (de `owned-resources`);
  - `target_kind` (`space` | `plan`), `target_id` (nulo solo en un enlace sin aplicar);
  - `state` (`offered` | `pending` | `active` | `rejected` | `cancelled` | `ended`), `end_reason` (`revoked` | `returned` | `resource-gone` | `target-gone` | `lender-gone` | `owner-changed`);
  - `limits_json`: unión decodificada con Schema en `packages/contracts/src/grants.ts` (`ai-account`: `{ tokens: { amount, period } | null, requests: { amount, period } | null }`; `environment`: `{ cpus, memoryBytes, diskBytes }`; `vault-group`: `{}`);
  - `offer_token_hash`, `offer_expires_at` (enlaces); `created_at/by`, `decided_at/by`, `ended_at/by`.
  - Índice único parcial: como mucho un Grant `pending` o `active` por (recurso, destino). Las filas terminadas se guardan: son el historial.
- **Un servicio `Grants`** (`apps/server/src/grants/Grants.ts`) con `give`, `createOffer`, `claimOffer`, `accept`, `reject`, `cancel`, `end` (revocar o devolver), `setLimits`, `listGiven`, `listReceived`. Las transiciones son una tabla probada; las demás se rechazan con un error tipado. Cada transición se audita y, en la misma transacción, llama a la pérdida de alcance de su tipo (`AiAccountReachLoss`, `VaultReachLoss`, liberación de Threads de la máquina).
- **Regla de lectura por tipo:** `AllowedAiAccounts` (`ai/AllowedAiAccounts.ts`), `VaultReach`/`EffectiveVaults` (`vaults/`) y `environment.use` (`auth/AccessPolicy.ts`) leen «propio del Space (owned-resources) ∪ Grants `active` a ese Space ∪ Grants a un Plan que alcancen al User (hook vacío hasta plans-and-limits)». Se evalúa en cada llamada, como hoy: terminar un Grant tiene efecto en la siguiente petición, turno o conexión. Cada recurso alcanzado lleva `via: own | grant(grantId)`; si es propio, gana `own` (sin tope).
- **Plan como destino:** existe en el esquema y en la política (solo el Owner, nace `active`), pero `Grants.give` lo rechaza con `plan-target-unavailable` hasta que `plans-and-limits` defina quién lo usa y dónde.

### Quién hace qué (`AccessPolicy`, tabla probada)

| Acción | Se decide sobre | Quién |
| --- | --- | --- |
| `grant.give`, `grant.offer`, `grant.setLimits`, `grant.revoke`, `grant.cancel` | el dueño del recurso | el User dueño; si es una Organization, sus Admins y su Steward. A un Plan: solo el Owner, y solo recursos que él puede prestar |
| `grant.decide` (aceptar, rechazar, aplicar un enlace), `grant.return` | el Space destino | Organization: sus Admins; Personal space: su dueño |
| `grant.viewGiven` | el dueño del recurso | los mismos que `grant.give` |
| `grant.viewReceived` | el Space destino | quien trabaja en él ve los `active`; los `pending` solo quien decide |

El Owner como operador no presta ni retira recursos ajenos y ve los Grants ajenos como consumo, no como contenido (decisión de privacidad del mapa).

### Enlaces de préstamo

- `grants.createOffer` devuelve una URL `<URL pública del Hub>/grants/offer/<token>` (AGENTS: enlaces hacia `T3CODE_PUBLIC_URL`, si no al origen actual). Un uso, 7 días, se guarda solo el hash; el prestador lo ve en «Préstamos dados» y lo puede cancelar.
- Al abrirlo, el receptor (con sesión) ve recurso, prestador, límites y avisos, y elige un Space donde tenga `grant.decide`. Aplicarlo es aceptar: el Grant nace `active`.

### AI accounts prestadas

- Solo se prestan las de tipo `subscription` y `api-key`. Las `direct` dan `not-lendable` (su credencial sale al agente y su uso no se cuenta).
- **Suscripciones:** el formulario de dar y el de aceptar muestran: «Los términos de <proveedor> prohíben compartir esta cuenta; puede ser suspendida» (ADR 0005, ADR 0010).
- **Atribución:** `GatewayRequestRecord` (`ai/AiGatewayActivity.ts`) gana `grantId`. `ai_usage` y `ai_usage_daily` (migración 114) ganan `grant_id`, que en `ai_usage_daily` entra en la clave primaria con `''` cuando el uso es propio. Ese cambio se hace con una migración que reconstruye la tabla.
- **Topes** (servicio `GrantCaps` en `ai/`, llamado en el paso 2 del enrutado de `ai/AiGateway.ts`):
  - Periodos de calendario en UTC, los mismos días de `ai_usage_daily`: día; semana ISO, que empieza el lunes; mes.
  - Tokens que cuentan: entrada + salida + escritura de caché. Las lecturas de caché se muestran, pero no cuentan (pregunta abierta 3).
  - Una petición con tokens desconocidos suma 0 tokens y 1 petición.
  - Se suma el resumen diario más los registros que aún no ha escrito el writer de `AiUsage`. El tope solo puede pasarse por las peticiones que ya estaban en curso al alcanzarlo, nunca por una nueva.
  - Un Grant agotado cuenta como «cuota agotada» de esa cuenta: hay failover a otra cuenta permitida del mismo proveedor y modelo (regla existente). Si no queda ninguna, error con la forma del cliente (429): «The AI account <name> lent to <Space> reached its <weekly> cap; it resets <date>. Switch AI account.»
  - Sin tope (`tokens: null`) es una elección explícita en el formulario. Los Grants migrados nacen sin tope.
- **Vistas:** `aiUsage.summary` (contrato `packages/contracts/src/aiUsage.ts`) gana el filtro y la dimensión `grantId` y el campo `estimatedUsd`. Visibilidad añadida en `AiUsage.summary`: quien puede `grant.viewGiven` ve las filas de sus Grants por Space y User prestatario, día y modelo, nunca Thread. El prestatario sigue viendo lo suyo; el Admin, lo de su Space (regla existente).
- **Precio:** `apps/server/src/ai/aiPrices.ts`, una tabla en el repo de entradas `{ provider, model (patrón), validFrom, input, output, cacheRead, cacheWrite }` en USD por millón de tokens. Cada día se valora con la entrada vigente ese día, así que un precio nuevo no reescribe el pasado. Se actualiza con las releases del Hub; nada se descarga (ADR 0007). Solo se aplica a `api-key`; un modelo sin entrada se muestra como «sin precio». No es un tope.
- **Suscripciones:** sin USD. Cuando el lector de cuotas (`usage/cliproxyApi.ts`, contra la gateway gestionada) da el porcentaje usado y el reinicio de una ventana, la parte del prestatario es (tokens del Grant en la ventana / tokens de la cuenta en la ventana) × porcentaje usado. Se muestra como aproximada.
- **Requisito previo:** el ticket `../ai-accounts-and-gateway/issues/16` (el uso no se ve) debe estar resuelto. Sin uso registrado no hay topes ni atribución.

### Vault groups prestados

- El grupo prestado aparece en el vault del Space prestatario como grupo enlazado («<grupo> · de Ana»): de solo lectura, elegible en los valores por defecto del Space y en las elecciones de Project (`vault.choose`), igual que un grupo propio. Dentro de los grupos del Space va detrás de los propios en el orden por defecto.
- `EffectiveVaults.forThread` lo lee en cada llamada: un cambio del prestador llega al siguiente turno, terminal o script. Variables visibles con su valor; Secrets solo con su nombre (ADR 0012), enmascarados en el historial como hoy (`SecretMasker`).
- Los nombres `dangerous` (`secretNameRisk`) de un grupo prestado no se entregan nunca. El panel «Secrets» del Thread los muestra como «no entregado: viene de un préstamo».
- **Dar:** «Los agentes de <Space> podrán leer los Secrets de este grupo: les llegan como variables de entorno» (ADR 0004).
- **Retirar:** «Los valores pueden haberse leído. Rota estos Secrets: …». La lista tiene «Reemplazar» en cada uno. `ThreadSecretValues` sigue enmascarando el historial pasado.
- Se pueden prestar a cualquier Space (mismo modelo para los tres tipos). El caso guiado es un grupo del vault personal hacia una Organization de la que eres Member.

### Máquinas prestadas (ADR 0011)

- Se prestan los External environments con dueño (`owned-resources`), nunca un Sandbox del Hub; la capacidad del Hub es cosa de `plans-and-limits`.
- **Alojar Sandboxes:** la máquina debe poder hacerlo, es decir, tener Podman rootless, la imagen del Sandbox y nada escuchando fuera de loopback (`sandboxes/hostExposure.ts`). La máquina lo informa (`sandboxHost: { ready, reason }`) en `/api/environments/self` y el Hub lo guarda. Si su último informe dice que no, dar el Grant se rechaza con el motivo. Si no se sabe, el Grant se crea y avisa de que la máquina aún no puede alojar el Sandbox.
- **Host:** `environments/DedicatedHost.ts` pasa a ser un host de Sandboxes que corre junto al servidor de cualquier máquina joined, también la personal: el dueño sigue trabajando de forma nativa (ADR 0011). `/api/environments/self` responde una lista `sandboxes: [{ spaceId, grantId, limits, credential }]` en vez de un solo `spaceId` (contrato `EnvironmentSelfResult`). Incluye el Space propio de una máquina de Organization y cada Grant `active`. El host mantiene un Sandbox por Space (`dedicated-<S>` ya es por Space) y borra el home de cualquier Space que deje de estar en la lista.
- **En el Hub:** cada Sandbox prestado es un Environment propio (`kind = 'sandbox'`, `mode = 'lent'`, `space_id` del prestatario, `grant_id`, `host_environment_id` de la máquina), con una credencial suya como `dedicated_sandbox_credentials` (migración 107), válida solo para ese Space. Hay que alinear la forma con lo que `owned-resources` haga de las máquinas dedicadas.
- **Límites:** CPU y memoria del Grant, recortadas a la máquina (`fitLimitsToHost`), y aplicadas en el siguiente arranque del Sandbox. Se permite sobrecomprometer, pero el formulario avisa si la suma de los Grants de memoria o disco supera la capacidad de la máquina. Disco: el host mide el home de cada Sandbox prestado y lo informa. Por encima del límite, el Hub rechaza turnos nuevos en ese Sandbox con un error claro y no borra nada (como las cuotas del Hub).
- **Uso:** `environment.use` para los Admins y Members del Space prestatario (no Guests), como una dedicada. Se ofrece en el selector y como Environment preferido de Projects de ese Space, nunca por defecto (`previewThreadPlacement`). No se para por inactividad, igual que una dedicada (pregunta abierta 6).
- **Aviso al aceptar y distintivo permanente:** «<Prestador> controla esta máquina y puede ver todo lo que corre en ella: archivos, procesos, los Secrets que reciban los turnos y la clave de la gateway de cada Thread.»
- **Retirar o devolver:** el Hub deja de aceptar turnos en ese Sandbox, interrumpe los que corren (su checkpoint se sube como en cualquier interrupción, con espera máxima de 2 minutos) y anula la credencial. Si la máquina está apagada, la anula al momento. Los Threads cuyo Active environment era ese Sandbox pasan a «needs an environment» (estado `released` existente). La vista del Grant ofrece «Mover» por Thread y «Mover todos» al Sandbox del Space, con el movimiento de `../hub-thread-store/issues/08` desde el último checkpoint subido. El host borra el home en su siguiente consulta a `/self`.
- El prestador ve en cada Grant de máquina el estado del Sandbox y su CPU, memoria y disco (`resourceTelemetry`), nunca sus Threads.

### Fin automático

- Recurso borrado o que cambia de dueño → `resource-gone` / `owner-changed`.
- Space destino borrado → `target-gone`. Archivado → el Grant sigue `active` y no se usa, porque archivar es reversible.
- Prestador borrado (borrado de cuenta de `platform-privacy`, o Organization borrada) → `lender-gone`.
- Que el prestador deje la Organization destino no termina un Grant: lo puede retirar él y lo puede devolver el destino.
- Todo dentro de la transacción del borrado que lo causa, con el mismo paso de pérdida de alcance que «Retirar».

### Migración de las allowances

- Una migración convierte `ai_account_allowances` y `vault_allowances` en Grants `active` del Owner, sin tope, con `created_by` el Owner y auditoría `grant.give` con vía `migration`. Después borra las tablas. `aiAccounts.allow` y `vaults.allow` desaparecen de RPCs, UI y `RPC_SPACE_ACCESS`.
  - Allowance al Personal space del Owner → nada: el recurso ya es suyo.
  - Allowance a un Space → Grant a ese Space.
  - Allowance a un User → Grant a su Personal space. **Con pérdida:** antes valía en cualquier Space donde trabajase. La migración guarda, para el Owner, una lista de (recurso, User, Organizations donde ese User lo usó en los últimos 90 días según `ai_usage`, o Organizations de las que es Member en el caso de un Vault). Platform → «Revisar préstamos migrados» la muestra con «Prestar a <Organization>», que para las Organizations que pasan al Owner como Steward nace activo. Ver pregunta abierta 1.
  - Un Vault con allowances se convierte en el grupo o los grupos que defina `owned-resources`: un Grant por grupo.

### Puertas

| Puerta | Qué se declara |
| --- | --- |
| WS (`RPC_SPACE_ACCESS`, `auth/RpcSpaceAccess.ts`) | `grants.listGiven`, `grants.listReceived`, `grants.give`, `grants.createOffer`, `grants.readOffer`, `grants.claimOffer`, `grants.accept`, `grants.reject`, `grants.cancel`, `grants.end`, `grants.setLimits`; `aiUsage.summary` con `grantId`. Comandos de cliente con `createEnvironmentRpcCommand` y `CLIENT_GUARDED_RPC_SCOPES` |
| HttpApi / raw routes (`DoorRules.ts`) | `/api/environments/self` cambia su respuesta (lista de Sandboxes); `/api/ai/*` aplica topes. Nada nuevo |
| MCP (`MCP_TOOL_RULES`) | ninguna herramienta: dar, aceptar y retirar son decisiones de confianza con avisos, de una persona (pregunta abierta 5). Ninguna herramienta existente devuelve Grants ajenos |
| Executor wire | el Sandbox prestado solo recibe trabajo de Threads de su Space (`boundSpaceOf`, como las dedicadas) |
| Logs, OTLP | sin tokens de enlace ni credenciales de Sandbox |

### Clientes

- **Web y desktop:** modal de Usuario → «Préstamos dados» (todos sus Grants y los de las Organizations que dirige, con uso y acciones). Modal de Space → «Prestado a este Space» y «Por aceptar». «Prestar…» en la fila de cada AI account, Vault group y máquina. Página del enlace de préstamo. Paleta: «Prestar un recurso…», «Préstamos por aceptar», «Préstamos dados»; sin atajo por defecto nuevo. Si `../settings-modals/` no ha llegado, las mismas pantallas van en las secciones equivalentes de Settings y se mueven con los modales.
- **Selector de AI account:** cuentas prestadas con «de <prestador>» y la parte del tope usada.
- **Selector de Environment:** máquinas prestadas con el distintivo de aviso.
- **Móvil:** listas, aceptar, rechazar, devolver, retirar, uso y enlace de préstamo (aplicarlo). Dar un Grant con límites queda en web y desktop.
- **Pendientes:** contador junto al Space en el selector de Spaces, para quien puede decidir, en web, desktop y móvil. Llega por el stream de Spaces de `packages/client-runtime/src/spaces/`.
- **Modos de conexión:** nada local. Los enlaces usan la URL pública del Hub y las máquinas prestadas se conectan como cualquier joined (LAN, Tailscale, SSH).

### Auditoría

- Nuevas en la allow-list (`packages/contracts/src/audit.ts`, etiquetas en `packages/client-runtime/src/spaces/spaceDirectory.ts`): `grant.give`, `grant.offer`, `grant.accept`, `grant.reject`, `grant.cancel`, `grant.end` (con `reason` y lado), `grant.limits.change`. `ai_account.allow` y `vault.allow` se quedan solo para leer el historial.
- Detalle permitido: tipo e id del recurso y su nombre, prestador, destino, límites. Nunca tokens de enlace ni valores.

### Documentación

- `docs/internals/grants.md`: la regla única de alcance, la tabla de transiciones y por qué existen los enlaces. Secciones reescritas en `ai-gateway.md` (topes y atribución), `secrets.md` (grupos prestados, nombres `dangerous`) y `sandboxes.md` (host con varios Spaces).
- `docs/user/`: una sección «Lending resources» que explique qué se presta, cómo se acepta, qué ve el dueño de una máquina y los términos de las suscripciones.

## Testing Decisions

- **Un test bueno** comprueba lo que ve un prestador, un prestatario o el Owner por interfaces públicas: RPC, gateway, `/self`, conjunto efectivo. Red-first en reglas de acceso, topes y migraciones.
- **Seams:**
  - `Grants` con su tabla de transiciones: cada transición ilegal se rechaza.
  - `AccessPolicy` (tabla de la sección «Quién hace qué»).
  - `AllowedAiAccounts` y `EffectiveVaults` con Grants activos, pendientes y terminados.
  - Topes con el CLIProxyAPI falso de `ai/AiGateway.testkit.ts`: periodo, failover y error 429 en las tres formas.
  - `AiUsage.summary` para prestador, prestatario, Admin y Owner.
  - Valoración en USD con dos versiones de precio.
  - Migraciones (allowances → Grants, `grant_id` en el uso) con el patrón de `118_AiAccountReachLoss.test.ts`.
- **Máquinas:** el testkit «Hub con Environments» (`environments/HubWithEnvironments.testkit.ts`) con el runtime process, como `HubWithEnvironments.dedicated.test.ts`: una máquina personal con dos Spaces prestatarios, credenciales limitadas a cada Space, retirada con turno en marcha, Threads liberados y movidos. El grupo Podman (`sandboxes/PodmanSandboxRuntime.test.ts`) añade dos Sandboxes prestados en un host: no se leen entre sí ni leen el home del dueño.
- Sin esperas ni sondeos: drenar el effect worker o esperar el evento persistido (AGENTS).
- **Prior art:** `AiGateway.test.ts`, `AiUsage.test.ts`, `VaultReachLoss.test.ts`, `HubWithEnvironments.aiRemovals.test.ts`, `DoorRules.test.ts`, `vaults/VaultDoors.test.ts`.
- **Prueba real por ticket de interfaz:** Hub de desarrollo con datos copiados (nunca `~/.t3/userdata`), Ana (User) y Acme (Organization): Ana presta una API key con tope bajo, Acme acepta, un turno lo agota y falla con el mensaje; para máquinas, en WSL con Podman, el Replay provider en el Sandbox prestado.

## Out of Scope

- Quién usa un Grant a un Plan y dónde: `../plans-and-limits/`.
- Topes en dinero, facturación entre Users y cobro por préstamo: `../billing/`.
- Topes por User dentro del Space prestatario (pregunta abierta 4).
- Secrets que solo usa un proceso y el agente no ve (proxy de credenciales): fuera del mapa.
- Prestar capacidad de Sandbox del servidor del Hub: límites de plan.
- Re-prestar un recurso prestado: un prestatario no lo puede prestar a otro.

## Further Notes

- **Riesgos:** el dueño de una máquina prestada puede leer los Secrets y las gateway keys de los turnos que corren en ella. El aviso lo dice, y las gateway keys de Thread rotan en cada apertura de sesión (spec 4). Las suscripciones prestadas pueden suspenderse (ADR 0005).
- **Orden sugerido:** 01 → 02 → 03 → 04 → 05; 06 y 07 tras 01; 08 → 09 → 10; 11 tras 02, 07 y 10; 12 y 13 al final.

## Preguntas abiertas

1. **Allowances «a un User» dentro de una Organization.** Hoy una AI account o un Vault permitidos a Ana valen en cualquier Space donde trabaje. Pasarlos a un Grant a su Personal space los estrecha; prestarlos a cada Organization suya los ensancha a todos sus Members. Recomendación: estrechar, y que el Owner ensanche desde la lista de «Revisar préstamos migrados» con un clic. La alternativa (un destino «User en un Space») contradice la decisión transversal de no prestar a Users sueltos.
2. **Enlaces de préstamo.** Sin ellos no se puede prestar a un Space del que no eres miembro sin exponer un directorio. Recomendación: enlaces de un uso y 7 días, como las Invitations de plataforma.
3. **Qué tokens cuentan para el tope.** Recomendación: entrada + salida + escritura de caché. Las lecturas de caché de Claude Code son enormes y harían los topes difíciles de razonar. Alternativa: contarlas al 10 %, como su precio.
4. **Topes por User dentro del Space prestatario.** Recomendación: no en esta fase, porque el tope es del Grant entero. Un Admin que quiera repartir pide Grants a Personal spaces.
5. **Herramientas MCP para agentes.** Recomendación: ninguna para dar, aceptar o retirar (son decisiones de confianza con avisos). El agente se entera de un tope agotado por el error de la gateway.
6. **Parada por inactividad de los Sandboxes prestados.** El host no recibe órdenes del Hub: solo pregunta a `/self`. Recomendación: sin parada, como las dedicadas; los límites acotan lo que cuestan.
7. **Factor fuerte para dar o aceptar un Grant de máquina.** Recomendación: no. Ninguna credencial sale y retirar es inmediato. Si el Owner lo quiere, solo al dar Grants de máquina, por HttpApi como `confirmStrongFactor`.
8. **Caducidad de los Grants pendientes.** Recomendación: no caducan; el prestador los cancela. Los enlaces sí caducan (7 días).
9. **Zona horaria de los periodos.** Recomendación: UTC, la de `ai_usage_daily`; la UI muestra la hora local del reinicio.
