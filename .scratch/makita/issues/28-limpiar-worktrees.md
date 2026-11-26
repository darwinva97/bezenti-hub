# 28: Limpiar los worktrees de las tareas terminadas

**What to build:** El Hub borra de su máquina el worktree de cada tarea de Makita cuando ya no hace falta: su PR fusionado o cerrado (por Makita, por el Hub o por una persona en GitHub), o la tarea terminada sin PR tras 7 días de gracia. Hoy nadie lo borra y el disco se llena con cada tarea. Cuando una persona fusiona o cierra el PR de Makita en GitHub, el Hub borra también la rama `makita/…`. Ver spec, «Empujar», «Abrir el PR», «Parar».

**Blocked by:** 10, 12, 13, 14, 27 (hechos).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (autonomía estilo robobun)

**Seguridad:** sensible (borra carpetas en máquinas unidas y ramas en GitHub sin orden de nadie). Nota de diseño `28-design.md` antes de construir.

Spec: ../spec.md

- [ ] Un trabajo del Scheduler borra el worktree de una tarea terminada (`done`, `stopped`, `failed`) cuando su PR está fusionado o cerrado, o a los 7 días si nunca abrió PR. Mientras la tarea vive o su PR sigue abierto, se queda. Cubre también las tareas que terminaron antes de este ticket.
- [ ] Solo la ruta que el Hub guardó para esa tarea, y solo si es un worktree del checkout de ese Project hecho para esa tarea; nunca el checkout ni una ruta que venga de un agente o de GitHub. Los cambios sin commit se pierden a propósito.
- [ ] Máquina apagada: se reintenta más tarde sin bloquear la pasada y se abandona a la vista (auditado) a los 14 días. Una máquina con una versión anterior (sin `move.remove`) no se llama: se espera a que se actualice. Un worktree que ya no está cuenta como borrado.
- [ ] Una persona fusiona o cierra el PR de Makita en GitHub: la rama `makita/…` se borra (lo mejor posible) y la tarea termina si seguía viva.
- [ ] La fila de la tarea dice que su worktree se borró y cuándo (migración); auditado.
- [ ] Red-first: worktree borrado tras el merge de una persona; conservado con el PR abierto; conservado 7 días para una tarea fallida y borrado después; reintentado con la máquina apagada; una segunda pasada no hace nada; se niega a borrar una ruta que no es el worktree guardado de la tarea.
