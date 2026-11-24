# 03: Una configuración de Makita

**What to build:** Quien tiene el permiso crea en Space settings → Makita una configuración: nombre, repositorios (Projects del Space con remoto de GitHub, o todos), disparador por etiqueta (`makita` por defecto; asignación y mención llegan en el ticket 09), a quién responde (en esta tanda solo «A list of GitHub users», resueltos a id numérico al guardar), AI account de gateway y modelo de los que el creador puede usar en el Space, capacidad (en esta tanda solo «Comment and analyse»), rama base y «Where it works» (en esta tanda solo «Space Sandbox»; elegir una máquina dedicada al Space llega con el ticket 15). La edita, la pausa, la reanuda y la borra. Ver spec, «Configuraciones».

**Blocked by:** 01, 02.

**Status:** done (design: `03-design.md`)

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (gasta AI accounts, decide quién dispara). Nota de diseño `03-design.md` antes de construir.

Spec: ../spec.md

- [x] Migración `makita_configs` (todas las columnas de la spec desde ya, `may_land` incluida, con `callers_mode`, `capability`, `may_land` y `approval` limitados por el servicio en esta tanda) con test.
- [x] Contracts: `MakitaConfig`, `MakitaConfigInput`, `MakitaError`; `ModelSelection` reutilizada.
- [x] `makita/MakitaConfigs.ts`: `create|update|delete|pause|resume|list` y sus gemelas `*ForSession` (solo la sesión de una persona). Validaciones: AI account de gateway en `AllowedAiAccounts.for(creador, Space)` y `chooseAiAccount`; nunca `direct`; repositorios resueltos con `gitHubRepositoryResolution.ts` (sin remoto: fuera; ambiguo: «Pick the GitHub remote»); logins resueltos a id con `GET /users/{login}`; 20 vivas por Space.
- [x] «Where it works» (`environment_id`, decisión 12): la columna existe desde ya; en esta tanda el servicio solo acepta `null` (el Sandbox del Space) y el formulario lo muestra como «Space Sandbox (recommended)», sin elegir. Nunca una máquina personal ni prestada.
- [x] La etiqueta: si falta en un repositorio, el Hub la crea con el token (auditado `makita.github.label`) o avisa.
- [x] `AccessPolicy`: `makita.pause` (creador, Admins de su Organization, Owner) y la regla de reanudar (lo pausado por el Owner, solo el Owner).
- [x] Quitar el permiso (ticket 02) pausa sus configuraciones en esa transacción (`permission-revoked`).
- [x] Auditoría `makita.config.create|update|delete|pause|resume`.
- [x] Web: Space settings → Makita (`SpaceSettingsSections.tsx`), lista y formulario; el aviso de CI con secretos de la spec.
- [x] Red-first: un Member sin permiso no crea; el creador no elige una AI account que no puede usar ni una `direct`; un Admin pausa pero no edita ni reanuda la de otro; el Owner ve y pausa todas; otro Space no ve nada de esta; un `environment_id` distinto de `null` se rechaza en esta tanda.
