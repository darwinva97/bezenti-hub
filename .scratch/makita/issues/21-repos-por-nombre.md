# 21: Añadir un repositorio por su nombre

**What to build:** En el formulario de una configuración, quien la hace escribe `owner/name` (o una URL de github.com) y pulsa «Add». El Hub comprueba con el token de Makita que el repositorio existe y que la cuenta de Makita lo alcanza; si es privado, que la cuenta de GitHub vinculada de quien lo pide es colaboradora (sin decir nada de un repositorio privado que esa persona no podría ver). Si un Project del Space ya tiene ese remoto, lo reutiliza; si no, crea el Project en el Space de la configuración por el mismo camino que «clonar un repositorio como Project» (`ProjectCloneTracker`), como esa persona, con su permiso `project.create`, y lo audita. El Project queda marcado en la configuración. Quitarlo de la configuración nunca borra el Project. Para que Makita funcione como `robobun` en Bun sin crear antes un Project a mano.

**Blocked by:** 03, 08.

**Status:** done (design: `21-design.md`)

**Tipo:** AFK

**Tanda:** 4

**Seguridad:** sensible (crea Projects en un Space, usa el token de Makita, toca repositorios privados). Nota de diseño `21-design.md` antes de construir.

Spec: ../spec.md

- [x] Contracts: `MakitaRepoAddInput { spaceId, repo }`, `MakitaRepoAddResult { project, created, notes }`.
- [x] Puerta WS `makita.repos.add`: sesión propia de una persona, `makita.use` en el Space; crear exige además `project.create` (lo mismo que crear uno a mano); scope `source-control:write` como `projectClone.start`. En los barridos de puertas.
- [x] `owner/name`, `https://github.com/owner/name(.git)`, `git@github.com:owner/name.git`; cualquier otra cosa se rechaza sin llamar a GitHub.
- [x] Reutiliza un Project del Space con ese remoto (sin crear nada, sin pedir `project.create`).
- [x] Repositorio privado: solo si la cuenta vinculada de quien lo pide es colaboradora (o es el Owner). Un 404, un 403 y un privado ajeno responden igual.
- [x] Crea el Project con el clon del Hub, en el Space de la configuración, como quien lo pide (dueño según las reglas del Space); espera a que el clon tenga su remoto o falle.
- [x] Auditoría `makita.repo.add` (con su etiqueta en `AUDIT_ACTION_LABELS`).
- [x] Web: en «Repositories», un campo «owner/name» y «Add»; el Project nuevo aparece marcado.
- [x] Red-first: un Guest, un Admin sin el permiso y otro Space no añaden nada; otro Space no se ve; un privado sin cuenta vinculada colaboradora se responde como inexistente; reutilizar no crea un segundo; quitarlo de la configuración no borra el Project.
