# 09: 1Password sin escritorio

**What to build:** El driver `one_password` gana dos formas de autenticación que funcionan en un Hub sin escritorio: service account (token sellado, pasado a `op` solo por el entorno del proceso hijo) y 1Password Connect (HTTP con token). También `list` y `write` por ítem para los Provider-backed vaults. La forma de escritorio no cambia. Ver spec, tabla «Proveedores».

**Blocked by:** 03

**Status:** needs-triage

- [ ] Config con `auth`: `desktop` (hoy) | `service_account` | `connect` (URL, CA).
- [ ] Red-first: el token nunca está en argv ni en logs; `op` corre con entorno limpio.
- [ ] Connect con un servidor falso en proceso; service account con un `op` de prueba.
- [ ] Prueba opcional contra una cuenta real (`T3CODE_TEST_LIVE_1PASSWORD=1`).
