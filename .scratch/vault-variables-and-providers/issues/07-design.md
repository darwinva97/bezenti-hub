# 07 — Diseño: Workload identity tokens

Ticket: `07-workload-identity-tokens.md`, ADR 0009, spec «Workload identity tokens», Q7 y Q12.

Se apoya en:

- el 04: driver OpenBao y `ProviderReads`;
- el 05: entrega `file`, `filesFolder`, `secrets.refreshFiles`, contrato 16 (`SECRET_FILES_CONTRACT_VERSION`; el 15 son los assets remotos) y la migración 122. El 07 no cambia el contrato; si lo necesitara, sería el 17. Una entrada `file` falla cerrada si la máquina no tiene raíz en memoria.

Se construye cuando el 05 esté en `vault-fase-1`.

## 1. Claves de firma (`identity/IdentityKeys.ts`)

- **Algoritmo y `kid`:** ES256 (P-256), generada con `node:crypto`. El `kid` es el thumbprint RFC 7638 de la JWK pública.
- **Dónde se guardan:**
  - la privada, sellada en `ServerSecretStore` como `identity-signing-<kid>`;
  - la pública y las fechas, en la tabla `identity_signing_keys(kid, public_jwk, created_at, publish_at, sign_from, sign_until, retire_at)`.
- **Calendario:** cada clave firma 30 días.
  - La siguiente se genera y se publica 7 días antes de firmar.
  - La anterior sigue publicada 7 días después de su `sign_until`.
  - Firma siempre la clave con `sign_from ≤ ahora < sign_until`.
- **Cuándo rota:** una tarea comprueba al arrancar y cada hora, con `Clock`, así que se prueba con `TestClock`. Las claves se crean perezosamente: no hay ninguna hasta que la identidad está en uso (Q12).
- **Nunca se exportan:**
  - ninguna puerta ni comando las devuelve, y `reveal` no las conoce;
  - `t3 secrets key import`, es decir una restauración, borra las filas y los sellos, y el Hub genera claves nuevas. Los verificadores recogen el `kid` nuevo del JWKS.
  - La rotación de la clave maestra las vuelve a sellar como al resto (conflicto 2).

## 2. Rutas públicas (`identity/http.ts`, raw `HttpRouter`)

- **`GET /.well-known/openid-configuration`** devuelve `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported: ["ES256"]`, `response_types_supported: ["id_token"]`, `subject_types_supported: ["public"]` y `claims_supported`.
- **`GET /.well-known/jwks.json`** devuelve las claves publicadas: solo `kty`, `crv`, `x`, `y`, `kid`, `alg`, `use`. Nunca `d`, y se construye por lista blanca de campos.
- **Caché:** `Cache-Control: public, max-age=300`.
- **Son públicas de verdad:** `/.well-known` ya se salta Cloudflare Access en bezenti, así que no exponen nada más.
- **Mientras no se usan (Q12):** no hay ninguna entrada `identity` ni ningún proveedor con `hub_identity`. Entonces la ruta **delega en el mismo handler de respaldo** que una ruta desconocida, y la respuesta es idéntica. Un test compara estado, cabeceras y cuerpo contra `/.well-known/nope`.
- **Emisor:** `T3CODE_IDENTITY_ISSUER`, o el origen de `T3CODE_PUBLIC_URL`. **Nunca la cabecera Host.**
  - Tiene que ser `https://` (`http://` solo a loopback).
  - Sin emisor, la identidad está apagada y guardar una entrada `identity` falla con `identity-no-issuer`.
- **`T3CODE_IDENTITY_DISCOVERY_URL_INTERNAL`:** solo se documenta, para el `issuer.discoveryURL` del API server y el `oidc_discovery_url` de OpenBao.

## 3. Tokens (`identity/IdentityTokens.ts`)

- **Claims estándar:** `iss`, `aud` (**una sola cadena**, nunca un array), `iat`, `nbf = iat − 60 s` (holgura de reloj), `exp = iat + ttl`, y `jti` (UUID).
- **TTL:** 10 min por defecto, 1 h como máximo (Q7).
- **Thread** (de la fila real, nunca del cliente):
  - `sub = t3:space:<slug>:project:<slug|->:user:<username>`;
  - `username`;
  - `groups = ["t3:space:<slug>", "t3:org:<slug>"]`;
  - `installation`, `user_id`, `space_id`, `space_slug`, `organization`, `project_id`, `thread_id`, `root_thread_id`, `environment_id`, `environment_kind`, `role`.
  - Nunca nombres de Vaults ni de entradas.
- **Hub** (`hub_identity`): `sub = t3:hub:<installation>`, `scope = <scope id | "direct">`, TTL 5 min.
- **Audiencia:**
  - el emisor solo firma la audiencia guardada en la entrada o en el config del proveedor, nunca una que traiga la llamada;
  - al guardar, se rechaza una audiencia vacía, con espacios o comas, de más de 256 caracteres, o que sea un origen del propio Hub.
- **Auditoría:** `identity.issue` registra `aud`, `sub`, `jti`, `exp`, la entrada y el Thread. Nunca el token.

## 4. Entradas `identity`

**Migración 123** (o la siguiente libre si el 05 cambia):

- reconstruye `vault_entries` sobre la forma de la 122;
- `kind` admite `identity`, con `identity_audience` e `identity_ttl_seconds` (entre 60 y 3600);
- CHECK: `identity` ⇒ `class='secret'`, `revealable=0`, `delivery='file'`, sin valor, sin link y sin proveedor;
- crea `identity_signing_keys`.

**Puertas y entrega:**

- **`vaults.entries.put`** gana `identity: { audience, ttlSeconds? }`. Acción nueva `vault.identityEntry`, solo del Owner. Un Admin recibe `forbidden`, también al editar o borrar.
- **`vaults.reveal`** responde `sealed`.
- **Entrega (05):**
  - `plan` comprueba el contrato 16 y la raíz en memoria. Si no, falla cerrado.
  - `resolve` emite un token por (raíz del Thread, User, entrada) y lo reutiliza mientras le quede más de 1/3 de vida.
  - Va como archivo `NOMBRE`, sellado como `delivered:<hmac>` para el enmascarado.
- **Plantillas:** una plantilla solo puede nombrar una entrada `identity` con `| path`, nunca su valor. Así un refresco no obliga a volver a renderizar.
- **Refresco** (`identity/IdentityRefresher.ts`):
  - tras cada `resolve` con identidad se anota `(entorno, filesFolder, raíz, User, entradas)`;
  - a 2/3 de la vida se emite de nuevo, con los claims vivos, y se llama a `secrets.refreshFiles` solo con esos archivos;
  - `not-held` o la pérdida de alcance (`mayReceiveSecrets`) borra la anotación, y el archivo caduca solo.

## 5. `hub_identity` en OpenBao

- La definición gana `hubIdentity?(config): { audience } | undefined`.
- `ProviderReads` emite el token del Hub para el scope de cada grupo. Lo pone en un campo de runtime, `identityToken`, que nunca se guarda en los ajustes, antes de llamar al driver.
- OpenBao gana `authMethod: "hub_identity"` con `authRole`, `authMount?` (por defecto `jwt`) y `audience`. El login es `{ role, jwt }`.
- La identidad del token de OpenBao excluye `identityToken` e incluye el scope. Así un JWT nuevo no fuerza un login nuevo.
- Activa las rutas (Q12).

## 6. Tests red-first

- **`IdentityTokens.test.ts`:**
  - el token verifica contra el JWKS publicado, con un verificador mínimo basado en `crypto.verify` y JWK;
  - el JWKS no tiene `d` ni campos fuera de la lista;
  - un token caducado más allá de la holgura, o de otra audiencia, lo rechaza el verificador;
  - un verificador con el reloj 45 s atrasado lo acepta;
  - no se emite una audiencia que no viene de una entrada o proveedor;
  - los claims salen del Thread real y no nombran Vaults.
- **Rotación con `TestClock`:**
  - la siguiente clave se publica 7 días antes de firmar;
  - durante el solape verifican las dos;
  - la vieja desaparece del JWKS a los 7 días;
  - `key import` borra las claves.
- **Rutas:**
  - sin uso, la respuesta es idéntica a la de una ruta desconocida;
  - con uso, `issuer` sale del config aunque la petición traiga otro Host.
- **`Vaults.test.ts`:**
  - un Admin no puede crear ni editar una entrada `identity`;
  - CHECK de la 123 (`env`, revelable o con valor → rechazo);
  - una plantilla con la identidad sin `| path` → rechazo.
- **`SecretDelivery.test.ts`:**
  - contrato < 16 o raíz en disco → falla cerrado;
  - token reutilizado y reemitido en sus umbrales;
  - el refresco llama a `refreshFiles`, y `not-held` lo para.
- **`DoorRules.test.ts`, `MaskedPaths.test.ts` y `AuditLog.test.ts`:** las dos rutas públicas, `identity.issue` sin token, y `vault.identityEntry`.
- **OpenBao:** `hub_identity` contra el falso, y opcional contra `bao server -dev` con JWT auth y `jwks_url`.

## 7. Riesgos y fuera del ticket

**Riesgos:**

- La clave de firma es una raíz de confianza nueva: se rota, nunca se exporta, y está auditada.
- Una copia vieja de la base de datos junto con su backup de clave maestra abre las claves de entonces, que valen como mucho 37 días. Es el mismo riesgo que con cualquier Secret.
- El reloj del Hub: se avisa si `nbf` y `exp` quedan fuera.
- El Sandbox compartido lee el archivo del token por la misma uid (ADR 0004; se avisa en Settings).
- Las rutas públicas delatan que el Hub emite identidad: se acepta.

**Fuera:**

- la prueba real en k3s, para un humano (ticket 18);
- AWS, GCP y Azure como proveedores que entran con `hub_identity` (10);
- Infisical (11);
- móvil (16).

**Docs:** recetas en `docs/user` para Kubernetes `AuthenticationConfiguration` (`username` con prefijo `t3:` y `groups`), OpenBao JWT auth, AWS, Google Cloud y Azure, más `docs/internals/secrets.md`, sección «Workload identity».

## Conflictos y recomendación

1. **`sub`:** el brief dice `t3:<user>` y el spec `t3:space:…:project:…:user:<username>`. → **El `sub` del spec**, que es único por Space, Project y User y sirve a OpenBao y AWS. Además, un claim `username` que Kubernetes mapea con el prefijo `t3:` y da `t3:<user>`, y `groups` con `t3:space:<slug>`.
2. **«Nunca se exportan»** choca con la realidad: la clave maestra exportada abre todo lo sellado. → Ningún camino las entrega, y `key import` las borra para que se regeneren. El riesgo residual se documenta. La alternativa, un archivo aparte fuera de la clave maestra, se perdería en una restauración y no compensa.
3. **Q12, «404 idéntico»:** el catch-all puede no responder 404 (SPA). → Se delega en el mismo handler de respaldo y el test compara las respuestas, no un 404 fijo.
4. **Plantillas con identidad:** el 05 la admite «en el futuro». → Solo con `| path`.
5. **Refresco:** el 05 deja `refreshFiles` sin llamador. → `IdentityRefresher`, que el 06 reutilizará para los Leases.
6. **Cómo da el Hub su token a un driver:** sin servicio nuevo en el contrato del driver, por un campo de runtime que pone `ProviderReads`, como las credenciales del 03.
7. **Sin `T3CODE_PUBLIC_URL` ni `T3CODE_IDENTITY_ISSUER`:** → identidad apagada, y guardar falla con `identity-no-issuer`. Nunca se deduce de la petición.
8. **Lista de audiencias permitidas global:** el spec no la pide (Q7: una por entrada, solo el Owner). → No; solo se rechazan las audiencias del propio Hub.

## Aprobado (2026-11-16): las 8 recomendaciones, y estos tests obligatorios

1. Un verificador estándar valida un token contra el JWKS servido. Lo rechaza con `aud` equivocada, tras `exp`, antes de `nbf` y con un `kid` desconocido. Se usa `jose` si algún paquete ya depende de él (está en el catálogo); si no, WebCrypto.
2. Rotación con `TestClock`:
   - un token firmado con la clave vieja verifica durante el solape y falla cuando se retira;
   - la siguiente clave está en el JWKS antes de firmar.
3. El JWKS y el discovery nunca llevan campos privados (`d`, `p`, `q`, `dp`, `dq`, `qi`, `k`). Se comprueba sobre el JSON crudo.
4. El token nunca aparece en logs, filas de auditoría, errores ni respuestas WS, solo en el archivo entregado. Se prueba con un token conocido.
5. El emisor nunca sale de la cabecera Host: una petición con un Host falsificado recibe el emisor configurado.

Ticket 18 (de Darwin) gana en su checklist:

- `T3CODE_IDENTITY_ISSUER` o `T3CODE_PUBLIC_URL` en el Deployment del Hub;
- el autenticador `jwt` de k3s apuntando a la URL de discovery interna;
- el kubeconfig con `tokenFile: {{ KUBE_TOKEN | path }}`.
