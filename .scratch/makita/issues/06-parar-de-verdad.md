# 06: Parar de verdad

**What to build:** Pausar una configuración, o «Stop all Makita work» del Owner, para en el acto: las tareas en marcha pasan a `stopped`, se interrumpe su turno, la gateway rechaza desde la siguiente petición a sus Threads aunque la interrupción no llegue, y ninguna herramienta `makita_*` vuelve a escribir en GitHub. «Stop» por tarea también. Ver spec, «Parar».

**Blocked by:** 05.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (gateway). Nota de diseño `06-design.md` antes de construir.

Spec: ../spec.md

- [ ] Pausa en una transacción (configuración, tareas `stopped`, aprobaciones canceladas) y, fuera de ella, la interrupción del turno de cada Thread con el comando de `thread.stop` como el sistema.
- [ ] `AiGatewayKeys.authorize`: una gateway key de Thread de una tarea de Makita comprueba la pausa global, la de la configuración y que la tarea no esté `stopped` → 403 «Makita is stopped for this work.»; `GatewayCaller.makitaConfigId`.
- [ ] Cada `makita_*` comprueba la pausa antes de escribir.
- [ ] Interruptor global (ticket 01) con efecto: el poller deja de leer; al reanudar, cursores a «ahora».
- [ ] WS `makita.tasks.stop`; auditoría `makita.task.stop` con `reason`.
- [ ] Web: «Stop now» por configuración y por tarea; el estado pausado y quién lo pausó.
- [ ] Red-first (`AiGatewayRoute.testkit.ts` y el GitHub falso): un turno en marcha recibe 403 en su siguiente petición tras pausar; un `makita_comment` tras pausar no escribe; lo pausado por el Owner no lo reanuda el creador; parar no escribe nada en GitHub.
