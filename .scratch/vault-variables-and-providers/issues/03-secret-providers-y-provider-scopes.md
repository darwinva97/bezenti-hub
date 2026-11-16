# 03: Secret providers y Provider scopes en Settings

**What to build:** Settings → Secret providers: conectar, editar, probar y borrar proveedores (configuración en `settings.secretProviders` y credenciales selladas) y sus Provider scopes (rol, rutas y prefijos dinámicos permitidos, `writable`), permitidos a Vaults concretos. Los Admins añaden Provider entries solo dentro de los scopes permitidos a su Vault. Ver spec, «Quién hace qué» y «Provider scopes».

**Blocked by:** 02

**Status:** needs-triage

- [ ] Migración: `secret_provider_scopes`, `vault_provider_scopes`.
- [ ] WS `secretProviders.list|put|delete|test`, `secretProviders.scopes.list|put|delete|allow` (Installation, solo Owner) en `RPC_SPACE_ACCESS`.
- [ ] Red-first: un Admin no añade una entrada fuera de los `allowed_paths` del scope, tampoco con `..`, `//`, `%2e` o mayúsculas distintas. La comprobación se repite al leer: quitar un prefijo del scope rompe la entrada.
- [ ] Red-first: la credencial de un proveedor no puede ser una referencia a ese mismo proveedor.
- [ ] Borrar un proveedor o un scope lista las entradas que se rompen y pide confirmación; luego quedan «broken».
- [ ] «Test connection» por proveedor y por scope (auth y una lectura de prueba de una ruta permitida, elegida por el Owner), sin mostrar el valor.
- [ ] Auditoría `secret_provider.*`, `provider_scope.*`.
- [ ] Web y desktop: Settings → Secret providers; en el formulario de un Vault, «Source: Provider» con selector de scope y campo de referencia con el placeholder del driver. Móvil: lo mismo.
- [ ] Docs: `docs/user` (conectar un proveedor; por qué un rol por scope).
