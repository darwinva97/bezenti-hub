# 15: Ajustes del Owner con todos los proveedores

**What to build:** Los ajustes que ya aceptan `SecretReference` (AI accounts, tokens de source control, entornos de provider instances, CLIProxyAPI externo) ofrecen todos los proveedores conectados, sin scopes, y respetan `requireSettingsSecret`. Ver spec, «Ajustes del Owner».

**Blocked by:** 03

**Status:** needs-triage

- [ ] `SecretSourceInput` y `SecretProviderDialog` dejan de suponer 1Password (`classifySecretProvider` por registro).
- [ ] Red-first: una referencia de un proveedor caído hace fallar el ajuste con `SettingsSecretUnresolvedError` y nunca cambia de cuenta en silencio.
- [ ] Caché de los ajustes con la caducidad del driver; «Refresh» la invalida como hoy.
