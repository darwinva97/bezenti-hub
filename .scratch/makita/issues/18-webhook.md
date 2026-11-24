# 18: Webhook de GitHub (opcional)

**What to build:** Si el Owner lo decide, `POST /api/makita/github` recibe los eventos de los repositorios donde un administrador configuró el webhook, verifica la firma HMAC y los pasa por el mismo normalizador que el poller; el sondeo sigue de respaldo. Ver spec, «Cómo llegan los eventos» (Webhook) y pregunta abierta 1.

**Blocked by:** 09, y que el Owner lo pida (pregunta abierta 1 decidida: sondeo), y el Bypass de Cloudflare Access que pida el dueño de infraestructura.

**Status:** needs-info (el Owner eligió sondeo el 2026-11-24; este ticket solo se construye si más adelante pide webhook)

**Tipo:** HITL (necesita decisión y un cambio de infraestructura)

**Tanda:** 4

**Seguridad:** sensible (ruta pública). Nota de diseño `18-design.md` antes de construir.

Spec: ../spec.md

- [ ] Secreto del webhook en `MakitaTokenStore`, mostrado una vez para pegarlo en GitHub.
- [ ] Ruta raw con `verifyWebhookSignature` (`X-Hub-Signature-256`, `sha256=`, hex), cuerpo hasta 1 MiB, `X-GitHub-Delivery` registrado; en `RAW_ROUTE_RULES`; cookies refused.
- [ ] Mismas claves naturales que el poller (un evento visto por las dos vías cuenta una vez).
- [ ] Texto para el dueño de infraestructura: Bypass solo en la ruta exacta, regla WAF opcional.
- [ ] Red-first: firma mala → 401 sin tocar la base; el mismo evento por webhook y por sondeo crea una tarea.
