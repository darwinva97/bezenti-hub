# 22: Un tope de tareas a la vez

**What to build:** Cada configuración gana «at most N tasks at once» (por defecto 3, de 1 a 20, editable). Los eventos que piden una tarea nueva cuando la configuración ya tiene N trabajando se quedan en cola, en orden de llegada, y arrancan cuando acaba una; la actividad los muestra como «Waiting» con su puesto; sobreviven a un reinicio. Pausar, «Stop all», `/makita stop` y cerrar el issue quitan lo que espera igual que ya quitan el trabajo pendiente. Un techo de todo el Hub que pone el Owner en Platform → Makita (por defecto 10, sumando todas las configuraciones) manda sobre las configuraciones. Despertar una tarea que ya existe (una mención, un resultado de CI, una aprobación) nunca cuenta contra el tope ni espera por él.

**Blocked by:** 05, 07.

**Status:** in progress (design: `22-design.md`)

**Tipo:** AFK

**Tanda:** 4

**Seguridad:** sensible (decide cuánto gasta Makita a la vez; migración). Nota de diseño `22-design.md` antes de construir.

Spec: ../spec.md

- [ ] Migración 172: `makita_configs.max_tasks` (3, 1–20) y `makita_account.max_tasks` (10, 1–100), con test.
- [ ] `MakitaTasks.startQueued`: solo las tareas nuevas esperan; cuentan las tareas «at work» (las de «Now»: `running`, `waiting-ci`, `awaiting-approval`).
- [ ] Lo que espera se quita con la pausa, la parada global, el borrado, `/makita stop`, el issue cerrado o bloqueado y la salida del creador (en la transacción de `stopTasksWithin`).
- [ ] Actividad: `waiting` con repositorio, número, quién lo pidió, desde cuándo y su puesto en la cola de su configuración.
- [ ] Puerta WS `makita.account.setTaskLimit` (solo el Owner, `makita.manageAccount`), auditada `makita.account.limit`.
- [ ] Web: el campo en el formulario de la configuración, la fila dice el tope, la actividad lista lo que espera, Platform → Makita el techo.
- [ ] Red-first: la cuarta etiqueta espera y arranca al acabar una; el orden se respeta; una mención a una tarea viva no espera; el techo del Hub gana; pausar o cerrar el issue quita lo que espera; un reinicio no lo pierde.
