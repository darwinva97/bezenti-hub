# 15: «Anyone» y desconocidos

**What to build:** Una configuración se puede abrir a «Anyone» a sabiendas (aviso de la spec y casilla), y entonces las peticiones de quien no aprueba esperan `/makita ok` antes de empezar (salvo `approval = never`). La opción «Reply once to people who aren't allowed». Ver spec, «Quién lo pide y si puede», «Aprobación» (puerta de arranque) y preguntas abiertas 4 y 8.

**Blocked by:** 14, 11, 08.

**Status:** needs-triage

**Tipo:** AFK (preguntas abiertas 4 y 8)

**Tanda:** 3

**Seguridad:** sensible. Nota de diseño `15-design.md` antes de construir.

Spec: ../spec.md

- [ ] `callers_mode = anyone` solo con la casilla y solo si la configuración corre en el Sandbox de Makita.
- [ ] Puerta de arranque: `awaiting-approval` y su comentario.
- [ ] `strangers = reply`: un comentario por issue con el texto de la spec.
- [ ] Platform → Makita marca las configuraciones «anyone».
- [ ] Red-first: con «anyone» y `approval = others`, el issue de un desconocido no arranca el agente hasta el ok; con `reply`, dos menciones del mismo desconocido dan una sola respuesta.
