# 11: Aprobación `/makita ok`

**What to build:** La opción de aprobación de cada configuración (`others` por defecto, `always`, `never`) y sus aprobadores: antes del primer push de una tarea pedida por alguien que no aprueba, Makita pide `/makita ok` en el issue y empuja cuando un aprobador lo da; un push que sigue a una instrucción de alguien que no aprueba pide otro. El Owner puede aprobar desde el Hub. Ver spec, «Aprobación».

**Blocked by:** 10, 08.

**Status:** needs-triage

**Tipo:** AFK (pregunta abierta 10: aprobadores por defecto)

**Tanda:** 2

**Seguridad:** sensible. Nota de diseño `11-design.md` antes de construir.

Spec: ../spec.md

- [ ] `approval` y `approvers_json` en el formulario y el servicio.
- [ ] `pending_push_json` y `approved_through` en la tarea; comentario de petición con rama y tamaño.
- [ ] Un `/makita ok` válido con la regla exacta de la spec (comentario nuevo, primera línea exacta, aprobador por id, mismo issue o PR, posterior a la petición).
- [ ] Pushes de arreglo de CI heredan la aprobación.
- [ ] WS `makita.tasks.approve` (Owner); auditoría `makita.task.approve` con `via`.
- [ ] Red-first: un `/makita ok` editado, de un no aprobador, anterior a la petición o en otro issue no aprueba; el agente no se aprueba a sí mismo (sus comentarios son de la cuenta de Makita); `approval = always` exige aprobación también al creador.
