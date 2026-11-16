# 02: Entrar con Keycloak y vincular una cuenta existente

**What to build:** Un User local entra como hoy, va a su cuenta, pulsa «Conectar con Keycloak», confirma con su credencial actual, elige su cuenta en Keycloak y vuelve al Hub ya vinculado: sus passkeys, contraseña y TOTP se borran (el Owner conserva los suyos), sus demás sesiones se cierran y la nueva sesión nace del login de Keycloak. Desde entonces entra con «Entrar con Keycloak» en la página de inicio de sesión. Una identidad que el Hub no conoce todavía se rechaza con «Este Hub no te conoce» (la admisión llega en el ticket 03). Es el flujo OIDC completo: authorization code con PKCE, `state` atado al navegador, `nonce`, ID token verificado. Ver spec, «Módulos», «Intenciones del flujo» y «Vincular, reset y el inicio de sesión local».

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `user_identities`, `identity_logins` (refresh token sellado con `SecretCipher` y el `login_id` como dato autenticado), `auth_sessions.identity_login_id`.
- [ ] `KeycloakClient`: URL de autorización (ámbitos `openid profile email offline_access`, PKCE S256, `prompt=login` cuando se pida), intercambio de código con `client_secret_basic`, verificación del ID token (`Jwt.verifyWithKeySet`; `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`; RS256, PS256, ES256, EdDSA).
- [ ] `KeycloakSignIn.start` (`POST /api/auth/keycloak/start`) para `sign-in` y `link`: flujo en memoria con `makeGrantStore` (10 min), cookie `__Host-` aleatoria que lo ata al navegador, `returnTo` solo ruta relativa del mismo origen.
- [ ] `GET /oauth/keycloak/callback`: comprueba cookie, `state`, `iss` (RFC 9207) y PKCE; sus fallos cuentan para `signInThrottle`. Para un User activo con esa identidad emite la sesión de navegador (sliding, 30 días) con `identity_login_id`; desactivado o quitado, el mismo rechazo de hoy.
- [ ] `link`: exige sesión de navegador y la prueba de `requireStepUp` en el `start`; rechaza una identidad de otro User; en una transacción vincula, borra credenciales locales y enlaces de pairing sin gastar (no al Owner), revoca todas sus sesiones y emite la nueva. Auditoría `user.identity.link`.
- [ ] Un User con identidad que no es el Owner no puede registrar contraseña, TOTP ni passkey (`AccountChangeRefusedError`).
- [ ] `requireStepUp` deja de aceptar «sin credenciales locales» como prueba para un User con identidad (hasta el ticket 06, esas acciones se rechazan para él).
- [ ] `/api/auth/session` dice si la página debe ofrecer Keycloak; `AuthAccount` lleva la identidad vinculada (usuario, correo, URL `<issuer>/account`).
- [ ] Web: botón en `SignInSurface`; en la cuenta, «Conectar con Keycloak» o «Entras con Keycloak como …» con enlace a la cuenta de Keycloak, sin los controles de credenciales locales (salvo el Owner).
- [ ] Tests en la frontera del servidor con el Keycloak falso: vincular y volver a entrar; `state`, cookie, `nonce`, verificador o `iss` incorrectos; identidad ajena; sin step-up; el Owner conserva passkey y códigos; las sesiones anteriores quedan revocadas y su socket se cierra.
