# Diseño: buscar MCPs en el MCP Registry

Issue: darwinva97/bezenti-hub#12. Sigue a `space-mcps-and-skills-design.md` (#10), que dejó fuera
un catálogo público. Estado: **decidido** (2026-11-27, darwinva97 en #12: «tú decide y hazlo»).

## Qué cambia

- **Registro del primer corte:** solo el registro oficial, `registry.modelcontextprotocol.io`
  (`GET /v0/servers?search=&version=latest`), que no pide clave. No había búsqueda de Skills en un
  marketplace que copiar: el flujo nuevo es buscar → elegir → formulario relleno → revisar → Save.
- **Quién busca:** el servidor del Hub (`spaceTools.mcp.search`, `McpRegistry.ts`). Así un solo
  sitio valida la respuesta y una sola caché (10 min, 200 preguntas, compartida porque el registro
  es público) sirve a web, desktop y móvil. Tiempo máximo 8 s. Un fallo o una respuesta rara es
  `registry-unavailable` y la pantalla sigue funcionando.
- **Respuesta no confiable:** `mcpRegistryRules.ts` decodifica cada entrada por separado y descarta
  la que no decodifica, la que no sabe arrancar (solo npm, pypi y oci para stdio, y
  `streamable-http` sobre https), y la que rompe las reglas de un Space MCP (`configProblem`,
  `secretLiteralIn`). Nunca la repara. Máximo 20 resultados.
- **Vault:** un valor marcado `isSecret` llega como `${NOMBRE}`; `Authorization` como
  `Bearer ${<SERVIDOR>_TOKEN}`. Al guardar se aplica `unknown-reference` como siempre: hay que tener
  esa entrada en un Vault group que alcance el Space.
- **Nada corre sin confirmar:** elegir solo rellena el formulario (web) o abre una confirmación con
  el comando completo, los valores y los nombres del Vault que necesita (móvil). Se ofrece antes un
  remoto que un comando.
- **Origen:** `space_mcps.source_json` (migración 178) guarda `{ registry, id, version }` al crear;
  una edición lo conserva. Se ve en la fila y en el audit entry `space_mcp.create` (`source`).
  Apagar y borrar son los de siempre.

## Quién puede

Solo quien gestiona las tools del Space (`spaceTool.manage`): el resto recibe `forbidden`, y quien
no ve el Space, `not-found`. Es una lectura (`AuthAccessReadScope`): no cambia nada.

## Cómo se apaga y cómo se añaden registros

- El Owner arranca el servidor con `T3CODE_MCP_REGISTRY_URL=off` para que el Hub no salga a
  internet; la misma variable apunta a un espejo con la misma API.
- Otro registro es otro adapter que produce `SpaceMcpSearchResult` y un valor nuevo en
  `SpaceMcpSource.registry`.

## Fuera de este corte

Skills desde un marketplace (cuando haya un registro que elegir), una tool MCP para agentes, un
límite por usuario además de la caché, y editar el borrador en el móvil antes de guardarlo.
