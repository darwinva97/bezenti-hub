# 04: Driver OpenBao / HashiCorp Vault

**What to build:** Kind `openbao`, «OpenBao / HashiCorp Vault»: KV v1 y v2 (versión declarada por mount), `?version=N`, lecturas en lote; autenticación `kubernetes` (token proyectado y audiencia), `jwt` (archivo), `approle`, `token` (renovable) y `cert`; `namespace` y CA propia. Renueva su token antes de que caduque y vuelve a entrar si lo pierde. Ver spec, tabla «Proveedores».

**Blocked by:** 03

**Status:** needs-triage

- [ ] `packages/secret-provider-openbao` (definition + server driver), registrado en `secret-provider-definitions` y en el servidor.
- [ ] Sintaxis `mount/ruta#campo` validada por `isReference`; KV v2 usa `data/` internamente.
- [ ] Un token por scope (el `auth` del scope sobrescribe al del proveedor), en memoria, renovado a 2/3 de su TTL; un 403 por token caducado reintenta una vez tras volver a entrar.
- [ ] Errores clasificados (`not-found` 404, `forbidden` 403, `unavailable` timeout/5xx/sellado).
- [ ] Tests con un OpenBao falso en proceso (`it.live`): cada método de auth, KV v1/v2, versión, lote, renovación y CA propia. Prueba opcional con `bao server -dev` (`T3CODE_TEST_LIVE_OPENBAO=1`).
- [ ] Ningún valor ni token en logs, spans ni errores (test de humo).
- [ ] Prueba real: en un k3s, el Hub entra con su ServiceAccount y un Thread recibe `kv/acme/app#token`.
- [ ] Docs: receta de OpenBao (rol de Kubernetes auth, política por scope).
