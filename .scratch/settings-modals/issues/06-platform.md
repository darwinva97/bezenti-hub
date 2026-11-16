# 06: Platform

**What to build:** El modal **Platform** en `/settings/platform/$section`, solo para el Owner. Recibe **Users** (el contenido de `UsersDialog.tsx`), **Audit log** (el de `AuditLogDialog.tsx`; `AuditLogSettingsSection.tsx` desaparece), **Master key** (`MasterKeySettingsSection`), **AI gateway** (`AiGatewaySettings`), **Sandboxes** (`HubSandboxesSettings` y `SandboxImageSettings`), **Hub defaults** (`ThreadsSettingsPanel`, `BrowserSettingsPanel` y la parte de todos los Projects de `WorktreesSettingsPanel`) y **Labs** (`LabsSettingsPanel`). Quedan reservados los huecos Hub machine (ticket 07), Registration y Keycloak (`../keycloak-sign-in/`), Plans (`../plans-and-limits/`) y Terms (`../platform-privacy/`).

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Space selector: «Users and permissions» y «Audit log» se sustituyen por una entrada «Platform», solo para el Owner. `UsersDialog.tsx` y `AuditLogDialog.tsx` se borran como diálogos; su contenido vive en las secciones.
- [ ] Un User que no es el Owner no ve Platform en la barra lateral, el selector ni la paleta, y si abre su URL ve «Only the Owner of this Hub opens Platform.» y nada más.
- [ ] `/settings/ai-gateway`, `/settings/threads`, `/settings/browser`, `/settings/integrations` (salvo `#devices`), `/settings/worktrees`, `/settings/labs`, `/settings/beta` y las anclas de clave maestra y auditoría de `/settings/access` redirigen aquí. Un Member que llega por ellas ve el aviso: deja de leer los valores del Hub, que hoy ve en solo lectura.
- [ ] `CustomSnoozeDialog.tsx` lleva a Platform → Hub defaults → Threads.
- [ ] Nuevo comando de atajo `settings.platform` sin tecla y entrada «Platform» en la paleta (solo Owner).
- [ ] Filas de visibilidad de Platform en `settingsModals.test.ts`; test de navegador del aviso para un Member.
