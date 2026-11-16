# 09: Móvil: Settings con cuatro entradas

**What to build:** `apps/mobile/src/features/settings/SettingsRouteScreen.tsx` pasa a ser un índice con User, Space, Project y Platform (esta, solo para el Owner), más las conexiones que ya muestra. Cada entrada abre una pantalla índice con las mismas secciones que la web, limitadas a las pantallas que el móvil ya tiene. Se mueven sin reescribirlas, según el reparto del spec («Móvil»). Las rutas de `apps/mobile/src/Stack.tsx` pasan a `settings/user/…`, `settings/space/…`, `settings/project/…` y `settings/platform/…`. Lo de Platform que el móvil no tiene se abre en el navegador del sistema con la URL pública del Hub.

**Blocked by:** 03, 05, 06

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] La visibilidad de cada entrada y sección sale de la lógica compartida de `packages/client-runtime` del ticket 03, no de una copia.
- [ ] Space muestra Scheduled tasks y Archive del Space actual; Project muestra `SettingsProjectOverviewRouteScreen` con el Project del contexto.
- [ ] Platform lista Providers, Threads, Worktrees, Source control y Maintenance del Hub, Labs y Diagnostics, y una fila «Open Platform in browser» que abre `/settings/platform/users` en la URL pública del Hub (ADR 0007).
- [ ] La búsqueda de ajustes del móvil (`settings-search.ts`, `settings-page-targets.ts`) apunta a las rutas nuevas.
- [ ] Pasada con `test-t3-mobile` como Owner y como Member; capturas al PR.
