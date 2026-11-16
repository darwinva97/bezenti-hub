# 12: Quitar la página Settings antigua

**What to build:** Borrar lo que queda de la página Settings mezclada una vez movidas todas las secciones: los archivos `apps/web/src/routes/_chat.settings.<vieja>.tsx` (las URLs viejas viven en la tabla de redirecciones), `SETTINGS_NAV_GROUPS`, `SETTINGS_SECTION_LABELS`, `SETTINGS_OWNER_ONLY_PATHS`, `InstallationSettingsBoundary.tsx`, `SETTINGS_DEVICE_ONLY_PATHS` y `SettingsScopeSentence.tsx`, las partes de `settingsScope*.ts` y `SettingsScopeContext.tsx` que solo servían al alcance «all» y al eje de máquina, `ConnectionsSettings.tsx` una vez repartido, y `/settings/secrets` con `SecretsSettings` (`T3CODE_FEATURE_SECRETS`), que redirige a User → Vault.

**Blocked by:** 02, 04, 05, 06, 07, 08, 11

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] No queda ninguna ruta `/settings/<x>` fuera de `user`, `space`, `project` y `platform`, salvo como fila de la tabla de redirecciones.
- [ ] El test de tabla cubre todas las rutas viejas (incluidas `integrations`, `storage`, `beta` y `secrets`) y todas las anclas de `SETTINGS_SEARCH_ITEMS` anteriores.
- [ ] `knip` no encuentra exportaciones muertas de lo borrado; `vp run check:changed` pasa.
- [ ] Ningún enlace de la app (`grep "\"/settings/"` en `apps/web/src` y `apps/mobile/src`) apunta a una ruta vieja.
- [ ] Pasada integrada con `test-t3-app` como Owner y como Member: abrir los cuatro modales desde barra lateral, Space selector, paleta y atajo; un marcador viejo lleva a su sitio; capturas antes y después al PR.
