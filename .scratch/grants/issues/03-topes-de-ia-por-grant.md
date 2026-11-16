# 03: Topes de IA por Grant en la gateway

Spec: ../spec.md

**What to build:** El prestador fija en cada Grant de AI account un tope de tokens por día, semana o mes y, si quiere, uno de peticiones. La gateway lo aplica en cada petición. Cada petición registra qué Grant usó. Al agotarse, la gateway hace failover a otra cuenta permitida del mismo proveedor y modelo, o devuelve un 429 que dice qué Grant se agotó y cuándo se reinicia. Ver spec, «AI accounts prestadas» (Atribución, Topes).

**Blocked by:** 01, `../../ai-accounts-and-gateway/issues/16` (el uso debe registrarse antes de poder topar).

**Status:** ready-for-agent

- [ ] `GatewayRequestRecord.grantId` (`ai/AiGatewayActivity.ts`). Migración: `grant_id` en `ai_usage` y en la clave de `ai_usage_daily` (`''` para lo propio), con la tabla reconstruida y test.
- [ ] `ai/GrantCaps.ts`, llamado en el paso 2 del enrutado de `ai/AiGateway.ts`:
  - [ ] periodos UTC de calendario (día, semana ISO, mes);
  - [ ] cuentan entrada + salida + escritura de caché;
  - [ ] tokens desconocidos suman 0 tokens y 1 petición;
  - [ ] se suma el resumen diario más los registros que el writer aún no ha escrito.
- [ ] Red-first con el CLIProxyAPI falso, en las tres formas (OpenAI, Anthropic y Gemini):
  - [ ] una petición nueva tras alcanzar el tope se rechaza;
  - [ ] el periodo siguiente vuelve a permitir (`TestClock`);
  - [ ] failover a otra cuenta permitida del mismo proveedor;
  - [ ] sin otra cuenta, 429 con el mensaje del spec;
  - [ ] una cuenta propia nunca se topa.
- [ ] Las claves de CLI local ligadas al Space cuentan contra el mismo Grant.
- [ ] `grants.setLimits` para el prestador. Bajar el tope por debajo de lo gastado agota el Grant desde la siguiente petición. Auditoría `grant.limits.change`.
- [ ] Formulario de dar: tope de tokens obligatorio salvo «Sin tope» explícito; tope de peticiones opcional.
- [ ] El selector de AI account muestra la parte usada del tope de cada cuenta prestada; el header del Thread muestra el error de tope.
- [ ] `docs/internals/ai-gateway.md`: sección de topes (qué cuenta y por qué se puede pasar en las peticiones en curso).
- [ ] Prueba real: tope de 2 000 tokens/día, un turno con un modelo barato lo agota y el siguiente falla con el mensaje.
