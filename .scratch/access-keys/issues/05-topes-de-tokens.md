# 05: Topes de tokens

**What to build:** Cada access key lleva un tope total para toda su validez y/o topes por día, semana ISO o mes (UTC), o «No token limit» elegido de forma explícita. La gateway los mira al empezar cada petición: con el total alcanzado responde 403, con uno por periodo 429 con la fecha de reinicio, `retry-after` y `x-should-retry: false`, en la forma del cliente. Ver spec, «Topes de tokens» y «Lo que recibe el cliente».

**Blocked by:** 04.

**Status:** ready-for-agent

**Tipo:** AFK (el número de peticiones en curso sigue la recomendación de la pregunta abierta 3; cambiarlo es una constante)

Spec: ../spec.md

- [ ] Contracts: `AccessKeyLimits` (`total`, `day`, `week`, `month`, cada uno entero positivo o `null`); `unlimited: true` obligatorio en la entrada para dejarlos todos en `null`.
- [ ] `ai/AccessKeyCaps.ts` (o `GrantCaps` generalizado): reutiliza `periodOf`; usado = filas de `ai_usage_daily` de la clave (fórmula de los Grants + `estimated_tokens`) + `unwritten` por sujeto (`AiGatewayActivity` pasa de `grantId` a `grant:<id>` / `access-key:<id>`); el total, desde la creación.
- [ ] `AiGatewayProxy`: el tope de la clave se mira tras el modelo y antes del primer envío; total → 403; periodo → 429 con `retry-after`, `x-should-retry: false` y, en OpenAI, `code: "insufficient_quota"`; varios a la vez, el orden de la spec.
- [ ] Web: topes en el formulario de crear (al menos uno, o «No token limit»); en la lista, usado / tope / lo que queda / reinicio en hora local.
- [ ] Red-first (`TestClock`, CLIProxyAPI falso, las tres formas):
  - [ ] una petición nueva tras alcanzar el tope diario da 429 con el mensaje y `retry-after`; al día siguiente (UTC) vuelve a pasar;
  - [ ] semana ISO y mes igual; el total da 403 y no vuelve con el cambio de día;
  - [ ] total y diario a la vez: gana el total;
  - [ ] una petición en curso cuando se alcanza el tope termina y cuenta entera; con 4 en paralelo, el exceso es como mucho de esas 4;
  - [ ] lo que el writer no ha escrito ya cuenta (`unwritten`);
  - [ ] las lecturas de caché no cuentan; una respuesta cortada cuenta su estimación.
- [ ] Docs: «Access keys» → topes y por qué se pueden pasar.
- [ ] Prueba real: tope de 2 000 tokens/día; Claude Code lo agota y la siguiente pregunta muestra el mensaje sin reintentar durante minutos; lo mismo con Codex. Si un cliente no respeta `x-should-retry`/`insufficient_quota`, se documenta.
