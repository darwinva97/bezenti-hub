# 05: Project settings

**What to build:** El modal del Project en `/settings/project/$projectKey/$section`, que sustituye `/settings/projects` (`ProjectsSettings.tsx`) y reparte `ProjectSettingsPanel.tsx` en secciones: **General** (nombre, icono, pin, archivar, Space y mover con `ProjectMoveDialog`, zona de peligro), **Vaults** (`ProjectVaultsSettings`), **Machine** (`ProjectPreferredEnvironmentSettings` y Checkouts), **Defaults** (`ProjectDefaultsSettings` y el override de worktrees de `WorktreesSettingsPanel`) y **Actions** (`ProjectActionsSettings`). El selector de checkout se queda dentro del modal; la página «Choose a project» desaparece.

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `/projects/$projectKey` y `/settings/projects?project=…&machine=…&checkout=…` redirigen al modal con el mismo Project y checkout. `/settings/projects` sin Project lleva al Project del contexto o cierra en el opener.
- [ ] Abrir el modal de un Project de otro Space cambia el Space actual.
- [ ] Entradas: «Project settings» del menú del Project en `Sidebar.tsx`, la paleta (`action:project-settings`) y el enlace del borrador en `ChatView.tsx`. Nuevo comando de atajo `settings.project` sin tecla, que abre el Project del contexto.
- [ ] Quién edita sigue la regla actual (`canEditGroup`); quien solo ve el Project lee.
- [ ] Mover el Project a otro Space desde General sigue funcionando y, tras moverlo, el modal sigue al Project (que cambia de Space).
- [ ] `ProjectSettingsPanel.browser.test.tsx` y `useProjectScriptSettings.browser.test.tsx` siguen pasando contra la ruta nueva, sin duplicarse.
- [ ] Filas nuevas en la tabla de redirecciones.
