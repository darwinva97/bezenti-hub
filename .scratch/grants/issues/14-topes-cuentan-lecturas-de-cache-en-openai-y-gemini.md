# 14: Los topes cuentan las lecturas de caché en OpenAI y Gemini

Spec: ../spec.md

**What to build:** Los topes de un Grant (ticket 03) cuentan entrada + salida + escritura de caché, y no las lecturas de caché (pregunta abierta 3). Pero `input_tokens` no significa lo mismo en todas las formas (`ai/gatewayShapes.ts`, `mergeUsage`):

- En la forma Anthropic, la entrada deja fuera la caché.
- En OpenAI (`prompt_tokens`, `input_tokens`) y en Gemini (`promptTokenCount`), la entrada incluye las lecturas de caché.

`GrantCaps` suma `input_tokens` tal cual. Por eso un préstamo de Codex o de Gemini cuenta sus lecturas de caché y agota el tope mucho antes de lo que dice la regla.

El ticket 05 ya guarda la entrada sin caché por fila diaria: `ai_usage_daily.uncached_input_tokens`, migración 147, con NULL cuando no se sabe. Los topes deben contar esa columna en lugar de `input_tokens`, y lo mismo los registros que el writer aún no ha escrito (`AiGatewayActivity.unwritten`). Ver spec, «AI accounts prestadas» (Topes).

**Blocked by:** 05.

**Status:** done

- [x] `GrantCaps` cuenta `uncached_input_tokens` + salida + escritura de caché. Una fila con NULL (anterior a la migración 147) cuenta `input_tokens`, como hoy: nunca de menos.
- [x] El recuento de lo no escrito usa la misma regla por forma (`uncachedInputOf`, movido a `ai/gatewayShapes.ts` para que `AiGatewayActivity` lo use sin ciclo).
- [x] Red-first con el CLIProxyAPI falso en forma OpenAI con `cached_tokens`: las lecturas de caché no acercan el tope.
- [x] `docs/internals/ai-gateway.md`, «Caps»: qué cuenta como entrada en cada forma.
- [x] La parte de cuota de una suscripción prestada (ticket 05) cuenta los tokens igual que los topes.

## Notes

- Pendiente (follow-up): en `LoanUsage`, «N in» muestra la entrada tal como la da el proveedor, con las lecturas de caché dentro en OpenAI y Gemini, así que entrada + salida + escritura no coincide con el «used» del tope en esas formas. Arreglarlo pide `uncachedInputTokens` en `AiUsageTotals` (cambio de contrato).
