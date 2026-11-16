# 16: Agente y clientes

**What to build:** El agente ve el estado completo de lo que recibe (`list_secret_names` con clase, fuente, entrega, ruta, caducidad, estado y valor de Variables), y los tres clientes cubren todo el spec: Settings → Vaults, Settings → Secret providers, panel «Secrets» del Thread y aprobaciones, en web, desktop y móvil. Ver spec, «Agente» y «Clientes».

**Blocked by:** 01–08, 14

**Status:** needs-triage

- [ ] MCP `list_secret_names` con los campos nuevos; red-first: nunca el valor de un Secret, ni de otro User del Thread.
- [ ] `request_secret`: guarda sellado; en un Provider-backed vault `writable`, escribe en el proveedor.
- [ ] Recorrer «Hit every surface» de `AGENTS.md` y anotar qué aplica a cada entrada (paleta de comandos, atajos, escritorio, móvil, puertas de vuelta).
- [ ] Nombres accesibles fijados y usados en las pruebas.
