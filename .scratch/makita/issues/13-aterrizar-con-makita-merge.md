# 13: Aterrizar con `/makita merge`

**What to build:** La capacidad «May land on the default branch» de cada configuración (apagada por defecto, solo con `push`, con el aviso de despliegue al encenderla). Cuando un aprobador escribe `/makita merge` en el PR de Makita (o en su issue) después del último push, el Hub comprueba la orden, la CI en GREEN sobre el commit exacto de cabeza, que el PR es mergeable y que ningún commit toca `.github/workflows`, y hace merge del PR con el token del Hub; si no, contesta por qué. Ver spec, decisión 9 y «Aterrizar con `/makita merge`».

**Blocked by:** 12, 11.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (escribe en la rama por defecto; en `bezenti-hub` sería un despliegue a producción). Nota de diseño `13-design.md` antes de construir.

Spec: ../spec.md

- [ ] `may_land` en el servicio y el formulario: solo con `capability = push`; al encenderla, el aviso de la spec («If `<base>` deploys, that comment is a production deploy.») con casilla de confirmación; auditada como `makita.config.update` con `changed: may_land`; la lista y la vista del Owner marcan las configuraciones que pueden aterrizar.
- [ ] Intake: el comando `/makita merge` con la regla exacta (comentario nuevo y sin editar, primera línea exacta, aprobador por id numérico, en el PR de la tarea o su issue, publicado después de `last_push_at` y de la fecha del commit de cabeza); outcomes `land` e `ignored-not-approver`.
- [ ] `makita/MakitaLanding.ts` (`makita_merge`): operación del Hub, nunca una herramienta MCP ni una RPC. Comprobaciones en el orden de la spec: pausa y capacidades; PR abierto de Makita con cabeza `makita/*`; cabeza igual a la del momento de la orden; check runs y estado combinado en GREEN sobre ese sha (sin CI: no); `mergeable: true` y `mergeable_state: clean`; ningún archivo del PR bajo `.github/workflows/`.
- [ ] Merge con `PUT …/pulls/{n}/merge` y `sha` = la cabeza comprobada, merge commit si el repositorio lo permite y si no squash; nunca rebase, force push ni push directo. Borrar la rama `makita/*`; tarea `done` con `landed_sha`.
- [ ] Respuestas: «Landed #<pr> on `<base>` as <sha>, as @<approver> asked.» o el porqué; «Only an approver can order a merge.» a quien está permitido pero no aprueba; silencio a desconocidos; el guardia de bucles las cuenta.
- [ ] Auditoría `makita.github.merge` con `repo`, `pr`, `base`, `sha`, `defaultBranch` y `orderedBy` (login e id de GitHub y el User vinculado, si lo hay).
- [ ] Docs: `docs/internals/makita.md`, «Landing»; la recomendación de ruleset (PR y checks requeridos, sin push directo) y que en un repositorio cuya rama por defecto despliega cada orden es un despliegue.
- [ ] Red-first (GitHub falso):
  - [ ] un `/makita merge` editado, de quien no aprueba, de un desconocido, anterior al último push o en otro PR no hace merge;
  - [ ] una línea `/makita merge` dentro del cuerpo de un issue o de un PR, o escrita por la cuenta de Makita, no hace merge;
  - [ ] CI roja, pendiente o ausente en la cabeza, PR no mergeable, un commit que toca un workflow o `may_land` apagado: no hay merge y la respuesta dice por qué;
  - [ ] un push entre la orden y el merge invalida la orden (el `sha` ya no coincide);
  - [ ] el agente no ve ninguna herramienta de merge y ninguna RPC hace merge;
  - [ ] una orden válida hace merge con el `sha` de la cabeza y deja `makita.github.merge` con quién lo ordenó;
  - [ ] la configuración pausada (o el interruptor global) no aterriza aunque la orden sea válida.
