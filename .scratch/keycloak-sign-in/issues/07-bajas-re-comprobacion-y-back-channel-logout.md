# 07: Bajas: re-comprobación y back-channel logout

**What to build:** Una cuenta deshabilitada en Keycloak deja de entrar al Hub en menos de una hora, y un logout desde Keycloak (consola de administración o el propio User) cierra al momento las sesiones del Hub que nacieron de ese inicio de sesión, con sus sockets y con las apps, clientes MCP y enlaces de pairing aprobados desde él. Salir del Hub ofrece «Salir también de Keycloak». Una caída de Keycloak no saca a nadie. Ver spec, «Bajas».

**Blocked by:** 05

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `KeycloakLogins`: al usar una sesión con `identity_login_id` (verificación HTTP y renovación del socket en `SessionStore`) y con `checked_at` de más de una hora, refresh en segundo plano, uno a la vez por login, guardando el refresh token nuevo antes de soltar el turno.
- [ ] `invalid_grant` termina el login (`ended_at`) y revoca sus sesiones; error de red o 5xx no revoca y deja «Keycloak no responde desde …» en la sección del Owner; éxito aplica `planGroupSync` con el ID token nuevo.
- [ ] `POST /oauth/keycloak/backchannel-logout`: verifica el `logout_token` (firma, `iss`, `aud`, `events`, sin `nonce`, `iat` reciente, `jti` no visto en una caché acotada); termina los logins por `sid` o, sin `sid`, los de esa identidad por `sub`; 200 o 400. En `RAW_ROUTE_RULES`.
- [ ] Herencia: `AppSignIn.approve`, la aprobación de `McpOAuth` y la creación de un enlace de pairing desde una sesión con `identity_login_id` lo pasan a la sesión o enlace que emiten (`auth_pairing_links.identity_login_id`).
- [ ] Salir: la página tras `POST /api/auth/sign-out` de una sesión de Keycloak ofrece «Salir también de Keycloak» (`end_session_endpoint` con `id_token_hint`, vuelta a `/sign-in`) y avisa de que cierra también las apps aprobadas desde ese navegador.
- [ ] La sección del Owner avisa si el último login no obtuvo `offline_access`.
- [ ] Tests en la frontera del servidor con el Keycloak falso y `TestClock`: a la hora y un uso, `invalid_grant` revoca y cierra el socket (esperando el evento de revocación, no tiempo); error de red no revoca; back-channel por `sid` cierra solo ese login; por `sub`, todos; `jti` repetido y token sin `events` dan 400; una sesión de app y una de cliente MCP caen con su login.
