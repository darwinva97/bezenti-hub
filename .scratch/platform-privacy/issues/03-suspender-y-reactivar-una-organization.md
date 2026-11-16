# 03: Suspender, reactivar y borrar una Organization sin verla

**What to build:** Desde la lista de Spaces de Plataforma, el Owner suspende una Organization con un motivo corto. Al momento se paran sus turnos y su Sandbox. Mientras está suspendida no se crea ni se ejecuta nada en ella y la AI gateway rechaza sus claves, pero sus Members la siguen leyendo, ven un banner con el motivo y pueden descargar sus datos. El Owner la reactiva cuando quiera. Solo una Organization suspendida se puede borrar para siempre, escribiendo su nombre. Nada de esto le enseña su contenido.

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md («Abusos»)

- [ ] Primero las filas en rojo de `AccessPolicy.test.ts`: en una Organization suspendida, crear y ejecutar → `space-suspended`; `space.view` → Allow para sus Members; `organization.suspend`/`unsuspend` → solo el Owner, sea o no Member; `organization.delete` sobre una Organization ajena → solo si está suspendida.
- [ ] Hay columnas `spaces.suspended_at` y `spaces.suspended_reason` (migración). `SpaceResource` gana `suspended`. Archivar y restaurar se niegan mientras dure la suspensión.
- [ ] Suspender para los turnos en marcha y el Sandbox del Space por los caminos existentes (los de archivar en `OrganizationLifecycle.ts`), y la AI gateway rechaza las claves de ese Space. Test de frontera: tras suspender, un `thread.turn.start` de un Member se niega y no queda ningún turno en marcha (se drena el effect worker).
- [ ] Reactivar devuelve al Space su estado normal; el Sandbox arranca cuando lo pida el trabajo, como hoy.
- [ ] El borrado usa el borrado existente de una Organization. Test: borrar una no suspendida se niega.
- [ ] Hay `AuditAction` `organization.suspend` (`reason`) y `organization.unsuspend`.
- [ ] Web y móvil: acciones en la lista de Plataforma (borrar pide escribir el nombre) y banner «Suspended by the platform operator: <motivo>» en la Organization para sus Members. Esos Members siguen viendo su contenido; la descarga llega con el 09.
- [ ] `docs/user/install.md`: un párrafo sobre suspender en la sección de Users deshabilitados y quitados.

Deshabilitar un User sigue como está (`InstallationUserService.setStatus`): es la suspensión de una persona y de su Personal space.
