# 19: Inventario de puertas y prueba real en `bezenti-hub`

**What to build:** El pase final: todas las puertas nuevas en los barridos, la documentación completa, y la prueba real con una cuenta de bot de prueba en `bezenti-hub` siguiendo `bezenti/AGENTS.md`. Ver spec, «Puertas», «Testing Decisions» (prueba real) y «Further Notes» (primer cliente).

**Blocked by:** 13, 15, 16.

**Status:** needs-triage

**Tipo:** HITL (el Owner crea la cuenta de bot y su token; la prueba la mira una persona)

**Tanda:** 4

**Seguridad:** sensible. Sin nota de diseño propia: revisa las de los tickets anteriores.

Spec: ../spec.md

- [ ] `DoorRules.test.ts` y `RpcAuthorization.test.ts`: `makita.*`, `githubIdentity.*`, las herramientas `makita_*` y los escritores de cada tabla.
- [ ] Barrido de `makita.*` como Owner, Admin, Member y Guest de dos Organizations, el User de un Personal space, otro User, un agente, el shell y una sesión limitada a un Space.
- [ ] Fugas: el token en ninguna tabla, log, span, auditoría, entorno de agente ni respuesta.
- [ ] Docs: `docs/internals/makita.md` completo; `docs/user/` «Makita» (crear la cuenta de bot, scopes, rol Write, ruleset recomendado, configurar, aprobar, parar).
- [ ] Prueba real: configuración para `bezenti-hub` con base `public-hub-1`, solo para el creador; issue con la etiqueta → análisis; con `push`, rama `makita/…`, `bezenti-verify` verde y PR con las cuatro secciones; un RED provocado se arregla; `/makita stop` y el interruptor global paran un turno en marcha; el uso se ve como «Makita: <name>».
