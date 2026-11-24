# 14: Seguir la conversación del PR

**What to build:** En el PR de Makita, las reviews y los comentarios de personas permitidas despiertan al Thread sin mención, y el agente responde o empuja de nuevo; el guardia de bucles cuenta entre issue y PR. Ver spec, «Seguir la conversación».

**Blocked by:** 12, 09.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 2

**Seguridad:** sensible (más entrada no confiable). Nota de diseño `14-design.md` antes de construir.

Spec: ../spec.md

- [ ] Reviews de los PRs abiertos de Makita (`gh:review:<id>`) y comentarios de su conversación y en línea.
- [ ] Un push pedido en una review de alguien que no aprueba pasa por la aprobación (ticket 11).
- [ ] Guardia: 5 seguidos sin persona, 30 por 24 h, por issue o PR.
- [ ] Red-first: otro bot (cuenta normal en `ignore_json`) que comenta en bucle no recibe más de una respuesta; una review de un no permitido no despierta.
