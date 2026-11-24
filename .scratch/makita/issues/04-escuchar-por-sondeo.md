# 04: Escuchar por sondeo y deduplicar

**What to build:** El Hub lee con el token del bot, cada 30 s a 2 min y con peticiones condicionales, el feed de eventos de issues de cada repositorio que escucha alguna configuración activa, y registra cada etiquetado `makita` una sola vez con quién lo puso y qué decidió (empezar, ignorar y por qué). En esta tanda el evento aceptado queda `queued` (el ticket 05 lo convierte en tarea). Ver spec, «Cómo llegan los eventos», «Deduplicación e idempotencia» y «Quién lo pide y si puede».

**Blocked by:** 03.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (entrada de cualquiera en internet). Nota de diseño `04-design.md` antes de construir.

Spec: ../spec.md

- [ ] Migraciones `makita_events` y `makita_repo_cursors` con test.
- [ ] `makita/MakitaIntake.ts` registrado en `scheduling/Scheduler.ts`: feed `issues/events` por repositorio con `If-None-Match`; cadencia 30 s / 2 min; respeta `X-Poll-Interval`, `retry-after`, `x-ratelimit-reset` y el límite secundario.
- [ ] Clave natural `gh:issue-event:<id>`; `INSERT … ON CONFLICT DO NOTHING RETURNING`; el cursor avanza tras escribir el lote.
- [ ] Decisión del caller: propia cuenta, `type: "Bot"`, `ignore_json`, luego la lista de la configuración por id numérico; elección de la configuración más antigua que coincide; `outcome` de la spec.
- [ ] Repositorio sin acceso (403/404): `unreachable_since`, aviso en la configuración y en Platform → Makita; 401: `makita_account.status = token-invalid` y el poller para.
- [ ] Interruptor global y pausa de la configuración: eventos `ignored-paused`; al reanudar, cursores a «ahora».
- [ ] `makita/MakitaGitHub.testkit.ts`: el GitHub falso de la spec (feeds, ETag y 304, errores).
- [ ] Red-first: el mismo evento leído dos veces cuenta una; un reinicio a mitad de lote no pierde ni duplica; un etiquetado de alguien fuera de la lista queda `ignored-not-allowed`; uno de un bot, `ignored-bot`; con 304 no se escribe nada.
