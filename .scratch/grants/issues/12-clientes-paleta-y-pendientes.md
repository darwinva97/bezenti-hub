# 12: Desktop, móvil, paleta de comandos y avisos de pendientes

Spec: ../spec.md

**What to build:** Los Grants llegan a todas las superficies:

- desktop, revisando lo que añade a web;
- móvil, con pantallas propias para listas, aceptar, rechazar, devolver, retirar, uso y aplicar un enlace;
- la paleta de comandos;
- un contador de pendientes junto al Space, para quien decide.

Dar un Grant con límites queda en web y desktop. Ver spec, «Clientes».

**Blocked by:** 04, 06, 07, 10.

**Status:** ready-for-agent

- [ ] El contador de pendientes llega por el stream de Spaces (`packages/client-runtime/src/spaces/`) solo a quien tiene `grant.decide`. Web, desktop y móvil lo muestran en el selector de Spaces. Red-first: un Member no lo recibe.
- [ ] Paleta: «Prestar un recurso…», «Préstamos por aceptar», «Préstamos dados». Sin atajo por defecto nuevo.
- [ ] Desktop: el enlace de préstamo abre en la app (deep link) o en el navegador con la URL pública del Hub.
- [ ] Móvil (`apps/mobile/src/features/`):
  - [ ] «Préstamos dados» y «Prestado a este Space» con uso;
  - [ ] aceptar, rechazar, devolver y retirar, con los mismos avisos;
  - [ ] aplicar un enlace;
  - [ ] selector de AI account y de Environment con «de <prestador>», distintivo de máquina prestada y parte del tope usada.
- [ ] Lógica compartida en `packages/client-runtime`, no copiada en web y móvil.
- [ ] `docs/user/`: sección «Lending resources» (qué se presta, cómo se acepta, qué ve el dueño de una máquina, términos de las suscripciones).
- [ ] Pase con `test-t3-app` (web) y `test-t3-mobile` (móvil).
