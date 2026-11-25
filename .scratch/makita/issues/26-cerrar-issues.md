# 26: Cerrar issues con un veredicto

**What to build:** Una capacidad nueva por configuración, apagada por defecto: «May close issues». Con ella, el agente de una tarea puede pedir al Hub, con una herramienta nueva del Hub, que cierre el issue de su propia tarea como «not planned» o «completed», dando un veredicto (wanted / not wanted / duplicate of #n / cannot reproduce / already fixed in #n), una confianza y un motivo corto, como el «Wanted check: not-wanted, confidence 0.8 … Closing as not planned.» de `robobun`. El Hub decide; el agente solo pide. Ver spec, «Amenazas de prompt injection», «Seguir la conversación», «Parar».

**Blocked by:** 05, 08, 09 (hechos).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (autonomía estilo robobun)

**Seguridad:** sensible (escritura en GitHub decidida a partir de texto no confiable). Nota de diseño `26-design.md` antes de construir.

Spec: ../spec.md

- [ ] La configuración gana «May close issues» (apagada por defecto), un umbral de confianza (por defecto 0.8) y un límite diario de cierres.
- [ ] Herramienta MCP `makita_close_issue { verdict, ref?, confidence, reason }`, listada solo cuando la capacidad está encendida; puerta en `MCP_TOOL_RULES`, `MaskedPaths` y `agentContextBudget.json`.
- [ ] El Hub comprueba: capacidad encendida, nada en pausa, tarea viva, el issue es el de la tarea y está abierto, su autor es alguien a quien la configuración responde o la orden de triar vino de alguien así (nunca cierra el issue de un desconocido por texto de un desconocido), confianza al menos el umbral, el `#n` de un duplicado o de «already fixed» existe en el mismo repositorio, como mucho un cierre por tarea y uno por issue para siempre, y el límite diario.
- [ ] Un comentario al estilo robobun (veredicto, confianza, motivo y cómo reabrirlo), luego el cierre con el `state_reason` que toca. Auditado. La tarea termina `done`.
- [ ] Reabrir gana para siempre: una persona permitida que reabre el issue, o que comenta `/makita reopen` (el Hub lo reabre), deja constancia y Makita no vuelve a cerrar ese issue.
- [ ] Red-first: cerrar con la capacidad apagada, en pausa, con la tarea parada, por debajo del umbral, el issue de un desconocido pedido por un desconocido, un duplicado de un `#n` que no existe, dos veces en una tarea o un issue ya reabierto, y pasado el límite diario no cierra nada; uno válido comenta y cierra con su `state_reason`; `/makita reopen` de un desconocido no hace nada.
