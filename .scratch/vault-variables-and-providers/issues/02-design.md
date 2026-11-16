# 02 — Diseño: Núcleo de Provider entries

Ticket: `02-nucleo-de-provider-entries.md`. Decisiones del Owner (`triage/decisions-2026-11-16.md`) por encima del spec: Q3 = el arranque falla entero con error tipado y «Retry», nunca el último valor conocido. Los scopes y la UI de proveedores son del ticket 03.

## 1. Datos — migración 120 `VaultProviderEntries`

- **Reconstrucción de `vault_entries`**, como en la 119: un CHECK sobre `kind` no se altera.
  - `kind IN ('own','copy','link','provider')`.
  - `provider_id TEXT`: clave de `settings.secretProviders`.
  - `provider_reference TEXT`: hasta 1024 caracteres, normalizada.
  - `provider_scope_id TEXT NULL`: siempre NULL en 02; el 03 crea la tabla y la rellena.
  - CHECK: `(kind = 'provider') = (provider_id IS NOT NULL AND provider_reference IS NOT NULL)`; `kind IN ('link','provider')` ⇔ `value_id IS NULL`; un `provider` tiene `linked_entry_id NULL`, `class = 'secret'` y `revealable = 0`.
- **Sin tabla `delivered_values` nueva.** Se reutiliza el patrón que ya existe para la credencial directa de una AI account (`ai-account:` en `thread_secret_values`):
  - cada valor entregado se sella en un almacén nuevo, `ServerSecretStore.DeliveredValueStore` (carpeta `secrets/delivered-values/`, propósito `delivered-value`);
  - su fila va en `thread_secret_values` con `value_id = delivered:<id>`, por raíz de Thread;
  - `ThreadSecretValues.pruneAndListHeld` ya borra las filas al borrar el Thread, y un barrido al arrancar quita los archivos que ninguna fila sostiene (como hace `VaultReachLoss`).
  - El `<id>` es un HMAC del valor con la clave de huellas, así que una entrega repetida no duplica.

## 2. Contrato de driver (`packages/secret-provider-core`)

- `read(config, refs)` devuelve `ReadonlyArray<ReadResult>`, donde `ReadResult` es:
  - `{ _tag: "value", value, expiresAt?, version? }`, o
  - `{ _tag: "error", error: "not-found" | "forbidden" | "unavailable" | "invalid" }`.
- `test(config) → Effect<TestReport>`: obligatorio. «Test connection» es UI del 03.
- **1Password**, mismo comportamiento:
  - timeout o fallo al lanzar `op` → `unavailable`;
  - salida distinta de 0 → `not-found` (`op` no distingue sin permiso de inexistente);
  - valor vacío → `not-found`;
  - `test` = `op whoami --account`.
- **`SecretResolver` de los ajustes** adapta `ReadResult` a `string | undefined` y conserva su caché de por vida y su `invalidate`. Los ajustes no cambian.

## 3. Lectura para Vaults: `vaults/ProviderReads.ts` (servicio nuevo)

- **Mismos drivers que los ajustes**, más un driver de test que solo inyectan los tests por layer. El registro de producción no cambia.
- **Agrupa por (proveedor, scope)**: grupos en paralelo, en lote dentro de cada uno. Timeout de 10 s por grupo; si salta, todo el grupo es `unavailable`.
- **Caché** por `(providerId, scopeId, reference, configKey)`:
  - dura hasta `expiresAt`, o hasta `refreshInterval` del proveedor (por defecto 5 min) si no hay `expiresAt`;
  - los errores no se cachean;
  - una sola lectura en vuelo por clave.
- **La referencia se valida al guardar y otra vez al leer:**
  - `isReference` del driver;
  - normalización: se rechazan `..`, `//`, `%2e` y `%2f`, en crudo o decodificados, y caracteres de control;
  - `allowedBy(scope, ref)`: en 02, con scope NULL, siempre sí (es el acceso del Owner). El 03 añade los prefijos `allowed_paths`, y la llamada ya está en el camino de lectura.
- **Huella:** `HMAC-SHA256(fingerprintKey, value)`.
  - `fingerprintKey` son 32 bytes aleatorios en `ServerSecretStore` (`vault-fingerprint-key`), creados la primera vez.
  - `SecretPlan.fingerprint` añade `[name, "p:" + hmac]` por cada Provider entry: nunca el valor ni su hash simple.

## 4. Entrega y fallos

- **`EffectiveVariable` gana `source`**: `{ hub, valueId }` o `{ provider, providerId, scopeId, reference }`. `mayReceiveSecrets` cuenta también las filas `provider`, que tienen `value_id` NULL.
- **El plan lee los proveedores a través de la caché.** Es el conflicto 1, más abajo. `resolve` reutiliza esas lecturas.
- **Si una entrada falla, falla el arranque entero:** `SecretProviderReadError { reason, provider (etiqueta), scope, entries (nombres) }`, nuevo en `contracts/secretEnv.ts` y dentro de `SecretDeliveryFailure`. No se entrega nada del conjunto, y el mensaje nunca lleva valores.
  - `unavailable` → «OpenBao didn't answer for KUBE_TOKEN, DB_URL. Retry.»
  - `forbidden`, `not-found` e `invalid` tienen mensaje propio.
- **«broken»:** proveedor ausente de los ajustes o kind sin driver (el scope borrado llega en el 03). Se calcula al listar, sin leer el proveedor. No se entrega y no hace fallar el arranque, igual que un Secret link roto (spec «Rotas»).
- **Enmascarado:** `SecretDelivery` llama a `remember` con los valores de proveedor como `delivered:<id>`, antes de entregar. `SecretMasker.valuesOf` resuelve `delivered:` desde `DeliveredValueStore`. Por la fila del Thread, un valor rotado sigue enmascarado.

## 5. Puertas

- **`vaults.entries.put` gana `provider: { providerId, reference }`**, en lugar de `value`.
  - Solo el Owner: acción nueva `vault.providerEntry`.
  - Solo se puede crear o cambiar la referencia.
  - Sin `class` ni `allowReveal`: siempre un Secret sellado.
  - No hay UI de alta en 02.
- **`VaultEntry` gana `provider: { label, reference } | null`**, solo para quien edita: un Member ve «Provider» sin la ruta, igual que un link no muestra su original.
- **`vaults.reveal`** devuelve `sealed`, porque la fila es `revealable = 0`.
- **Link y copia de una Provider entry** → `not-linkable`. «Copy into the Hub» es el ticket 08.
- **Errores en el cliente:** la Web y el desktop muestran el error tipado en el Thread, con «Retry».
  - «Retry» reutiliza el reintento de arranque de run que ya existe si cubre este fallo; si no, añado uno que vuelve a lanzar el turno.
  - Móvil: conflicto 3.
- **Settings → Vaults (web)** muestra la insignia «Provider: <label>» y «broken».
- **MCP y executor sin cambios:** `list_secret_names` da solo nombres, y la entrega sigue siendo `env`.
- **Auditoría:** `secret.edit` con `op: add|reference` y detalle `provider` (etiqueta), sin la referencia. `secret.read` es del 03 o del 17.

## 6. Tests red-first (se amplían los archivos existentes)

- **`SecretDelivery.test.ts`**, con un driver de test por layer:
  - un proveedor que no responde (TestClock, 10 s) → `SecretProviderReadError unavailable` con las entradas, y ningún valor entregado;
  - `forbidden` y `not-found` con su propio código;
  - un valor rotado cambia la huella; la huella no contiene ni el valor ni su sha256;
  - una lectura cacheada no vuelve a llamar al driver hasta que pasa `expiresAt`.
- **`SecretMasker.test.ts` y el testkit «Hub con Environments»:** un valor de proveedor sale como `[NAME]` en el historial, en la terminal y en los logs, también después de rotarlo.
- **`Vaults.test.ts`:**
  - Admin, Member y Guest no crean Provider entries;
  - una referencia con `..`, `%2e` o `//` se rechaza al guardar, y también al leer si se metió por SQL;
  - `reveal` devuelve `sealed` sin llamar al driver;
  - link o copia → `not-linkable`;
  - un proveedor borrado → «broken» sin entregar.
- **`ProviderReads.test.ts`** (nuevo, no hay ninguno): grupos en paralelo, lote, timeout, `refreshInterval`.
- **`secret-provider-core`:** el `SecretResolver.test` existente, adaptado. **1Password:** `driver.test` con clasificación y `test`.
- **`120_*.test.ts`:** las filas se conservan y los CHECK funcionan. **`DoorRules.test.ts`:** quién lee `DeliveredValueStore` (SecretDelivery escribe, SecretMasker lee) y la acción nueva.

## 7. Riesgos y fuera del ticket

- **Riesgos:**
  - la disponibilidad del turno pasa a depender del proveedor (ADR 0008; solo para Threads con Provider entries);
  - el plan lee proveedores (conflicto 1): la caché lo acota;
  - 1Password en un Hub sin `op` deja las entradas en `unavailable`, no en «broken».
- **Fuera:** scopes, `allowed_paths` y Settings → Secret providers (03); OpenBao (04); archivos y plantillas (05); Dynamic secrets (06); Provider Variables (conflicto 2); auditoría `secret.read`; UI móvil (16).
- **Docs:** `docs/internals/secrets.md` gana «Provider entries», con enlace a la ADR 0008.

## Conflictos y recomendación

1. **El spec dice «se lee en `resolve`, nunca al planear»**, pero la huella HMAC tiene que conocer el valor para reabrir la sesión en el turno siguiente cuando el valor rota, y el plan se calcula sin `resolve`. → **Leer en el plan a través de la caché con TTL** (una sola lectura por turno como mucho), y fallar el plan igual que fallaría el arranque.
2. **El spec permite Provider entries de clase Variable**, pero mostrar su valor en `vaults.entries.list` exige leer el proveedor mientras se pinta la UI, y el spec («Rendimiento») lo prohíbe. → **En 02, solo Secrets sellados** (CHECK). Las Provider Variables se dejan para cuando haya un caso.
3. **El ticket pide «Retry» en web, desktop y móvil**, pero la decisión de fases dice que en la fase 1 los clientes son solo web. → **Web y desktop en 02; móvil en el 16.**
4. **El ticket y el spec piden una tabla `delivered_values`**, pero el código ya resuelve lo mismo con `thread_secret_values` y un prefijo (`ai-account:`). → **Reutilizar ese patrón** con `delivered:` y un almacén sellado nuevo: el mismo borrado con el Thread y los mismos lectores del masker, sin tabla nueva.
5. **El ticket nombra `provider_scope_id` sin scopes**, porque los scopes llegan en el 03. → **`provider_id` obligatorio y `provider_scope_id` NULL**; el 03 exige scope para las entradas de Admins.
