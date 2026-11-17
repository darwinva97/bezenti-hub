# 05: Variables

> Reescrito el 2026-11-16. Gran parte ya está construida en `../../vault-variables-and-providers/` ticket 01 (migración 119): `vault_entries.class` (`secret` | `variable`), Variables legibles con `vault.readVariables`, no enmascaradas por `SecretMasker`, entregadas en `secretEnv`, Variable → Secret que sella, y Secret → Variable solo con un valor nuevo. Se queda `class` (no se añaden `type` ni `value_text`) y el valor de una Variable sigue en el almacén cifrado. Este ticket cubre lo que falta.

**What to build:** Lo que falta para el spec: el agente distingue Secrets de Variables y lee el valor de una Variable con `list_secret_names`; el panel «Secrets» del Thread y el historial muestran las Variables con su valor; la UI de añadir deja claro qué es cada tipo, también en móvil; la auditoría nombra el tipo. Ver spec, «Secrets y Variables» y «Herramientas del agente».

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Comprobar primero contra el código qué de esta lista ya existe (el ticket 01 de `vault-variables-and-providers` y su `01-design.md`) y no repetirlo; anotar en el commit lo que ya estaba.
- [ ] `list_secret_names`: cada elemento con `type` (`secret` | `variable`, de `class`) y, solo en Variables, `value` (`OrchestratorMcpListSecretNamesResult`, cambio aditivo). Fuente de verdad: el mismo conjunto efectivo que recibe el proceso. Red-first en `OrchestratorMcpService.test.ts`: una Variable devuelve su valor; un Secret, una Provider entry, un template con algún Secret y una entrada de identidad nunca. `MCP_TOOL_RULES` y `DoorRules.test.ts` al día.
- [ ] Descripción nueva de la herramienta; eval `evals/mcp-tool-use` corrido antes y después, con un caso nuevo que falla antes: el agente lee la Variable de la respuesta y usa `$NAME` para el Secret.
- [ ] Instrucciones de desarrollador de los agentes: la línea de secretos menciona Variables.
- [ ] Panel «Secrets» del Thread (web y móvil): las Variables con su valor, los Secrets solo con nombre. Test de que el valor de un Secret nunca llega al cliente.
- [ ] Web y desktop: al añadir, elegir «Secret» o «Variable» con el texto «Visible to everyone who receives this group»; Variables con su valor y editables en área de texto; «Make secret» con aviso de que lo ya impreso sigue visible. Lo que ya exista se ajusta a estos textos, no se rehace. Móvil igual, en `apps/mobile/src/features/vaults/`.
- [ ] Auditoría `secret.edit` con `type` y `op` (`add`, `replace`, `rename`, `describe`, `delete`, `to-secret`); nunca el valor de una Variable.
- [ ] Docs: `docs/internals/secrets.md` (modelo y masking, una frase cada uno, si falta); `docs/user/install.md` explica Secret frente a Variable en la sección de vaults.
