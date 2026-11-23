# 04: Uso por clave de acceso

**What to build:** El resumen diario guarda el uso de cada access key aparte, con una estimación para las respuestas sin uso conocido. Settings → AI accounts → Usage muestra cada clave como «Access key: <label>» junto a los Users, a quien gestiona el Space, y la lista de claves muestra por clave lo usado hoy, esta semana, este mes y en total. Ver spec, «Uso» y «Topes de tokens» (respuestas sin uso conocido).

**Blocked by:** 01.

**Status:** done (design: `04-design.md`)

**Tipo:** AFK

Spec: ../spec.md

- [x] Migración (número al integrar): `ai_usage_daily` reconstruida con `access_key_id` en la clave primaria (`''` para lo demás) y `estimated_tokens`; índice parcial `(access_key_id, day)`. Test con golden como la 146: las filas existentes no cambian de valor.
- [x] `ResponseTap`: bytes de respuesta entregados; `AiGatewayProxy`: bytes del cuerpo. Para access keys, una respuesta sin uso conocido lleva `estimatedTokens` = el mayor entre lo leído y la estimación por bytes (`ceil(bytes / 4)` de entrada y de salida); sigue contando en `unknown_requests`.
- [x] `AiUsage.summary`: las filas de las access keys de un Space para quien tiene `accessKey.view` ahí (también el User de un Personal space); filtro por clave; nombres «Access key: <label>». Un Member que no gestiona el Space no las ve.
- [x] `AccessKeys.list`: por clave, tokens del día, semana ISO, mes (UTC) y total, lecturas de caché aparte, peticiones sin uso conocido y estimadas.
- [x] Web: Usage con el sujeto «Access key: <label>» y su filtro; columnas de uso en la lista de claves (los «≈» dichos, nunca como cero).
- [x] Red-first: una respuesta cortada antes de su último evento suma tokens estimados, no 0; un Member de Acme no ve el uso de las claves de Acme; el Admin sí; el User de un Personal space ve las de sus claves; un filtro solo estrecha.
- [x] Docs: «Usage» y «Access keys» → uso.
