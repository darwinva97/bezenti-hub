# 19: La barra lateral y sus acciones solo actúan en el Space actual

**What to build:** Todo lo que se hace desde la barra lateral pertenece al Space seleccionado en el selector de abajo: la lista de Projects y Threads, crear un Project, crear un Thread (el selector de Project solo ofrece los del Space actual), Search y Settled. Hoy la lista ya se filtra por Space (`apps/web/src/hooks/useSidebarSpaceFilter.ts`), pero hay un interruptor **All Spaces**, el Thread abierto sigue listado aunque sea de otro Space, y las demás acciones no están limitadas.

**Blocked by:** None (can start immediately).

**Status:** done (rama `feat/identity-17-19`)

Spec: ../spec.md · Mapa: ../../public-hub/map.md («Todo en el Space actual»)

- [x] Crear un Project lo crea en el Space actual, desde la barra lateral, la paleta de comandos y el atajo de teclado.
- [x] Crear un Thread solo ofrece los Projects del Space actual, desde todas las entradas (botón, paleta, atajo, pantalla de borrador).
- [x] Search busca solo Projects y Threads del Space actual.
- [x] Settled cuenta y lista solo Threads del Space actual.
- [x] Desaparece el interruptor **All Spaces**.
- [x] Abrir un Thread o Project de otro Space (enlace, notificación, historial del navegador) cambia el Space actual al suyo, en vez de dejarlo listado fuera de su Space. Así la barra lateral nunca mezcla Spaces.
- [x] El servidor rechaza crear un Thread en un Project de otro Space que no sea el pedido; la regla no depende solo del cliente.
- [x] Web, escritorio y móvil se comportan igual; la lógica compartida vive en `packages/client-runtime`.
- [x] `docs/user/install.md` («Spaces and organizations») se reescribe donde habla de **All Spaces** y del Thread abierto de otro Space.
