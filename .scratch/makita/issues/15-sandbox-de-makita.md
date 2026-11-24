# 15: Sandbox de Makita

**What to build:** Un segundo Sandbox por Space, `sandbox:<spaceId>:makita`, solo para los Threads de Makita de ese Space: su propio contenedor, home y credencial, sin ningún Thread normal del Space y sin sus checkouts. Las configuraciones con `environment_id = null` pasan a él. Y «Where it works» gana su elección: el Sandbox (por defecto, recomendado) o una máquina dedicada a ese Space, nunca una personal ni una prestada (decisión 12). Ver spec, «Amenazas de prompt injection» (riesgos que quedan) y pregunta abierta 4.

**Blocked by:** nada dentro de esta spec (05 para usarlo).

**Status:** needs-triage

**Tipo:** AFK (pregunta abierta 4; ADR que amplía 0004)

**Tanda:** 3

**Seguridad:** sensible (aislamiento). Nota de diseño `15-design.md` antes de construir.

Spec: ../spec.md

- [ ] ADR: un segundo Sandbox por Space para trabajo no confiable.
- [ ] `sandboxes`: un propósito (`space` o `makita`) en la fila y en el id; `environment.use` y el ejecutor (`SandboxSpaceMismatchError`) exigen además que solo Threads de Makita vayan al de Makita y ninguno de Makita al del Space.
- [ ] La ruta git sirve al de Makita solo los repositorios de los Projects de sus tareas.
- [ ] Límites y ciclo de vida como el del Space (docs/internals/sandboxes.md «Limits», «Lifecycle»).
- [ ] «Where it works»: el formulario ofrece «Space Sandbox (recommended)» y las máquinas dedicadas a ese Space (`environment.dedicate`); el servicio rechaza una personal, una prestada por un Grant o una de otro Space; al empezar cada tarea se vuelve a validar y, si la máquina ya no está dedicada al Space, la tarea no arranca y la configuración muestra «This machine is no longer dedicated to this Space» (sin pasar sola al Sandbox); el formulario avisa que en una máquina dedicada los Threads de Makita comparten usuario con los demás Threads que corren en ella.
- [ ] Red-first: desde un Thread de Makita no se ve ningún proceso, archivo ni checkout de un Thread normal del Space; un Thread normal no se coloca en el de Makita; una configuración no elige una máquina personal, prestada o de otro Space, y una máquina que deja de estar dedicada para la siguiente tarea.
- [ ] Docs: docs/internals/sandboxes.md, «Makita sandbox».
