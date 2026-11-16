# 03 — Diseño: Secret providers y Provider scopes

Ticket: `03-secret-providers-y-provider-scopes.md`. Se apoya en el 02: `ProviderReads.allowedBy` y `provider_scope_id`, hoy siempre NULL. En paralelo va el 05: aquí no se toca el contrato del executor ni la forma de entrega de `SecretDelivery`. Migración **121**; el 05 se queda la 122.

## 1. Proveedores: siguen en `settings.secretProviders`

- **Ya existen** la puerta (`server.updateSettings`, de Installation y solo del Owner), la validación por kind (`ensureSecretProviderWritesAllowed`) y la UI (Settings → Secrets, `SecretProviderDialog`). Se reutilizan; no se crea `secretProviders.put|delete` (conflicto 1).
- **Credenciales selladas.** `SecretProviderDefinition` gana `credentialFields: ReadonlyArray<string>`, campos del config cuyo valor es `SettingsSecretValue`: un literal o una referencia.
  - Al escribir, un literal se sella en `ServerSecretStore` como `secret-provider/<id>/<campo>`. En `settings.json` queda `{ sealed: true }`.
  - Los clientes lo ven redactado, con el mismo mecanismo que las demás credenciales de ajustes.
  - Al leer, `ProviderReads` resuelve las credenciales antes de llamar al driver: un literal sale del almacén, una referencia del `SecretResolver`.
- **Regla del ciclo** (red-first): al escribir se rechaza una credencial que sea una referencia al propio proveedor, y también la cadena A → B → A. Error `secret-provider-cycle`, sin valores.
- 1Password no tiene credenciales, así que lo prueba un kind de test inyectado por layer. El primer driver real que las usa es OpenBao (04).
- **Borrar un proveedor:** la UI pide antes `secretProviders.impact` (las entradas y scopes que se rompen) y confirma. El servidor no lo bloquea: lo que queda pasa a «broken».

## 2. Datos — migración 121 `SecretProviderScopes`

- `secret_provider_scopes`:
  - `scope_id` PK, `provider_id`, `label`, con UNIQUE(provider_id, label);
  - `auth_json`: rol, mount o método que sobrescribe el del proveedor, sin secretos (las credenciales por scope llegan con el 04, por el mismo sellado);
  - `allowed_paths_json`: prefijos, al menos uno;
  - `allowed_dynamic_json` (default `[]`, lo usa el 06), `writable` (0/1, lo usa el 08), `probe_reference` NULL;
  - `created_at`, `updated_at`, `created_by`.
- `vault_provider_scopes`: (`vault_id`, `scope_id`) PK y `created_at`. Solo los Vaults de Organizations y los propios del Owner. Nunca el Main vault, que ya es del Owner.
- `vault_entries.provider_scope_id` ya existe (02). Desde ahora, la entrada de un Admin lo exige. La del Owner puede ser NULL (acceso directo, como en el 02).

## 3. Quién hace qué

| Acción                                                                    | Owner | Admin (de la Org del Vault) | Member/Guest |
| ------------------------------------------------------------------------- | ----- | --------------------------- | ------------ |
| Conectar, editar o borrar proveedores; probarlos                          | sí    | no                          | no           |
| Crear, editar o borrar scopes; permitirlos a Vaults                       | sí    | no                          | no           |
| Provider entry sin scope (directa)                                        | sí    | no                          | no           |
| Provider entry con scope permitido a ese Vault, dentro de `allowed_paths` | sí    | sí                          | no           |
| Ver qué scopes puede usar un Vault                                        | sí    | sí (con `vault.edit`)       | no           |

- `AccessPolicy`:
  - `secretProvider.manage`, de Installation y solo del Owner;
  - `vault.providerEntry` pasa a valer lo mismo que `vault.edit`. El scope permitido lo decide `Vaults` (la política no ve scopes).

## 4. Rutas permitidas: al guardar Y al leer

- `allowedBy(scope, ref)` pasa de ser siempre verdadero a esto:
  - el scope existe y su proveedor es el de la entrada;
  - el scope está permitido al Vault de la entrada;
  - la referencia ya normalizada (02) empieza por un prefijo en un **límite de segmento**: igual al prefijo, o el prefijo seguido de `/`, `#` o `?`. Así `kv/acme` no deja pasar `kv/acme-evil/x`;
  - la comparación distingue mayúsculas: OpenBao y la mayoría de proveedores las distinguen.
- **Al leer** se repite entera. `ProviderRef` gana `vaultId` (lo pone `EffectiveVaults`). Es el único cambio que toca `SecretDelivery`: pasa el ref tal cual.
- **Si deja de cumplirse** (scope borrado o recortado, permiso retirado, proveedor borrado), la entrada queda «broken»: no se entrega y el arranque no falla, como un link roto.
  - `Vaults.listEntries` lo calcula sin leer el proveedor.
  - Borrar o recortar un scope, o retirar un permiso, responde con la lista de entradas que se rompen y no cambia nada si no lleva `confirm: true` (el patrón de `breakLinks`).

## 5. «Test connection»

- `secretProviders.test({ providerId, scopeId? })`:
  - llama a `driver.test(config)` para la autenticación;
  - con un scope, hace además una lectura de su `probe_reference`, la ruta que el Owner eligió y que debe caer en `allowed_paths`;
  - va directo, sin caché;
  - responde `{ auth: ok|error, probe?: ok|error }` con clases (`forbidden`, `not-found`, `unavailable`, `invalid`) y nunca un valor.
- Se audita `secret_provider.test` con el resultado.

## 6. Puertas, auditoría y web

- **WS** (Installation, solo el Owner, en `RPC_SPACE_ACCESS`):
  - `secretProviders.test` y `secretProviders.impact`;
  - `secretProviders.scopes.list|put|delete|allow`.
- **WS para editores:** `vaults.providerScopes({ vaultId })`. Lista los scopes permitidos a ese Vault: etiqueta, proveedor, prefijos y el placeholder del driver. Nunca credenciales ni `auth_json`.
- `DoorRules`: las nuevas en sus tablas. Ninguna respuesta lleva `value`, `credential`, `token` ni `auth`.
- **Auditoría** (sin valores ni credenciales):
  - `secret_provider.create|update|delete`, desde el diff de `secretProviders` en `updateSettings`, más `secret_provider.test`;
  - `provider_scope.create|update|delete|allow` con etiqueta, proveedor y número de prefijos.
- **Web** (Settings → Secrets, panel ya existente):
  - por proveedor, «Test connection» y la sección «Scopes»: etiqueta, prefijos (uno por línea), «Writable», «Probe path», Vaults permitidos;
  - confirmación al borrar, con la lista de lo que se rompe.
  - En «Add a secret to <Vault>»: «Source: Value / Provider». Con Provider, selector de scope (y «Direct» solo para el Owner) y el campo de referencia con el placeholder del driver.
- **Móvil:** ticket 16 (conflicto 3).

## 7. Tests red-first (se amplían los existentes)

- `Vaults.test`:
  - un Admin fuera de los `allowed_paths`, también con `..`, `//`, `%2e`, mayúsculas distintas o `kv/acme-evil`, se rechaza;
  - un Admin con un scope no permitido a su Vault, o sin scope, se rechaza;
  - un Member nunca;
  - recortar un prefijo, borrar el scope o retirar el permiso deja «broken», y sin `confirm` solo lista.
- `SecretDelivery.test`: la entrada rota tras el cambio no se entrega y la lectura no llega al driver. Es la comprobación al leer.
- `ProviderReads.test`: límite de segmento y mayúsculas; la credencial sellada se resuelve; nunca sale en errores ni logs.
- `serverSettings.test`: credencial que se referencia a sí misma, o ciclo A → B → A, se rechaza; un literal se sella y llega redactado.
- `SecretProviderScopes.test` (nuevo): CRUD y permisos solo del Owner; `test` sin valor.
- `121_*.test`, `AccessPolicy.test`, `DoorRules.test`, `AuditLog`: las claves nuevas.

## 8. Riesgos y fuera del ticket

- **Riesgos:**
  - el 05 cambia `SecretDelivery` en paralelo; mi cambio allí es una línea (pasar `vaultId`), y el conflicto, si lo hay, es trivial;
  - recortar un scope rompe entradas en Threads activos en su siguiente arranque, y eso es lo que se busca.
- **Fuera:**
  - drivers nuevos (04, 09–12);
  - `allowed_dynamic` y Leases (06);
  - `writable` y Provider-backed vaults (08);
  - credenciales por scope (04);
  - móvil (16);
  - auditoría `secret.read`.
- **Docs:**
  - `docs/user`: conectar un proveedor; por qué un rol por scope (la política del proveedor es la segunda barrera si el Hub se equivoca);
  - `docs/internals/secrets.md`: «Provider scopes».

## Conflictos y recomendación

1. **El ticket pide WS `secretProviders.list|put|delete`**, pero ya existen la puerta de ajustes y su UI. → **Reutilizarlas**, añadir solo `test` e `impact`, y auditar el diff en `updateSettings`. Así no hay dos caminos para lo mismo.
2. **Credenciales selladas:** ningún driver las usa antes del 04. → **Construir en el 03** el mecanismo genérico (`credentialFields`, sellado, redactado, resolución y regla del ciclo), probado con un kind de test, para que el 04 solo tenga que declarar campos.
3. **El ticket pide móvil**, pero la fase 1 es solo web. → **Móvil en el 16.**
4. **Recortar un scope:** ¿fallo del arranque o «broken»? El spec dice «broken» y no entregar. → **«broken»**: un fallo bloquearía todos los turnos por un cambio deliberado del Owner.
5. **El Owner sin scope:** el 02 lo permitía. → **Mantenerlo** para el Owner («Direct»). Los Admins siempre con scope.
