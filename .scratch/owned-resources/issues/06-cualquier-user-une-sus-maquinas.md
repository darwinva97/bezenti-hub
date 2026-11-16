# 06: Cualquier User une sus máquinas

**What to build:** Todo User activo aprueba el alta de su propia máquina en modo personal, sin el Installation permission `environments.registerOwn`, que desaparece. La máquina sigue como hoy: solo la usa su dueño, para sus Threads, en cualquiera de sus Spaces (pregunta abierta 1). Ver spec, «Environments».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en `AccessPolicy.test.ts` y `EnvironmentJoin.test.ts`: un Member sin permisos aprueba su máquina con factor fuerte; un User desactivado no.
- [ ] `environment.register` en `AccessPolicy` permite a todo User activo; `environments.registerOwn` sale de `InstallationPermission` (`packages/contracts/src/spaces.ts`), de `UsersDialog.tsx` y de las etiquetas de `packages/client-runtime/src/spaces/spaceDirectory.ts`; una migración borra sus filas.
- [ ] «Register this machine» (`RegisterEnvironmentSurface.tsx`) deja de mostrar el mensaje de permiso que falta.
- [ ] Web, desktop y móvil: «Add machine» (`AddEnvironmentDialog.tsx`, `apps/mobile/src/features/environments/`) visible para todo User.
- [ ] Docs: `docs/user/install.md` («Join a machine to your Hub», «Personal spaces and Installation permissions») y `docs/internals/environment-auth.md` sin el permiso.
