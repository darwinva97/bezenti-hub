# 12: Abrir el PR, esperar la CI y arreglar el RED

**What to build:** El agente abre el PR con `makita_open_pull_request` (base de la configuración, cuerpo con Problem / Fix / Verified / Downsides), el PR se enlaza al Thread, el intake vigila los checks de la rama, y un RED despierta al Thread con los trabajos fallidos y `makita_ci_logs`; tres arreglos sin GREEN o 90 minutos sin terminar paran con un comentario. Ver spec, «Abrir el PR, esperar la CI, arreglar el RED».

**Blocked by:** 10.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (escribe en el repositorio). Nota de diseño `12-design.md` antes de construir.

Spec: ../spec.md

- [ ] `makita_open_pull_request` con la validación de secciones y el pie fijo; enlace al Thread con `thread.pull-request.*`.
- [ ] Vigilancia de check runs y estados del `head_sha` en el intake (no `watch_pull_request`).
- [ ] `makita_ci_logs { job }`: cola del log hasta 64 KiB, enmarcada.
- [ ] Bucle de CI (3 intentos), «no CI» a los 10 minutos, 90 minutos sin terminar; estados `waiting-ci` y `waiting-reply`.
- [ ] Auditoría `makita.github.pull_request`.
- [ ] Red-first: no hay herramienta de merge ni de aprobar; un cuerpo sin «Downsides» se rechaza; el cuarto RED no despierta al agente.
