# 11: Móvil: «Secrets» sale encima de la cabecera del Thread

**What to build:** En la pantalla de un Thread del móvil, la fila «Secrets» aparece pegada a la hora, dentro de la barra de estado, y empuja la cabecera (flecha atrás, título «Hola», subtítulo del Project) hacia abajo, dejando un hueco grande. Visto en Android con la APK 0.1.7-bezenti.25/26 (captura del 2026-11-17, Thread «Hola» del Project «Anythings»).

Causa: en `apps/mobile/src/features/threads/ThreadRouteScreen.tsx:955`, `<ThreadSecrets>` (`apps/mobile/src/features/vaults/ThreadSecrets.tsx`) se dibuja antes que la cabecera (`ThreadHeader`, pasada como `header` a `ThreadScreenBinding`) y fuera de ella. No respeta el margen superior de la barra de estado (safe area), así que queda debajo de la hora; y como ocupa sitio antes de la cabecera, la baja. El aviso del environment (`ThreadEnvironmentNotice`, `apps/mobile/src/features/environments/ThreadEnvironmentNotice.tsx`), justo encima en la línea 954, probablemente tiene el mismo fallo cuando se muestra.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Reproducir en un test de `ThreadRouteScreen` (o de la composición de la pantalla): con un Thread que tiene Secrets, la cabecera es lo primero bajo la barra de estado y «Secrets» queda debajo de ella.
- [ ] `ThreadSecrets` y `ThreadEnvironmentNotice` se dibujan debajo de `ThreadHeader`, dentro del área segura (por ejemplo, como contenido bajo la cabecera de `ThreadScreenBinding`, no como hermanos anteriores), en iOS y Android, con y sin cabecera nativa de cristal (`usesNativeHeaderGlass`) y con el inspector abierto (`inspectorPresentation`, donde no hay cabecera).
- [ ] Sin hueco: la cabecera queda a la altura normal aunque haya Secrets y aviso de environment a la vez.
- [ ] Prueba real en un Android: Thread con Secrets, Thread con aviso de environment, Thread con los dos; captura antes y después.
