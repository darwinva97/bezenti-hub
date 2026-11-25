# 23: Mirar alrededor antes de trabajar

**What to build:** Antes de arreglar nada, el agente de Makita busca en el repositorio de su tarea issues y PRs abiertos o cerrados hace poco que ya cubran lo mismo, y sabe qué otras tareas de Makita están vivas en ese repositorio. Si algo ya lo cubre, lo dice en el issue con el número, al estilo de `robobun` («#41220 is an open PR that covers this bug.», «This change is already in #46383 … No separate PR is open.»), y espera a una persona en vez de arreglarlo otra vez. El Hub impide lo que puede: un segundo PR de Makita para el mismo issue.

**Blocked by:** 12, 14.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (como `robobun`)

**Seguridad:** sensible (una herramienta nueva que lee de GitHub con el token del bot; más entrada no confiable). Nota de diseño `23-design.md` antes de construir.

Spec: ../spec.md («Amenazas de prompt injection», «Atribución»)

- [ ] `makita_search { query, state?, kind? }`, solo lectura, en el Hub: issues y PRs del repositorio de su tarea y de ningún otro (abiertos, y cerrados en los últimos 90 días), por texto. Cada resultado: número, tipo, estado, título, autor (permitido o no), un extracto corto, y en un PR el issue que enlaza y si es de Makita. Todo enmarcado como dato no confiable; como mucho 20 resultados y un tamaño acotado.
- [ ] Comparte la espera por límite de GitHub del intake; un límite alcanzado aquí también la pone.
- [ ] Las otras tareas vivas de Makita en el mismo repositorio (issue, estado, rama, PR) en el primer mensaje y en cada respuesta de `makita_search`; solo datos que ya son públicos en GitHub, nunca la configuración ni el Space.
- [ ] El primer mensaje manda buscar primero y, si algo abierto ya lo cubre, decirlo en el issue con el número y esperar.
- [ ] `makita_open_pull_request` se rechaza si el issue de la tarea ya tiene un PR abierto de Makita de otra tarea viva; sigue habiendo exactamente uno por tarea.
- [ ] Puertas: `MCP_TOOL_RULES`, la lista de herramientas de Makita, `MaskedPaths`, `agentContextBudget.json` medido.
- [ ] Red-first: una consulta con `repo:otro/repo` no lee otro repositorio; el texto de un resultado nunca se trata como orden; un PR abierto de otra tarea que cierra el mismo issue impide abrir otro.
