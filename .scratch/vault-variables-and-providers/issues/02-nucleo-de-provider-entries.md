# 02: Núcleo de Provider entries

**What to build:** Una entrada puede ser `kind = 'provider'`: guarda scope y referencia, y el Hub la lee al arrancar el proceso. Amplía el contrato de driver (`read` con `expiresAt` y errores clasificados), sustituye la caché de por vida por una con caducidad para estas lecturas, calcula la huella con HMAC del valor, registra lo entregado en `delivered_values` para enmascararlo, y falla el arranque entero con un error tipado si un proveedor no responde. En este ticket, solo el Owner crea Provider entries, y se prueba con un driver de test. Ver spec, «Provider entries» y «Contrato de driver».

**Blocked by:** 01

**Status:** needs-triage

- [ ] Migración: `kind` ampliado, `provider_scope_id`, `provider_reference`; tabla `delivered_values` (sellada, por raíz de Thread, borrada con el Thread).
- [ ] `packages/secret-provider-core`: `ReadResult` (`value`, `expiresAt?`, `version?` | `error`), `test`. El driver de 1Password se adapta sin cambiar de comportamiento.
- [ ] `SecretDelivery.resolve` lee las Provider entries agrupadas por proveedor y scope, en paralelo, con timeout de 10 s; caché por `expiresAt` o `refreshInterval`.
- [ ] Red-first: proveedor que no responde → `SecretProviderUnavailableError { provider, scope, entries }`, y no se entrega nada del conjunto. `forbidden` y `not-found` tienen sus propios códigos.
- [ ] Red-first: un valor rotado en el proveedor cambia la huella y reabre la sesión en el siguiente turno; la huella no contiene el valor ni su hash simple.
- [ ] Red-first: un valor leído del proveedor sale como `[NOMBRE]` en el historial, en la terminal y en los logs, también después de que el proveedor cambie el valor.
- [ ] Entrada con scope o proveedor borrado → «broken», sin entregar.
- [ ] `vaults.reveal` responde `sealed` para Provider entries.
- [ ] Error en el Thread con «Retry» (web, desktop, móvil).
- [ ] Docs: `docs/internals/secrets.md` («Provider entries»), ADR 0008 enlazada.
