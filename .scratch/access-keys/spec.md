# Spec: Claves de acceso (access keys)

Status: needs-triage
Decisiones de origen: decisiones del Owner del 2026-11-23 (abajo)
ADRs: 0005 (suscripciones compartidas por la AI gateway del Hub, riesgo de ToS aceptado), 0007 (sin servicios de upstream), 0010 (Grants)
Vocabulario: `GLOSSARY.md` gana **Access key** (clave de acceso): una clave de la AI gateway que un Space da a alguien, tenga o no cuenta en el Hub, con modelos, validez y topes propios. No es un User ni actúa como uno.
Depende de: `../ai-accounts-and-gateway/` (gateway, gateway keys, uso; tickets 04, 05, 10 y 16 hechos), `../grants/` (topes por Grant, ticket 03, y su contabilidad de tokens, ticket 14), `../owned-resources/` (AI accounts de un User o de una Organization)
Se cruza con: `../plans-and-limits/` (cuota de tráfico del Hub por Space, ticket 09)

## Decisiones del Owner (2026-11-23)

1. **Quien recibe la clave puede no tener cuenta en el Hub.** Hay gente que no quiere usar la UI del Hub y solo pega la configuración en su propio agente. La clave es de un Space y su uso cuenta ahí. Un User del Hub también puede recibir una.
2. **Por clave:** modelos permitidos (lista, con patrones como `claude-sonnet-*`), validez (N días o hasta una fecha; caduca sola) y topes de tokens: un total para toda la validez **y/o** topes por día, semana o mes (se pueden combinar).
3. **Sin límite de peticiones por minuto** por clave (no se quiere).
4. **UI:** Space settings → AI accounts → «Access keys»: crear (nombre del destinatario, modelos, validez, topes, a qué AI accounts del Space llega: por defecto todas las del Space), mostrar la clave una vez con **Copy setup** (Claude Code `settings.json`, Codex `config.toml` y una base URL genérica compatible con OpenAI), lista con uso, lo que queda, caducidad y último uso, **Revoke**, **Renew/extend** y **subir topes**. Con un tope alcanzado o la clave caducada, el cliente recibe un error claro en la forma de su API («This access key reached its monthly token limit», «This access key expired on …»).

## Problem Statement

Hoy solo dos tipos de gateway key llegan a `/api/ai/*` (`ai_gateway_keys`, migración 113): la de Thread, que el Hub da al agente de un turno, y la de User, que cada User crea para su CLI local en un Space donde trabaja (spec 4 ticket 10). Las dos actúan **como un User**: `AiGatewayKeys.authorize` exige un User activo que trabaje en el Space y aplica `AllowedAiAccounts.for(User, Space)`.

El Owner y los Admins quieren dar acceso a las AI accounts de un Space a personas que no son Users (un colaborador externo, alguien que prueba, alguien que solo quiere su Claude Code de siempre), o a Users sin meterlos en ese Space. Para eso hoy tendrían que invitarlos al Space (con acceso a Projects, Threads y Vaults) o compartir una credencial real del proveedor. Y una clave de User no tiene límites: ni modelos, ni caducidad, ni topes; solo los Grants tienen topes, y los Grants son entre Spaces.

## Solution

- Una **access key** es una gateway key del **Space**, no de un User: `t3ak_` + 32 bytes aleatorios, guardada solo como SHA-256, mostrada una vez.
- La emiten quienes gestionan el Space: los Admins de una Organization y el Owner; en un Personal space, su User (pregunta abierta 2). La ven y revocan esos mismos y, siempre, el Owner.
- Cada clave lleva: etiqueta del destinatario, Space, quién la emitió, modelos permitidos, AI accounts que alcanza (todas las propias del Space por defecto), caducidad y topes de tokens (total y/o por día, semana y mes).
- La gateway la trata como una clave más en `/api/ai/*` (formas Anthropic, OpenAI y Gemini): en cada petición comprueba la clave, la caducidad, el Space, las cuentas, el modelo y los topes, en ese orden, y responde en la forma del cliente con un mensaje que dice qué pasó y, si vuelve, cuándo.
- El uso queda en `ai_usage` con la clave como sujeto (sin User) y se ve en Settings → AI accounts → Usage y en la lista de claves, a quien gestiona el Space.
- Se renuevan, se amplían, se cambian sus topes, modelos y cuentas, y se revocan. Todo queda en la auditoría.

## User Stories

### Emitir y repartir

1. As an Admin of an Organization, I want to create an access key for someone who has no Hub account, with their name as its label, so that they use our Space's AI accounts from their own agent without joining the Space.
2. As the Owner, I want to create access keys in any Organization and in my own Personal space, so that I can give access wherever I manage the AI accounts.
3. As a User, I want to create access keys in my own Personal space for my own AI accounts, so that I can share them with a friend under my own limits (pregunta abierta 2).
4. As an issuer, I want the key shown only once, with «Copy setup» for Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/config.toml` and the shell line) and any Anthropic- or OpenAI-compatible client (base URLs and the key), so that the recipient only pastes it.
5. As an issuer, I want the Claude Code setup to pin its model aliases (Opus, Sonnet, Haiku and the background model) to models the key may use, so that the recipient's agent never asks for a model the key refuses.
6. As an issuer, I want to be warned when the key reaches a subscription account, so that I know an outsider will consume my subscription (ADR 0005).

### Límites de cada clave

7. As an issuer, I want to choose which models the key may use, from the models the Space's accounts serve or as patterns like `claude-sonnet-*`, or explicitly «All models», so that the recipient uses only what I allow.
8. As an issuer, I want to choose which of the Space's AI accounts the key reaches, all by default, so that I can keep an account out of it.
9. As an issuer, I want the key to be valid for N days or until a date, and to stop by itself after, so that I never forget a key open.
10. As an issuer, I want a total token cap for the whole validity, and/or caps per day, ISO week or month, so that I bound what the recipient spends.
11. As an issuer, I want the form to require at least one token cap unless I explicitly choose «No token limit», so that an uncapped key is a decision, never a default.
12. As the Owner, I want no requests-per-minute limit per key, so that limits stay about tokens and time (decisión 3).

### Lo que ve quien tiene la clave

13. As a recipient, I want `/v1/models` to list only the models my key may use, so that my client offers only what works.
14. As a recipient, I want a clear error in my client's API shape when my key expired («This access key expired on 2026-12-01 18:00 UTC»), reached a cap («This access key reached its daily token limit; it resets 2026-11-24 00:00 UTC»), asks for a model it may not use (naming the allowed ones), or was revoked, so that I know what happened and whom to ask.
15. As a recipient, I want my client not to retry for hours a request that cannot succeed until a cap resets, so that it fails fast and tells me.
16. As a recipient without a Hub account, I want to check with my key what it allows, until when, and how much is left (pregunta abierta 5), so that I don't have to ask the issuer.

### Gestionar

17. As an issuer, I want the list of the Space's access keys with label, models, accounts, expiry, last use, and for each cap the used, remaining and reset, so that I see at a glance who spends what.
18. As an issuer, I want to renew or extend a key (also an expired one), so that the recipient keeps the same setup.
19. As an issuer, I want to raise or lower caps and change models, accounts and label, effective from the next request, so that I adjust without a new key.
20. As an issuer, I want to revoke a key, effective from the next request, so that a leaked or unneeded key stops at once.
21. As the Owner, I want to see and revoke every access key in every Space, so that I can stop any key on the Installation.
22. As an Admin, I want an access key to keep working when its issuer leaves the Organization or stops being Admin, since it belongs to the Space, so that the recipient is not cut off by a role change.

### Uso y auditoría

23. As an issuer, I want the access keys' usage in Settings → AI accounts → Usage as «Access key: <label>» beside Users, so that I see all of the Space's consumption in one place.
24. As the Owner, I want every create, change and revoke of an access key in the audit log, never with the key, so that I can trace who gave access to whom.

### Ciclo de vida

25. As an issuer, I want a Space's keys refused while it is archived or frozen and working again when it is restored (unless expired), so that archiving is reversible.
26. As the Owner, I want a deleted Space's keys revoked in the deletion itself, so that nothing outlives it.
27. As an issuer, I want an account that the Space no longer has (disabled, deleted, gone to another owner) to drop out of every key at once, and a key left with no account to say so, so that a key never reaches more than the Space has.

### Clientes

28. As an issuer on mobile, I want to see the Space's access keys with usage and expiry, and revoke one, so that I can stop a key on the go; creating and editing stay on web and desktop.

## Implementation Decisions

### Qué es una access key

- **Una gateway key más, de un Space:** `GatewayCaller.kind` gana `access`. No tiene User: `authorize` nunca exige que alguien trabaje en el Space; quien la tiene actúa en nombre del Space, con los límites de la clave. Un User del Hub que recibe una no la usa «como él»: su uso cuenta en la clave, no en su User.
- **Tabla propia** `ai_access_keys` (migración, número al integrar; hoy la siguiente libre es la 159), no `ai_gateway_keys`: esa tiene `user_id NOT NULL` y `CHECK (kind IN ('thread','user'))`, cambiarlo pide reconstruir una tabla caliente, y una access key lleva datos que las otras no tienen. Columnas:
  - `key_id` (`ak_<24 hex>`), `key_hash` (SHA-256 hex, `UNIQUE`), `key_hint` (los 4 últimos caracteres, para reconocerla en la lista), `space_id`, `label` (hasta 80 caracteres), `created_by` (User que la emitió), `created_at`;
  - `models_json` (lista de modelos o patrones; `["*"]` = todos), `accounts_json` (`null` = todas las cuentas propias del Space, ahora y las que vengan; si no, lista de ids);
  - `expires_at` (instante UTC, obligatorio), `limits_json` (`AccessKeyLimits`, abajo);
  - `last_used_at` (escrito como mucho una vez por minuto, como las gateway keys), `revoked_at`, `revoked_reason`, `revoked_by`, `updated_at`.
- **Formato** `t3ak_` + 32 bytes base64url (43 caracteres). Un prefijo propio, distinto de `t3gk_`, para que una clave filtrada se reconozca y para que `authorize` sepa en qué tabla buscar sin leer las dos. `isGatewayKeyShaped` acepta los dos prefijos.
- **Solo hash:** la clave existe en claro solo en la respuesta de `accessKeys.create` (Redacted en los dos extremos del cable). SHA-256 sin sal, como las gateway keys y los enlaces de préstamo: con 256 bits aleatorios no hay diccionario que valga.
- **Límite:** 50 claves vivas (ni revocadas ni caducadas hace más de 30 días) por Space; la 51 se rechaza con «This Space has 50 access keys. Revoke one to make another.».

### Quién hace qué (`AccessPolicy`)

- Nueva acción `accessKey.manage` sobre un Space:
  - **Organization abierta** (ni archivada ni congelada): sus Admins y el Owner, como `aiAccount.manage` de las cuentas de una Organization.
  - **Personal space:** su User (también el Owner en el suyo). El Owner **no** emite ni cambia claves en el Personal space de otro User: esas cuentas son de ese User (owned-resources, Grants: el Owner no tiene bypass). Pregunta abierta 2.
- Nueva acción `accessKey.view` / revocar: quien tiene `accessKey.manage` y, en cualquier Space, el Owner (como hoy ve y revoca todas las Local CLI keys). Revocar en un Space archivado o congelado está permitido; crear y cambiar, no.
- Las puertas solo responden a la sesión de una persona: un agente (MCP, `via: agent`), el shell del Hub o una sesión limitada a un Space reciben `forbidden`, como `aiGatewayKeys.*`. Ningún agente emite, lista ni revoca claves.
- Un Member, un Guest o alguien de fuera ven como `not-found` una clave que no gestionan.

### Modelos permitidos

- **Entradas:** un nombre exacto o un prefijo con un solo `*` final (`claude-sonnet-*`); `*` solo = «All models», que el formulario ofrece como opción explícita. Entre 1 y 50 entradas, cada una hasta 256 caracteres, sin espacios ni caracteres de control. Una lista vacía se rechaza.
- **Comparación** (`accessKeyModelAllowed`, pura, en `gatewayShapes.ts` o junto a ella): sin distinguir mayúsculas; el modelo pedido se compara sin el prefijo `acct-<id>/` (la cuenta fijada la decide la regla de cuentas) y sin un sufijo final entre corchetes como `[1m]` (solo para comparar: aguas arriba va tal cual). Un nombre exacto solo admite ese nombre: para incluir las versiones fechadas (`<nombre>-20261001`) se usa un patrón. Así el emisor ve exactamente lo que permite.
- **Sin alias en el Hub:** la gateway nunca traduce `sonnet`, `opus` o `haiku` ni cambia un modelo por otro (decisión de spec 4: nunca un cambio de modelo silencioso). Por eso «Copy setup» de Claude Code fija en `env` `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` y `ANTHROPIC_DEFAULT_HAIKU_MODEL` a modelos que la clave permite y alguna de sus cuentas sirve (el de la familia si existe, si no el primero permitido): el modelo de fondo de Claude Code (Haiku) deja de pedir algo que se rechazaría. Codex recibe `model = "<permitido>"`. La prueba real confirma los nombres de variables con las versiones del momento.
- **Orden de la comprobación:** el modelo se mira antes de planear la ruta: uno no permitido es 403 sin llegar a ninguna cuenta («This access key may not use claude-opus-5-5. It may use: claude-sonnet-5-5, claude-haiku-5-5.», como mucho 10 nombres y «…»). Permitido pero sin cuenta que lo sirva: el 404 de hoy de `planRoute`.
- **`/v1/models`** (las tres formas): la intersección de lo que sirven las cuentas que alcanza la clave con la lista permitida. Un patrón se expande contra los catálogos; nunca aparece como nombre.

### AI accounts que alcanza

- **Las del Space:** `AllowedAiAccounts` gana `forSpace(spaceId)`: la misma consulta que `accountsIn` para un Space, sin la condición de que un User trabaje ahí. Solo cuentas de gateway (`api-key`, `subscription`), nunca `direct`: una credencial directa iría al agente de quien recibe la clave.
- **Solo las propias del Space** (`via: own`) en esta versión. Las prestadas por un Grant quedan fuera: quien prestó lo hizo a un Space y sus Members, no a gente de fuera, y una clave no puede ampliar ese consentimiento. Ticket 09 (pregunta abierta 1) deja que el prestador lo permita en cada Grant.
- `accounts_json = null`: todas las propias del Space, evaluadas en cada petición (una cuenta nueva del Space entra sola). Una lista: su intersección con `forSpace` en cada petición; una cuenta que el Space ya no tiene (deshabilitada, borrada, pasada a otro dueño) deja de contar sin tocar la fila, y el formulario la muestra tachada con «No longer in this Space».
- **Ninguna cuenta disponible:** 403 «No AI account this access key may use is available now.».
- **Enrutado:** el de una clave de User (`planRoute` con `keyKind: "user"`): `acct-<id>/<modelo>` fija una cuenta solo si la clave la alcanza (si no, 403); si no, la primera, en el orden del Space, que sirva el modelo; failover dentro del mismo proveedor solo entre las que alcanza la clave.

### Validez

- **Al crear:** «Valid for N days» (1 a 366; `expires_at = ahora + N × 24 h`) o «Valid until <fecha>» (el final de ese día en la zona horaria del navegador del emisor, guardado como instante UTC; como mucho 366 días desde ahora). Sin «nunca caduca».
- **En cada petición:** `authorize` compara `expires_at` con la hora del Hub. Una petición admitida antes de caducar termina; la siguiente se rechaza. Una clave caducada no se revoca: se puede renovar.
- **Renovar/extender:** una nueva `expires_at`, con el mismo tope de 366 días desde el momento del cambio. Vale para una clave caducada; nunca para una revocada (revocar es para siempre: se hace otra).
- La lista muestra «Expires in 3 days» o «Expired on …» en hora local, con la hora UTC al pasar el ratón.

### Topes de tokens

- **Forma** (`AccessKeyLimits` en `packages/contracts`): `{ total: number | null, day: number | null, week: number | null, month: number | null }`, enteros positivos hasta 10¹²; cualquier combinación. Todo `null` solo con la elección explícita «No token limit» (`unlimited: true` en la entrada del RPC), igual que el formulario de los Grants exige un tope salvo «Sin tope».
- **Qué cuenta** (igual que los Grants, docs/internals/ai-gateway.md «Caps of lent AI accounts», y por la misma razón): entrada no leída de caché + salida + escrituras de caché, con `uncachedInputOf` por forma (Anthropic: `input_tokens` tal cual; OpenAI y Gemini: `max(0, entrada − lecturas de caché)`). Las lecturas de caché se muestran pero no cuentan: las de Claude Code son enormes y baratas, y con ellas un tope no significaría nada. Un solo significado de «tokens» en todo el Hub: los topes de Grants, los de claves y el coste estimado leen la misma fórmula.
- **Periodos:** días, semanas ISO (desde el lunes) y meses naturales **UTC**, los de `ai_usage_daily` y los de los Grants (`GrantCaps.periodOf`, que se reutiliza). La UI muestra el reinicio en hora local; el mensaje de error, en UTC.
- **Total:** todo lo que la clave usó desde que se creó, renovaciones incluidas. Renovar no lo pone a cero: para dar más, se sube el total (lo que el emisor ve al renovar: «Used 8.1M of 10M total»).
- **Usado** = filas de `ai_usage_daily` de la clave (columna `access_key_id`, abajo) del periodo + lo que `AiGatewayActivity` registró y el writer aún no escribió (`unwritten`, hoy por Grant; pasa a ser por sujeto de tope: `grant:<id>` o `access-key:<id>`), así que un tope nunca cuenta de menos.
- **Respuestas sin uso conocido** (cortadas antes del último evento, o sin `usage`): para una access key cuentan con una **estimación**, nunca 0: el mayor entre lo que el tap llegó a leer (p. ej. la entrada de `message_start` de Anthropic) y `ceil(bytes del cuerpo de la petición / 4)` de entrada + `ceil(bytes de respuesta entregados / 4)` de salida. Sin esto, alguien de fuera podría cortar cada respuesta justo antes del evento final (donde OpenAI y Anthropic ponen la salida) y nunca gastar tope. La estimación se guarda aparte (`estimated_tokens` en `ai_usage_daily`), la petición sigue contando como `unknown_requests` y el uso la muestra como «≈». Los Grants siguen contando 0 (pregunta abierta 4). Una petición fallida (estado ≥ 400) no lleva tokens; una rechazada por el Hub (carga, tope, modelo) no llegó a ninguna cuenta y no cuenta nada.
- **Cuándo se mira:** al empezar cada petición, después del modelo y de las cuentas, nunca a mitad de respuesta. Una petición admitida por debajo del tope termina y cuenta entera: solo las que ya estaban en curso cuando se alcanzó pueden pasarlo. Ese exceso lo acota solo el límite general de peticiones en curso que ya tiene cada gateway key (16): las access keys no tienen uno propio (pregunta abierta 3, decidida: sin límite propio). Bajar un tope por debajo de lo usado rechaza la siguiente.
- **Un tope de clave y un tope de Grant son independientes:** cuando una clave llegue a cuentas prestadas (ticket 09), una petición tiene que caber en los dos.

### Lo que recibe el cliente

Siempre en la forma de la ruta (`errorBody`, como hoy), con el estado de abajo; nunca el nombre de otra clave, ni el uso de nadie más, ni el Space si la clave es desconocida.

| Caso                                              | Estado | Mensaje                                                                                                                                        | Además                                                                                   |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Clave desconocida o revocada                      | 401    | el de hoy («This AI gateway key is not valid. It may have been revoked or expired.»)                                                           | revocada y desconocida no se distinguen                                                  |
| Caducada                                          | 403    | «This access key expired on 2026-12-01 18:00 UTC. Ask whoever gave it to you to renew it.»                                                      | 403 y no 401: un 401 hace que Claude Code pida `/login` y oculte el motivo               |
| Space archivado o congelado                       | 403    | «This access key's Space is archived. It works again if the Space is restored.»                                                                 |                                                                                          |
| Modelo no permitido                               | 403    | «This access key may not use <modelo>. It may use: …»                                                                                           | Anthropic `permission_error`, OpenAI `code: "model_not_allowed"`, Gemini `PERMISSION_DENIED` |
| Sin cuenta disponible                             | 403    | «No AI account this access key may use is available now.»                                                                                       |                                                                                          |
| Tope total alcanzado                              | 403    | «This access key used its total token limit (10,000,000). Ask whoever gave it to you to raise it.»                                              | no vuelve solo                                                                           |
| Tope por periodo alcanzado                        | 429    | «This access key reached its daily token limit (2,000,000); it resets 2026-11-24 00:00 UTC.» (`weekly`, `monthly`)                              | `retry-after` (segundos hasta el reinicio), `x-should-retry: false`, OpenAI `code: "insufficient_quota"` |
| Demasiadas peticiones en curso de la clave        | 429    | el de hoy («Too many requests to the AI gateway at once. Try again.»)                                                                           | este sí se reintenta                                                                      |

- `x-should-retry: false` lo respetan los SDK de Anthropic y OpenAI (Claude Code usa el primero); `insufficient_quota` es el código que Codex trata como cuota agotada sin reintentar. La prueba real (ticket 11) comprueba con Claude Code y Codex que el mensaje se muestra y que no reintentan; si un cliente no lo respeta, se documenta.
- Varias condiciones a la vez: gana la primera de la tabla (de arriba abajo), y entre topes, el total antes que el mes, la semana y el día.

### `authorize` y el resto de la puerta

- `AiGatewayKeys.authorize` sigue siendo la única regla de `/api/ai/*`: con el prefijo `t3ak_` lee `ai_access_keys` (una consulta: la clave y su Space, con `archived_at`, `frozen_at` y si existe) y decide revocada → caducada → Space → cuentas (`forSpace` ∩ `accounts_json`, solo de gateway). Devuelve un `GatewayCaller` con `kind: "access"`, `userId: null`, `accessKeyId`, `spaceId`, `threadId: null`, `allowed` y los límites de la clave (modelos, topes).
- `AiGatewayProxy.forward` aplica modelo y topes antes de `planRoute` (el modelo) y antes de cada envío (los topes, junto a los de Grant), y usa como sujeto de sus colas `ak:<keyId>` donde hoy usa el User (`readersPerUser`, `perUser`); el total del Hub no cambia. `GatewayRequestRecord` gana `accessKeyId` y lleva `userId: null`.
- Nada más cambia en la puerta: solo cabeceras (nunca la clave en la URL, que ya se rechaza), sin cookies, sin span HTTP de `/api/ai/*`, mismo tamaño de cuerpo y plazos.
- **Fuerza bruta:** 256 bits aleatorios; una clave con forma incorrecta se rechaza sin leer la base y una con forma correcta cuesta una búsqueda por índice único, antes de leer ningún cuerpo. No se añade un freno por dirección: no protegería nada que la entropía no proteja ya, y castigaría a un Hub detrás de un proxy. Los 401 se registran (método, ruta, estado) como hoy, sin la clave.

### Uso

- `ai_usage`: `user_id = ''` y `key_id` = el `ak_…` de la clave (las filas de Thread y de User no cambian). Nueva columna `access_key_id` (NULL salvo access keys) para que las lecturas no dependan del prefijo del id.
- `ai_usage_daily` se reconstruye (como la migración 146) con `access_key_id TEXT NOT NULL DEFAULT ''` en la clave primaria y `estimated_tokens INTEGER NOT NULL DEFAULT 0`, más un índice parcial `(access_key_id, day) WHERE access_key_id <> ''` para los topes. Las filas existentes quedan con `''`. Migración con test y golden, número al integrar.
- **Quién lo ve** (`AiUsage.summary`): además de las reglas de hoy, quien tiene `accessKey.view` en el Space ve las filas de sus access keys (así el User de un Personal space ve las de sus claves aunque `aiUsage.viewSpace` se lo niegue para el resto). En la vista, cada clave aparece como sujeto «Access key: <label>» junto a los Users, con un filtro por clave. Un Member que no gestiona el Space no ve las filas de sus claves.
- **En la lista de claves:** por cada tope, usado, lo que queda y el reinicio (de la misma comprobación que la gateway, como el selector muestra los topes de un Grant); también lecturas de caché y peticiones sin uso conocido, dichas, nunca como cero.
- El coste estimado (`aiPrices.ts`) se muestra por clave igual que por User; nunca es un tope (fuera de alcance).

### Ciclo de vida

| Qué pasa                                                    | La clave                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Caduca                                                      | rechazada (403 con la fecha); renovable                                                                                           |
| Revocada a mano                                             | 401 desde la siguiente petición; para siempre; la que está en curso termina                                                       |
| Organization archivada o congelada                          | rechazada (403) mientras dure; vuelve a funcionar al restaurarla, si no caducó; no se puede crear ni cambiar, sí revocar          |
| Organization borrada                                        | revocada en la misma transacción del borrado (`space-gone`, auditada como `system` con `via: organization.delete`)               |
| User de un Personal space deshabilitado                     | rechazada como un Space archivado (sus cuentas no se usan: `aiAccount.use` se las niega)                                          |
| User de un Personal space quitado                           | revocada en la transacción que lo quita (`space-gone`, `via: user.remove`): sus cuentas se borran en esa misma transacción        |
| Una cuenta deja el Space (deshabilitada, borrada, otro dueño) | deja de contar en la siguiente petición; sin cuentas, 403                                                                       |
| Quien la emitió deja la Organization, deja de ser Admin o es quitado | **nada**: la clave es del Space; los Admins que quedan la ven y la gestionan                                              |
| El Space pasa su cuota de tráfico del mes (Plans 09)        | 429 con el límite y `resetsAt`, como una clave de CLI local                                                                      |

- Las revocaciones del Hub se escriben con `revokeWithin` (o su gemela para access keys) dentro de la transacción del borrado, como las gateway keys (spec 4 ticket 11).
- Las filas nunca se borran: son el historial del uso y de la auditoría. La lista esconde por defecto las revocadas y las caducadas hace más de 30 días («Show ended»).

### Puertas

| Puerta                           | Qué se declara                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS (`RPC_SPACE_ACCESS`)          | `accessKeys.list {spaceId?}` (`access:read`; sin Space, el Owner las de todos), `accessKeys.create`, `accessKeys.update`, `accessKeys.revoke` (`access:write`), decididas en el servicio con `accessKey.manage`/`accessKey.view` y solo para la sesión de una persona; `accessKeys.modelOptions {spaceId}` (los modelos que sirven las cuentas propias del Space, para el formulario) |
| HttpApi (`HTTP_ENDPOINT_RULES`)  | ninguna                                                                                                                                                                                                                                                                      |
| Raw routes (`RAW_ROUTE_RULES`)   | `/api/ai/*` sin cambios de forma: la descripción de la regla añade la access key (caducidad, Space, cuentas, modelos, topes). Ticket 08 añade `GET /api/ai/access-key` (solo con la propia clave)                                                                           |
| Cookies (`AMBIENT_COOKIE_RULES`) | `/api/ai/*`: refused, como hoy                                                                                                                                                                                                                                               |
| MCP (`MCP_TOOL_RULES`)           | ninguna herramienta nueva; ninguna existente devuelve access keys, sus hashes ni sus pistas                                                                                                                                                                                 |
| Tablas                           | `ai_access_keys` solo la escribe `AccessKeys.ts` (y las revocaciones dentro de transacciones ajenas por su función exportada); `DoorRules.test.ts` lo vigila como hace con `ai_usage`                                                                                       |
| Logs, OTLP, argumentos           | nunca la clave ni su hash; la pista de 4 caracteres solo en la lista para quien la gestiona                                                                                                                                                                                  |

### Auditoría

- Nuevas acciones en la allow-list (`packages/contracts/src/audit.ts`), objetivo `access_key` (nombre = la etiqueta):
  - `access_key.create`: `space`, `expiresAt`, `limits`, `models` (número de entradas y si es «All models»), `accounts` (`all` o número), `subscription` (si alcanza alguna suscripción).
  - `access_key.update`: `space`, `changed` (lista de campos), `expiresAt`, `limits` (los nuevos valores), `via` (`renew` cuando solo cambia la caducidad).
  - `access_key.revoke`: `space`, `reason` (`revoked`, `space-gone`), `via`.
- Nunca la clave, su hash ni su pista. Actor: la persona; `system` para las revocaciones del Hub.

### Clientes

- **Web y desktop:** Space settings → AI accounts → «Access keys» (`AccessKeysSettings`), visible para quien tiene `accessKey.view` en ese Space; el Owner tiene además una vista de todos los Spaces. Crear (etiqueta, validez, modelos con selector de catálogo y «Add pattern», cuentas, topes con «No token limit» explícito, aviso de ToS si alcanza una suscripción), diálogo de «solo una vez» con la clave y «Copy setup» (pestañas Claude Code, Codex, Other clients), lista, «Renew», «Edit limits», «Revoke». Si la URL del Hub es `http:` y no es de loopback, el diálogo avisa que la clave viajaría en claro.
- **Setup** (`@t3tools/shared/aiGatewayAccessKey`, junto a `aiGatewayLocalCli` y reutilizando `gatewayOrigin`): con la URL pública del Hub (`T3CODE_PUBLIC_URL`, si no, el origen del cliente):
  - Claude Code: `env.ANTHROPIC_BASE_URL = <hub>/api/ai/anthropic`, `env.ANTHROPIC_AUTH_TOKEN = <clave>` y los modelos fijados (arriba).
  - Codex: `model`, `model_provider = "t3"` y `[model_providers.t3]` (`base_url = <hub>/api/ai/openai/v1`, `env_key = "T3_AI_GATEWAY_KEY"`, `wire_api = "responses"`), y aparte la línea de shell que exporta la clave (nunca en `config.toml`).
  - Other clients: base URL compatible con OpenAI `<hub>/api/ai/openai/v1`, con Anthropic `<hub>/api/ai/anthropic`, con Gemini `<hub>/api/ai/gemini`, la clave como `Authorization: Bearer` (o `x-api-key` / `x-goog-api-key`) y los modelos permitidos.
  - Justo tras crear, el setup lleva la clave; «Copy setup» en una clave listada lleva un marcador («<your access key>»).
- **Móvil** (como el resto de AI accounts, solo lectura más revocar): lista de las claves del Space con uso, topes, caducidad y último uso; «Revoke». Crear, editar y renovar, solo en web y desktop (necesitan copiar el setup y formularios largos).

### Documentación

- `docs/internals/ai-gateway.md`: sección «Access keys» (qué son, quién, modelos, cuentas, validez, topes, errores, uso, riesgos), y una línea en «The gateway layer» y «Doors».
- `GLOSSARY.md`: «Access key».

## Testing Decisions

- **Un test bueno** comprueba lo que ve quien tiene la clave (las rutas `/api/ai/*` y su forma), quien la gestiona y el Owner (RPC WS) y lo que queda en la base. Red-first en cada regla de seguridad y en cada tope.
- **Seams:**
  - `AiGatewayRoute.testkit.ts` (`hubWith`, `call`, `rawCall`, `acmeSetup`, con el CLIProxyAPI falso) para la puerta: caducidad con `TestClock`, modelos, cuentas, topes y los mensajes en las tres formas.
  - El testkit «Hub con Environments» (`HubWithEnvironments.aiAccounts.testkit.ts`) para el ciclo de vida: borrar una Organization, quitar a un User, archivar y restaurar, una cuenta que deja el Space.
  - `GrantCaps.test.ts` como modelo para los topes de clave (periodos, `unwritten`, el exceso acotado con peticiones en paralelo).
  - Migraciones: test con golden, como la 146 (las filas existentes quedan con `''` y nada cambia de valor).
- **Puertas:** barrido de `accessKeys.*` como Owner, Admin, Member y Guest de dos Organizations, el User de un Personal space, otro User, un agente, el shell y una sesión limitada a un Space (`AccessKeys.test.ts`); `DoorRules.test.ts` y `RpcAuthorization.test.ts`.
- **Fugas:** la clave no aparece en la base (solo su hash), en logs, spans, auditoría ni respuestas salvo la de `create`; grep en `ai_access_keys`, `ai_usage`, `audit_log` y los logs del test.
- **Prior art:** `AiGatewayKeys.localCli.test.ts`, `AiGatewayRoute.caps.test.ts`, `AiGatewayRoute.grants.test.ts`, `AiUsage.grants.test.ts`, `aiGatewayLocalCli.test.ts`, `noOwnerControls.test.ts` (móvil).
- **Prueba real** (ticket 11, en WSL contra el Hub de desarrollo con el CLIProxyAPI real fijado): un Admin de Acme crea una clave con `claude-sonnet-*`, 2 000 tokens/día y 2 días; Claude Code y Codex reales, configurados solo con el setup copiado, hacen una pregunta; un modelo no permitido, el tope diario y la caducidad (reloj del Hub adelantado en el entorno de prueba, o una clave de validez corta editada en la base de prueba) muestran su mensaje y el cliente no reintenta; Usage muestra «Access key: <label>».

## Out of Scope

- **Límite de peticiones por minuto** por clave (decisión 3), ni uno propio de peticiones en curso (pregunta abierta 3): solo el general de cada gateway key.
- **Topes en USD:** el coste se estima y se muestra (`aiPrices.ts`), nunca se aplica.
- **Credenciales directas:** una access key nunca llega a una AI account `direct`.
- **Enviar la clave** por correo u otro canal desde el Hub, o que quien la recibe se dé de alta: el emisor la copia y la manda por su canal.
- **Restricciones por IP** o por cliente.
- **Que quien la recibe vea sus conversaciones en el Hub:** una access key no crea Threads ni ve nada del Space.
- **Cambiar los Grants para que estimen tokens desconocidos:** queda como posible mejora (pregunta abierta 4).
- **Límite de access keys por Plan:** si Plans lo necesita, lo añade su spec.

## Further Notes

- **Riesgo aceptado:** la clave vive en los archivos de quien la recibe y la puede leer lo que corra como esa persona. Llega solo a lo que permite, durante su validez y hasta sus topes; se revoca desde cualquier dispositivo.
- **ToS (ADR 0005):** dar una clave que alcanza una suscripción a alguien de fuera es compartir esa suscripción con más gente todavía. El formulario lo avisa en cada clave que alcance una; las API keys siguen siendo la alternativa conforme.
- **Plans y límites:** la cuota de tráfico del Hub (Plans ticket 09) rechaza hoy las peticiones de claves de CLI local de un Space que la pasó; las access keys entran en la misma regla. El ticket que llegue segundo añade la comprobación.
- **Orden sugerido para los tickets:**
  1. Emitir, usar y revocar una clave de acceso (con validez).
  2. Modelos permitidos.
  3. AI accounts que alcanza una clave.
  4. Uso por clave de acceso.
  5. Topes de tokens.
  6. Renovar, ampliar y cambiar topes.
  7. La clave sigue a su Space.
  8. Estado de la clave para quien la tiene (necesita decisión).
  9. Cuentas prestadas con permiso del prestador (necesita decisión).
  10. Móvil.
  11. Inventario de puertas y pase completo.

  2 y 3 pueden ir en paralelo tras 1; 8, 9 y 10 en paralelo tras 6.

## Preguntas abiertas (decididas por el Owner el 2026-11-23)

Decisiones: 1 → no en esta versión (ticket 09 queda para después, con el permiso del prestador); 2 → sí; 3 → **sin límite propio** de peticiones en curso para las access keys: rige el mismo límite general que ya tiene cada gateway key (16), y el exceso sobre un tope queda acotado solo por eso; 4 → sí, estimación por bytes solo para access keys; 5 → sí, ticket 08 se construye.

1. **¿Una access key llega a AI accounts prestadas al Space por un Grant?** Quien presta confió en un Space y en su gente, no en quien reciba una clave; y los topes del Grant y los de la clave se sumarían en una sola petición. Recomendación: no en esta versión (solo las cuentas propias del Space); el ticket 09 añade a los límites de un Grant de AI account un permiso `accessKeys` (por defecto `false`, también en los Grants que ya existen) que solo el prestador cambia, y entonces la petición debe caber en los dos topes.
2. **¿Puede el User de un Personal space emitir access keys para sus propias cuentas?** El Owner pidió «el Owner o un Admin del Space». Recomendación: sí, el User de un Personal space es quien lo gestiona (como decide los Grants que recibe) y las cuentas son suyas, que ya puede prestar; y el Owner no emite en el Personal space de otro User (no tiene bypass sobre lo ajeno, como en los Grants), aunque sí ve y revoca cualquier clave.
3. **¿Cuántas peticiones en curso por access key?** Acotan cuánto se puede pasar un tope (cada una termina aunque el tope se alcance a mitad). Recomendación: 4 (hoy 16 por gateway key): un agente como Claude Code rara vez lleva más de 2 o 3 a la vez (subagentes) y el exceso queda en unas pocas respuestas. No es un límite por minuto.
4. **Respuestas sin uso conocido.** Los Grants las cuentan como 0 tokens. Para alguien de fuera eso es una vía para no gastar tope (cortar antes del último evento). Recomendación: para access keys, contarlas con la estimación por bytes descrita en «Topes de tokens»; revisar más adelante si los Grants deben hacer lo mismo.
5. **¿Quien tiene la clave puede consultar su estado?** Sin cuenta en el Hub, hoy no tiene forma de saber cuánto le queda. Recomendación: sí, `GET /api/ai/access-key` autenticado solo con la propia clave, que devuelve etiqueta, caducidad, modelos permitidos y, por tope, usado, lo que queda y el reinicio; nunca el Space ni quién la emitió más allá de la etiqueta, ni el uso de nadie más (ticket 08).
