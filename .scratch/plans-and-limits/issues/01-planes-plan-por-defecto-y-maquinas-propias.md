# 01: Plans, plan por defecto y máquinas propias

**What to build:** El Owner crea, edita y borra Plans, elige el plan por defecto y asigna un Plan a cada User desde el modal Plataforma. Todo User nuevo recibe el plan por defecto; el Owner no tiene Plan ni límites. El primer límite que se hace cumplir es «máquinas propias». Para entonces `environments.registerOwn` ya no existe (lo quita `../../owned-resources/issues/06`, y `personalSpace.create` lo quita `../../identity-and-access/issues/17`), así que aquí desaparece la tabla `installation_permissions`, ya vacía, y el código que quede de ella. El User ve su Plan y su uso de máquinas en el modal Usuario. Ver spec, «Modelo», «Límites» y «Consumo visible».

**Blocked by:** `../../identity-and-access/issues/17-personal-space-siempre-disponible.md`, `../../owned-resources/issues/06`; los modales Plataforma y Usuario de `../../settings-modals/`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: tabla `plans` (límites NULL = sin límite, 0 = ninguno; `is_default` único), `users.plan_id`; Plan «Default» sin límite de máquinas propias (tras `owned-resources/06` cualquiera puede unir las suyas); borra `installation_permissions`. Test de la migración con filas reales: nadie gana ni pierde capacidad.
- [ ] Servicio `Plans` (`apps/server/src/plans/Plans.ts`): CRUD, `setDefault`, `assignPlan({ userId, planId, source })` (`source`: `owner` | `billing`, para `../../billing/`), `limitsForUser`, `limitsForSpace` (en este ticket, solo Personal spaces; el 02 añade Organizations). Borrar exige Plan de destino; el por defecto no se borra.
- [ ] La inserción de Users no-Owner (`apps/server/src/persistence/Users.ts`) pone el plan por defecto en la misma transacción. Red-first: un User creado por Invitation tiene Plan.
- [ ] `PlanLimitReachedError` en `packages/contracts` (`limit`, `used`, `allowed`, `spaceId?`, `holder`, `planName`, `resetsAt?`) y su mensaje compartido en `packages/client-runtime`.
- [ ] `AccessPolicy`: `environment.register` permitido a todo User activo; `Principal.installationPermissions` desaparece. `EnvironmentRegistry.authorizeRegister` comprueba `max_own_machines` contra las External environments personales del User. Red-first: un User con 0 no aprueba el join y ve el límite; con 1 y una máquina, tampoco; quitar una máquina deja aprobar otra; bajar el límite no quita ninguna.
- [ ] Fuera del código: `InstallationPermission`, `SetInstallationPermissionRequest`, `installationUsers.setPermission`, `SpaceDirectory.setInstallationPermission`, `INSTALLATION_PERMISSION_LABELS`; el comentario de `packages/contracts/src/hubEnvironments.ts` sobre `registerOwn`. `installationUsers.setPlan` los sustituye.
- [ ] Puertas: grupo HttpApi `plans` (`list`, `create`, `update`, `delete`, solo Owner), `installationUsers.setPlan` (solo Owner) y `plans.usage` (propio; con `userId`, solo Owner) en `HTTP_ENDPOINT_RULES`.
- [ ] Auditoría `plan.create`, `plan.update`, `plan.delete`, `plan.default`, `plan.assign`.
- [ ] Web/desktop: modal Plataforma → «Plans» y Plan de cada User (sustituye a los interruptores de `UsersDialog.tsx`); modal Usuario → «Plan» con «Own machines 1 of 2». La pantalla de aprobación de máquina muestra el error de límite.
- [ ] Docs: `docs/user/install.md` («Personal spaces and Installation permissions» pasa a «Plans and limits»), `docs/internals/environment-auth.md` sin Installation permissions; `GLOSSARY.md` sin «Installation permission».
- [ ] Prueba real: el Owner crea «Free» con 0 máquinas, se lo asigna a un User, el `t3 join` de ese User queda sin aprobar con el mensaje del límite; el Owner le sube a 1 y la aprobación funciona.
