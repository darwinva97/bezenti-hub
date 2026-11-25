# 27: Limpieza de los PRs de Makita

**What to build:** Dos salidas para el trabajo que Makita deja abierto, como en `oven-sh/bun` con `robobun`: (a) cerrar sus propios PRs sin actividad durante N días; (b) una etiqueta de «trabajo malo» con la que un aprobador cierra al instante uno de sus PRs. Ver spec, «Abrir el PR, esperar la CI, arreglar el RED», «Aprobación», «Parar».

**Blocked by:** 11, 12, 14 (hechos).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (autonomía estilo robobun)

**Seguridad:** sensible (escrituras en GitHub sin orden de un agente). Nota de diseño `27-design.md` antes de construir.

Spec: ../spec.md

- [ ] (a) Opción por configuración «Close its pull requests idle for N days» (apagada; 7–180, por defecto 90). Un trabajo del Scheduler cierra los PRs abiertos de Makita de esa configuración sin actividad en N días: un comentario que dice por qué y que reabrirlo está bien, borra la rama `makita/…`, termina la tarea, auditado. Nunca un PR que no sea de Makita para una tarea conocida, nunca uno con una aprobación pendiente o una tarea en marcha.
- [ ] (b) Una etiqueta «bad work» por configuración (nombre opcional, vacío = apagada; se sugiere `slop`). Cuando un aprobador (`isApproverNow`) la pone en un PR de Makita, el Hub lo cierra al momento, borra la rama y para la tarea, sin discutir. Si la pone cualquier otro, no pasa nada.
- [ ] Las dos se ven en la actividad y se auditan; pausar la configuración o «Stop all» las para en el siguiente evento.
- [ ] Red-first (GitHub falso): un PR inactivo N días se cierra una vez con su comentario y su rama borrada; uno activo, uno ajeno, uno con push pendiente de aprobación o con la tarea en marcha no; la etiqueta de un aprobador cierra y para; la de otro no hace nada; en pausa, nada.
