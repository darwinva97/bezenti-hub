# 06: Medir el disco del Hub por Space, y que borrar lo libere

**What to build:** El Hub mide cuánto disco ocupa cada Space en el Hub: historial de sus Threads, adjuntos y repositorios git del Hub de sus Projects y Threads sin Project. Lo mide cada hora y poco después de borrar algo en el Space. Borrar un Thread o un Project tiene que bajar esa cifra; si no, un Space lleno no tendría salida. El User, el Admin y el Owner ven el número, todavía sin cuota. Ver spec, «Disco del Hub».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `space_storage_usage` (`space_id`, `events_bytes`, `attachments_bytes`, `repository_bytes`, `measured_at`).
- [ ] Servicio `HubStorageUsage` con un fiber periódico (cada hora; configurable para tests) y una medición con retraso corto tras borrar Threads o Projects en un Space. Historial: `SUM(length(payload_json))` de `orchestration_v2_events` por Thread no borrado, agrupado por Space (los eventos de un Thread borrado se quedan en el log; la cuota no los cuenta, spec, Pregunta abierta 9); adjuntos: archivos del Thread en `attachmentStore.ts`; repositorios: `git count-objects -v` de `<stateDir>/hub-repositories` (`HubRepository.ts`).
- [ ] Borrar un Thread quita sus refs del repositorio del Hub (`refs/t3/threads/<id>/`, `refs/t3/recovered/<id>/` y los de checkpoint de sus scopes) y sus adjuntos; borrar un Project borra su repositorio; un `git gc --prune` periódico recoge los objetos sueltos (los repos van con `gc.auto=0`). Red-first: en `main`, borrar un Thread con checkpoints no baja el disco medido.
- [ ] Rendimiento: medir con datos reales copiados (`vp run migrate-dev-db`) y anotar la duración en el ticket. Si la pasada pasa de un segundo, contador incremental por Thread en vez de recorrer la tabla.
- [ ] `PlanUsage` añade disco por Space (por componente y `measured_at`) en `plans.usage` y `spaces.usage`.
- [ ] Web/desktop: modal Usuario → «Plan» y modal Space → «Usage» con «Hub disk 1.2 GB (history 0.1, attachments 0.3, checkpoints 0.8), measured 10 min ago». «Archiving does not free space; deleting does.»
- [ ] Owner: Plataforma → Users muestra el disco de cada Space de cada User, en números.
