# 10: Empujar ramas `makita/*`

**What to build:** Con capacidad «Also push branches and open pull requests», el agente hace commits normales y llama a `makita_push`; el Environment sube el `HEAD` al repositorio del Hub, el Hub valida y lo empuja con el token a `makita/<n>-<slug>` en GitHub, sin force. Nunca otra rama, nunca workflows. Ver spec, «Empujar la rama: el Hub hace de relevo».

**Blocked by:** 05.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (escribe en el repositorio). Nota de diseño `10-design.md` antes de construir.

Spec: ../spec.md

- [ ] Capacidad `push` en el formulario y el servicio.
- [ ] Autor del worktree configurado al empezar (nombre del bot, `noreply` de GitHub).
- [ ] Petición al Active environment para subir `HEAD` a `refs/t3/makita/<taskId>/head` (canal de `CheckpointUploadService`); `gitRoute.ts` da ese prefijo de escritura solo al Thread de esa tarea.
- [ ] Validación en el Hub: desciende de la base o del último tip; ningún commit cambia `.github/workflows/**`; tamaño.
- [ ] Push por URL con el credential helper de `HubRepository`, destino construido por el Hub, sin force; rama remota movida → error claro.
- [ ] Auditoría `makita.github.push`.
- [ ] Red-first: un intento de empujar a `main`, a la base o a otra rama es imposible (el agente no elige el destino); un commit que toca un workflow se rechaza; una configuración `comment` no ve `makita_push`; el token nunca está en el Environment (se busca en su entorno y su home).
