# Mapa: Hub abierto al público, con operador, préstamos y planes

Label: wayfinder:map

## Destination

Diseño decidido para que el Hub pase de «la Installation de un Owner que invita a su equipo» a una plataforma abierta que el Owner gobierna: cualquiera se registra (si el Owner lo permite), es dueño de sus máquinas, cuentas de IA y vaults, los presta con límites a Spaces, y el Owner controla registro, planes y límites sin leer el contenido ajeno. Listo para pasar por `/to-spec` y `/to-tickets` fase por fase. Construir queda fuera del mapa.

## Notes

- Sustituye la línea «SaaS público, registro abierto y facturación» de «Out of scope» de `../multi-user-hub/map.md`.
- ADRs que cambian: 0001 (se sustituye: plataforma con operador), 0003 (Keycloak y modos de registro), 0004 (Sandboxes también en máquinas externas prestadas), 0005 (cualquiera es dueño de AI accounts y las presta). Spec de vaults: deja de valer «solo el Owner crea Vaults» y «solo el Owner revela valores».
- Tickets ya escritos que entran aquí: `../identity-and-access/issues/17` (Personal space siempre), `18` (cualquier User crea Organizations), `19` (sidebar y acciones solo del Space actual); `../ai-accounts-and-gateway/issues/16` (el uso de IA no se ve).
- Vocabulario nuevo en `GLOSSARY.md`: Grant (préstamo), Plan, Steward (responsable de una Organization), Vault group, Secret y Variable, Registration mode, Platform invitation. Usar esos términos en specs y tickets.
- Idioma: tickets en español; GLOSSARY y ADRs en inglés.

## Decisions so far

Decididas con el Owner en conversación (2026-11-16); cada una pasará a su ticket de grilling o al spec.

- **Entrada por Keycloak (OIDC).** Keycloak es la única puerta para todos: registro con correo y contraseña, Google, GitHub y la cuenta corporativa de Bezenti. El Hub solo habla OIDC. Quien entra por Keycloak con el grupo de Bezenti queda detectado y recibe su membership en Bezenti (grupo → Role). El Owner conserva passkey local y códigos de recuperación para entrar aunque Keycloak falle. Escritorio y móvil entran por el navegador del sistema, como hoy.
- **Owner como operador.** Sigue existiendo y gobierna: modos de registro (abierto, solo invitación, cerrado; lo hace cumplir el Hub, no Keycloak), alta de Users o de correos a mano, planes, plan por defecto, suspender y quitar, ver consumo.
- **Privacidad.** El Owner ve todo en sus propios Spaces; en los ajenos ve consumo, no contenido (threads, Personal spaces, secretos). Es una garantía de la aplicación, no criptográfica (el Owner tiene la clave maestra), y los términos de uso lo dicen.
- **Dueños y préstamos.** Máquinas, AI accounts y grupos de vault tienen dueño (un User o una Organization) y se prestan a Spaces, Users o planes, con límites y retirables. Un préstamo a una Organization empieza solo cuando un Admin de ella lo acepta. Los recursos de una Organization solo los prestan sus Admins o su responsable. Lo que hoy el Owner «permite» pasa a ser préstamos del Owner.
  - Máquinas prestadas: el trabajo de cada Space corre aislado en esa máquina (Sandbox del ADR 0004 llevado a máquinas externas) con límites de CPU, memoria y disco por préstamo; aviso de que el dueño de la máquina puede ver lo que corre en ella; al retirarla, los Threads se paran o se mueven.
  - AI accounts prestadas: tope por préstamo, aplicado por la gateway; la credencial no sale del Hub.
  - Suscripciones (Claude, ChatGPT…): se pueden prestar a cualquier Space, también donde el dueño no es miembro, pero el préstamo muestra una advertencia corta de que sus términos lo prohíben y la cuenta puede ser suspendida.
  - Las cuentas de IA de Bezenti se usan en Bezenti y también se pueden ofrecer dentro de un plan.
- **Vaults con grupos.** Todo Vault tiene un grupo `default` que no se borra, y más grupos con nombre. Cada grupo tiene Secrets y Variables. Un Secret se escribe y después solo se reemplaza o borra; nadie vuelve a ver su valor, tampoco el Owner (desaparece el «revelar»). Una Variable se ve y se edita siempre y no se enmascara en el historial. Los valores admiten varias líneas (área de texto); el enmascarado del historial cubre un Secret multilínea completo o en parte. Un User comparte un grupo de su vault personal con el vault de una Organization a la que pertenece, como enlace (los cambios llegan al siguiente turno, se deja de compartir cuando quiera), con aceptación de un Admin y aviso de que el agente de esa Organization puede leer los Secrets.
- **Planes y límites.** Un plan es un conjunto con nombre de límites (Organizations que puede crear, miembros por Organization, máquinas propias, disco, Sandbox en el servidor del Hub, préstamos de la plataforma). Cada User tiene un plan; los Installation permissions actuales se convierten en límites. Los límites de una Organization salen del plan de su responsable (quien la creó, transferible). Bajar de plan no borra nada: solo impide crear más. Los pagos llegan al final y solo cambian el plan de alguien.
- **Configuración en modales separados.** Usuario (cuenta, sesiones, apariencia, atajos, preferencias, vault personal, máquinas, AI accounts, préstamos dados, plan); Space (miembros, invitaciones, vaults, AI accounts y máquinas propias o prestadas, préstamos por aceptar, archivar; también para el Personal space); Proyecto (vaults y grupos, máquina, valores por defecto, scripts); Plataforma, solo Owner (registro, planes, Users, auditoría, clave maestra). Se llega también por la paleta de comandos y atajos; en móvil son pantallas con la misma división. Sustituye la página Settings actual.
- **Todo en el Space actual.** Sidebar, crear Project, crear Thread (solo Projects del Space actual), Search y Settled se limitan al Space seleccionado (ticket `../identity-and-access/issues/19`).

### Decisiones transversales (2026-11-16, al pasar a specs)

Recomendaciones tomadas para que los specs sean coherentes entre sí; el Owner puede reabrirlas en cada spec («Preguntas abiertas»).

- **Alta a mano = Invitation de plataforma.** Con el registro cerrado o solo con invitación, el Owner da de alta a alguien con una Invitation sin Space (enlace copiable, un uso, 7 días). Se acepta tras entrar por Keycloak. Nada de emparejar por correo.
- **Vincular Users existentes.** Un User local entra como hoy y pulsa «Conectar con Keycloak» en el modal de Usuario; desde entonces entra por Keycloak y sus credenciales locales se borran. El Owner conserva siempre las suyas. Un ajuste de Plataforma permite o no el inicio de sesión local para los demás.
- **Bajas en Keycloak.** El Hub guarda el refresh token, re-comprueba la identidad al renovar la sesión y acepta el back-channel logout de Keycloak; un User deshabilitado en Keycloak pierde sus sesiones del Hub.
- **Segundo factor.** Cuenta como factor fuerte un token de Keycloak cuyo `acr`/`amr` esté en una lista que configura el Owner; si no, vale la regla local (passkey o TOTP en el Hub).
- **Recursos en fase 2.** Un recurso de un User solo se usa en su Personal space (excepto sus máquinas personales, que como hoy usa él mismo en cualquiera de sus Spaces); uno de una Organization, en esa Organization y lo gestionan sus Admins. Salir de ahí es un Grant (fase 3). El Main vault del Owner pasa a ser su vault personal.
- **Grants.** Recursos prestables: Environment, AI account, grupo de Vault. Destinos: Space o plan (no Users sueltos: prestar a una persona es prestar a su Personal space). Un Grant a una Organization lo acepta un Admin de ella; a un Personal space, su dueño; a un plan, solo puede darlo el Owner y no se acepta. Lo que hoy el Owner «permite» se migra a Grants ya aceptados.
- **Topes de IA.** En tokens por periodo (día, semana, mes) y opcionalmente en peticiones; el coste estimado en USD se muestra con una tabla de precios por modelo versionada, pero no es tope en esta fase.
- **Cuotas del Hub** (disco de threads y checkpoints, tráfico de gateway y previews) son límites del plan; al llenarse se impide crear y empezar turnos nuevos, nunca se borra.
- **Responsable (Steward) de una Organization**: quien la creó; transferible a otro Admin. Sus límites salen de su plan. Las Organizations que ya existen pasan al Owner.
- **Borrado de cuenta propio**: el User lo pide desde su modal; se retiran sus Grants, las Organizations de las que es responsable piden traspaso o se archivan, y su Personal space se borra a los 30 días (antes puede descargar sus datos).

## Not yet specified

- Lo que cada spec deje en «Preguntas abiertas». Los specs `plans-and-limits`, `billing` y `platform-privacy` quedan en `needs-triage` hasta que el Owner las acepte; el resto, `ready-for-agent` con sus recomendaciones.

## Notes for /to-spec

Specs, en orden de dependencia (ADRs 0008–0012):

1. `../keycloak-sign-in/`: entrada por Keycloak, modos de registro, Invitations de plataforma, grupo → membership, vinculación, bajas, segundo factor.
2. `../owned-resources/`: cualquier User u Organization es dueño de máquinas, AI accounts y Vaults; Vaults con grupos, Secrets de solo escritura y Variables; tickets 17, 18 y 19 de `../identity-and-access/`.
3. `../grants/`: Grants con límites, aceptación y retirada; topes de IA y atribución del uso (ticket 16 de `../ai-accounts-and-gateway/`); grupos de Vault compartidos; máquinas prestadas con Sandbox y límites.
4. `../plans-and-limits/`: planes, plan por defecto, Steward, cuotas del Hub, Grants a un plan.
5. `../platform-privacy/`: el Owner deja de leer lo ajeno, avisos de quién puede ver qué, borrado y descarga de cuenta, términos de uso y, como último ticket, abrir el registro.
6. `../billing/`: pagos que cambian el plan.

Transversal: `../settings-modals/` (Usuario, Space, Proyecto, Plataforma), en paralelo a la fase 2.

## Out of scope

- Secretos que nadie puede leer, solo usar el agente en un proceso (proxy de credenciales): mejora futura.
- La implementación: sigue al mapa, vía `/to-spec` → `/to-tickets` → `/implement-spec`.
