# 07: Cuota de disco del Hub

**What to build:** Cuando un Space está por encima del disco del Hub de su titular, se rechaza crear Projects y Threads, empezar turnos y mover Projects o Threads hacia él. Nada se borra; un turno en marcha termina y sube su checkpoint. Todos los Members del Space ven un aviso con el límite y quién es el titular. Ver spec, «Límites» y «Disco del Hub».

**Blocked by:** 06.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `PlanLimits.check("hubDisk", spaceId)` con la última medición, en `ThreadMessageIntake.dispatchCommand` (`apps/server/src/orchestration-v2/ThreadMessageIntake.ts`) para `thread.create` y `message.dispatch`, antes de `commitCommand`; en crear Project; y en el plan de mover Project o Thread hacia el Space. El orquestador no cambia.
- [ ] Red-first: Space por encima → `thread.create` y `message.dispatch` rechazados con `PlanLimitReachedError`; un turno ya en marcha completa y su checkpoint se sube; un mensaje encolado antes se ejecuta; borrar Threads y volver a medir deja empezar.
- [ ] Cada entrada que empieza trabajo pasa por la misma comprobación: cliente, herramientas MCP (`t3_thread_launch`, `t3_thread_send`, `t3_project_create`…), tareas programadas y sus webhooks. Un test por entrada que no use ya `dispatchCommand`; si alguna no lo usa, se arregla para que lo use.
- [ ] Aviso del Space junto al composer en web, desktop y móvil: «This Space has used its Hub disk (5.2 GB of 5 GB). New turns are paused. <Titular> can free space or change plan.» Estado compartido en `packages/client-runtime`.
- [ ] Los botones de crear (sidebar, paleta de comandos, atajos) muestran el error de límite, no un fallo genérico.
- [ ] Docs: la fila de disco en «Plans and limits», con cómo liberar espacio.
- [ ] Prueba real: Plan con 50 MB, un Thread con adjuntos lo pasa; el composer muestra el aviso y el envío se rechaza; borrar el Thread y esperar la medición lo desbloquea.
