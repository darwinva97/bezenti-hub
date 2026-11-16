# 11: Infisical, Doppler, Bitwarden Secrets Manager y Kubernetes

**What to build:** Cuatro drivers: `infisical` (universal auth, Kubernetes auth u OIDC con la identidad del Hub; también sus dynamic secrets), `doppler` (service token), `bitwarden_sm` (`bws` con access token) y `kubernetes` (Secrets de un namespace con el ServiceAccount del Hub, un kubeconfig sellado o la identidad del Hub, más `TokenRequest` de un ServiceAccount como Dynamic secret sin revocación). Ver spec, tabla «Proveedores» y pregunta 11.

**Blocked by:** 03; `TokenRequest` como dinámico, 06

**Status:** needs-triage

- [ ] Un paquete por driver, con servidor o binario falso en sus tests.
- [ ] Red-first (`kubernetes`): un namespace fuera de `allowed_paths` se rechaza; el driver no escribe Secrets; `TokenRequest` respeta audiencia y TTL del scope.
- [ ] Docs: recetas, entre ellas la del clúster de bezenti con `TokenRequest` de `agentes/claude`.
