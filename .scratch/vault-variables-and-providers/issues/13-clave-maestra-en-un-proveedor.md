# 13: Clave maestra en un proveedor

**What to build:** `T3CODE_MASTER_KEY_SOURCE` = `file` | `openbao-transit` | `aws-kms` | `gcp-kms` | `azure-keyvault`, con la clave de datos guardada envuelta y desenvuelta al arrancar con credenciales del despliegue (nunca del almacén). `t3 secrets key wrap|unwrap` para pasar de una fuente a otra y volver. Ver spec, «Clave maestra en un proveedor».

**Blocked by:** 04, 10

**Status:** needs-triage

- [ ] Red-first: proveedor caído al arrancar → el Hub no arranca, con un mensaje claro (pregunta 10); una clave envuelta con otra clave de KMS no abre el almacén.
- [ ] `wrap` y `unwrap` con el Hub parado, reanudables como la rotación actual.
- [ ] Settings explica que la copia de seguridad es la clave envuelta.
- [ ] Docs: `docs/internals/secrets.md` y la guía de despliegue (Transit de OpenBao en k3s).
