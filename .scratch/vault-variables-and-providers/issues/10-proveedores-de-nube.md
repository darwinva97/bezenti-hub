# 10: Proveedores de nube

**What to build:** Drivers `aws_secrets_manager`, `aws_ssm`, `gcp_secret_manager` y `azure_key_vault`, con autenticación estática (sellada) o federada: `AssumeRoleWithWebIdentity`, workload identity federation y federated credential, usando la identidad del Hub (07) o un token proyectado. Claves JSON con `#clave` y versiones. Ver spec, tabla «Proveedores».

**Blocked by:** 03; la parte federada, 07

**Status:** needs-triage

- [ ] Firmado SigV4 y llamadas a las APIs REST sin SDK pesado, o con los SDK oficiales si el tamaño del ejecutable lo permite (decidir en el ticket con mediciones).
- [ ] Red-first: credenciales estáticas nunca en logs; una referencia de otra cuenta o proyecto fuera de `allowed_paths` se rechaza.
- [ ] Tests con servidores falsos; pruebas opcionales reales por variable.
- [ ] Docs: recetas por nube, también para los agentes con la identidad del Thread (`AWS_WEB_IDENTITY_TOKEN_FILE`, `external_account` como plantilla, `AZURE_FEDERATED_TOKEN_FILE`).
