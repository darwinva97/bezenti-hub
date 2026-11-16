# 03: Checkout y webhook cambian el Plan

**What to build:** Un User elige un Plan de pago en el modal Usuario → «Plan» y paga en Stripe Checkout. El webhook firmado de Stripe llega al Hub, que lee la suscripción en Stripe y pone el Plan de su Price, o el plan por defecto cuando la suscripción ha terminado. Ver spec, «Cliente de Stripe» y «Webhook».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `StripeClient.createCheckoutSession` y `retrieveSubscription`. Checkout con `mode=subscription`, `client_reference_id` = userId, `customer` si ya existe, URLs de vuelta a `T3CODE_PUBLIC_URL`. Un User con suscripción viva recibe un error que le manda al portal.
- [ ] Raw route `POST /api/billing/stripe/webhook` en `RAW_ROUTE_RULES`: firma HMAC-SHA256 con tolerancia de 5 minutos y comparación en tiempo constante; `billing_events` para idempotencia.
- [ ] Migración: `billing_events` y `user_billing`.
- [ ] Una sola regla, `planForSubscription(status, priceId)`: `active`, `trialing`, `past_due` → Plan del Price; el resto, o Price sin Plan → plan por defecto. Se aplica con `Plans.assignPlan({ source: "billing" })`.
- [ ] Red-first con fixtures de eventos reales y un `HttpClient` falso: firma inválida o caducada → 400 sin cambios; evento repetido → 200 sin cambios; `updated` antes que `created` deja el estado correcto (se lee la suscripción); cancelación con `cancel_at_period_end` no cambia el Plan hasta `deleted`; `deleted` → plan por defecto sin borrar nada.
- [ ] Puerta `billing.checkout` (el propio User) en `HTTP_ENDPOINT_RULES`.
- [ ] Web/desktop: Plans de pago con precio y límites; «Upgrade» abre Checkout (en desktop, en el navegador del sistema); al volver, el modal muestra el Plan nuevo en cuanto llega el evento.
