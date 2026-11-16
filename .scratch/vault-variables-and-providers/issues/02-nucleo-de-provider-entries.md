# 02: Núcleo de Provider entries

**What to build:** Una entrada puede ser `kind = 'provider'`: guarda scope y referencia, y el Hub la lee al arrancar el proceso. Amplía el contrato de driver (`read` con `expiresAt` y errores clasificados), sustituye la caché de por vida por una con caducidad para estas lecturas, calcula la huella con HMAC del valor, registra lo entregado en `delivered_values` para enmascararlo, y falla el arranque entero con un error tipado si un proveedor no responde. En este ticket, solo el Owner crea Provider entries, y se prueba con un driver de test. Ver spec, «Provider entries» y «Contrato de driver».

**Blocked by:** 01

**Status:** needs-triage

- [x] Migración (120): `kind` ampliado, `provider_id`, `provider_reference`, `provider_scope_id` (NULL hasta el 03). En lugar de la tabla `delivered_values` (decisión del diseño 02): filas `delivered:<HMAC>` en `thread_secret_values` y un almacén sellado `DeliveredValueStore`, borrados con el Thread.
- [x] `packages/secret-provider-core`: `ReadResult` (`value`, `expiresAt?`, `version?` | `error`), `test`. El driver de 1Password se adapta sin cambiar de comportamiento.
- [x] Las Provider entries se leen agrupadas por proveedor y scope, en paralelo, con timeout de 10 s; caché por `expiresAt` o `refreshInterval` (`ProviderReads`). El plan lee a través de la caché (decisión del diseño 02).
- [x] Red-first: proveedor que no responde → `SecretProviderReadError { reason, provider, scope, entries }`, y no se entrega nada del conjunto. `forbidden` y `not-found` tienen sus propios códigos.
- [x] Red-first: un valor rotado en el proveedor cambia la huella y reabre la sesión en el siguiente turno; la huella no contiene el valor ni su hash simple.
- [x] Red-first: un valor leído del proveedor sale como `[NOMBRE]` en el masker del Thread (el mismo de historial, terminal y logs), también después de que el proveedor cambie el valor.
- [x] Entrada con proveedor borrado → «broken», sin entregar (el scope borrado, en el 03).
- [x] `vaults.reveal` responde `sealed` para Provider entries.
- [x] Error en el Thread con «Retry» (web y desktop; móvil en el ticket 16).
- [x] Docs: `docs/internals/secrets.md` («Provider entries»), ADR 0008 enlazada.
