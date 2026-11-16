# 07: Aceptar los términos al registrarse y cuando cambian

**What to build:** Si hay una versión publicada que el User no ha aceptado, el Hub no le deja hacer nada más que leer los términos, aceptarlos, cerrar sesión, descargar sus datos o borrar su cuenta. Vale para la web, escritorio, móvil, agentes externos (MCP) y tokens de `t3`. Quien acaba de registrarse y rechaza los términos no deja ninguna cuenta a medias. A un User existente, rechazarlos solo le cierra la sesión.

**Blocked by:** 06, `../keycloak-sign-in/` (primer inicio de sesión que crea el User)

**Status:** ready-for-agent

Spec: ../spec.md («Puerta de aceptación», «Primer inicio de sesión»)

- [ ] Hay tabla `legal_acceptances` (userId, versión, fecha) y una RPC para aceptar la versión vigente.
- [ ] Un solo punto de control, donde se resuelve el principal (`apps/server/src/auth/CurrentPrincipal.ts`), devuelve `LegalAcceptanceRequiredError` (contracts) a todo lo que no esté en la lista permitida. El Owner no pasa por él.
- [ ] Primero tests de frontera en rojo: un User con la versión anterior recibe el error por WS, por HTTP y en una herramienta MCP, pero puede aceptar y luego sigue. Corregir sin subir la versión (06) no dispara la puerta.
- [ ] «Decline» en un User que nunca aceptó nada lo borra al momento y cierra la sesión; en uno que ya había aceptado antes, solo cierra la sesión.
- [ ] Los turnos en marcha y las tareas programadas siguen (pregunta abierta 4 del spec).
- [ ] Web: página de aceptación con los dos documentos, el resumen de quién ve qué (texto del 08 cuando exista) y «Accept», «Decline», «Download my data» y «Delete my account». Escritorio la hereda. Móvil: pantalla nativa que bloquea al recibir el error y llama a la RPC de aceptar. Cliente compartido: el error se trata una vez en `packages/client-runtime`.
- [ ] `docs/user/install.md`: una frase en la sección de términos.
