# 05: Inventario de puertas y pase completo: el Owner ciego al contenido ajeno

**What to build:** Un barrido de todas las puertas por las que una sesión, un token o un agente del Owner podría llegar al contenido de un Space del que no es Member. Cada puerta queda clasificada (contenido → negado; metadato o consumo → permitido; operador → permitido sin contenido), y un test hace fallar la próxima puerta que se añada sin clasificar. Las fugas que aparezcan se arreglan aquí, cada una con su test en rojo primero.

**Blocked by:** 01, 02, 03, 04

**Status:** ready-for-agent

Spec: ../spec.md («Operar frente a ver», «Testing Decisions»: tabla de puertas)

- [ ] **Tabla de puertas**: `apps/server/src/auth/RpcAuthorization.test.ts` exige una clasificación «Owner en Space ajeno» para cada RPC de `RPC_SPACE_ACCESS` e `INSTALLATION_RPC_METHODS` (`RpcSpaceAccess.ts`, `packages/contracts/src/installationAccess.ts`), cada ruta HTTP y cada herramienta MCP. Lo que falte hace fallar el test.
- [ ] **WS**: `subscribeShell`, búsqueda de Threads, Settled, terminales, previews, dispositivos (`deviceList` y siguientes), adjuntos, diffs de checkpoint, archivos de Project (`projectsReadFile`), Pull Requests (`RequestVisibility`, que por defecto ve todo) y tareas programadas (`requireTaskRights`).
- [ ] **Informes de operador**: `serverGetStorageCleanupReport` y `serverGetDatabaseStorage` agrupan por Space sin títulos ni rutas de Spaces ajenos.
- [ ] **HTTP**: rutas de adjuntos y assets, proxy de previews y sus cookies de origen (`PreviewOriginCookies`), `apps/server/src/guest/http.ts`, `apps/server/src/audit/http.ts`, `apps/server/src/spaces/http.ts` e `installationUsersHttp.ts`.
- [ ] **MCP** (`apps/server/src/mcp/`): todas las herramientas de `toolkits/` pasan por `mcpVisibility.visibilityOf`. Ninguna trata «sin User» como «todo» si ya existe un Owner. Al menos `t3_thread_*`, `t3_project_*`, `preview_*`, `device_*`, `list_secret_names`, `delegate_task`, `schedule_task` y `t3_environment_read`.
- [ ] **Hilo del executor** (`packages/contracts/src/environmentExecutor.ts`): el Owner no abre terminal, preview ni archivos en el Sandbox de un Space ajeno ni en una máquina prestada a otro. `sandbox.manage` arranca, para y cambia límites, sin shell.
- [ ] **Enlaces de invitado**: el Owner no crea uno en una Organization ajena, y los enlaces existentes no cambian de dueño.
- [ ] **Logs y trazas** (`serverLogger.ts`, `apps/server/src/observability/`, `serverGetTraceDiagnostics`): no llevan texto de mensajes ni valores de Secrets o Variables. La AI gateway no guarda cuerpos de petición ni respuesta; solo cuentas.
- [ ] **Triage** (`serverPrepareTriage`): con Spaces ajenos, el triage sobre la máquina del Hub recibe solo logs y trazas, sin base de datos ni `userdata` (pregunta abierta 8 del spec).
- [ ] **Notificaciones** (push móvil, web): solo las recibe quien puede ver el Thread.
- [ ] **Keycloak**: el mapeo de grupo a membership de `../keycloak-sign-in/` no puede meter al Owner en una Organization de la que no es Steward (pregunta abierta 7 del spec). Se comprueba con un test en ese spec o aquí.
- [ ] Ninguna acción de operador crea una membership del Owner. Se comprueba repasando `SpaceDirectory`, `MembershipService` e `InvitationService`.
- [ ] Bajo `## Comments` queda la tabla final (puerta → clasificación → test que la cubre) y la lista de lo que queda fuera de la garantía: shell del Hub, base de datos, clave maestra, copias y administración de Keycloak.
