# 09: Menciones y asignación como disparadores

**What to build:** Makita también arranca cuando se le asigna un issue o se le menciona en un comentario de un issue o un PR, y en un issue con tarea abierta una mención de una persona permitida continúa el Thread. `/makita stop` y `/makita retry` funcionan. Ver spec, «Cómo llegan los eventos» (feeds 2 y 3), «Quién lo pide» y «Seguir la conversación».

**Blocked by:** 05.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (más entrada no confiable). Nota de diseño `09-design.md` antes de construir.

Spec: ../spec.md

- [ ] Feeds `issues/comments` y `pulls/comments` con `since` y ETag; claves `gh:issue-comment:<id>`, `gh:review-comment:<id>`; solo cuenta la creación (`ignored-edited`).
- [ ] Disparadores `assigned` (caller: quien asignó) y `mention` (caller: autor), según `triggers_json`.
- [ ] Continuación: `sendToThread` en modo `queue` con el mismo enmarcado; comentarios de no permitidos nunca despiertan.
- [ ] Comandos `/makita stop` y `/makita retry`.
- [ ] Red-first: una mención en un comentario editado no dispara; una mención de un no permitido no despierta un Thread abierto; dos menciones en el mismo issue no crean dos tareas.
