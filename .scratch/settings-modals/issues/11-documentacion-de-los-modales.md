# 11: Documentación: cada «Settings → …» a su modal

**What to build:** Reescribir en `docs/user/` cada ruta «Settings → X» con su ruta nueva («User settings → Appearance», «Space settings → Members», «Project settings → Actions», «Platform → Hub machine → Providers»…), según la tabla de clasificación del spec. Se cambian también las menciones a «Organization settings», «Users and permissions» y «Audit log» desde el Space selector en `docs/user/install.md`. Se añade en `install.md` una sección breve con los cuatro modales y cómo se abren (barra lateral, Space selector, paleta, `mod+,`), sin describir pantallas.

**Blocked by:** 02, 04, 05, 06, 07, 08, 09

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Ningún archivo de `docs/user/` contiene «Settings →» ni «Settings ->» con una ruta vieja (`grep` limpio). Archivos con rutas hoy: `install.md`, `providers-*.md`, `remote-access.md`, `source-control.md`, `project-settings.md`, `thread-sidebar.md`, `composer.md`, `keybindings.md`, `devices.md`, `appearance.md`, `usage.md`, `updating.md`, `background-service.md`, `outside-agents.md`, `telemetry.md`, `open-source-licenses.md`, `cursor.md`, `browser-import.md`, `default-browser.md`, `faq.md`, `guest-links.md`, `keyboard-focus.md`, `permission-modes.md`, `public-hub.md`, `snap-shot.md`.
- [ ] `docs/user/keybindings.md` documenta `settings.user` (`mod+,`), `settings.space`, `settings.project` y `settings.platform`.
- [ ] `docs/internals/mobile-navigation.md`, `mobile-development.md`, `remote.md` y `open-source-licenses.md` se reescriben donde nombran rutas o pantallas de Settings, sin añadir historia.
- [ ] Las secciones que existen solo para el Owner se presentan como tales; no se documentan los huecos reservados.
