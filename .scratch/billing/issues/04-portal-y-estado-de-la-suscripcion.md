# 04: Customer Portal y estado de la suscripción

**What to build:** El User abre el Customer Portal de Stripe desde el modal Usuario («Manage subscription») para cambiar tarjeta, ver facturas, cambiar de Plan o cancelar, y ve cuándo renueva o termina su suscripción. El Owner ve el estado de cada User en el modal Plataforma, sin datos de pago. El móvil muestra el Plan y el estado en solo lectura. Ver spec, «Cliente de Stripe» y «Clientes».

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `StripeClient.createPortalSession` y la puerta `billing.portal` (el propio User, solo si tiene `customer`).
- [ ] `billing.status`: el propio User; con `userId`, solo Owner. Estado, Plan, `current_period_end`, `cancel_at_period_end`. Nunca método de pago ni importes cobrados.
- [ ] Red-first: un User no lee el estado de otro; cambiar de Plan en el portal llega por `customer.subscription.updated` y cambia el Plan.
- [ ] Web/desktop: «Renews on 1 Dec» / «Ends on 1 Dec, then returns to Default» / «Payment failed; Stripe will retry». En Plataforma → Users, estado de cada User y el aviso al cambiar a mano el Plan de quien tiene suscripción.
- [ ] Móvil: Plan, estado y fecha de fin, sin precios ni enlaces de compra.
- [ ] `StripeClient.cancelSubscription` disponible para el borrado de cuenta de `../../platform-privacy/`.
- [ ] Docs: sección «Paid plans» en la guía de usuario de planes.
