# 01: Marco de los cuatro modales y User settings con las preferencias

**What to build:** El marco común de los modales y el primero de ellos. Un registro de secciones por modal (`apps/web/src/components/settings/settingsModals.ts`: id, etiqueta, icono, componente y visibilidad, con huecos reservados no visibles) alimenta la navegación de `SettingsSidebarNav.tsx` dentro de `AppRouteModal`. Nace la ruta `/settings/user/$section` con las preferencias que ya son del User o del dispositivo: General, Appearance, Chat, Diffs, Keybindings, SnapShots (escritorio) y About (con Licenses como subpágina). Nace también la tabla de URLs viejas (sustituye `movedSettingsPath`, `RENAMED_SETTINGS_PATHS` y `MOVED_SECTION_ANCHORS`), y los elementos de búsqueda pasan a `modal` + `section` con un resolutor de URL. Las demás páginas siguen en la nav vieja hasta su ticket.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md · Mapa: ../../public-hub/map.md («Configuración en modales separados»)

- [ ] `/settings` y `/settings/user` llevan a `/settings/user/general`; `/settings/general`, `/settings/appearance`, `/settings/chat`, `/settings/diffs`, `/settings/keybindings`, `/settings/snap-shot`, `/settings/about` y `/settings/open-source-licenses`, con sus anclas, redirigen a su sección nueva.
- [ ] La cabecera dice «User settings»; «Restore device defaults» sigue en General.
- [ ] Cambiar de sección reemplaza la entrada del historial: Atrás y Esc vuelven al opener. Abrir Licenses añade entrada.
- [ ] El botón Settings del pie de la barra lateral (`SidebarChrome.tsx`) muestra el nombre del User y abre User settings. El menú **Settings…** de escritorio (`DesktopApplicationMenu.ts`, `CmdOrCtrl+,`) también.
- [ ] Nuevo comando de atajo `settings.user` en `packages/contracts/src/keybindings.ts` (`STATIC_KEYBINDING_COMMANDS`) con `mod+,` por defecto en `packages/shared/src/keybindings.ts`, editable en Keybindings.
- [ ] La paleta (`CommandPalette.tsx`) tiene «Open user settings» y sus resultados de ajustes muestran «User · ‹sección›» para los movidos.
- [ ] El buscador del modal busca solo en las secciones de User settings.
- [ ] Keybindings conserva la regla de hoy (el Owner edita; los demás leen con una línea que lo explica), sin el aviso general de `InstallationSettingsBoundary`.
- [ ] La redirección de SnapShots de `routes/__root.tsx` apunta a la sección nueva.
- [ ] Test de tabla en `settingsModals.test.ts`: cada ruta vieja movida aquí y cada ancla conocida llevan a una sección registrada; los huecos reservados nunca son visibles.
- [ ] Test de navegador del marco: URL profunda, cambio de sección y Atrás vuelve al opener.
