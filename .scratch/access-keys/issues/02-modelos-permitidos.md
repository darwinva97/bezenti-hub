# 02: Modelos permitidos

**What to build:** Cada access key lleva una lista de modelos permitidos (nombres exactos, patrones con `*` final o «All models»). La gateway rechaza con 403 en la forma del cliente un modelo fuera de la lista, nombrando los permitidos; `/v1/models` lista solo lo permitido que sirven las cuentas de la clave; y «Copy setup» de Claude Code fija sus alias y su modelo de fondo a modelos permitidos. Ver spec, «Modelos permitidos».

**Blocked by:** 01.

**Status:** ready-for-agent

**Tipo:** AFK

Spec: ../spec.md

- [ ] Contracts: `AccessKeyModels` (1 a 50 entradas, `*` final solo, `["*"]` = todos); `AccessKeyCreateInput.models` obligatorio.
- [ ] `accessKeyModelAllowed(entries, requested)` pura, con test de tabla: mayúsculas, `acct-<id>/`, sufijo `[1m]`, nombre exacto frente a versión fechada, patrón, `*`, entradas inválidas.
- [ ] `AiGatewayProxy`: el modelo se mira antes de `planRoute`; no permitido → 403 (`permission_error`, `model_not_allowed`, `PERMISSION_DENIED`) con hasta 10 nombres permitidos; permitido sin cuenta que lo sirva → el 404 de hoy.
- [ ] `/v1/models` de las tres formas: catálogos de las cuentas de la clave ∩ lista (los patrones se expanden; nunca aparecen como nombre).
- [ ] WS `accessKeys.modelOptions {spaceId}`: los modelos que sirven las cuentas propias del Space (para el formulario), con `accessKey.manage`.
- [ ] Setup: Claude Code con `ANTHROPIC_MODEL` y `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` fijados a modelos permitidos y servidos (el de la familia si existe, si no el primero); Codex con `model`. Test del setup con listas que no incluyen Haiku u Opus.
- [ ] Web: selector de modelos por familia desde el catálogo, «Add pattern» y «All models» explícito; la lista de claves muestra los modelos.
- [ ] Red-first: `claude-sonnet-*` deja `claude-sonnet-5-5` y rechaza `claude-opus-5-5` en las tres formas, también fijado con `acct-<id>/`; `/v1/models` no lista Opus; una lista vacía o con `*` en medio se rechaza al crear.
- [ ] Docs: «Access keys» → modelos y alias.
- [ ] Prueba real: con solo Sonnet permitido, Claude Code (setup copiado) responde sin errores del modelo de fondo; `/model opus` muestra el 403 con los modelos permitidos.
