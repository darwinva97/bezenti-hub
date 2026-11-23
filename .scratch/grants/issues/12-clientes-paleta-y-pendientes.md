# 12: Desktop, móvil, paleta de comandos y avisos de pendientes

Spec: ../spec.md

**What to build:** Los Grants llegan a todas las superficies:

- desktop, revisando lo que añade a web;
- móvil, con pantallas propias para listas, aceptar, rechazar, devolver, retirar, uso y aplicar un enlace;
- la paleta de comandos;
- un contador de pendientes junto al Space, para quien decide.

Dar un Grant con límites queda en web y desktop. Ver spec, «Clientes».

**Blocked by:** 04, 06, 07, 10.

**Status:** done except the live passes (design: 12-design.md)

- [x] El contador de pendientes llega por el stream de Spaces (`packages/client-runtime/src/spaces/`) solo a quien tiene `grant.decide`. Web, desktop y móvil lo muestran en el selector de Spaces. Red-first: un Member no lo recibe.
- [x] Paleta: «Prestar un recurso…», «Préstamos por aceptar», «Préstamos dados». Sin atajo por defecto nuevo.
- [x] Desktop: el enlace de préstamo abre en la app (deep link) o en el navegador con la URL pública del Hub.
- [x] Móvil (`apps/mobile/src/features/`):
  - [x] «Préstamos dados» y «Prestado a este Space» con uso;
  - [x] aceptar, rechazar, devolver y retirar, con los mismos avisos;
  - [x] aplicar un enlace;
  - [x] selector de AI account y de Environment con «de <prestador>», distintivo de máquina prestada y parte del tope usada.
- [x] Lógica compartida en `packages/client-runtime`, no copiada en web y móvil.
- [x] `docs/user/`: sección «Lending resources» (qué se presta, cómo se acepta, qué ve el dueño de una máquina, términos de las suscripciones).
- [ ] Pase con `test-t3-app` (web) y `test-t3-mobile` (móvil): no hecho aquí (sin Hub real ni dispositivo; móvil solo con tests de componentes).
