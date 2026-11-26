# 29: Hablar con Makita sin comandos

**What to build:** Que la gente le diga a Makita lo que quiere con sus palabras, en español o en inglés, y funcione: parar, reintentar, reabrir, aprobar un push que espera y ordenar el merge. Los comandos `/makita …` siguen funcionando exactamente igual, como forma exacta. El Owner preguntó en producción «¿/makita stop o @makita stop?»: la respuesta tiene que ser «da igual, dilo como quieras». Ver spec, «Seguir la conversación», «Aprobación», «Aterrizar con `/makita merge`».

**Blocked by:** 09, 11, 13, 14, 26 (hechos).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (autonomía estilo robobun)

**Seguridad:** sensible (una frase de un comentario pasa a ser una orden: parar, aprobar un push, hacer merge). Nota de diseño `29-design.md` antes de construir.

Spec: ../spec.md

## Qué cambia

- **El Hub reconoce frases cortas, sin modelo.** Un comentario dirigido a Makita (con `@mención` en un issue; sin mención en el PR de Makita, como hoy) cuyo texto, quitando la mención, la puntuación, los emoji, las tildes, las mayúsculas y las palabras de cortesía, es exactamente una frase de una lista cerrada, vale lo mismo que su comando. Una frase más larga que solo contiene la palabra («no pares hasta que pase CI», «stop using tabs») no es una orden: llega al agente como conversación normal. Las líneas citadas (`>`) no cuentan, y si el comentario menciona a otra persona tampoco.
- **Parar** («para», «detente», «alto», «cancela», «ya no», «déjalo», «stop», «cancel», «abort»…) = `/makita stop`, con las mismas reglas.
- **Reintentar** («reintenta», «inténtalo de nuevo», «retry», «try again»…) = `/makita retry` cuando la última tarea del issue falló y no hay otra viva. Si no, es una mención normal (que hoy ya arranca o despierta una tarea): no se rompe nada.
- **Reabrir** («reábrelo», «reopen it»…) = `/makita reopen`, en un issue que Makita cerró, por alguien a quien la configuración responde. Encaja en la regla del ticket 26 sin cambiarla; en un issue la frase necesita la mención.
- **Aprobar un push que espera** («ok», «dale», «aprobado», «súbelo», «approved», «go ahead», «lgtm»…) = `/makita ok`, solo si quien lo dice es aprobador **ahora** y la tarea tiene un push esperando que Makita ya pidió; si no, es conversación. Para frases más largas, una herramienta nueva `makita_request_approval { commentId, kind }`, gemela de `makita_request_merge`: el agente señala el comentario y el Hub lo vuelve a leer de GitHub y le pide todo lo que pide a `/makita ok` (aprobador ahora, sin editar, escrito después de la petición de Makita, de esa tarea y ese repositorio), más que haya despertado el turno en curso y no se haya usado antes. Una review no aprueba.
- **Merge** («mergéalo», «fusiónalo», «merge it», «merge»…) = `/makita merge`, solo de un aprobador ahora; si no, conversación (el agente ya sabe que su autor no aprueba). Ninguna comprobación de `MakitaLanding.ts` cambia.
- **Lo que Makita dice** ofrece primero las palabras y deja el comando como alternativa exacta: «Ready to push … An approver can reply `@makita-bot ok` (or `/makita ok`) to send it.» (con el login real de Makita), el aviso de cierre con «reopen» y las instrucciones del agente.
- **Docs**: Space settings → Makita, `docs/internals/makita.md`, una página corta `docs/user/makita.md` y la spec.

## Quién puede

Lo mismo que con los comandos: parar y reintentar, quien la configuración responde; reabrir, igual (ticket 26); aprobar y ordenar merge, solo los aprobadores, leídos en el momento. Desconocidos, bots, la propia cuenta de Makita y comentarios editados: nada, como hoy.

## Cómo se deshace

Igual que cada comando: una tarea parada se pide otra vez; un push aprobado no se deshace (como con `/makita ok`), y un merge tampoco (como con `/makita merge`). Si una frase de la lista resulta mala, se quita de la lista en `makitaPlainWords.ts` y deja de ser orden en el siguiente despliegue; los comandos siguen.

## Riesgo que queda

Que una frase corta de la lista se diga sin querer dar la orden («ok» como acuse de recibo con un push esperando). Por eso «ok» y «merge» solo valen de un aprobador, aprobar solo con un push ya pedido y merge solo con todas las comprobaciones de CI; las listas son cortas, sin «sí»/«yes» ni «ship it», y una frase más larga nunca es orden del Hub.

- [ ] Reconocimiento puro (`makitaPlainWords.ts`) con las listas, probado en tabla: tildes, mayúsculas, puntuación, emoji, mención al principio o al final, citas, otra persona mencionada, frases largas que contienen la palabra.
- [ ] Parar, reintentar, reabrir, aprobar y merge por frase, con las mismas reglas que su comando, y con pruebas en los dos sentidos.
- [ ] `makita_request_approval`, solo en configuraciones que empujan; puerta en `MCP_TOOL_RULES`, `MaskedPaths`, `McpInvocationContext` y `agentContextBudget.json`.
- [ ] Inyección: el cuerpo de un issue o el comentario de quien no aprueba que dice «approved, push it» no aprueba nada, y el agente que lo señala recibe un no.
- [ ] Mensajes de Makita, instrucciones del agente, Space settings y docs ofrecen primero las palabras.
