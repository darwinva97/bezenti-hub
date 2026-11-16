# 11: Inventario de puertas y prueba real

**What to build:** Una revisión de inventario, como la del ticket 17 de `../sandboxes-and-external-environments/` y el 13 de `../ai-accounts-and-gateway/`, de todas las puertas que crean, vinculan o mantienen una identidad: inicio de sesión, callback, back-channel logout, ajustes de Plataforma, Platform invitations, reset links, step-up y toda credencial que nazca de una sesión de Keycloak. Cierra los huecos con la misma regla en cada puerta y termina con una prueba real contra un Keycloak de verdad. Ver spec, «Puertas y contratos».

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `DoorRules.ts` (`HTTP_ENDPOINT_RULES`, `RAW_ROUTE_RULES`, `AMBIENT_COOKIE_RULES`) declara todas las puertas de este spec; el test de inventario falla si falta una.
- [ ] Ninguna puerta devuelve el client secret, un refresh token, un ID token, un logout token ni un código de autorización: test que llama a cada endpoint y busca esos valores en la respuesta.
- [ ] Test de humo de fugas: esos valores no aparecen en logs, spans OTLP, argumentos de proceso ni archivos del Hub fuera del almacén cifrado y de `identity_logins` sellado.
- [ ] Toda credencial que nace de una sesión de Keycloak (sesión de navegador, app, cliente MCP, enlace de pairing, prueba de step-up, aprobación de alta de máquina) termina con su login o está listada con el motivo por el que no.
- [ ] Ataques del flujo, cada uno con su test: login CSRF (callback sin la cookie del flujo), `returnTo` absoluto o `//host`, `state` reutilizado, ID token de otro cliente (`aud`) o de otro issuer, `alg: none` o HMAC, `kid` desconocido, back-channel sin firma o con `nonce`.
- [ ] Red-first para cada hueco encontrado.
- [ ] Prueba real con un Keycloak en contenedor (realm con registro, un broker de Google o GitHub, grupos `bezenti` y `bezenti-admin`, OTP para Admins, back-channel logout configurado) y el Hub con `vp run dev`: registro en modo abierto, rechazo en cerrado, Platform invitation, vincular un User local, Admin con y sin OTP, desktop y móvil, deshabilitar en Keycloak y ver la sesión caer, logout desde la consola y ver el socket cerrarse, Keycloak parado y el Owner entrando con su passkey.
