# 02: Conectar Stripe y asociar Prices a Plans

**What to build:** En el modal Plataforma → «Payments» el Owner pega la clave secreta y el secreto del webhook de Stripe (solo escritura), copia la URL del webhook, asocia a cada Plan de pago un Price de Stripe (el Hub lee importe e intervalo) y activa o desactiva los pagos. Ver spec, «Configuración».

**Blocked by:** 01 (solo la decisión de proveedor: si sale Paddle, se reescribe este ticket); `../../plans-and-limits/issues/01-planes-plan-por-defecto-y-maquinas-propias.md`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Secrets `billing-stripe-secret-key` y `billing-stripe-webhook-secret` en `ServerSecretStore`; se reemplazan o borran, nunca se devuelven. Red-first: `billing.settings` no lleva ninguna clave (fila en el barrido de `DoorRules.test.ts`).
- [ ] Migración: `plan_prices` y `billing_settings`.
- [ ] `StripeClient` (`apps/server/src/billing/StripeClient.ts`) con `HttpClient` de Effect, sin SDK; aquí solo `retrievePrice`. Guardar un Price lo lee en Stripe y rechaza uno inexistente o no recurrente.
- [ ] Reglas: el plan por defecto no tiene Price; activar exige las dos claves, `T3CODE_PUBLIC_URL` y un Plan con Price; borrar un Plan con Price se rechaza (`Plans` de `../../plans-and-limits/`).
- [ ] Puertas: `billing.settings`, `billing.setPlanPrice` (solo Owner) y `billing.plans` (cualquier User; Plans de pago con precio, solo si los pagos están activos) en `HTTP_ENDPOINT_RULES`.
- [ ] Auditoría `billing.settings.update`, `billing.price.set`, `billing.enable`, `billing.disable`.
- [ ] Web/desktop: modal Plataforma → «Payments». Desactivar oculta «Upgrade» a los Users y no toca suscripciones existentes.
- [ ] Docs: `docs/operations/` (configurar Stripe para un Hub).
