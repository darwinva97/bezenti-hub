# 16: El uso de una IA no se ve

**What to build:** El Owner informa (2026-11-16) que el uso de las AI accounts no se está mostrando. Hay que reproducirlo, encontrar dónde se pierde y arreglarlo. El ticket 05 registra cada petición de la gateway en `ai_usage` y `ai_usage_daily` (`apps/server/src/ai/AiUsage.ts`) y lo muestra en Settings → AI accounts → Usage y en el panel del Thread.

**Blocked by:** None (can start immediately).

**Status:** needs-triage

Hechos ya comprobados:
- Al menos los turnos de Claude del Hub sí pasan por la gateway: el agente recibe `ANTHROPIC_BASE_URL` local y un `ANTHROPIC_AUTH_TOKEN` `t3gk_…`. Si su uso no aparece, el fallo está en el registro o en la vista, no en el enrutado.

Hipótesis a comprobar, en orden:
1. Las peticiones llegan a la gateway pero no se escriben (fallo en el fiber de `AiUsage`, que se registra y no corta la petición, así que pasa desapercibido en los logs).
2. Se escriben, pero `aiUsage.summary` las filtra (visibilidad por User, Space o cuenta) o la vista consulta otro rango de fechas.
3. El uso pasa por caminos que no tocan la gateway y nunca se cuentan: credenciales directas (Grok con `XAI_API_KEY` hasta el ticket 14, `agy` con Gemini key o Vertex), CLIs locales con su propio login, o clientes que usan CLIProxyAPI sin pasar por la capa del Hub.
4. Las respuestas no traen `usage` y se cuentan como «tokens desconocidos», que la vista no muestra.

- [ ] Reproducción con datos reales copiados (nunca contra `~/.t3/userdata`): un turno, y comprobar fila en `ai_usage`, resumen diario y vista.
- [ ] Test rojo en el punto donde se pierde, luego el arreglo.
- [ ] La vista dice explícitamente qué no puede contar (credenciales directas, CLIs locales) en vez de mostrar cero.

## Comments

**Análisis inicial: qué se puede saber de quién gastó una IA** (para el mapa `../../public-hub/map.md`, «Atribución del uso de IA prestada»).

Cada petición que pasa por la gateway ya guarda User, Space, Thread, gateway key, AI account, proveedor, modelo, tokens (entrada, salida, caché), estado y duración, sin prompts ni claves. Con eso, para una AI account prestada se puede mostrar al dueño cuánto usó cada User y cada Space que la tiene prestada, por día y por modelo, y a quien la usa, su propio consumo. Lo que falta:
- **Dinero:** solo hay tokens. Pasar a USD necesita una tabla de precios por proveedor y modelo, mantenida y versionada (el precio de ayer no cambia con el de hoy).
- **Suscripciones:** no tienen precio por petición sino ventanas de cuota (cinco horas, semana). Lo honesto es mostrar tokens y, si el proveedor lo expone, la parte de la cuota consumida, no un precio inventado.
- **Fuera de la gateway no se puede atribuir nada:** credenciales directas, CLIs locales con su login, uso fuera del Hub de la misma cuenta. Para un préstamo, esto obliga a que una AI account prestada solo se use por la gateway.
- **Privacidad:** el dueño de la cuenta ve quién la usó y cuánto, nunca qué se pidió. Encaja con la decisión de privacidad del mapa.
