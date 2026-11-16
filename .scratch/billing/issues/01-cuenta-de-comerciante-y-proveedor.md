# 01: Cuenta de comerciante y proveedor de pagos

**What to build:** El Owner decide con quién y cómo cobra, y deja la cuenta lista en modo test. No es código: es la decisión de comerciante de la que depende todo lo demás. Ver spec, «Por qué Stripe» y Preguntas abiertas 1, 2 y 5.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

Spec: ../spec.md

- [ ] Decidir Stripe o un Merchant of Record (Paddle), según quién factura (entidad, país) y si se quiere declarar el IVA de la UE (OSS) con Stripe Tax o delegarlo. Si sale Paddle, reescribir «Cliente de Stripe» y «Webhook» del spec antes de los tickets 03–05.
- [ ] Crear la cuenta y, en modo test: un Product y un Price recurrente por cada Plan de pago; prueba gratuita si se quiere.
- [ ] Configurar el Customer Portal: cancelar al final del periodo, cambio de Plan entre los Prices de los Plans, facturas visibles.
- [ ] Configurar los reintentos de cobro para que, al agotarse, cancelen la suscripción (no «dejar impagada»).
- [ ] Decidir la política de reembolsos y los textos legales que piden los términos de uso de `../../platform-privacy/`.
- [ ] Confirmar la Pregunta abierta 2 (móvil sin precios ni enlaces de compra).
- [ ] Anotar aquí la decisión y las claves de test en el gestor de secretos del Owner (nunca en el repositorio).
