# 01: El Owner no ve el contenido de los Spaces ajenos

**What to build:** Ser Owner deja de significar «verlo todo». En los Spaces de los que el Owner no es Member (Personal spaces de otros y Organizations ajenas) el Owner no ve Threads, Projects, terminales, previews ni nada de su contenido, ni desde la web ni desde su agente. Sigue operando la Installation: sus RPC de operador funcionan igual. Una migración le hace Admin de toda Organization que ya existe, así que en Bezenti y en las demás actuales no cambia nada.

**Blocked by:** None (can start immediately). Hay que coordinar el orden con los tickets de `../owned-resources/` que tocan `AccessPolicy.ts`.

**Status:** ready-for-agent

Spec: ../spec.md («Operar frente a ver»)

- [ ] Primero se cambian a rojo las filas del Owner en `apps/server/src/auth/AccessPolicy.test.ts`: contenido en una Organization sin membership y en un Personal space ajeno → Deny (`not-a-member`, `not-your-personal-space`); Owner Admin → igual que cualquier Admin. Las acciones de operador (`user.*`, `sandbox.manage`, `sandbox.inspect`, `aiUsage.viewSpace`, `masterKey.backup`) siguen en Allow.
- [ ] `AccessPolicy.ts` deja de dar Allow al Owner en las acciones de contenido (`space.view`, `thread.*`, `project.*`, `guestLink.create`, `environment.use` en un Space, `vault.*` del Vault de un Space y `vault.choose`). Desaparece `personal-space-read-only`. En un Personal space congelado, el Owner conserva solo parar y borrar; se quita mover fuera (`mayMoveOut`).
- [ ] `SpaceDirectory.viewableSpaces` (`apps/server/src/spaces/SpaceDirectory.ts`) devuelve al Owner sus Spaces y no `"all"`. `SpaceVisibility.writableSpaces` pierde su caso del Owner.
- [ ] `RpcSpaceAccess.ts` decide las RPC `installation` y `ownerOnlyCall` con `isOwner` de la sesión, no con `visibility.all`. Test de frontera: `serverGetProcessDiagnostics` sigue funcionando para el Owner y se le niega a un Admin con todos los scopes.
- [ ] Con un Owner ya existente, «sin User» deja de ser «todo»: `SpaceVisibility.of(undefined)`, `mcpVisibility.visibilityOf` y los Threads anteriores a los Users resuelven la visibilidad del Owner. `everything` queda solo para la instalación sin Owner, el shell del Hub y el trabajo interno.
- [ ] Una migración añade al Owner como `admin` a toda Organization en la que no tenga membership. Hay test de migración sobre una base con dos Organizations.
- [ ] Test de frontera: el snapshot y los deltas de `orchestration.subscribeShell` de una sesión del Owner no traen Threads ni Projects de un Personal space ajeno ni de una Organization ajena; `t3_thread_list` y `t3_thread_read` por MCP con el token del Owner, tampoco.
- [ ] El selector deja de tener «Personal spaces (read only)» (`apps/web/src/components/sidebar/SpaceSelector.tsx`, `packages/client-runtime/src/spaces/spaceDirectory.ts`, `apps/mobile/src/state/spaces.ts`). Se quita el texto «The Owner can see everything in your Personal space.» y la frase equivalente de `apps/web/src/components/auth/InvitationSurface.tsx`; los avisos nuevos llegan en el 08.
- [ ] Docs: en `docs/user/install.md` se reescriben «The Owner sees everything» y los párrafos de «Personal spaces (read only)»; un párrafo en `docs/internals/environment-auth.md` explica que ser Owner no es verlo todo.

Fuera de alcance: lo que el Owner sí ve de los Spaces ajenos (02), la auditoría y los procesos (04) y el barrido del resto de puertas (05).
