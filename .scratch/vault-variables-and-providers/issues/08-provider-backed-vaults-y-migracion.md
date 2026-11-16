# 08: Provider-backed vaults y migración en los dos sentidos

**What to build:** Ligar un Vault a una ruta de un scope (`list`), con clase y entrega desde los metadatos del proveedor; escritura con _check-and-set_ cuando el scope es `writable`; «Move to provider» de una entrada propia y «Copy into the Hub» (sellada) de una Provider entry. Ver spec, «Provider-backed vaults».

**Blocked by:** 04

**Status:** needs-triage

- [ ] Migración: `vaults.provider_scope_id`, `provider_path`, `backed`.
- [ ] WS `vaults.bind|unbind`, `vaults.refresh`, `vaults.entries.move`, `vaults.entries.copyIntoHub`.
- [ ] Contrato de driver: `list`, `write` (con `cas`); OpenBao KV v2 con `custom_metadata` `t3.class.<CLAVE>` y `t3.delivery.<CLAVE>`.
- [ ] Red-first: claves que no son nombres válidos → «invalid name», no se entregan; una escritura sobre una versión cambiada → «changed in the provider», sin pisar; sin `writable`, no hay «Add», «Replace value» ni «Delete».
- [ ] Red-first: «Copy into the Hub» solo para el Owner y siempre sellada; «Move to provider» deja la entrada como Provider entry, y la siguiente entrega lee del proveedor.
- [ ] Caché de la lista de 60 s; nunca se lee el proveedor para pintar la lista de Vaults.
- [ ] `request_secret` escribe en un Provider-backed vault `writable`.
- [ ] Auditoría `vault.bind`, `secret.edit` con `move-to-provider` y `copy-into-hub`.
- [ ] Web y móvil: «Bind to provider», estado de la última lectura, «Refresh».
