# 18: Receta bezenti: clúster y OpenBao

**What to build:** Los cambios de `darwinva97/infra-contabo` (no de este repo) para que los Threads de `claude.bezenti.com` accedan al clúster con lo de este spec, y la retirada de las credenciales actuales. Ver spec, «Further Notes».

**Blocked by:** 05, 07 (o 11 para la variante con `TokenRequest`)

**Status:** ready-for-human

- [ ] Retirar de `bezenti-ti` el `KUBECONFIG` (`system:masters`, válido hasta 2027-11-10) y `SSH_PASSWORD` (root); rotar la CA de clientes de k3s, porque el certificado quedó expuesto en un Thread.
- [ ] k3s: segunda entrada `jwt` en `/etc/rancher/k3s/autenticacion-api.yaml` con el emisor del Hub, `discoveryURL` interna (el dominio público está tras Cloudflare Access), username `t3:` + `username`, grupos `t3:space:<id del Space>` (claim `groups`; ids, no slugs: ver 07); RBAC por Space (`view` por defecto) en `manifiestos/`.
- [x] Cloudflare Access para las apps nativas (2026-11-16, por la API, **falta pasarlo al código de `infra-contabo`**). Aplicaciones con la política reutilizable `infra-sin-access` (Bypass): `infra · claude-app-api` (`/api`), `infra · claude-app-ws` (`/ws`), `infra · claude-app-well-known` (`/.well-known`, cubre también las rutas de identidad de la ADR 0009), `infra · claude-app-oauth` (`/oauth`). Siguen con `infra-admins`: `infra · claude-owner-registro` (`/api/auth/owner`) e `infra · claude-owner-reset` (`/api/auth/reset`); la web (`infra · claude`) no cambia.
- [x] WAF rate limiting (plan Free): `infra · claude login: limite por IP`, 5 peticiones cada 10 s por IP y bloqueo de 10 s en `/api/auth/password/sign-in`, `/password/totp`, `/passkey/sign-in`, `/recovery-code/sign-in` y `/app-sign-in/token`.
- [ ] Cloudflare corta las peticiones de más de 120 s (Proxy Read Timeout), por ejemplo `request_secret`: decidir si el Hub responde antes o se usa otra ruta.
- [ ] Red: ufw permite el 6443 desde `hub-vps` (72.60.66.80) solo, o un túnel dedicado; añadir la IP a `tls-san` si cambia la dirección.
- [ ] OpenBao: rol de Kubernetes auth para `bezenti-hub/openbao-lector` (ya existe el SecretStore `openbao` sin uso) o JWT auth con la identidad del Hub; una política por scope; NetworkPolicies `bezenti-hub` → `openbao:8200` (salida del Hub y entrada de OpenBao; hoy ambas lo bloquean).
- [ ] Deployment del Hub: volumen de token proyectado con audiencia `vault` (mantener `automountServiceAccountToken: false`).
- [ ] Deployment del Hub: `T3CODE_IDENTITY_ISSUER` (o `T3CODE_PUBLIC_URL`) con el emisor público; sin él, la identidad del 07 está apagada.
- [ ] k3s: el autenticador `jwt` usa como `issuer.discoveryURL` la URL de discovery **interna** del Hub (la de `T3CODE_IDENTITY_DISCOVERY_URL_INTERNAL`), con `issuer.url` igual al emisor público.
- [ ] Auditoría de la API: regla `Metadata` para `t3:` (usuarios del Hub) antes de la regla que descarta `get/list/watch`.
- [ ] En el Hub: Vault «cluster-lectura» con `KUBE_SERVER` y `KUBE_CA` (Variables), `KUBE_TOKEN` (identidad: siempre `file`) y `KUBECONFIG` (plantilla, `file`, con `tokenFile: {{ KUBE_TOKEN | path }}`; una plantilla solo nombra una identidad con `| path`, diseño 07), permitido solo a los Projects que lo necesitan, con `deliverTo: [sandbox, dedicated]`.
- [ ] SSH del nodo: solo clave, `PermitRootLogin prohibit-password`, idealmente solo por `wg0`.
