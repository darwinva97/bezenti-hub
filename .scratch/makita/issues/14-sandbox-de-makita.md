# 14: Sandbox de Makita

**What to build:** Un segundo Sandbox por Space, `sandbox:<spaceId>:makita`, solo para los Threads de Makita de ese Space: su propio contenedor, home y credencial, sin ningún Thread normal del Space y sin sus checkouts. Las configuraciones con `environment_id = null` pasan a él. Ver spec, «Amenazas de prompt injection» (riesgos que quedan) y pregunta abierta 4.

**Blocked by:** nada dentro de esta spec (05 para usarlo).

**Status:** needs-triage

**Tipo:** AFK (pregunta abierta 4; ADR que amplía 0004)

**Tanda:** 3

**Seguridad:** sensible (aislamiento). Nota de diseño `14-design.md` antes de construir.

Spec: ../spec.md

- [ ] ADR: un segundo Sandbox por Space para trabajo no confiable.
- [ ] `sandboxes`: un propósito (`space` o `makita`) en la fila y en el id; `environment.use` y el ejecutor (`SandboxSpaceMismatchError`) exigen además que solo Threads de Makita vayan al de Makita y ninguno de Makita al del Space.
- [ ] La ruta git sirve al de Makita solo los repositorios de los Projects de sus tareas.
- [ ] Límites y ciclo de vida como el del Space (docs/internals/sandboxes.md «Limits», «Lifecycle»).
- [ ] Red-first: desde un Thread de Makita no se ve ningún proceso, archivo ni checkout de un Thread normal del Space; un Thread normal no se coloca en el de Makita.
- [ ] Docs: docs/internals/sandboxes.md, «Makita sandbox».
