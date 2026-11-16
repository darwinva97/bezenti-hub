# 08: Inicio de sesión local para quien no es el Owner

**What to build:** El Owner apaga «Permitir inicio de sesión local a los demás» cuando todos han pasado a Keycloak: desde entonces solo él entra con passkey, contraseña o código de recuperación, las sesiones locales de los demás se cierran y la aceptación de Invitations con credenciales nuevas desaparece. Un reset link que da el Owner sirve para que alguien vincule (o vuelva a vincular) una cuenta de Keycloak. El Owner también puede desactivar Keycloak, que vuelve a abrir el inicio local. Ver spec, «Vincular, reset y el inicio de sesión local».

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Con el ajuste apagado, passkey, contraseña, TOTP y la aceptación de Invitations con credenciales nuevas se rechazan para quien no es el Owner, después de verificar la credencial; el Owner entra igual.
- [ ] Apagarlo revoca en la misma transacción las sesiones de quien no es el Owner sin `identity_login_id` y nacidas de un inicio local (no las de la shell del Hub); no se puede apagar con Keycloak inactivo. El modal muestra antes cuántos Users no tienen identidad.
- [ ] Intención `reset` en `start` con el token del reset link: vincula esa identidad (sustituye la anterior), borra credenciales locales, cierra todas las sesiones y emite una de Keycloak, en una transacción; la página `/reset` la ofrece con Keycloak activo y deja passkey o contraseña solo si el inicio local está permitido. Auditoría `resetLink.redeem` y `user.identity.link`.
- [ ] Desactivar Keycloak: conserva configuración, identidades y mapeos, enciende el inicio local y termina todos los logins de Keycloak; el modal avisa cuántas sesiones cierra.
- [ ] Cambiar el issuer con identidades guardadas pide confirmación con el aviso del spec.
- [ ] Web: con Keycloak activo y el inicio local apagado, el formulario local de `SignInSurface` queda plegado bajo «Acceso del Owner».
- [ ] Tests en la frontera del servidor: un Member con contraseña rechazado tras verificar y el Owner dentro; apagar cierra el socket de una sesión local y no el de una de Keycloak; reset link que re-vincula una identidad nueva y deja la antigua sin efecto.
