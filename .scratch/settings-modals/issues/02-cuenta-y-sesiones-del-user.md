# 02: User settings → Account y Sessions

**What to build:** Lo que es de la persona dentro de `/settings/access` (`ConnectionsSettings view="access"`) pasa a User settings: **Account** recibe `AccountSettingsSection` (métodos de inicio de sesión, TOTP, contraseña, cerrar sesión) y, en escritorio, la conexión guardada al Hub («Hub of this app»: `SavedEnvironmentRows`, `AddEnvironmentDialog`, `KeptSavedConnectionsNotice`). **Sessions** recibe «Your sessions» (authorized clients, pairing links) y «Permissions» (`SessionPermissions`). Quedan reservados en Account los huecos «Connect with Keycloak» (`../keycloak-sign-in/`) y «Delete my account» (`../platform-privacy/`).

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `/settings/access#authorized-clients` y los anclajes de cuenta y sesiones redirigen a User → Sessions o User → Account. El resto de `/settings/access` (clave maestra, auditoría, red) sigue en la nav vieja hasta los tickets 06 y 07.
- [ ] `PermissionUpdateNotice.ts` lleva a User → Sessions; el aviso «Set up an authenticator app to become Admin» de `SpaceSelector.tsx` lleva a User → Account.
- [ ] Revocar una sesión, crear un enlace de emparejamiento y cambiar de método siguen funcionando igual (mismos componentes, sin `Dialog` nuevo).
- [ ] La sección «Hub of this app» solo aparece en escritorio.
- [ ] Filas nuevas en la tabla de redirecciones de `settingsModals.test.ts`.
