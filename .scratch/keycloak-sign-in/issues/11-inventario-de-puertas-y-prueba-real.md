# 11: Inventario de puertas y prueba real

**What to build:** Una revisión de inventario, como la del ticket 17 de `../sandboxes-and-external-environments/` y el 13 de `../ai-accounts-and-gateway/`, de todas las puertas que crean, vinculan o mantienen una identidad: inicio de sesión, callback, back-channel logout, ajustes de Plataforma, Platform invitations, reset links, step-up y toda credencial que nazca de una sesión de Keycloak. Cierra los huecos con la misma regla en cada puerta y termina con una prueba real contra un Keycloak de verdad. Ver spec, «Puertas y contratos».

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09

**Status:** done

Spec: ../spec.md

- [x] `DoorRules.ts` (`HTTP_ENDPOINT_RULES`, `RAW_ROUTE_RULES`, `AMBIENT_COOKIE_RULES`) declara todas las puertas de este spec; el test de inventario falla si falta una.
- [x] Ninguna puerta devuelve el client secret, un refresh token, un ID token, un logout token ni un código de autorización: test que llama a cada endpoint y busca esos valores en la respuesta.
- [x] Test de humo de fugas: esos valores no aparecen en logs, spans OTLP, argumentos de proceso ni archivos del Hub fuera del almacén cifrado y de `identity_logins` sellado.
- [x] Toda credencial que nace de una sesión de Keycloak (sesión de navegador, app, cliente MCP, enlace de pairing, prueba de step-up, aprobación de alta de máquina) termina con su login o está listada con el motivo por el que no.
- [x] Ataques del flujo, cada uno con su test: login CSRF (callback sin la cookie del flujo), `returnTo` absoluto o `//host`, `state` reutilizado, ID token de otro cliente (`aud`) o de otro issuer, `alg: none` o HMAC, `kid` desconocido, back-channel sin firma o con `nonce`.
- [x] Red-first para cada hueco encontrado.
- [x] Prueba real con un Keycloak en contenedor (realm con registro, un broker de Google o GitHub, grupos `bezenti` y `bezenti-admin`, OTP para Admins, back-channel logout configurado) y el Hub con `vp run dev`: registro en modo abierto, rechazo en cerrado, Platform invitation, vincular un User local, Admin con y sin OTP, desktop y móvil, deshabilitar en Keycloak y ver la sesión caer, logout desde la consola y ver el socket cerrarse, Keycloak parado y el Owner entrando con su passkey.

**Hecho:** `DoorRules.ts` gana `IDENTITY_DOORS` (cada puerta que crea, vincula o mantiene una identidad, con su regla; el test falla si falta una de los grupos de identidad o una de las puertas del spec, si alguna RPC WS o herramienta MCP toca el inicio de sesión, o si la cookie del flujo se lee fuera del callback) y `KEYCLOAK_SESSION_CREDENTIALS` (cada credencial que nace de una sesión: termina con su login o el motivo por el que no; el test descubre las columnas de credenciales de las migraciones y los módulos que firman o guardan credenciales). `KeycloakDoors.test.ts` llama a cada puerta y no encuentra secreto, código, verificador ni token en ninguna respuesta, log, span, proceso, fila en claro ni archivo fuera del almacén cifrado. Ataques: `alg: none`, HS256 con la JWK o el PEM públicos y `kid` desconocido, en callback y back-channel (una avalancha de `kid` desconocidos pide el key set una vez como mucho). Red-first: «Salir también de Keycloak» devolvía el ID token como `id_token_hint` (ya no, y el Hub no guarda ID tokens; migración 158); desactivar o quitar un User dejaba vivos sus logins de Keycloak con el refresh token sellado; el barrido de cookies era una lista a mano. Prueba real: `11-real-test.md` (21/21; desviaciones y hallazgos allí). Pendiente: las CLI keys del gateway sobreviven al login (atarlas es un follow-up); el «Sign out» de usuario en la consola de Keycloak no corta la sesión offline del Hub (historia 35).
