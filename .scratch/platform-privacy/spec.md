# Spec: Privacidad de la plataforma

Status: needs-triage
Map: ../public-hub/map.md (fases 5 y 6: `../platform-privacy/`; el último ticket abre el registro)
Decisiones de origen: «Privacidad», «Owner como operador» y, en «Decisiones transversales», «Borrado de cuenta propio» y «Bajas en Keycloak»
ADRs: 0008 (plataforma abierta con un Owner operador que no lee lo ajeno), 0009 (Keycloak), 0010 (Grants), 0011 (las máquinas prestadas corren Sandboxes), 0012 (los Secrets son de solo escritura)
Specs hermanos (no se redefinen aquí): `../keycloak-sign-in/`, `../owned-resources/`, `../grants/`, `../plans-and-limits/`, `../settings-modals/`
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`

## Problem Statement

Hoy el Owner lo ve todo. `AccessPolicy` (`apps/server/src/auth/AccessPolicy.ts`) responde Allow al Owner en casi cualquier acción de contenido. `SpaceDirectory.viewableSpaces` le devuelve `"all"`. El selector de Space le lista los ajenos en «Personal spaces (read only)» (`apps/web/src/components/sidebar/SpaceSelector.tsx`), y a un User quitado se le congela el Personal space y se le entrega al Owner. La auditoría muestra los nombres de Threads, Projects y Vaults de cualquier Space, y la vista de procesos enseña la línea de órdenes de cualquier proceso. Eso valía para «la Installation de un Owner que invita a su equipo» (ADR 0001). Con el registro abierto (ADR 0008) deja de valer: un desconocido que se registra no acepta que el operador lea sus conversaciones, su código o sus valores.

Faltan además las piezas mínimas de una plataforma abierta. No hay términos de uso que aceptar, nadie avisa de quién puede ver qué al aceptar una máquina o compartir un grupo de Vault, un User no puede borrar su cuenta ni descargar sus datos, y el Owner no tiene forma de parar una Organization abusiva sin entrar en ella.

## Solution

Se separa lo que el Owner **opera** de lo que el Owner **ve**. Ser Owner da acciones de operador sobre la Installation: Users, Plans, registro, suspender, consumo, Sandboxes y clave maestra. El contenido lo decide la membership, igual que para cualquier User. En los Spaces de los que el Owner es Member (Bezenti y cualquier Organization que ya existe, a la que una migración le añade como Admin) no cambia nada. En los demás (Personal spaces ajenos y Organizations de otros) el Owner solo ve lo necesario para operar: nombre, tipo, Steward, número de miembros, número de Projects y Threads, consumo de IA, disco y estado del Sandbox. Nunca ve Threads (tampoco sus títulos), archivos de Projects, nombres de Projects, terminales, previews, valores de Vault ni Variables.

Es una garantía de la aplicación, no criptográfica. El Owner opera el servidor, tiene la clave maestra, administra Keycloak y puede leer la base de datos desde el shell. Los términos lo dicen tal cual.

Para tratar abusos sin leer contenido, el Owner deshabilita Users (ya existe), suspende y reactiva una Organization, borra una Organization suspendida y adelanta el borrado de la cuenta de un User quitado. Todo ello lo hace sin ver qué hay dentro.

Cada User puede descargar sus datos y borrar su cuenta. El borrado espera 30 días y se puede cancelar. Al quitar a un User, el Owner pasa por ese mismo camino en lugar de quedarse con su Personal space. El Owner publica unos términos de uso y una política de privacidad en el modal de Plataforma, y cada User los acepta al entrar y otra vez cuando cambian. Los avisos de quién puede ver qué salen de un solo sitio y aparecen donde se toma la decisión. El último ticket es la lista de comprobación para abrir el registro.

## User Stories

### El Owner deja de leer lo ajeno

1. Como User, quiero que el Owner no pueda leer mis Threads, mis Projects ni mis archivos en mi Personal space, para poder usar la plataforma sin conocer al operador.
2. Como Admin de una Organization que creé yo, quiero que el Owner no vea su contenido si no es Member, para que mi equipo trabaje en privado.
3. Como Owner, quiero seguir viendo y haciendo lo mismo de siempre en Bezenti y en las Organizations que ya existían, para que el cambio no me quite nada de mi trabajo.
4. Como Owner, quiero una lista de todos los Spaces con nombre, tipo, Steward, miembros, número de Projects y Threads, consumo de IA, disco y estado, para operar la plataforma sin entrar en ellos.
5. Como Owner, quiero que la auditoría siga nombrando quién hizo qué y en qué Space, sin el nombre de Threads, Projects, Vaults ni Secrets ajenos, para investigar abusos sin leer contenido.
6. Como Owner, quiero que la vista de procesos me dé el consumo de cada Space ajeno sin sus órdenes ni rutas, para encontrar lo que se come la máquina.
7. Como Owner, quiero que mi agente (MCP, tareas programadas, `t3` con mi token) tenga mis mismos límites, para que no sea una puerta trasera.
8. Como Owner, quiero que el Space selector deje de listar Personal spaces ajenos, para no tener una interfaz que promete algo que ya no puedo hacer.

### Abusos

9. Como Owner, quiero suspender una Organization con un motivo, de modo que no corra nada en ella y sus Members la vean en solo lectura con ese motivo, para parar un abuso sin leer qué hay dentro.
10. Como Owner, quiero reactivar una Organization suspendida, para deshacer una suspensión injusta.
11. Como Owner, quiero borrar para siempre una Organization suspendida escribiendo su nombre, para cumplir una orden de retirada sin verla.
12. Como Member de una Organization suspendida, quiero ver que lo está, el motivo y que puedo leer y descargar mis datos, para no pensar que es un fallo.
13. Como Owner, quiero seguir deshabilitando y rehabilitando Users como hasta ahora, para cortar el acceso de una persona al momento.

### Avisos de quién puede ver qué

14. Como persona que se registra, quiero leer en la pantalla de aceptación, en una frase, que el operador ve mi consumo y mis datos de cuenta pero no mi contenido, y que es una garantía de la aplicación y no criptográfica, para decidir con conocimiento.
15. Como User, quiero un recordatorio en mi Personal space de que solo yo veo su contenido, para fiarme de dónde trabajo.
16. Como persona que acepta una Invitation, quiero saber que los Members de esa Organization ven sus Projects y Threads, para saber qué comparto.
17. Como Admin que acepta una máquina prestada (o User que la acepta en su Personal space), quiero un aviso de que su dueño puede ver todo lo que corra en ella, para no mandar código o Secrets a ciegas.
18. Como User que comparte un grupo de Vault con una Organization, quiero un aviso de que los agentes de esa Organization pueden leer sus Secrets, y como Admin que lo acepta, un aviso de que el dueño del grupo puede cambiar los valores, para que ambos sepan qué riesgo asumen.

### Términos

19. Como Owner, quiero escribir en el modal de Plataforma mis términos de uso y mi política de privacidad, como texto o como URL, partiendo de un texto inicial que ya dice lo que el operador puede y no puede ver, para no empezar de cero.
20. Como Owner, quiero elegir si un cambio pide aceptarlos otra vez o es una corrección menor, para no molestar a todos por una errata.
21. Como persona que se registra, quiero aceptar los términos antes de usar nada, y poder rechazarlos sin dejar una cuenta a medias.
22. Como User, quiero que me pidan aceptar de nuevo cuando cambian, y poder descargar mis datos o borrar mi cuenta si no acepto.
23. Como User de móvil o escritorio, quiero que la aceptación funcione en la app sin tener que adivinar por qué fallan las peticiones.

### Mi cuenta

24. Como User, quiero descargar mis datos (perfil, Projects y Threads de mi Personal space, mis Threads en Organizations, Variables, nombres de mis Secrets, Grants y consumo) en un archivo, para llevármelos.
25. Como User, quiero que la descarga nunca contenga el valor de un Secret, para que un archivo perdido no filtre credenciales.
26. Como User, quiero borrar mi cuenta desde mi modal de Usuario, para irme sin pedírselo a nadie.
27. Como Steward, quiero que borrar mi cuenta me pida traspasar o archivar cada Organization que llevo, para no dejar a mi equipo sin responsable.
28. Como User que borró su cuenta, quiero 30 días para cancelar el borrado y descargar mis datos, para no perderlo todo por un error.
29. Como User, quiero saber al confirmar qué no vuelve si cancelo (Grants retirados, memberships, Organizations traspasadas), para que no haya sorpresas.
30. Como Owner, quiero que quitar a un User siga el mismo camino (su Personal space se borra a los 30 días sin pasar por mis manos) y poder adelantar ese borrado, para cumplir una petición de retirada.

### Abrir el registro

31. Como Owner, quiero una lista de comprobación que solo me deje abrir el registro cuando todas las protecciones estén puestas, para no abrirlo con una puerta sin cerrar.

## Implementation Decisions

### Operar frente a ver

- **Regla.** `isOwner` deja de implicar «ve todo». El Owner tiene dos tipos de acción. Las de operador se deciden sobre la Installation o sobre un Space como objeto, sin contenido: deshabilitar y quitar Users, Plans y registro (`../plans-and-limits/`, `../keycloak-sign-in/`), suspender, reactivar y borrar una Organization suspendida, ver el resumen de Spaces y el consumo (`aiUsage.viewSpace`, `sandbox.inspect`), gestionar Sandboxes (`sandbox.manage`), `masterKey.backup` y adelantar el borrado de una cuenta quitada. Las acciones de contenido (`space.view`, `thread.*`, `project.*`, `guestLink.create`, `environment.use` en un Space, `vault.*` sobre el Vault de un Space y `aiAccount.use`) se deciden para el Owner como para cualquier User: por su membership o por ser el dueño del Personal space.
- **`AccessPolicy`.** Se quitan los atajos `if (principal.isOwner) return allow` en contenido, junto con la razón `personal-space-read-only`: un Personal space ajeno da `not-your-personal-space` también al Owner. Sobre un Personal space congelado, el Owner conserva solo «parar» y «borrar», que no leen nada. Se quita «mover fuera». El comentario de cabecera se reescribe.
- **`SpaceDirectory.viewableSpaces`** deja de devolver `"all"` al Owner y le devuelve sus Spaces, como a cualquiera. `SpaceVisibility.writableSpaces` pierde su caso especial del Owner.
- **`Visibility.all`** (`apps/server/src/spaces/SpaceVisibility.ts`) queda para tres casos: la instalación sin Owner (un solo usuario, como upstream), el shell del Hub (`SHELL_SESSION_SUBJECT`) y el trabajo interno del servidor que no entrega nada a una persona. Cuando ya existe un Owner, «sin User» (`SpaceVisibility.of(undefined)`, `mcpVisibility.visibilityOf`, los Threads anteriores a los Users) se resuelve como el Owner. Ya no equivale a todo.
- **Comprobación de operador.** `RpcSpaceAccess.ts` decide hoy las RPC `installation` con `visibility.all`. Pasa a decidirlas con `isOwner` de la sesión (`sessionActsForInstallation` de `packages/contracts/src/installationAccess.ts`). Así el Owner sigue operando aunque deje de verlo todo. Este cambio va en el mismo ticket que el de visibilidad; si fuera por separado, el Owner perdería sus RPC de operador.
- **Migración.** Toda Organization existente en la que el Owner no tenga membership recibe al Owner como `admin`. Hoy solo el Owner crea Organizations, así que se cubren todas, y ahí no cambia nada de lo que el Owner hacía en ellas. El Steward de esas Organizations es el Owner (`../plans-and-limits/`). Ninguna acción de operador crea memberships para el Owner: para entrar en una Organization ajena necesita una Invitation, como cualquiera, y los demás Members lo ven en la lista.
- **Lo que ve el Owner de un Space ajeno.** Nombre, tipo, Steward, número de Members, número de Projects y Threads, fecha de creación, estado (activo, archivado, suspendido, congelado, borrado pendiente con fecha), tokens de IA por periodo, disco, y estado y uso del Sandbox. No ve la lista de Members (véase «Preguntas abiertas»), ni nombres de Projects o Threads, ni nombres de grupos de Vault o de entradas, ni valores. El contrato `PlatformSpaceSummary` no tiene campos para nada de eso: la forma del dato es la garantía.

### Abusos

- **Suspender una Organization**: `spaces.suspended_at`, `spaces.suspended_reason` (texto corto, visible para sus Members). Al suspender se paran los turnos en marcha y su Sandbox. Mientras dura, la policy niega toda acción que crea o ejecuta (`space-suspended`), la AI gateway rechaza las claves de ese Space y sus Members siguen leyendo y descargando sus datos. Reactivar lo deshace todo. Una Organization suspendida no se archiva ni se restaura hasta que se reactiva. Los Grants que esa Organization da a otros no cambian (véase «Preguntas abiertas»).
- **Borrar**: el Owner borra una Organization ajena solo si está suspendida, escribiendo su nombre y sin plazo de espera. Usa el borrado existente (`apps/server/src/spaces/OrganizationLifecycle.ts`).
- **Users**: deshabilitar y rehabilitar no cambian (`InstallationUserService.setStatus`). Quitar pasa por el cierre de cuenta (abajo).
- **Auditoría**: nuevas acciones `organization.suspend` y `organization.unsuspend` (con el detalle `reason`). `organization.delete` ya existe.

### Auditoría, procesos y consumo sin contenido ajeno

- **Auditoría** (`apps/server/src/audit/AuditLog.ts`, `packages/contracts/src/audit.ts`): el Owner sigue viendo todas las entradas. Cuando el Space de una entrada no es suyo, la lectura deja `target.name` a `null` para `project`, `thread`, `vault` y `secret`, y quita las claves de detalle con contenido. Esas claves se marcan una vez en `AUDIT_CONTENT_DETAIL_KEYS` junto a `AUDIT_DETAIL_KEYS`; por ejemplo `vault`, `subjectName`, `failureMessage` y `from`/`to` de un renombrado de Vault. La redacción se hace al leer, no al escribir, para que el Owner vea los nombres si más tarde entra como Member.
- **Procesos** (`apps/server/src/diagnostics/ProcessDiagnostics.ts`, `ProcessResourceMonitor.ts`, `apps/server/src/resourceTelemetry/ResourceAttribution.ts`): un proceso atribuido a un Space ajeno se enseña con su tipo, su Space, CPU, memoria y antigüedad, sin orden, argumentos, carpeta ni puertos. Lo no atribuido (procesos del propio Hub) se enseña como hoy. El Owner puede seguir parando un proceso (`serverSignalProcess`), que no lee nada. Los servidores que escuchan en el Hub (`subscribeDiscoveredLocalServers`) siguen la misma regla.
- **Consumo de IA** (`packages/contracts/src/aiUsage.ts`): en un Space ajeno el Owner ve el consumo por Space, User, AI account y modelo. La consulta por un Thread (`threadId`) se le niega en esos Spaces.

### Términos de uso y política de privacidad

- **Datos**: `legal_documents` (`kind` `terms` | `privacy`, `source` `text` | `url`, cuerpo Markdown o URL, `version`, `published_at`) y `legal_acceptances` (userId, version, at). Las dos piezas comparten un único número de versión.
- **Publicar**: en el modal de Plataforma (`../settings-modals/`), sección «Términos y privacidad». «Publicar y pedir aceptación» sube la versión; «Corregir sin pedir aceptación» guarda sin subirla. La primera vez se ofrece un texto inicial en inglés con las frases obligatorias: qué ve el operador, qué no ve, que es una garantía de la aplicación y no criptográfica, que el operador administra el servidor, la clave maestra y Keycloak, y que el dueño de una máquina prestada ve lo que corre en ella. El Owner lo edita a su gusto. Se audita como `legal.publish`.
- **Servir**: endpoint público (sin sesión) con los dos documentos y la versión, y páginas `/legal/terms` y `/legal/privacy` en la web del Hub. Un documento `url` redirige. El Markdown se pinta con el renderizador existente, sin HTML crudo.
- **Puerta de aceptación**: si hay una versión publicada y la última que aceptó el User es menor, toda petición de ese User falla con `LegalAcceptanceRequiredError` (contracts). Solo pasan leer los términos, aceptar, cerrar sesión, pedir y descargar la exportación y borrar la cuenta. La comprobación vive en un solo sitio: donde se resuelve el principal (`apps/server/src/auth/CurrentPrincipal.ts`), y la usan WS, HTTP, MCP y los tokens de `t3`. El Owner no la pasa. Los turnos en marcha y las tareas programadas no se paran (véase «Preguntas abiertas»).
- **Primer inicio de sesión**: lo crea `../keycloak-sign-in/`. La puerta aparece nada más crearse el User. «No acepto» en un User que nunca aceptó ninguna versión lo borra al momento (no tiene datos) y cierra la sesión. En un User que ya había aceptado antes, solo cierra la sesión.
- **Clientes**: en la web, la página de aceptación. Escritorio la hereda. En móvil, una pantalla nativa que bloquea al recibir el error, con enlaces a los documentos y «Aceptar», que llama a la RPC (la puerta la deja pasar).

### Avisos de quién puede ver qué

- Los textos viven en un solo módulo de `packages/client-runtime` y los usan web y móvil. Se ponen donde se decide, no en un apartado aparte. Lugares: la pantalla de aceptación de términos, el Personal space (recordatorio del selector y modal del Space), la aceptación de una Invitation a una Organization (`apps/web/src/components/auth/InvitationSurface.tsx`), la aceptación de un Grant de máquina y el compartir y aceptar un grupo de Vault. Estas dos últimas pantallas son de `../grants/`. Este spec pone el texto y el test que comprueba que está.
- Desaparecen los textos que dejan de ser verdad: «The Owner can see everything in your Personal space.» (`SpaceSelector.tsx`) y el aviso de `InvitationSurface.tsx` de que el Owner ve los Personal spaces.

### Descargar mis datos

- Servicio `AccountExport`: un User pide una exportación (una a la vez), el Hub la genera en segundo plano en un `.zip` y la deja descargable 7 días. Una exportación pendiente se reanuda si el Hub se reinicia. RPC para pedirla y ver su estado; descarga por HTTP con la sesión del propio User.
- Contenido: `profile.json` (nombre, login, fechas, sesiones activas), Projects de su Personal space (metadatos: nombre, remoto, rama por defecto, ajustes, sin archivos), sus Threads (los del Personal space y los que creó en Organizations de las que sigue siendo Member) como JSON más un Markdown legible por Thread, con sus adjuntos. También su vault personal (Variables con valor y Secrets solo con nombre), los Grants dados y recibidos y su consumo de IA. Nunca el valor de un Secret, ni Threads de otros.
- Se audita como `account.export`. No hay herramienta MCP: es una acción de la persona sobre su cuenta.

### Borrar mi cuenta y quitar un User

- **Un solo servicio, `AccountClosure`**, con dos entradas: el User lo pide (`self`) o el Owner lo quita (`removed`).
- **Pedirlo (User)**: en el modal de Usuario (`../settings-modals/`). Primero se ofrece la descarga. Luego, por cada Organization de la que es Steward, elige un Admin al que traspasarla (el traspaso es de `../plans-and-limits/`) o la archiva. Después ve un resumen de lo que se pierde y de lo que no vuelve si cancela, y confirma escribiendo su login. Si su último inicio de sesión tiene más de 10 minutos, tiene que volver a entrar por Keycloak antes.
- **Efecto inmediato**: `users.deletion_due_at = ahora + 30 días`. Se terminan sus sesiones, tokens, enlaces y claves de la gateway, se paran sus turnos, se borran sus tareas programadas y se retiran los Grants que dio (camino de retirada de `../grants/`) y los que recibió su Personal space. Terminan sus memberships (lo que hizo en Organizations se queda en ellas, como hoy). Su Personal space queda congelado y sus máquinas y AI accounts propias dejan de usarse.
- **Durante los 30 días**: si entra (por Keycloak) solo ve «Tu cuenta se borrará el D», con «Descargar mis datos» y «Cancelar el borrado». Cancelar le devuelve la cuenta, el Personal space, sus máquinas y sus AI accounts. No vuelven Grants, memberships ni Organizations traspasadas, y así se dice al confirmar.
- **El día 30** (`AccountPurge`, con el `Scheduler` de `apps/server/src/scheduling/` y la fecha guardada; al arrancar purga lo vencido): se borra el Personal space entero (Projects, Threads, adjuntos, checkpoints del Hub y el Sandbox con su volumen), el vault personal, las AI accounts propias con sus credenciales, las máquinas registradas, credenciales y sesiones, y el vínculo con Keycloak. La fila del User queda como lápida («Deleted user», sin login ni correo) para que la autoría en Organizations y la auditoría sigan siendo coherentes. El Hub no borra la identidad en Keycloak; el modal enlaza a la consola de cuenta de Keycloak para hacerlo allí.
- **Quitar (Owner)**: `InstallationUserService.setStatus(removed)` usa `AccountClosure`. El Personal space ya no se entrega al Owner, y sigue el mismo plazo de 30 días, que el Owner puede adelantar («Borrar ahora», escribiendo el nombre). Las Organizations de las que era Steward pasan al Admin más antiguo; si no queda ninguno, se archivan. Un User quitado no puede cancelar el borrado.
- **Personal spaces ya congelados al desplegar**: reciben `deletion_due_at = despliegue + 30 días`. Las notas de la versión avisan al Owner para que mueva antes lo que quiera conservar.
- **Auditoría**: `account.delete.request`, `account.delete.cancel`, `account.delete.complete` y `account.delete.expedite`.
- **Agentes**: no hay herramienta MCP para borrar una cuenta (es destructivo y solo lo hace una persona). El Owner no puede borrar la suya.

### Contratos (`packages/contracts`)

- Nuevos: `PlatformSpaceSummary`, `LegalDocuments`, `LegalAcceptanceRequiredError`, `AccountExportStatus`, `AccountDeletionState`. Estado `suspended` (con su motivo) en el Space que ven sus Members. Nuevas `AuditAction` con sus claves y `AUDIT_CONTENT_DETAIL_KEYS`.
- Las RPC de operador nuevas entran en `INSTALLATION_RPC_METHODS`. Las del User sobre su cuenta se declaran en `CLIENT_GUARDED_RPC_SCOPES` y en `RpcSpaceAccess` como `unscoped` («la cuenta propia de la sesión»). Las mutaciones de cliente usan `createEnvironmentRpcCommand`.

### Superficies

- **Web**: modal de Plataforma (resumen de Spaces con suspender, reactivar y borrar; Términos y privacidad), modal de Usuario (descargar mis datos, borrar mi cuenta), página de aceptación, pantalla de borrado pendiente, banner de Organization suspendida y avisos. Escritorio hereda la web.
- **Móvil**: las mismas pantallas en la división de `../settings-modals/`, la pantalla de aceptación nativa, el banner de suspendida y los avisos.
- **Paleta de comandos**: «Download my data» y «Delete my account» abren el modal de Usuario en su sección; «Platform: Spaces» para el Owner.
- **Agentes**: ver apartados anteriores. El agente del Owner hereda su visibilidad y no hay herramientas nuevas.
- **Docs**: `docs/user/install.md` reescribe «Spaces and organizations» («The Owner sees everything»), «Personal spaces and Installation permissions», «Disabling and removing people» y «Audit log», y añade «Who can see what» (una tabla corta) y «Your account» (descargar y borrar). `docs/user/guest-links.md` y `docs/user/outside-agents.md` se revisan. `docs/internals/environment-auth.md` explica en un párrafo que ser Owner no es lo mismo que verlo todo, porque es una restricción que cruza componentes.

## Testing Decisions

- Solo comportamiento externo. Primero los tests en rojo: cada regla nueva es una fila que falla en `main`.
- **Costura 1, `AccessPolicy.test.ts`**: filas del Owner sin membership en una Organization y en un Personal space ajeno (contenido → Deny), del Owner Admin (como cualquier Admin), de las acciones de operador (→ Allow) y de una Organization suspendida (crear y ejecutar → `space-suspended`, ver → Allow). Las filas existentes del Owner con «Allow» en contenido ajeno cambian de signo; no se escriben suites nuevas.
- **Costura 2, frontera del servidor** (HTTP y WS reales sobre SQLite en memoria, sobre los testkits existentes `UserAuth.testkit.ts` y `SpaceVisibility.testkit.ts`): el snapshot y los deltas de `subscribeShell` del Owner sin Spaces ajenos; una RPC `installation` sigue funcionando para el Owner y se le niega a un Admin; una llamada MCP del Owner a `t3_thread_list`/`t3_thread_read` no ve lo ajeno; la auditoría redactada; la puerta de términos en WS, HTTP y MCP; el ciclo de borrado con `TestClock` (pedir, cancelar, purgar el día 30, Owner adelanta); la exportación sin el valor de un Secret (se busca el valor en los bytes del zip).
- **Tabla de puertas**: `RpcAuthorization.test.ts` ya exige que toda RPC declare su acceso. Se amplía para que toda RPC, ruta HTTP y herramienta MCP tenga una clasificación «Owner en Space ajeno» (contenido, metadato/consumo u operador). Una puerta nueva sin clasificar hace fallar el test.
- No se repiten las reglas de la costura 1 en la costura 2. Sin sleeps, polling ni timeouts; `TestClock` para los 30 días, los 7 días de la exportación y la expiración.
- Clientes: los textos de aviso no se testean como texto. Sí se testea con un test de navegador que cada pantalla de decisión monta el aviso, y en móvil se hace una pasada en un cliente real.

## Out of Scope

- Cifrado de extremo a extremo o cualquier garantía criptográfica frente al operador.
- Proxy de credenciales (Secrets que el agente no lee): mejora futura del mapa.
- Captcha, verificación de correo y protección contra fuerza bruta en el registro: los hace Keycloak (`../keycloak-sign-in/`).
- Pagos (`../billing/`), Plans y cuotas (`../plans-and-limits/`), mecánica de Grants (`../grants/`), modales (`../settings-modals/`).
- Moderación de contenido, informes de abuso dentro de la app y retención legal.
- Borrar la cuenta del Owner o traspasar la Installation.

## Preguntas abiertas

1. **¿Ve el Owner la lista de Members de una Organization ajena?** Recomendación: no, solo el número y el Steward; para contactar basta el Steward.
2. **¿Puede el Owner borrar una Organization suspendida al momento?** Recomendación: sí, escribiendo su nombre, porque una orden de retirada no espera. Alternativa: 30 días como en las cuentas.
3. **¿Suspender una Organization pausa también los Grants que ella da a otros?** Recomendación: no en esta fase. Se suspende lo que corre en ella, y el Owner puede deshabilitar al Steward si hace falta.
4. **¿La puerta de términos para los turnos en marcha y las tareas programadas?** Recomendación: no se paran; la puerta se aplica a lo que la persona (o su agente externo) pide a partir de ahí.
5. **¿Entran en la exportación los Threads propios en Organizations?** Recomendación: sí, mientras siga siendo Member; son sus mensajes. No entran los de otros en esos Threads (no hay), ni los de Organizations que dejó.
6. **¿Borra el Hub la identidad en Keycloak?** Recomendación: no; enlaza a la consola de cuenta de Keycloak. Borrarla requeriría credenciales de administración de Keycloak en el Hub.
7. **Grupo de Keycloak → membership** (`../keycloak-sign-in/`): el Owner administra Keycloak y podría meterse en una Organization ajena mapeando un grupo. Recomendación: un mapeo solo puede apuntar a Organizations de las que el Owner es Steward. Hay que coordinarlo con ese spec, y el inventario de puertas lo comprueba.
8. **Triage desde la app sobre la máquina del Hub**: el agente lee los logs y el estado del Hub, incluida la base de datos con contenido ajeno. Recomendación: cuando hay Spaces ajenos, el triage en la máquina del Hub recibe solo logs y trazas, sin base de datos ni `userdata`. `npx t3 triage` en el shell queda fuera de la garantía, como todo el shell.
9. **Personal spaces ya congelados al desplegar**: recomendación, 30 días desde el despliegue y aviso en las notas de la versión, sin una regla de transición que deje al Owner moverlos.
10. **Volver a iniciar sesión antes de borrar la cuenta**: recomendación, 10 minutos desde el último inicio de sesión (`max_age` de OIDC). Hay que confirmar con `../keycloak-sign-in/` que se puede pedir.

## Further Notes

- La garantía tiene límites que se dicen y no se esconden: el shell del Hub, la base de datos, la clave maestra (`masterKey.backup`), las copias de seguridad, la administración de Keycloak (que puede suplantar a un User) y el dueño de una máquina prestada (ADR 0011). Los términos iniciales lo dicen, y la tabla «Who can see what» de `docs/user/install.md` también.
- Cualquier fallo de autorización expone ahora datos de desconocidos (ADR 0008). Por eso este spec acaba con un inventario de puertas, y abrir el registro espera a ese inventario y a los de `../keycloak-sign-in/`, `../plans-and-limits/` y `../grants/`.
- «Hit every surface» (AGENTS.md): entradas (modal, paleta), clientes (web, escritorio, móvil), agentes (el del Owner hereda los límites y no hay herramientas destructivas nuevas), contratos, estados inversos (suspender/reactivar, pedir borrado/cancelar, publicar términos/corregir) y docs.
