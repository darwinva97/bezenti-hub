# 09: Cuota de tráfico del Hub

**What to build:** Cuando un Space pasa el tráfico del mes de su titular, se rechaza empezar turnos, abrir previews nuevos y las peticiones de gateway con claves de CLI local, hasta que empieza el mes siguiente o el titular cambia de Plan. Lo que ya está en marcha sigue. Ver spec, «Límites» y «Tráfico del Hub».

**Blocked by:** 07, 08.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `PlanLimits.check("hubTraffic", spaceId)` en el mismo punto que la cuota de disco (`ThreadMessageIntake.dispatchCommand`), al emitir un token de preview (`HubPreviews.ts`) y en la gateway solo para claves de CLI local (`AiGatewayKeys`), que reciben 429 con el límite y `resetsAt` en el cuerpo.
- [ ] Red-first: por encima del tráfico, `message.dispatch` y abrir un preview fallan con `resetsAt`; las peticiones de gateway de un turno en marcha siguen; un preview ya abierto sigue; al cambiar de mes vuelve a dejar.
- [ ] El aviso del Space del ticket 07 cubre también el tráfico, con la fecha de reinicio.
- [ ] Docs: la fila de tráfico en «Plans and limits»; `docs/internals/ai-gateway.md`, una frase sobre el 429 de cuota para claves de CLI local.
