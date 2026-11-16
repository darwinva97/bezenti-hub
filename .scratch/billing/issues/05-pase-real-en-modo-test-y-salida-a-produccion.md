# 05: Pase real en modo test y salida a producción

**What to build:** Con la cuenta del ticket 01 en modo test, recorrer todo el ciclo contra un Hub de desarrollo con `stripe listen`, revisar las puertas de pagos y, si todo pasa, cambiar a claves de producción. Ver spec, «Testing Decisions».

**Blocked by:** 01, 04.

**Status:** ready-for-human

Spec: ../spec.md

- [ ] Hub de desarrollo con `T3CODE_PUBLIC_URL` y `stripe listen --forward-to <hub>/api/billing/stripe/webhook`.
- [ ] Recorrido: subir a un Plan con tarjeta de test; cambiar de Plan en el portal; cancelar y avanzar el reloj de test de Stripe hasta el fin del periodo (vuelve al plan por defecto, nada borrado); tarjeta que falla y reintentos agotados (vuelve al plan por defecto).
- [ ] Inventario: el webhook sin firma no cambia nada; ninguna respuesta lleva claves; un User no ve el estado de otro; el móvil no muestra precios ni enlaces de compra.
- [ ] Revisar la auditoría: cada cambio de Plan por pago aparece como `source: billing`.
- [ ] Pasar a claves de producción y registrar el endpoint del webhook de producción en Stripe.
