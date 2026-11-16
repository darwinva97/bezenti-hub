# Spec: Pagos

Status: needs-triage
Map: ../public-hub/map.md (spec 6 de 6, fase 7)
Decisiones de origen: «Planes y límites» («Los pagos llegan al final y solo cambian el plan de alguien»), «Owner como operador»
ADRs: 0008 (plataforma abierta con un Owner operador), 0012 (Secrets de solo escritura), 0007 (ningún servicio de pingdotgg; un proveedor de pagos que el Owner configura con su propia cuenta no lo contradice)
Vocabulario: `GLOSSARY.md`: Plan, User, Owner
Depende de: `../plans-and-limits/` (Plans, `Plans.assignPlan` con `source`), `../settings-modals/` (modales Usuario y Plataforma), `../platform-privacy/` (términos de uso)

## Problem Statement

Con planes y límites (`../plans-and-limits/`) el Owner decide a mano qué Plan tiene cada User. En una plataforma abierta eso no escala: quien quiere más capacidad tiene que escribir al Owner, y el Owner cobra por fuera y cambia el Plan a mano, y otra vez a mano cuando la persona deja de pagar.

## Solution

Un proveedor de pagos, **Stripe**, solo cambia el Plan de un User. El Hub no factura, no guarda tarjetas, no calcula impuestos ni reintenta cobros.

- El Owner conecta su cuenta de Stripe en el modal Plataforma (claves de solo escritura) y asocia a cada Plan de pago un Price de Stripe.
- Un User elige un Plan de pago en el modal Usuario → «Plan» y paga en Stripe Checkout, alojado por Stripe.
- Un webhook firmado avisa al Hub; el Hub lee la suscripción en Stripe y pone el Plan que corresponde a su Price.
- Cuando la suscripción termina (cancelada al final del periodo, o impagada tras los reintentos de Stripe), el User vuelve al plan por defecto. Nada se borra (regla de `../plans-and-limits/`).
- Facturas, recibos, cambio de tarjeta y cancelación: en el Customer Portal de Stripe, al que el Hub solo enlaza.

## Por qué Stripe

| | Stripe | Paddle / Lemon Squeezy (Merchant of Record) | Mollie, PayPal |
| --- | --- | --- | --- |
| Checkout y portal alojados | sí, los dos | sí | checkout sí; portal de suscripción limitado o ninguno |
| Suscripciones y reintentos | Stripe Billing, configurable («cancelar tras reintentos») | sí | Mollie sí, más básico; PayPal, con otra API |
| Impuestos (IVA UE, OSS) | los calcula Stripe Tax, pero el comerciante y sus declaraciones son del Owner | el proveedor es el vendedor y los paga | del Owner |
| Coste | ~1,5 % + 0,25 € (tarjeta UE) + Billing ~0,7 % | ~5 % + 0,50 $ | similar a Stripe |
| Modo test, CLI para webhooks | sí (`stripe listen`) | sandbox | parcial |

**Recomendación:** Stripe. Tiene las dos piezas alojadas que mantienen el Hub pequeño (Checkout y Customer Portal), webhooks firmados con un esquema HMAC sencillo, reintentos y cancelación configurables en su panel, y modo test completo. La alternativa honesta es un Merchant of Record (Paddle) si el Owner no quiere gestionar el IVA de clientes de toda la UE: cambia el módulo del proveedor y no el resto. Es una decisión de comerciante y queda en el ticket 01 (`ready-for-human`).

## User Stories

1. As the Owner, I want to connect my Stripe account by pasting its secret key and webhook signing secret, never to see them again, so that payments work without exposing the keys.
2. As the Owner, I want to choose, for each paid Plan, the Stripe Price that buys it, and see its amount and interval read from Stripe, so that the price shown is the price charged.
3. As the Owner, I want the Platform modal to give me the webhook URL to paste into Stripe, and to refuse enabling payments when the Hub has no public URL, so that webhooks can arrive.
4. As the Owner, I want to turn payments off, so that nobody can start a new subscription while existing ones keep working until they end.
5. As a User, I want to see the paid Plans with their price and limits in the User modal, and pay for one in Stripe Checkout, so that I get more capacity without writing to anyone.
6. As a User, I want my Plan to change as soon as Stripe confirms the payment, so that I can use it at once.
7. As a User, I want a «Manage subscription» link to Stripe's portal, so that I can change card, see invoices, switch Plan or cancel.
8. As a User who cancels, I want to keep my Plan until the end of the period I paid and then return to the default Plan, so that I get what I paid for.
9. As a User whose payment fails, I want to keep my Plan while Stripe retries and return to the default Plan if it finally fails, so that a bad card does not cut me off at once.
10. As a User, I want the User modal to say when my subscription renews or ends, so that nothing surprises me.
11. As the Owner, I want the Platform modal to show each User's subscription status, Plan and period end, but no card or invoice details, so that I can help without seeing payment data.
12. As the Owner, I want every Plan change made by a payment recorded in the audit log as made by billing, so that I can tell it apart from my own changes.

## Implementation Decisions

### Configuración

- **Secrets** en `ServerSecretStore` (cifrados, `apps/server/src/auth/ServerSecretStore.ts`), de solo escritura (ADR 0012): `billing-stripe-secret-key`, `billing-stripe-webhook-secret`. Se reemplazan o se borran; nunca se leen desde un cliente.
- **Migración nueva:** `plan_prices(plan_id PK, stripe_price_id UNIQUE, amount, currency, interval, updated_at)`. Un Price por Plan. El importe se lee de Stripe al guardar y se guarda solo para mostrarlo.
- `billing_settings`: una fila con `enabled`. Activar exige las dos claves, `T3CODE_PUBLIC_URL` y al menos un Plan con Price.
- El plan por defecto no puede tener Price. Borrar un Plan con Price o con suscripciones activas se rechaza (quitar el Price primero; Pregunta abierta 4).

### Cliente de Stripe

- Llamadas REST con el `HttpClient` de Effect, sin el SDK de Stripe: crear una Checkout Session, crear una Billing Portal Session, leer una Subscription y leer un Price. Módulo único `apps/server/src/billing/StripeClient.ts`; cambiar de proveedor es cambiar este módulo y el parser del webhook.
- **Checkout:** `mode=subscription`, el Price del Plan, `client_reference_id` = userId, `customer` si el User ya tiene uno, URLs de vuelta a `T3CODE_PUBLIC_URL` (en desktop y móvil se abre el navegador del sistema). Un User con una suscripción activa no abre otro Checkout: cambia de Plan en el portal.
- **Portal:** sesión para el `customer` del User; el Hub devuelve la URL y el cliente la abre.

### Webhook

- Raw route `POST /api/billing/stripe/webhook` (necesita el cuerpo sin tocar para la firma), declarada en `RAW_ROUTE_RULES` (`apps/server/src/auth/DoorRules.ts`): sin sesión, autorizada solo por la firma.
- Comprueba `Stripe-Signature` (HMAC-SHA256 del secreto, tolerancia de 5 minutos, comparación en tiempo constante). Sin firma válida: 400 y nada más.
- **Idempotente:** `billing_events(event_id PK, received_at)`; un evento repetido responde 200 sin hacer nada.
- **No se fía del orden ni del contenido del evento:** para `checkout.session.completed`, `customer.subscription.created|updated|deleted` lee la Subscription actual en Stripe y aplica una sola regla:
  - estado `active`, `trialing` o `past_due` → el Plan asociado a su Price;
  - cualquier otro (`canceled`, `unpaid`, `incomplete_expired`…) o Price sin Plan → el plan por defecto.
- «Al final del periodo» y «tras los reintentos» los hace Stripe (portal configurado para cancelar al final del periodo; reintentos configurados para cancelar la suscripción al agotarse). El Hub no tiene temporizadores ni lógica de cobro.
- Aplica con `Plans.assignPlan({ userId, planId, source: "billing" })` de `../plans-and-limits/`: auditoría `plan.assign` con `source`.
- `user_billing(user_id PK, stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end, cancel_at_period_end, updated_at)`: lo que el User y el Owner ven.

### Plan del Owner frente a Plan de pago

- Mientras un User tiene una suscripción viva, el siguiente evento de Stripe vuelve a poner el Plan de su Price. El Owner puede cambiarle el Plan a mano, pero el modal Plataforma avisa: «This User's plan is managed by a subscription; the next billing event will set it again» (Pregunta abierta 3).

### Puertas

- **HttpApi** (`HTTP_ENDPOINT_RULES`): `billing.settings` (leer sin secretos, guardar, activar; solo Owner), `billing.setPlanPrice` (solo Owner), `billing.plans` (Plans de pago con precio; cualquier User), `billing.checkout` y `billing.portal` (el propio User), `billing.status` (el propio; con `userId`, solo Owner).
- **Raw route:** el webhook. **MCP, WS:** ninguna. Un agente no paga ni cambia Plans.

### Clientes

- **Web y desktop:** modal Plataforma → «Payments» (claves, URL del webhook, Price por Plan, activar o desactivar, estado por User). Modal Usuario → «Plan»: Plans de pago con precio, «Upgrade», «Manage subscription», renovación o fin.
- **Móvil:** solo lectura: Plan, estado y fecha de fin. Sin precios ni enlaces de compra, por las reglas de compras en apps de App Store y Google Play (Pregunta abierta 2).

### Auditoría

- `billing.settings.update`, `billing.price.set`, `billing.enable`, `billing.disable`; `plan.assign` con `source: billing`. Nunca importes de tarjeta, ni ids de método de pago.

### Documentación

- `docs/user/`: una sección «Paid plans» (en la página de «Plans and limits») para el User: cómo subir, cómo cancelar, qué pasa al terminar.
- `docs/operations/`: configurar Stripe para un Hub (Products y Prices, portal con cancelación al final del periodo, reintentos que cancelan, endpoint del webhook, modo test con `stripe listen`).

## Testing Decisions

- **Webhook:** tests con cuerpos de eventos reales de Stripe guardados como fixtures y un `HttpClient` falso de Stripe: firma válida, inválida, caducada; evento repetido; eventos fuera de orden; cada estado de suscripción da el Plan esperado (tabla). Red-first.
- **Checkout y portal:** el `HttpClient` falso recibe los parámetros esperados (`client_reference_id`, Price, URLs con `T3CODE_PUBLIC_URL`); un User con suscripción activa no abre otro Checkout.
- **Secrets:** ninguna respuesta de `billing.settings` lleva una clave (fila en el barrido de `DoorRules.test.ts`).
- **Prueba real:** modo test de Stripe con `stripe listen` hacia un Hub de desarrollo (ticket 05).
- **Prior art:** `ServerSecretStore.test.ts`, `scheduledTasks/webhookRoute.ts` y sus tests, `AiGatewayRoute.test.ts` (HttpClient falso).

## Out of Scope

- Facturas, recibos, notas de crédito, impuestos, reembolsos y reintentos de cobro en el Hub: todo en Stripe.
- Pagos únicos, créditos de tokens, cobro por uso: solo suscripciones a un Plan.
- Varios Prices por Plan (mensual y anual): uno por Plan en esta fase.
- Que una Organization pague su Plan: el Plan es siempre de un User (el Steward).
- Varios proveedores a la vez.

## Further Notes

- **Borrar una cuenta** (`../platform-privacy/`) cancela antes su suscripción en Stripe; el criterio va en ese spec, este ofrece `StripeClient.cancelSubscription`.
- **Sin URL pública no hay pagos:** un Hub solo en Tailscale no recibe webhooks; el modal lo dice.
- **Orden sugerido:** 01 (humano, en paralelo) → 02 → 03 → 04 → 05.

## Preguntas abiertas

1. **¿Stripe o un Merchant of Record (Paddle)?** Recomendación: Stripe si el Owner ya factura como empresa en la UE y acepta declarar el IVA (OSS) con Stripe Tax; Paddle si no. Decisión del ticket 01.
2. **¿Pagar desde la app móvil?** Las tiendas exigen su propio sistema de compras para bienes digitales y limitan enlazar a pagos externos. Recomendación: el móvil no muestra precios ni enlaces de compra; se paga en web o desktop.
3. **¿Quién gana, el Owner o la suscripción?** Recomendación: la suscripción, con aviso al Owner; para regalar un Plan a alguien que paga, se cancela su suscripción en Stripe.
4. **¿Qué pasa con los suscriptores si el Owner borra o deja sin Price un Plan?** Recomendación: no se puede mientras haya suscripciones activas a su Price; el Owner migra antes los Prices en Stripe.
5. **¿Prueba gratuita?** Recomendación: si se quiere, se configura como `trial` en el Price de Stripe; el Hub ya trata `trialing` como activo y no añade nada.
