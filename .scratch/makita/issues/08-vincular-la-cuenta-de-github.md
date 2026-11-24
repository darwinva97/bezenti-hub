# 08: Vincular la cuenta de GitHub

**What to build:** Un User vincula su cuenta de GitHub en User settings → Account publicando desde ella `@<makita> link <código>` en un issue de un repositorio que escucha Makita. Con eso existen «Only me» y «Members of this Space with a linked GitHub account» en las configuraciones. Ver spec, «Vincular una cuenta de GitHub».

**Blocked by:** 09 (el intake ya lee los comentarios de issues).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (identidad). Nota de diseño `08-design.md` antes de construir.

Spec: ../spec.md

- [ ] Migraciones `github_identities` y `github_link_codes` con test.
- [ ] `GitHubIdentities.ts`: código de 8 caracteres, 15 minutos, un uso, SHA-256; vínculo por id numérico; id ya vinculado a otro → mensaje sin nombre; desvincular (el User o el Owner).
- [ ] Intake: el comando `link` en la primera línea de un comentario; respuesta con una reacción.
- [ ] `callers_mode` `creator` y `members` en el servicio de configuraciones y en la decisión del caller (Members actuales, leídos en cada evento).
- [ ] WS `githubIdentity.get|linkCode|unlink`; auditoría `github_identity.link|unlink`.
- [ ] Web: User settings → Account → «GitHub account».
- [ ] Red-first: un código caducado o usado no vincula; nadie vincula el login de otro; quien sale del Space deja de contar en «members» en el siguiente evento; un login renombrado sigue reconocido por id.
