# Mapa: t3code multiusuario con Hub

Label: wayfinder:map

## Destination

Diseño completo y decidido de las 7 áreas (usuarios, organizaciones y permisos, cuentas de IA, vaults, Environments, continuidad de un Project entre Environments, procesos), sin recorte de MVP, listo para pasar por `/to-spec` y `/to-tickets` área por área. Construir queda fuera del mapa.

## Notes

- Dominio: el Owner y su equipo (no hay clientes ni venta). Fork independiente de t3code, autoalojado, un único Owner (`docs/adr/0001-self-hosted-independent-fork.md`). Un Hub central en la VPS del Owner es la fuente de verdad y nunca ejecuta agentes (`docs/adr/0002-central-hub.md`); cada Space corre por defecto en su Sandbox (`docs/adr/0004-one-container-sandbox-per-space.md`).
- Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`. Project ya NO está atado a un único Environment.
- Cada ticket de grilling: llamar a las skills `grilling` y `domain-modeling`.
- Punto de partida sobre lo que t3code ya tiene: `.scratch/multi-user-hub/research/00-t3code-baseline.md`.
- Las notas de los tickets de research viven en `.scratch/multi-user-hub/research/` (no hay remoto propio donde empujar ramas `research/*`).
- Idioma: tickets en español; GLOSSARY y ADRs en inglés.

## Decisions so far

<!-- una línea por ticket resuelto -->

- [Cierre del mapa](issues/16-cierre-del-mapa.md): protocolo y superficies de cliente pasan al spec; mover un Project de Space exige detener sus Threads y cambia sus Vaults/AI accounts por los del destino; se empieza de cero; auditoría mínima dentro del alcance; seis mejoras quedan fuera.
- [Vista de procesos](issues/15-vista-de-procesos.md): árbol Environment → Space → Project → Thread → procesos con CPU, memoria, autor y puertos; grupo «Compartido»; cada User apaga lo suyo, Admin su Space, Owner todo; en vivo + resumen por turno + gráficas de 7 días por Sandbox; tokens por Thread.
- [Mover un Project entre Environments](issues/14-mover-un-project-entre-environments.md): un Thread activo en un solo Environment a la vez; el Hub guarda el historial de los Threads (ADR 0006); archivos por git del Hub con checkpoint subido tras cada turno; traspaso reforzado con resumen al cambiar de máquina; cambios no subidos van a rama aparte.
- [Registrar Environments en el Hub](issues/13-registrar-environments-en-el-hub.md): Sandboxes + External environments (personales o dedicados a un Space); alta con `t3 join` (o SSH para VPS) y conexión saliente hacia el Hub; IA y secretos vienen del Hub; personales en nativo; pausa al desconectarse; por defecto se trabaja en el Sandbox del Space.
- [Vaults](issues/12-vaults.md): almacén cifrado propio del Hub; solo el Owner crea Vaults y los permite a Spaces/Users; Secret links al Main vault + copias + secretos propios; solo el Owner revela valores; vaults por defecto por Space; llegan como env vars y el agente puede listar nombres; valores ocultos en el historial.
- [Cuentas de IA](issues/11-cuentas-de-ia.md): solo el Owner registra AI accounts (suscripciones y APIs) y las permite a Spaces/Users; el Hub ejecuta CLIProxyAPI como AI gateway (credenciales fuera de los Sandboxes); prioridad global y failover del mismo proveedor los hace CLIProxyAPI; compartir suscripciones con el equipo, riesgo de ToS aceptado (ADR 0005).
- [Aislamiento entre Organizaciones](issues/10-aislamiento-entre-organizaciones.md): un Sandbox por Space (servidor T3 con usuario propio dentro de un contenedor rootless de Podman), registrado como Environment de ese Space; el Hub nunca ejecuta agentes; imagen base única, límites de recursos, red separada, previews vía Hub, parada por inactividad.
- [Inicio de sesión en el Hub](issues/09-inicio-de-sesion-en-el-hub.md): Hub público por HTTPS con cuentas locales (passkey + contraseña; Owner/Admins con passkey o contraseña+TOTP); Invitations por enlace copiable; login único en el Hub y los Environments confían en su prueba firmada; sin códigos de pairing; sesiones de 30 días renovables.
- [Roles y permisos](issues/08-roles-y-permisos.md): Roles fijos por Organization (Admin/Member/Guest) + Installation permissions; el agente hereda los permisos de quien lanzó el turno; nadie continúa Threads ajenos; solo el Owner nombra Admins; guest links solo en Organizations; el Owner ve los Personal spaces (de forma explícita).
- [Organizaciones y espacio personal](issues/07-organizaciones-y-espacio-personal.md): todo Project/Thread vive en un Space (Organization o Personal space); solo el Owner crea Organizations; entrada por Invitation aceptada; lo creado en una Organization es de la Organization; Projects movibles entre Spaces; archivar antes de borrar; nada se comparte desde un Personal space.
- [Qué ofrece varlock](issues/02-que-ofrece-varlock.md): esquema `.env.schema` versionable + 18 backends de secretos, inyección vía CLI (`varlock run`/`load`); sin concepto de usuario, tenant ni servidor, así que no sustituye un almacén central en el Hub. Encaje viable: driver de `secret-provider-core` y/o envolver providers y terminales con `varlock run`; su proxy de credenciales está en preview. Ojo: telemetría activada por defecto y caché compartida por usuario del SO.
- [Cómo meter identidad de usuario en la auth](issues/04-como-meter-identidad-de-usuario-en-la-auth.md): las sesiones (token HMAC + fila `auth_sessions`) no llevan usuario y `subject` es el canal de pareo, no sirve; hace falta un `userId` propio en grant, claim, tabla y principal, más un servicio de principal en `ws.ts`. Solo los comandos de creación tienen actor (`createdBy`); eventos y receipts no. De T3 Connect se reutiliza el patrón (prueba firmada externa → grant DPoP), no Clerk.
- [Técnicas para continuar un Project en otro Environment](issues/03-tecnicas-para-continuar-un-project-en-otro-environment.md): los checkpoints son refs git empujables pero inútiles sin las proyecciones; el estado del Thread vive en proyecciones SQLite (el log de eventos se poda en ~1 día) con ids locales al Environment; la sesión nativa del provider (JSONL en la máquina) no está probado que se reanude en otra. Opciones: snapshot + handoff, copia completa, acceso remoto por Peer Link, store central en el Hub.
- [Atribuir procesos a un Thread o Project](issues/06-atribuir-procesos-a-un-thread-o-project.md): viable. El monitor Rust ya recorre descendientes desde raíces (pid+start time); los agentes y terminales conocen `threadId` al lanzarse y ya hay cgroups por thread (Linux), `T3CODE_THREAD_ID` y recorrido de terminales. No atribuibles a un solo thread: app-server de Codex compartido, Chrome de preview, git. Excluir threads de las métricas es solo por cardinalidad OTLP.
- [Cómo plugar suscripciones y APIs](issues/01-como-plugar-suscripciones-y-apis.md): CLIProxyAPI unifica suscripciones (Claude, Codex, Antigravity/Gemini…) y APIs (incl. DeepSeek/OpenAI-compatibles) tras un endpoint; encaja sin código como provider instances con env vars. Riesgo serio de ToS al compartir suscripciones con otras personas y choque con poner el Hub en un VPS (IPs de datacenter); opciones A–D para el ticket «Cuentas de IA».
- [Opciones de aislamiento entre Organizaciones](issues/05-opciones-de-aislamiento-entre-organizaciones.md): todos los procesos ya pasan por `AgentScope.wrap` (systemd-run, solo límites de recursos). Lo más barato con aislamiento real: un servidor T3 por Organización con su usuario del SO; contenedores rootless añaden red/procesos; Firecracker/Kata necesitan KVM. Ninguna opción protege los secretos de una Organización frente a su propio agente.

## Not yet specified

<!-- vacío: el camino al destino está claro -->

## Notes for /to-spec

Specs propuestos, en orden de dependencia:

1. Identidad y acceso: Users, inicio de sesión, sesiones, Invitations, Spaces, Roles, Installation permissions y auditoría mínima («Organizaciones y espacio personal», «Roles y permisos», «Inicio de sesión en el Hub», «Cierre del mapa»).
2. Hub como store de Threads y movimiento entre Environments, incluido el protocolo Hub ↔ Environment («Mover un Project entre Environments», «Registrar Environments en el Hub»).
3. Sandboxes y External environments («Aislamiento entre Organizaciones», «Registrar Environments en el Hub»).
4. AI accounts y AI gateway («Cuentas de IA»).
5. Vaults («Vaults»).
6. Vista de procesos («Vista de procesos»).

Cada spec decide sus superficies de cliente (web, desktop, móvil).

## Out of scope

- SaaS público, registro abierto y facturación (ADR 0001). Reabierto en `../public-hub/map.md` (ADR 0008).
- La implementación: sigue al mapa, vía `/to-spec` → `/to-tickets` → `/implement-spec`.
- Secretos usados sin que el agente los vea (proxy de credenciales): mejora futura ([Cierre del mapa](issues/16-cierre-del-mapa.md)).
- `.env.schema` por Project: mejora futura.
- Copiar la sesión nativa de Claude/Codex entre máquinas: mejora futura.
- Imágenes de Sandbox personalizadas por Space o Project: mejora futura.
- Egress allowlist por Sandbox: mejora futura.
- Cuotas de IA por User u Organization: mejora futura (los tokens por Thread sí se muestran).
- Migración de datos de un t3code monousuario existente: se empieza de cero.
