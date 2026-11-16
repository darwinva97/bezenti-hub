# 17: Todo User tiene siempre su Personal space

**What to build:** Todo User de la Installation tiene siempre su Personal space, visible y usable desde que crea su cuenta, sin que el Owner tenga que activarlo. Desaparece el Installation permission `personalSpace.create` («Use their Personal space» en **Users and permissions**), que hoy deja el Personal space vacío y oculto hasta que el Owner lo concede (ticket 10, historias 34 y 35 del spec). Siguen igual las demás reglas del Personal space: el Owner lo ve en solo lectura, desde él no se comparte nada, y al quitar un User queda congelado y pasa al Owner.

Motivo: el Owner invitó a una persona como Member de una Organization porque quería que tuviera su propio espacio, y al entrar solo veía la Organization. Un User sin Personal space no tiene dónde trabajar fuera de las Organizations, y al quitarlo de la última se queda sin ningún Space.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md (cambia la decisión de las historias 34 y 35)

- [ ] `AccessPolicy` (`apps/server/src/auth/AccessPolicy.ts`) deja de exigir `personalSpace.create` para ver y crear en el Personal space propio. Las filas de la suite de `AccessPolicy` que cubrían «sin permiso, oculto» pasan a cubrir «siempre permitido al dueño»; las del Owner (solo lectura) y las de «nadie más ve uno ajeno» no cambian.
- [ ] `SpaceDirectory` lista siempre el Personal space de cada User en su selector, también el de quien acaba de aceptar una Invitation y el de quien fue quitado de todas sus Organizations.
- [ ] `personalSpace.create` sale de `InstallationPermission` (`packages/contracts/src/spaces.ts`), del diálogo **Users and permissions** (`apps/web/src/components/sidebar/UsersDialog.tsx`) y de las etiquetas de `packages/client-runtime/src/spaces/spaceDirectory.ts`. Una migración borra las filas guardadas de ese permiso. `environments.registerOwn` lo quita después `../../owned-resources/issues/06`; este ticket va antes.
- [ ] Un User congelado (quitado de la Installation) sigue con el Personal space congelado y en manos del Owner; un User desactivado no lo pierde.
- [ ] Web, desktop y móvil muestran el Personal space en el selector sin ningún caso nuevo.
- [ ] `docs/user/install.md` («Personal spaces and Installation permissions») y `docs/internals/environment-auth.md` se reescriben donde hablan del permiso; no se añade un apartado nuevo.

Fuera de alcance: invitar a alguien sin meterlo en una Organization. Aceptar una Invitation sigue añadiendo al User a la Organization de la Invitation.
