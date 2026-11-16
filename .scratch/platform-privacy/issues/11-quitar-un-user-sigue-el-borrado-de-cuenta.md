# 11: Quitar a un User sigue el borrado de cuenta

**What to build:** Quitar a un User ya no le entrega su Personal space al Owner. Pasa por el mismo `AccountClosure` que el borrado propio: sin acceso al momento y Personal space congelado que se borra a los 30 días, sin que el Owner lo vea. El Owner puede adelantar ese borrado («Delete now», escribiendo el nombre), y el User quitado no puede cancelarlo. Las Organizations de las que era Steward pasan al Admin más antiguo; si no queda ninguno, se archivan. Los Personal spaces que ya estaban congelados al desplegar reciben 30 días desde el despliegue.

**Blocked by:** 10

**Status:** ready-for-agent

Spec: ../spec.md («Quitar (Owner)», «Personal spaces ya congelados al desplegar»)

- [ ] `InstallationUserService.setStatus(removed)` (`apps/server/src/spaces/InstallationUserService.ts`) llama a `AccountClosure` con la entrada `removed`. Deshabilitar y rehabilitar no cambian.
- [ ] Primero tests en rojo (`InstallationUsers.test.ts`): tras quitar, el Steward pasa al Admin más antiguo (o la Organization se archiva si no hay Admin); el Owner no lee el Personal space congelado; «Delete now» purga al momento; con `TestClock`, el día 30 purga solo.
- [ ] Una migración da `deletion_due_at = ahora + 30 días` a todo Personal space congelado sin fecha.
- [ ] Hay `AuditAction` `account.delete.expedite`, y `user.remove` sigue igual.
- [ ] Web (`apps/web/src/components/sidebar/UsersDialog.tsx`, o su sitio en el modal de Plataforma) y móvil: el diálogo de quitar explica el plazo y ofrece «Delete now». La lista de Spaces (02) enseña la fecha de borrado.
- [ ] `docs/user/install.md` («Disabling and removing people»): se quita «freezes their Personal space … the Owner can only read it, move its projects» y se cuenta la regla nueva. El cambio va en las notas de la versión.
