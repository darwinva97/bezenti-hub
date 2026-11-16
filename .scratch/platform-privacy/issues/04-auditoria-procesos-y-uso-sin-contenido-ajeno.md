# 04: Auditoría, procesos y consumo sin contenido ajeno

**What to build:** Las tres vistas de operador que hoy filtran contenido ajeno pasan a enseñar solo quién, qué, dónde y cuánto. En la auditoría, las entradas de Spaces ajenos pierden el nombre del Thread, Project, Vault o Secret y las claves de detalle con contenido. En la vista de procesos, un proceso de un Space ajeno se enseña con su tipo, Space, CPU, memoria y antigüedad, sin orden, carpeta ni puertos. En el consumo de IA, lo ajeno se agrupa por Space, User, AI account y modelo, sin bajar a un Thread.

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md («Auditoría, procesos y consumo sin contenido ajeno»)

- [ ] `AUDIT_CONTENT_DETAIL_KEYS` vive en `packages/contracts/src/audit.ts`, junto a `AUDIT_DETAIL_KEYS`, y marca por acción las claves con contenido (por ejemplo `vault`, `subjectName`, `failureMessage`, `from`/`to` de un Vault). `AuditLog.list` (`apps/server/src/audit/AuditLog.ts`) redacta al leer: `target.name` a `null` para `project`, `thread`, `vault` y `secret` cuando el Owner no es Member del Space de la entrada. Test en rojo en `AuditLog.test.ts`. Si el Owner entra luego como Member, ve los nombres.
- [ ] `ProcessDiagnostics.read`, `ProcessResourceMonitor.readHistory` y `subscribeDiscoveredLocalServers` quitan orden, argumentos, carpeta y puertos de los procesos atribuidos (`ResourceAttribution.ts`) a un Space del que el Owner no es Member. Lo no atribuido se enseña como hoy. `serverSignalProcess` sigue funcionando. Hay test de frontera con un proceso atribuido a una Organization ajena.
- [ ] El resumen de uso niega al Owner el filtro `threadId` en un Space ajeno y nunca le devuelve filas por Thread de ese Space. Esta fila va en la suite existente del uso.
- [ ] Web (`AuditLogDialog.tsx`, `AuditLogSettingsSection.tsx`, la vista de procesos) y móvil enseñan «a thread», «a project»… cuando el nombre llega a `null`, sin huecos.
- [ ] `docs/user/install.md` («Audit log») dice qué se ve de los Spaces ajenos; `docs/internals/resource-telemetry.md` añade una línea sobre la redacción.
