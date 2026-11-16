# 05: Coste estimado en USD y parte de la cuota de una suscripción

Spec: ../spec.md

**What to build:** Una tabla de precios por proveedor y modelo, en el repo y versionada por fecha, da el coste estimado en USD de las cuentas `api-key`. Cada día se valora con el precio vigente ese día. Las suscripciones no muestran dinero: muestran tokens y, cuando el lector de cuotas lo da, la parte aproximada de la ventana de cuota que consumió cada Grant. Es solo visual, no un tope. Ver spec, «AI accounts prestadas» (Precio, Suscripciones).

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `apps/server/src/ai/aiPrices.ts`: entradas `{ provider, model, validFrom, input, output, cacheRead, cacheWrite }` (USD por millón de tokens) para los modelos que hoy sirve la gateway.
- [ ] `estimatedUsd` en `aiUsage.summary`, calculado en el servidor: nulo para suscripciones y para modelos sin entrada («sin precio»).
- [ ] Red-first: dos versiones de precio para un modelo; el día anterior al cambio conserva su valor.
- [ ] Parte de la cuota: con el porcentaje usado y el reinicio de una ventana que da `usage/cliproxyApi.ts`, se calcula (tokens del Grant en la ventana / tokens de la cuenta en la ventana) × porcentaje. Se marca «aprox.»; sin datos del proveedor, no se muestra.
- [ ] Web/desktop: columnas de USD y de parte de la cuota en el uso de prestador y prestatario.
- [ ] `docs/internals/ai-gateway.md`: cómo se actualiza la tabla (con las releases, nada se descarga; ADR 0007).
