# 10: Móvil: Members e Invitations del Space

**What to build:** En la pantalla Space del móvil, **Members** (lista con Role; un Admin cambia Roles de Members y Guests y los expulsa, con las mismas reglas que la web) e **Invitations** (crear con Role, copiar o compartir el enlace, revocar). Usa las funciones que ya existen en `packages/client-runtime/src/spaces/spaceDirectory.ts`. Archivar, restaurar y borrar la Organization siguen en la web: una fila los abre en el navegador del sistema.

**Blocked by:** 09

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Un Member ve la lista y puede salir de la Organization; un Admin invita, cambia Roles y expulsa sin tocar Admins; el Owner, además, Admins.
- [ ] El enlace de Invitation se comparte con la hoja nativa de compartir y caduca y se revoca como en la web.
- [ ] Sin lógica de permisos nueva en el móvil: la visibilidad viene de `packages/client-runtime`.
- [ ] Pasada con `test-t3-mobile`: invitar desde el móvil y aceptar en la web.
