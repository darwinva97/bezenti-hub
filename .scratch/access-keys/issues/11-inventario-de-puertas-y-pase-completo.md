# 11: Inventario de puertas y pase completo

**What to build:** Comprobar de punta a punta que cada puerta nueva está inventariada y decidida, que la clave no se filtra a ningún sitio y que los clientes reales (Claude Code y Codex) muestran los mensajes de la spec sin reintentar lo que no puede salir bien. Ver spec, «Puertas», «Testing Decisions» y «Lo que recibe el cliente».

**Blocked by:** 01 a 07 y 10 (y 08, 09 si se hacen).

**Status:** ready-for-agent

**Tipo:** AFK

Spec: ../spec.md

- [ ] Barrido de puertas de `accessKeys.*` (y `GET /api/ai/access-key` si existe) como Owner, Admin, Member y Guest de dos Organizations, el User de un Personal space, otro User, un agente (MCP), el shell y una sesión limitada a un Space; falla por una puerta de access keys que no llama ni nombra.
- [ ] `DoorRules.test.ts`, `RpcAuthorization.test.ts`: sin puertas sin declarar; `ai_access_keys` escrita solo donde se dice.
- [ ] Test de humo de fugas: la clave no está en la base, `audit_log`, logs, spans ni respuestas salvo la de `create`; tampoco su hash fuera de `ai_access_keys`.
- [ ] Prueba real en WSL con el CLIProxyAPI real fijado y una cuenta de prueba: un Admin de Acme crea una clave (`claude-sonnet-*` y un modelo de OpenAI, 2 000 tokens/día, 2 días); Claude Code y Codex reales en un `HOME` de prueba, solo con el setup copiado: responden; un modelo no permitido, el tope diario y una clave caducada muestran su mensaje y no reintentan; Usage y la lista muestran el uso; revocar corta la siguiente petición.
- [ ] Docs: repaso de «Access keys» contra lo construido; el estado de esta spec a `done`.
