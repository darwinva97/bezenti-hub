# 07: Workload identity tokens

**What to build:** El Hub como emisor OIDC (ADR 0009): claves ES256 selladas con rotación y solape, rutas públicas de discovery y JWKS, entradas `identity` (audiencia, TTL) entregadas siempre como Secret file sellado y refrescadas a 2/3 de su vida, y el método de auth `hub_identity` para que el Hub entre en proveedores sin credencial guardada. Ver spec, «Workload identity tokens».

**Blocked by:** 05

**Status:** needs-triage

- [ ] Claves en el almacén cifrado: generación, rotación cada 30 días, publicación 7 días antes y retirada 7 días después; nunca en `t3 secrets key export`.
- [ ] Raw routes públicas `/.well-known/openid-configuration` y `/.well-known/jwks.json` (404 mientras no se usen, pregunta 12); `T3CODE_IDENTITY_ISSUER` y la URL de discovery interna documentadas.
- [ ] Red-first: el JWKS nunca contiene `d`; un token de audiencia no permitida no se emite; los claims salen del Thread real (Space, Project, User, Environment) y nunca nombran Vaults.
- [ ] Entrada `identity` solo para el Owner; sellada y `file` por CHECK.
- [ ] `hub_identity` como auth de OpenBao (JWT auth) con `sub` `t3:hub:<installation>` y claim `scope`.
- [ ] Auditoría `identity.issue` con `aud`, `sub`, `jti`, `exp`.
- [ ] Prueba real: un k3s con `AuthenticationConfiguration` (username `t3:` + `username`, grupos `t3:space:<slug>`) acepta el token y aplica el RBAC del Space; otro Space recibe 403.
- [ ] Docs: recetas de Kubernetes, OpenBao JWT, AWS, Google Cloud y Azure en `docs/user`.
