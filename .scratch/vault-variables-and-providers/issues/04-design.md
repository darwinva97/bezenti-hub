# 04 — Diseño: Driver OpenBao / HashiCorp Vault

Ticket: `04-driver-openbao-y-hashicorp-vault.md`. Se apoya en el 02 (contrato `read`/`test` y `ProviderReads`) y en el 03 (`credentialFields` sellados, scopes con `auth`).

**Solapamiento con el 05:** paquete nuevo y su registro. No toca `SecretDelivery`, el contrato del executor ni migraciones (no hace falta ninguna). Fuera del paquete solo cambian:

- `secret-provider-definitions/registry.ts` y la lista del servidor;
- `ProviderReads`: superpone el `auth` del scope (conflicto 2);
- la UI de Settings → Secrets, con el formulario de OpenBao (conflicto 1).

## 1. Paquete `packages/secret-provider-openbao`

- `shared/definition.ts`: kind `openbao`, etiqueta «OpenBao / HashiCorp Vault», `configSchema`, `isReference`, placeholder `kv/acme/app#token`, y `credentialFields: ["token", "secretId", "clientKey"]`.
- `server/driver.ts`: `read` y `test`.
- `server/http.ts`: el cliente.
- `server/tokens.ts`: el ciclo de vida del token.
- Mismas reglas que 1Password: ningún valor, token ni cuerpo de respuesta sale del driver.

## 2. Configuración (plana: `credentialFields` del 03 son campos de primer nivel)

- **`address`:** obligatoria. Solo `https://`, o `http://` únicamente hacia loopback (`bao server -dev`). Se rechaza al guardar.
- **`namespace?`:** va en la cabecera `X-Vault-Namespace`.
- **`caCert?`:** PEM; no es un secreto. Se **añade** a la verificación TLS y no puede desactivarla: no hay interruptor «insecure» ni `skipVerify`, y `rejectUnauthorized` es siempre `true`.
- **`mounts`:** `[{ path, version: 1 | 2 }]` (al menos uno). Se declaran; nunca se pregunta a `sys/mounts`.
- **`authMethod`**, uno de:
  - `kubernetes`: `authRole`, `authMount?` (`kubernetes`), `tokenFile?` (por defecto, el token proyectado del ServiceAccount) y `audience?`, que documenta la audiencia del token proyectado y se valida con la del rol;
  - `jwt`: `authRole`, `authMount?` (`jwt`), `tokenFile` (obligatorio; la identidad del Hub es del 07);
  - `approle`: `roleId` (no secreto) y **`secretId`** (credencial);
  - `token`: **`token`** (credencial, renovable con `renew-self`);
  - `cert`: `clientCert` (PEM, no secreto), **`clientKey`** (credencial) y `authRole?`.
- Un filtro del schema exige los campos de cada método.
- **`refreshIntervalSeconds?`:** ya lo lee `ProviderReads`, 300 s por defecto.
- **`auth` de un scope (03)** solo puede cambiar campos no secretos: `role` → `authRole`, `mount` → `authMount`, `namespace`. Un `method` distinto del del proveedor hace la lectura `invalid` (cambiar de método exigiría otras credenciales).

## 3. Referencias y lecturas

- **Sintaxis:** `mount/ruta[?version=N]#campo`.
  - `isReference` exige el campo, una `N` entera > 0 si aparece, y que el mount sea uno de los declarados, por segmento.
  - `?version=N` solo vale en mounts v2; en un v1 la referencia es `invalid` al guardar.
- **KV v1:** `GET /v1/<mount>/<ruta>`, valor en `data`. **KV v2:** `GET /v1/<mount>/data/<ruta>[?version=N]`, valor en `data.data`.
- **Valor:** una cadena tal cual; número o booleano como texto. Un objeto o un campo ausente → `not-found`.
- **Lote:** se agrupan las referencias por ruta (y versión): `kv/acme/app#user` y `kv/acme/app#pass` son una sola petición. Las rutas distintas van en paralelo, con concurrencia 8. Cada referencia recibe su propio resultado.
- No hay `expiresAt` en lo estático: la caché del 02 usa `refreshInterval`.

## 4. Tokens (en memoria, nunca persistidos)

- **Un token por identidad**: hash de address, namespace, método, mount, rol y credencial. Dos scopes con el mismo rol comparten token; con roles distintos, no.
- **Login:** a la primera necesidad, una sola en vuelo por identidad.
- **A 2/3 de su `lease_duration`:**
  - si es renovable, se lanza `renew-self` en segundo plano (una vez), y las lecturas siguen con el token actual mientras siga vigente;
  - si no lo es (o falla la renovación), se vuelve a entrar.
- **Caducado:** la lectura espera al nuevo login.
- **Un 403** se trata como posible token revocado: se vuelve a entrar **una vez** y se reintenta. Si sigue en 403, es `forbidden`.
- **Método `token`:** no se puede volver a entrar. Si caduca, el resultado es `unavailable`, y el Owner sustituye el token en Settings.
- `tokenFile` y los PEM se leen con `FileSystem` en cada login, así un token proyectado que rota se recoge solo.

## 5. Cliente HTTP

- `fetch` de Node con un `undici.Agent` por (address, CA, certificado de cliente). `EnvHttpProxyAgent` cuando el proceso usa proxy, con la misma CA.
- **Timeouts:** 5 s por petición (`AbortSignal.timeout`), dentro de los 10 s por lote de `ProviderReads`.
- **Redirecciones:** `redirect: "manual"`.
  - Un 3xx al **mismo origen** se sigue una vez.
  - Un 3xx a **otro origen** (un standby que apunta al nodo activo) se trata como `unavailable`, sin seguirlo, y el token **nunca** sale hacia otro origen. La guía dice que se apunte al balanceador o al nodo activo.
- **Clasificación**, solo por estado y nunca con el cuerpo, que puede repetir datos:
  - 404 → `not-found`;
  - 401/403 → `forbidden`;
  - 400 → `invalid`;
  - 429, 5xx (también 503 de un servidor sellado), timeout, error TLS o de red → `unavailable`.
- Los logs llevan el estado y la operación (`login`, `read`, `renew`), nunca la ruta completa con el campo, ni el token, ni el cuerpo.

## 6. `test`

Login, y después `auth/token/lookup-self`. Responde `{ ok }` o la clase del fallo. La lectura de la ruta de prueba de un scope ya la hace el 03 con `read`.

## 7. Web (Settings → Secrets)

`SecretProviderDialog` gana el kind OpenBao:

- campos para address, namespace, CA (textarea) y mounts (líneas `ruta v1|v2`);
- el método y sus campos;
- `token`, `secretId` y `clientKey` como credenciales (redactadas, o una referencia a otro proveedor con `SecretSourceInput`, como el resto de credenciales de ajustes);
- el icono en `SECRET_PROVIDER_KINDS`.

## 8. Tests red-first

- **`driver.test.ts`, con un OpenBao falso en proceso** (`node:http` y `node:https`, `it.live`):
  - login con cada método (kubernetes y jwt leen el archivo; approle; token; cert con TLS mutuo);
  - KV v1, KV v2 y `?version=N`;
  - lote: una petición por ruta;
  - renovación a 2/3, que no bloquea las lecturas en vuelo, con `TestClock`;
  - token perdido → 403 → un login y un reintento;
  - token no renovable caducado → `unavailable`;
  - redirección a otro host: no se sigue y no envía `X-Vault-Token` (el servidor falso de destino registra cabeceras);
  - CA propia: sin ella, `unavailable`; con ella, OK; una CA equivocada falla;
  - clasificación 404/403/400/429/503;
  - un cuerpo de error que contiene el secreto no aparece en el resultado, los logs ni los spans.
- **Fixtures TLS de prueba**, en `test/fixtures/` y solo para tests: una CA, un certificado de servidor para `127.0.0.1` y uno de cliente, con valididad larga. Se generan una vez con `openssl` y se versionan, porque Node no fabrica X.509.
- **`definition.test.ts`:** `isReference` (mount declarado, campo obligatorio, versión solo en v2, trucos del 02) y la validación del config: http no loopback rechazado, campos por método, ninguna opción insecure.
- **`ProviderReads.test`:** el `auth` del scope se superpone (`role`) y un `method` distinto da `invalid`.
- **`serverSettings.test`:** un `secretId` de OpenBao se sella y llega redactado (el mecanismo del 03, ahora con un kind real).
- **Prueba real opcional** `openbao.live.test.ts`:
  - se salta salvo con `T3CODE_TEST_LIVE_OPENBAO=1` y `bao` en el `PATH`;
  - arranca `bao server -dev -dev-root-token-id=<aleatorio> -dev-listen-address=127.0.0.1:<puerto libre>`;
  - escribe KV v1 y v2 con la API, prueba los métodos token y approle (lo habilita con la API), lee con el driver y para el proceso.
  - Aquí `bao` no está instalado: lo correría quien lo tenga.

## 9. Riesgos y fuera del ticket

- **Riesgos:**
  - HA con standbys que redirigen a otro host: no se siguen, y hay que apuntar al balanceador (documentado);
  - proxy y CA propia juntos, solo si `EnvHttpProxyAgent` lleva la CA (test);
  - el método `token` no se recupera solo: es el menos recomendado en la guía.
- **Fuera:**
  - Dynamic secrets y Leases (06);
  - autenticación con la identidad del Hub (07);
  - `list`/`write` y Provider-backed vaults (08);
  - Transit para la clave maestra (13);
  - credenciales por scope (conflicto 3);
  - la prueba real en k3s (conflicto 4).
- **Docs:** receta en `docs/user`:
  - el rol de Kubernetes auth para el ServiceAccount del Hub;
  - una política por scope (`path "kv/data/acme/*" { capabilities = ["read"] }`);
  - KV v1/v2 por mount, y la CA.

## Conflictos y recomendación

1. **El ticket no menciona la UI**, pero sin el formulario en Settings → Secrets el Owner no puede conectar OpenBao salvo editando `settings.json`. → **Formulario web en el 04** (solo web; el móvil en el 16).
2. **El ticket dice que el `auth` del scope sobrescribe al del proveedor**, pero el contrato del driver recibe solo el config del proveedor. → **`ProviderReads` lee el `auth` del scope y lo superpone** (role, mount y namespace) antes de llamar al driver. Las lecturas ya se agrupan por scope y la clave de caché incluye el config resultante. No toca `SecretDelivery`.
3. **Credenciales por scope** (un `secretId` de AppRole por scope): el 03 las dejó para el 04, pero exigen un almacén sellado por scope y su UI. → **Fuera del 04.** Con `kubernetes` o `jwt` cada scope ya usa su propio rol sin secretos. Para AppRole, token o cert se conecta un proveedor por identidad. Si hace falta, se abre un ticket aparte.
4. **El ticket pide una prueba real en k3s**, y yo no tengo acceso al clúster. → **Queda para un humano** (ticket 18 o checklist). Yo dejo la receta y la prueba opcional con `bao server -dev`.
5. **Sintaxis de la referencia:** el spec escribe `kv/acme/app#token` y `?version=N` por separado. → **`mount/ruta?version=N#campo`**, en el orden de una URL; el placeholder lo muestra.
