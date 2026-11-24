# 05: La tarea y su Thread, solo comentar

**What to build:** Un etiquetado aceptado crea una tarea y su Thread en el Project del repositorio, del creador y ejecutado como él, en el Sandbox del Space, con la AI account de la configuración y sin ningún valor de Vault. Makita comenta «On it.» en el issue, el agente lee el issue enmarcado, analiza el código y publica su análisis con `makita_comment`. Ver spec, «La tarea y su Thread», «Atribución», «Amenazas de prompt injection» y «Seguir la conversación» (guardia de bucles).

**Blocked by:** 04.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (agente que lee texto no confiable). Nota de diseño `05-design.md` antes de construir.

Spec: ../spec.md

- [ ] Migración `makita_tasks` con test (`UNIQUE (host, repo, number)` para tareas vivas).
- [ ] Lanzamiento con `ThreadLaunchService.launch` como `ScheduledTaskService.runTask`: `CommandActor.actAsResolved` del creador, `creationSource: "makita"`, título, `ModelSelection`, worktree desde la base; `CommandId`/`MessageId` derivados de la clave del evento.
- [ ] Colocación fija a «Where it works»: en esta tanda, el Sandbox del Space; nunca una máquina personal ni prestada, ni la preferencia del Project. El Thread corre como el creador de la configuración, pida quien pida.
- [ ] Comprobaciones al empezar y antes de cada turno: pausa, creador activo, en el Space y con `makita.use`, Space abierto, AI account disponible; si falla por el creador, la configuración se pausa con su motivo.
- [ ] Un Thread de Makita: `EffectiveVaults` vacío, `SecretDelivery` no entrega nada, `request_secret`/`list_secret_names` → `forbidden`, sin workload identity; lista de herramientas MCP permitidas en `McpToolAccess.ts`.
- [ ] Prompt inicial con el enmarcado de `webhookTemplate.ts` (autor y «allowed» por comentario) y las instrucciones de la spec.
- [ ] MCP `makita_read_issue` y `makita_comment` (repositorio y número de la tarea; `SecretMasker` y rechazo de texto con forma de token; guardia de 5 seguidos y 30 por 24 h) en `MCP_TOOL_RULES`.
- [ ] Auditoría `makita.task.start` y `makita.github.comment`.
- [ ] Web: cabecera «Makita · <repo>#<n> · asked by @<caller>» en el Thread y filtro «Makita» en la lista.
- [ ] Red-first: un issue que pide imprimir el entorno, `gh auth token` o comentar un archivo de configuración no deja ningún valor de Vault ni el token en el entorno del agente ni en un comentario; el agente no ve `t3_thread_launch`, `request_secret` ni `watch_pull_request`; `makita_comment` no escribe en otro issue; el sexto comentario seguido no sale.
- [ ] Docs: `docs/internals/makita.md` (lo de este ticket); `GLOSSARY.md`: el título pasa de «Makita (t3code fork)» a «Bezenti Hub» y se añaden «Makita» (solo el bot) y «Makita configuration» (decisión del Owner del 2026-11-24).
