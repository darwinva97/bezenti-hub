# 08: Estado de la clave para quien la tiene

**What to build:** Quien tiene una access key, sin cuenta en el Hub, consulta con la propia clave qué permite, hasta cuándo y cuánto le queda: `GET /api/ai/access-key` responde etiqueta, caducidad, modelos permitidos y, por tope, usado, lo que queda y el reinicio. «Copy setup» incluye la línea para consultarlo. Ver spec, historia 16 y pregunta abierta 5.

**Blocked by:** 05.

**Status:** needs-triage

**Tipo:** HITL: necesita la decisión de la pregunta abierta 5 (si se hace y qué devuelve).

Spec: ../spec.md

- [ ] Raw route `GET /api/ai/access-key` (fuera de las rutas de CLIProxyAPI, nunca reenviada): solo una access key en cabecera, como el resto de `/api/ai/*`; otra gateway key → 404; cookie → ignorada (`AMBIENT_COOKIE_RULES`: refused). En `DoorRules.RAW_ROUTE_RULES`.
- [ ] Respuesta JSON: `label`, `expiresAt`, `models`, `limits` con `used`, `remaining`, `resetsAt` por tope; una caducada responde 200 con `expired: true` (para que se pueda leer la fecha). Nunca el Space, quién la emitió, las cuentas ni el uso de otros.
- [ ] Setup: un `curl` de ejemplo en «Other clients» (con el marcador cuando no hay clave).
- [ ] Red-first: una clave de Thread o de User recibe 404; una revocada 401; la respuesta no tiene ids ni nombres de Space o cuentas; los números coinciden con los de la lista del emisor.
- [ ] Docs: «Access keys» → estado.
