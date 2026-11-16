# 18: Receta bezenti: clúster y OpenBao

**What to build:** Los cambios de `darwinva97/infra-contabo` (no de este repo) para que los Threads de `claude.bezenti.com` accedan al clúster con lo de este spec, y la retirada de las credenciales actuales. Ver spec, «Further Notes».

**Blocked by:** 05, 07 (o 11 para la variante con `TokenRequest`)

**Status:** ready-for-human

- [ ] Retirar de `bezenti-ti` el `KUBECONFIG` (`system:masters`, válido hasta 2027-11-10) y `SSH_PASSWORD` (root); rotar la CA de clientes de k3s, porque el certificado quedó expuesto en un Thread.
- [ ] k3s: segunda entrada `jwt` en `/etc/rancher/k3s/autenticacion-api.yaml` con el emisor del Hub, `discoveryURL` interna (el dominio público está tras Cloudflare Access), username `t3:` + `username`, grupos `t3:space:<slug>`; RBAC por Space (`view` por defecto) en `manifiestos/`.
- [ ] Cloudflare Access: excluir `/.well-known/openid-configuration` y `/.well-known/jwks.json` de `claude.bezenti.com` si algún verificador entra por fuera.
- [ ] Red: ufw permite el 6443 desde `hub-vps` (72.60.66.80) solo, o un túnel dedicado; añadir la IP a `tls-san` si cambia la dirección.
- [ ] OpenBao: rol de Kubernetes auth para `bezenti-hub/openbao-lector` (ya existe el SecretStore `openbao` sin uso) o JWT auth con la identidad del Hub; una política por scope; NetworkPolicies `bezenti-hub` → `openbao:8200` (salida del Hub y entrada de OpenBao; hoy ambas lo bloquean).
- [ ] Deployment del Hub: volumen de token proyectado con audiencia `vault` (mantener `automountServiceAccountToken: false`).
- [ ] Auditoría de la API: regla `Metadata` para `t3:` (usuarios del Hub) antes de la regla que descarta `get/list/watch`.
- [ ] En el Hub: Vault «cluster-lectura» con `KUBE_SERVER` y `KUBE_CA` (Variables), `KUBE_TOKEN` (identidad, `none`) y `KUBECONFIG` (plantilla, `file`), permitido solo a los Projects que lo necesitan, con `deliverTo: [sandbox, dedicated]`.
- [ ] SSH del nodo: solo clave, `PermitRootLogin prohibit-password`, idealmente solo por `wg0`.
