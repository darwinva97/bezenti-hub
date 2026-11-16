# 09: Desktop, móvil y clientes MCP por Keycloak

**What to build:** Desktop y móvil entran al Hub por Keycloak sin flujo nuevo: abren `/app-sign-in` en el navegador del sistema, la página ofrece «Entrar con Keycloak», el flujo vuelve a `/app-sign-in` con sus parámetros y la aprobación sigue como hoy. Lo mismo con `/connect-agent` para los clientes MCP. En móvil, la pantalla de cuenta muestra con qué cuenta de Keycloak se entra o, si no hay, «Conectar con Keycloak», que abre la cuenta del Hub en el navegador del sistema. Ver spec, «Clientes».

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `AppSignInSurface` y `ConnectAgentSurface` ofrecen el botón de Keycloak con `returnTo` igual a su URL actual (ruta y query); al volver, la aprobación funciona sin volver a pedir nada.
- [ ] Móvil: el inicio de sesión por `WebBrowser.openAuthSessionAsync` completa el flujo de Keycloak (incluido un broker de Google o GitHub en la prueba real del ticket 11); la pantalla de cuenta muestra la identidad vinculada (de `AuthAccount`) o «Conectar con Keycloak».
- [ ] Desktop: el inicio de sesión del navegador del sistema con callback en loopback funciona igual; sin código nuevo salvo que la prueba encuentre un fallo.
- [ ] Un test de frontera del servidor: sesión de navegador nacida de Keycloak aprueba un app sign-in y un cliente MCP; la sesión emitida lleva el `identity_login_id` (si el ticket 07 ya está) y los scopes estándar.
- [ ] Pasada integrada única: `test-t3-app` para web y desktop, `test-t3-mobile` para móvil, contra el Keycloak falso o uno real en contenedor.
