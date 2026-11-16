# 10: Borrar mi cuenta, con 30 días para arrepentirse

**What to build:** Un User borra su cuenta desde su modal de Usuario. Primero se le ofrece descargar sus datos. Luego, por cada Organization de la que es Steward, elige un Admin al que traspasarla o la archiva. Ve un resumen de lo que pierde y de lo que no vuelve si cancela, y confirma escribiendo su login. Si su último inicio de sesión tiene más de 10 minutos, tiene que volver a entrar antes. En ese momento pierde el acceso, se retiran sus Grants, terminan sus memberships y su Personal space queda congelado. Durante 30 días, al entrar solo ve la fecha del borrado, «Descargar mis datos» y «Cancelar el borrado». El día 30 se borra su Personal space y todo lo suyo, y la fila del User queda como «Deleted user».

**Blocked by:** 09, `../grants/` (retirar un Grant), `../plans-and-limits/` (traspasar el Steward)

**Status:** ready-for-agent

Spec: ../spec.md («Borrar mi cuenta y quitar un User»)

- [ ] Servicio `AccountClosure` con la entrada `self` y la columna `users.deletion_due_at` (migración). Se apoya en lo que ya hacen deshabilitar y quitar (`InstallationUserService`, `SpaceDirectory.endAccessOf`) y en la retirada de Grants de `../grants/`.
- [ ] Al pedirlo: sesiones, tokens, enlaces y claves de la gateway terminados; turnos parados; tareas programadas borradas; Grants dados y recibidos retirados; memberships terminadas; Personal space congelado; máquinas y AI accounts propias sin uso. Hay que elegir antes qué pasa con cada Organization de la que es Steward; si no, se niega.
- [ ] Cancelar devuelve la cuenta, el Personal space, las máquinas y las AI accounts. Grants, memberships y traspasos no vuelven.
- [ ] `AccountPurge` usa el `Scheduler` (`apps/server/src/scheduling/`) con la fecha guardada y al arrancar purga lo vencido. Borra el Personal space (Projects, Threads, adjuntos, checkpoints del Hub, Sandbox y su volumen), el vault personal, las AI accounts con sus credenciales, las máquinas, credenciales y sesiones, y el vínculo con Keycloak. Deja la fila como lápida, sin login ni correo.
- [ ] Primero tests en rojo con `TestClock`: pedir → no hay acceso; entrar muestra solo el estado pendiente (la puerta deja pasar descargar y cancelar); cancelar el día 29 → cuenta activa; día 30 → no queda nada del Personal space y los Threads que hizo en una Organization siguen allí a nombre de «Deleted user».
- [ ] Hay `AuditAction` `account.delete.request`, `account.delete.cancel` y `account.delete.complete`.
- [ ] Web: flujo en el modal de Usuario y pantalla de borrado pendiente, con un enlace a la consola de cuenta de Keycloak para borrar allí la identidad. Paleta: «Delete my account». Móvil: el mismo flujo y la misma pantalla. El Owner no ve la opción.
- [ ] Sin herramienta MCP: es destructivo y solo lo hace la persona.
- [ ] `docs/user/install.md` («Your account»): qué pasa, los 30 días y qué no vuelve al cancelar.
