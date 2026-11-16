# 07: Páginas de máquina

**What to build:** Un componente `MachineSettings` con las secciones de una máquina: **Providers** (`ProviderSettingsPanel`), **Source control** (`SourceControlSettingsPanel`), **Devices** (`DevicesSettingsPanel`, `DeviceSourcesSettings`), **Maintenance** (versión y URL, `MaintenanceSettingsPanel`, con Diagnostics como subpágina) y, solo para el backend local del escritorio, **Network** (acceso de red, endpoints, Tailscale y WSL de `ConnectionsSettings`). Se monta en Platform → Hub machine (`/settings/platform/hub-machine/$section`) y en User → Machines → This computer (escritorio, con «This app»: `LocalEnvironmentSetting`, `JoinedEnvironmentSetting`). Las rutas `/settings/user/machines/$environmentId/$section` y `/settings/space/$spaceId/machines/$environmentId/$section` quedan listas para que el ticket 08 enlace cada máquina de las listas.

**Blocked by:** 01, 06

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `/settings/providers`, `/settings/source-control`, `/settings/devices`, `/settings/maintenance`, `/settings/diagnostics`, `/settings/storage` y `/settings/integrations#devices` redirigen a la máquina de `?machine=` si viene y se puede abrir; si no, a Platform → Hub machine para el Owner; si no, al opener.
- [ ] Cada página fija su máquina: sin selector de máquina ni alcance «all».
- [ ] Quién edita sigue igual que hoy (el Owner); los demás no ven estas secciones salvo lo que hoy ya ven. `../owned-resources/` cambiará la regla para el dueño de la máquina.
- [ ] Enlaces: `ModelPickerContent.tsx`, `useComposerSelection.ts`, `SidebarProviderUpdatePill.tsx`, `GitActionsControl.tsx` y la acción de source control de la paleta llevan a la sección de la máquina del Thread o Project del contexto, o a la del Hub, y no aparecen para quien no puede abrirla.
- [ ] La actualización de la app de escritorio pasa a User → About.
- [ ] Los tests de navegador de proveedores (`ProviderSettingsPanel.environment.browser.test.tsx`, `ProviderInstanceCard.environment.browser.test.tsx`) siguen pasando con la máquina fijada por la ruta.
- [ ] Filas nuevas en la tabla de redirecciones.
