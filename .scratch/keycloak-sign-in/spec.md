# Spec: Entrada por Keycloak

Status: ready-for-agent
Map: ../public-hub/map.md (spec 1 de 6, fase 1)
Decisiones de origen: «Entrada por Keycloak (OIDC)», «Owner como operador» (modos de registro, alta a mano); transversales «Alta a mano = Invitation de plataforma», «Vincular Users existentes», «Bajas en Keycloak», «Segundo factor»
ADRs: 0008 (plataforma abierta con un Owner operador), 0009 (Keycloak es el proveedor de identidad; sustituye en parte a 0003), 0003 (lo que sigue en pie: Hub público por HTTPS, la gente entra solo al Hub), 0012 (los Secrets son de solo escritura: también el client secret)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: User, Owner, Organization, Role, Invitation, Registration mode, Platform invitation
Depende de: spec de identidad y acceso (done); almacén cifrado del Hub (`ServerSecretStore`, ticket 01 de vaults). No depende de los demás specs del mapa. El ticket 17 de `../identity-and-access/` (Personal space siempre) se aplica también a los Users que crea este spec en cuanto llegue.

## Problem Statement

Hoy el Hub tiene sus propias cuentas (ADR 0003): passkey, contraseña con TOTP, códigos de recuperación del Owner y enlaces de reset que da el Owner. Para abrir la plataforma (ADR 0008) eso no basta: faltan registro con verificación de correo, recuperación de contraseña por correo, Google, GitHub, captcha y la cuenta corporativa con la que la gente de Bezenti ya entra al resto de su software. Construirlo en el Hub sería rehacer Keycloak peor y necesitar un servidor de correo.

Además el Owner no tiene forma de decidir quién entra salvo invitar a una Organization: no puede cerrar el registro, ni dar de alta a alguien sin meterlo en una Organization, ni hacer que quien pertenece al grupo de Bezenti en Keycloak aparezca ya como Member de Bezenti. Y una baja en la empresa no llega al Hub: la sesión de 30 días sigue viva aunque la cuenta corporativa esté deshabilitada.

## Solution

El Hub habla OIDC con un realm de Keycloak (authorization code + PKCE, cliente confidencial). Keycloak hace el registro, Google y GitHub, la verificación de correo, la recuperación de contraseña y el captcha; el Hub solo recibe una identidad verificada y decide qué hacer con ella.

- **«Entrar con Keycloak»** en la página de inicio de sesión de la web. Desktop y móvil ya entran por el navegador del sistema (`/app-sign-in`), así que heredan el botón sin cambiar de flujo.
- **El Hub decide quién entra**, con un Registration mode que configura el Owner: abierto (cualquiera tiene User en su primer inicio de sesión), solo con invitación (hace falta una Invitation o un grupo mapeado) o cerrado (solo una Platform invitation del Owner crea Users nuevos). Keycloak puede dejar registrarse a quien quiera: si el Hub no lo admite, no entra.
- **Platform invitations**: la forma del Owner de dar de alta a alguien a mano, con un enlace de un uso y 7 días, sin Space. Se acepta entrando por Keycloak.
- **Grupos → Organizations**: el Owner mapea grupos de Keycloak a una Organization y un Role (`bezenti` → Member de Bezenti, `bezenti-admin` → Admin). Se aplica en cada inicio de sesión y en cada re-comprobación; las memberships que crea el mapeo las gestiona Keycloak, las manuales no se tocan.
- **Vincular Users existentes**: un User local entra como hoy y pulsa «Conectar con Keycloak». Desde entonces entra por Keycloak y sus credenciales locales se borran. El Owner conserva siempre su passkey y sus códigos de recuperación para entrar aunque Keycloak falle.
- **Inicio de sesión local**: un ajuste de Plataforma lo permite o no a quien no es el Owner.
- **Bajas**: el Hub guarda un refresh token por inicio de sesión, re-comprueba la identidad como mucho cada hora mientras se usa, y acepta el back-channel logout de Keycloak. Una cuenta deshabilitada o una sesión cerrada en Keycloak cierra las sesiones del Hub que nacieron de ella, con sus sockets.
- **Factor fuerte**: cuenta como fuerte un inicio de sesión de Keycloak cuyo `acr` o `amr` esté en las listas que configura el Owner. El Owner y los Admins lo necesitan, como hoy necesitan passkey o TOTP.

## User Stories

### Configuración (Owner)

1. As the Owner, I want to set the Keycloak issuer URL, client id and client secret in the Platform settings, so that I can connect the Hub to my realm without editing files or restarting.
2. As the Owner, I want the client secret to be write-only (shown as "saved", replaceable, never shown again), so that a session on my account or a screenshot never leaks it.
3. As the Owner, I want a "Check" button that fetches the realm's discovery document and keys and tells me what is wrong, so that I find a typo before anyone tries to sign in.
4. As the Owner, I want the Platform settings to show the exact redirect, back-channel logout and post-logout URLs to paste into Keycloak, so that I configure the client right the first time.
5. As the Owner, I want to choose the Registration mode (open, invitation only, closed), so that I decide who may get a User regardless of what Keycloak allows.
6. As the Owner, I want to name the groups claim and map Keycloak groups to an Organization and a Role, so that people of a team arrive already in it.
7. As the Owner, I want to list the `acr` and `amr` values that count as a strong factor, so that Admins can use Keycloak's MFA instead of a passkey in the Hub.
8. As the Owner, I want to allow or forbid local sign-in for everyone but me, so that once everyone has moved to Keycloak nobody keeps a way in that Keycloak cannot cut.
9. As the Owner, I want to turn Keycloak off again and keep its configuration, so that I can stop using it without losing the work of setting it up.
10. As the Owner, I want every change to these settings in the audit log, so that I can see who opened the door and when.

### Entrar

11. As a User, I want a "Sign in with Keycloak" button on the Hub's sign-in page, so that I use the same account as in the rest of my software.
12. As a newcomer, I want to sign up in Keycloak (email, Google, GitHub) and land in the Hub with my User created, when the Registration mode lets me in, so that joining is one flow.
13. As a newcomer the Hub does not admit, I want a clear message ("this Hub is invitation only"), so that I know I need an invitation instead of thinking it is broken.
14. As a User on desktop or mobile, I want the app's browser sign-in to offer Keycloak too, so that I sign in the same way on every device.
15. As a User who approves an outside agent (MCP client), I want the approval page to let me sign in with Keycloak, so that outside agents keep working.
16. As a User, I want signing out of the Hub to offer "also sign out of Keycloak", so that on a shared computer nobody gets back in with one click.
17. As the Owner, I want my local passkey and recovery codes to keep working whatever Keycloak's state, so that a broken or unreachable realm never locks the Installation out.

### Invitations

18. As the Owner, I want to create a Platform invitation (no Space) and copy its link, so that I can add a person by hand when registration is closed or invitation only.
19. As the Owner, I want Platform invitations to be single-use, expire after 7 days and be revocable, so that a leaked link does little harm.
20. As an invitee, I want to open the link, sign in or sign up in Keycloak, and get my User, so that the invitation works even if I had no Keycloak account yet.
21. As an invitee to an Organization, I want to accept the Invitation by signing in with Keycloak, so that I do not need a separate Hub password.
22. As an invitee who already has a User, I want a Platform invitation to tell me I already have an account and stay unused, so that the Owner can give it to someone else.

### Grupos

23. As a Bezenti employee, I want my Keycloak group `bezenti` to make me a Member of Bezenti on my first sign-in, so that I find my team's work without waiting for an invitation.
24. As a Bezenti employee moved to `bezenti-admin`, I want to become Admin at my next sign-in or within the hour, so that Keycloak stays the source of truth for the team.
25. As a person removed from the group, I want to lose the membership that the group gave me, so that leaving the team in Keycloak means leaving it in the Hub.
26. As an Admin, I want a membership that a group manages to show "managed by Keycloak" and refuse Role changes and removal in the Hub, so that I am not surprised when the next sign-in undoes my change.
27. As a Member invited by hand, I want the group mapping to leave my manual membership alone when no mapped group applies to me, so that guests from outside the company keep their access.

### Vincular Users existentes

28. As a local User, I want a "Connect Keycloak" action in my account settings, so that I move my existing User (and its Spaces and Threads) to Keycloak sign-in.
29. As a local User, I want to confirm with my current credential before linking, so that someone with a stolen session cannot attach their own Keycloak account to mine.
30. As a linked User, I want my local passkeys, password and TOTP deleted and my other sessions signed out, so that only Keycloak can let me in from now on.
31. As the Owner, I want to link my own Keycloak account and still keep my passkey and recovery codes, so that I use Keycloak daily and keep the break-glass.
32. As a linked User, I want my account settings to show which Keycloak account I use and link to Keycloak's account page, so that I know where to change my password or MFA.
33. As the Owner, I want a reset link for a User to let them bind a Keycloak account (replacing the old one), so that someone whose Keycloak account was recreated or who was locked out can get back in.

### Bajas

34. As the Owner, I want disabling a person in Keycloak to sign them out of the Hub within the hour, so that offboarding in one place is enough.
35. As the Owner, I want a logout from Keycloak's admin console (back-channel logout) to close the person's Hub sessions and sockets at once, so that I can cut access immediately from Keycloak.
36. As a User, I want the app and outside-agent sessions I approved from a Keycloak sign-in to end with it, so that no device outlives the account that let it in.
37. As a User, I want a Keycloak outage not to sign me out, so that a few minutes of downtime do not interrupt my work.

### Factor fuerte

38. As an Admin, I want a Keycloak sign-in with MFA (`acr`/`amr` in the Owner's list) to count as my strong factor, so that I do not need a separate passkey in the Hub.
39. As an Admin signing in without MFA, I want the Hub to refuse me with a button to retry asking Keycloak for the second factor, so that a phished password alone never gives Admin rights.
40. As a User approving a machine join or any action that needs a fresh strong factor, I want to confirm through Keycloak, so that I can step up without local credentials.

## Implementation Decisions

### Dónde vive la configuración: Plataforma, no variables de entorno

- **Decisión:** todo se configura en la sección «Inicio de sesión» del modal de Plataforma (solo Owner; hasta que exista el modal del spec `../settings-modals/`, en el diálogo **Users and permissions** del Owner). No hay variables de entorno nuevas.
- **Por qué:**
  - El client secret va al almacén cifrado (`ServerSecretStore`, nombre `keycloak-client-secret`); en `service.env` quedaría en claro en disco y en el entorno del proceso.
  - Los mapeos de grupos apuntan a Organizations por id: se eligen de una lista, se borran con la Organization (clave foránea) y se cambian en la misma transacción que su entrada de auditoría.
  - El Owner cambia el modo de registro o desactiva Keycloak sin reiniciar el Hub.
  - El Owner siempre puede entrar con su passkey local para arreglar una configuración rota, y `t3 auth owner-reset` sigue cubriendo la passkey perdida: un env var como vía de rescate no aporta nada.
- **Base de URLs:** `T3CODE_PUBLIC_URL` si está; si no, el origen de la petición (LAN, Tailscale, dev). El modal muestra las tres URLs que hay que copiar a Keycloak: `<base>/oauth/keycloak/callback` (redirect), `<base>/oauth/keycloak/backchannel-logout` y `<base>/sign-in` (post-logout). En dev, Vite ya hace proxy de `/oauth` y `/api`.

### Modelo (migraciones siguientes a la última libre)

- `sign_in_settings` (una fila): `registration_mode` (`open` | `invitation-only` | `closed`, por defecto `invitation-only`, que es lo que hay hoy), `local_sign_in_for_members` (por defecto sí), `keycloak_enabled`, `keycloak_issuer`, `keycloak_client_id`, `keycloak_groups_claim` (por defecto `groups`), `strong_acr` y `strong_amr` (listas), fechas y editor.
- `keycloak_group_mappings`: `group`, `space_id` (Organization, `ON DELETE CASCADE`), `role`. Una fila por pareja grupo–Organization.
- `user_identities`: `user_id` (único), `issuer`, `subject`, únicos juntos; `username` y `email` como etiquetas que se actualizan en cada inicio de sesión; `linked_at`. La identidad es `iss` + `sub`, nunca el correo.
- `identity_logins`: un inicio de sesión de Keycloak. `login_id`, `user_id`, `sid` de Keycloak, refresh token sellado, `strong`, `offline`, `created_at`, `checked_at`, `ended_at`. El refresh token se sella como hoy los secretos TOTP (AES-256-GCM bajo una clave del almacén cifrado, `SecretCipher`), con el `login_id` como dato autenticado.
- `auth_sessions.identity_login_id` y `auth_pairing_links.identity_login_id` (nulos): de qué inicio de sesión de Keycloak nace una sesión.
- `space_memberships.managed_by_keycloak` (booleano).
- `space_invitations.space_id` y `role` pasan a ser nulos juntos: una fila sin Space es una Platform invitation. Mismo token, misma caducidad (7 días), mismo uso único y revocación.
- Users creados por Keycloak: `login_name` nulo (no tienen contraseña); `display_name` sale de `name` y, si falta, de `preferred_username`, solo al crearlos.

### Módulos

- **`KeycloakClient`** (adaptador, el único que habla OIDC): descubrimiento (`/.well-known/openid-configuration`, con `issuer` idéntico al configurado), URL de autorización, intercambio de código, refresh, verificación de ID tokens y de logout tokens. Toda la rareza del protocolo queda aquí.
  - Verificación con `effect/jose` (Effect 4.1.2, el del catálogo): `Jwt.verifyWithKeySet` con `Jwks.layerRemote` (caché de 10 minutos, re-fetch ante `kid` desconocido). Algoritmos admitidos: RS256, PS256, ES256, EdDSA. Se comprueban `iss`, `aud` (el client id), `azp` si viene, `exp`/`iat` con tolerancia pequeña y `nonce`.
  - `Jwks.makeRemote` solo acepta HTTPS. El issuer debe ser HTTPS salvo en loopback (`http://localhost`, `127.0.0.1`) para desarrollo; ahí el Hub descarga el key set con su `HttpClient` y lo sirve con `Jwks.makeLocal`, volviendo a descargarlo ante un `kid` desconocido.
  - Autenticación del cliente en el token endpoint: `client_secret_basic`. PKCE S256 siempre, con `makePkce` de `apps/server/src/auth/pkceGrants.ts`.
  - Ámbitos pedidos: `openid profile email offline_access`. Con `offline_access` el refresh token dura lo que la sesión offline de Keycloak (30 días por defecto, como la sesión del Hub) y no caduca con el idle de la sesión SSO. Si Keycloak no lo concede, el login se guarda con `offline = false`, la sesión del Hub acaba cuando acabe la de Keycloak y el modal de Plataforma lo avisa.
- **`SignInSettings`**: lee y guarda `sign_in_settings` y los mapeos (Owner), escribe el client secret en el almacén cifrado sin devolverlo nunca, y ofrece `check` (descubrimiento + key set). Auditoría en la misma transacción.
- **`KeycloakAdmission`** (puro, sin I/O): `decide(input) → Outcome`. Entra el modo de registro, el estado de la identidad (desconocida, de un User activo, desactivado o quitado), la intención del flujo, la Invitation que trae (ninguna, de plataforma, de Organization, inválida), si algún grupo mapeado aplica, y si el resultado exige factor fuerte y el login lo es. Sale: crear User, entrar, vincular, unirse a la Organization, o rechazo con motivo. Es la tabla de abajo; una regla nueva es una fila.
- **`planGroupSync`** (puro): memberships actuales (Role, gestionada o manual), grupos del token y mapeos → cambios (añadir, cambiar Role, quitar, pasar a gestionada). Se aplica en `MembershipService` dentro de una transacción, con una entrada de auditoría por cambio (actor `system`, detalle `keycloakGroup`).
- **`KeycloakSignIn`**: los flujos. `start(intent, …)` guarda en memoria (con `makeGrantStore`, 10 minutos, 1 000 como máximo) el `state`, el `nonce`, el verificador PKCE, la intención y el `returnTo`, y ata el flujo al navegador con una cookie `__Host-` aleatoria de 10 minutos. `callback` comprueba `state` y cookie, intercambia el código, verifica el token, llama a `KeycloakAdmission`, aplica `planGroupSync`, crea el `identity_login` y emite la sesión de navegador. Un reinicio pierde los flujos pendientes; la persona vuelve a pulsar el botón.
- **`KeycloakLogins`**: re-comprobación con refresh token, back-channel logout y fin de un login (revoca sus sesiones con `SessionStore.revokeAll…` y la invalidación de sockets que ya existe).

### Intenciones del flujo

| Intención    | Quién la empieza                       | Qué pide a Keycloak                                        | Qué hace al volver                                                                                   |
| ------------ | -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sign-in`    | cualquiera, sin sesión                 | nada especial                                              | admisión; crea User si toca; sesión                                                                  |
| `invitation` | quien abre `/invite#token=…`           | nada especial                                              | admisión con esa Invitation; acepta (Organization o plataforma); sesión                              |
| `link`       | un User con sesión local, tras step-up | `prompt=login`                                             | vincula; borra credenciales locales (no al Owner); revoca todas sus sesiones; sesión nueva de Keycloak |
| `reset`      | quien abre un reset link               | `prompt=login`                                             | vincula (sustituye la identidad anterior); borra credenciales locales; revoca sesiones; sesión       |
| `step-up`    | un User con sesión de Keycloak         | `prompt=login`, `max_age=0`, `acr_values` si hay lista     | prueba de un solo uso, 5 minutos, atada a esa sesión, si el login es fuerte y es la misma identidad  |

- `returnTo` es una ruta relativa del mismo origen (empieza por una sola `/`); cualquier otra cosa vuelve a `/`. Así `/app-sign-in?…` y `/connect-agent?…` vuelven con sus parámetros y desktop, móvil y clientes MCP siguen igual.
- Si la respuesta trae `iss` (RFC 9207), debe ser el issuer configurado.
- Los fallos del callback cuentan para el back-off por cliente de `signInThrottle`.

### Admisión (`KeycloakAdmission`)

| Identidad                     | Abierto                         | Solo con invitación                                    | Cerrado                                  |
| ----------------------------- | ------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| De un User activo             | entra                           | entra                                                  | entra                                    |
| De un User desactivado/quitado | rechazo, como hoy (tras verificar) | igual                                               | igual                                    |
| Nueva, con Platform invitation | crea User                       | crea User                                              | crea User                                |
| Nueva, con Invitation de Organization | crea User y membership  | crea User y membership                                 | rechazo                                  |
| Nueva, con grupo mapeado      | crea User                       | crea User (el mapeo es una invitación permanente)      | rechazo                                  |
| Nueva, sin nada               | crea User                       | rechazo «solo con invitación»                          | rechazo «registro cerrado»               |

- Un User que ya existe y abre una Platform invitation: «ya tienes cuenta»; la Invitation sigue sin usar. Con una Invitation de Organization, se une como hoy hace `/api/invitations/join` (con sus mismas negativas).
- La creación del User, el gasto de la Invitation (`UPDATE` condicional, como hoy), las memberships del mapeo, la identidad, el login y la sesión van en una transacción. Una negativa dentro deja la Invitation sin gastar.
- Con el modo abierto, un User nuevo sin grupo ni Invitation queda sin Organizations; su Personal space depende del ticket 17 de identity-and-access.

### Grupos → memberships (`planGroupSync`)

- Se leen del ID token, en el claim que diga el Owner (por defecto `groups`). Un grupo casa si es igual al del mapeo o igual quitándole la `/` inicial (Keycloak manda la ruta completa si así está el mapper). Un claim ausente cuenta como lista vacía, porque Keycloak lo omite cuando no hay grupos.
- Por cada Organization con mapeos, el Role deseado es el mayor de los grupos que casan (Admin > Member > Guest):
  - sin Role deseado: una membership gestionada se quita; una manual no se toca;
  - con Role deseado: se crea gestionada si no había; una gestionada cambia de Role si hace falta; una manual pasa a gestionada con ese Role (donde hay grupo, manda Keycloak).
- Organizations archivadas: no se tocan.
- Se aplica en cada inicio de sesión y en cada re-comprobación (el refresh devuelve un ID token nuevo). Así salir del grupo en Keycloak saca de la Organization en menos de una hora, no en 30 días.
- **AccessPolicy**: `MembershipResource` gana `managedByKeycloak`. Cambiar el Role de una membership gestionada, quitarla o salir de ella es Deny para todos, también el Owner (que cambia el mapeo o el grupo). Las memberships gestionadas se muestran con «Gestionada por Keycloak (grupo X)».

### Factor fuerte

- Un login es fuerte si su `acr` está en `strong_acr` o algún valor de `amr` está en `strong_amr`. Se guarda en `identity_logins.strong`. Sin listas, ningún login de Keycloak es fuerte.
- `passwordRequiresTotp` (`apps/server/src/auth/UserDirectory.ts`) se generaliza a `requiresStrongSignIn(user)`: Owner o Admin de alguna Organization. Lo consultan tanto el inicio de sesión local como el de Keycloak.
- Inicio de sesión de Keycloak de quien lo requiere (después de aplicar el mapeo) con un login no fuerte: rechazo «Tu Role necesita un segundo factor en Keycloak», con el botón «Reintentar con segundo factor» que repite el flujo con `acr_values` (los valores de `strong_acr`) y `prompt=login`. Las memberships que cambió el mapeo se quedan: reflejan lo que dice Keycloak.
- Ascender a Admin a un User de Keycloak (en el Hub o por el mapeo en una re-comprobación) termina sus logins no fuertes, como hoy `onPromotedToAdmin` revoca las sesiones que pudieron salir de una contraseña sola.
- Por esa regla, toda sesión viva de un Admin de Keycloak es fuerte. `hasStrongSignIn` y la consulta de `strongSignIn` de `SpaceDirectory` cuentan una identidad de Keycloak como factor fuerte, y `pendingAdmin` sigue siendo cosa de Users locales.
- **Step-up:** `AuthReauth` (`packages/contracts/src/userAccounts.ts`) gana `{ method: "keycloak", proofId }`. `confirmStrongFactor` y `requireStepUp` la aceptan para un User con identidad. Hoy `requireStepUp` deja pasar a quien no tiene credenciales locales; con Keycloak eso abriría cada acción protegida, así que un User con identidad y sin credenciales locales necesita siempre la prueba de Keycloak.
- Lo que hoy pide step-up a quien no es el Owner es aprobar el alta de una máquina (`EnvironmentJoin`, página `/register-environment`, que ya vuelve con su id en la URL). El Owner sigue usando su passkey.
- La regla local (passkey o contraseña con TOTP en el Hub) queda solo para Users locales. Un User de Keycloak no puede registrar credenciales locales (`setPassword`, TOTP, passkey se rechazan) salvo el Owner.

### Vincular, reset y el inicio de sesión local

- «Conectar con Keycloak» pide antes la misma prueba que un cambio de credenciales (`requireStepUp`), porque añade una forma de entrar. Una identidad que ya es de otro User se rechaza.
- Al vincular, en una transacción: identidad, borrado de passkeys, contraseña, TOTP y enlaces de pairing sin gastar (el Owner conserva todo lo suyo), revocación de todas sus sesiones y sesión nueva nacida del login de Keycloak. Auditoría `user.identity.link`.
- No hay «desvincular» para el propio User: ADR 0009 lo quiere de un solo sentido. La salida es del Owner: un reset link (`UserDirectory.issueResetLink`) ofrece, con Keycloak activo, entrar por Keycloak y vincular esa identidad, que sustituye a la anterior; con el inicio de sesión local permitido, ofrece además passkey o contraseña como hoy. Canjearlo sustituye todas las formas de entrar y cierra todas las sesiones, como hoy.
- **`local_sign_in_for_members` apagado:**
  - passkey, contraseña, TOTP y la aceptación de Invitations con credenciales nuevas se rechazan para quien no es el Owner, después de verificar la credencial (como hoy con una cuenta desactivada, para no ser oráculo);
  - al apagarlo, se revocan las sesiones de quien no es el Owner que nacieron de un inicio de sesión local (sin `identity_login_id`); las emitidas desde la shell del Hub (`t3 auth session issue --user`, `t3 pair`) no;
  - el modal avisa antes cuántos Users aún no tienen Keycloak; su vuelta es un reset link.
  - No se puede apagar sin Keycloak activo.
- **Desactivar Keycloak:** conserva configuración, identidades y mapeos; vuelve a encender el inicio de sesión local; termina todos los logins de Keycloak (sin re-comprobación no se pueden mantener). El modal avisa cuántas sesiones cierra.
- **Cambiar el issuer** con identidades guardadas pide confirmación: las identidades del issuer anterior dejan de casar y esas personas necesitan un reset link (o, en modo abierto, recibirían un User nuevo vacío).

### Bajas

- **Re-comprobación:** cuando se usa una sesión que nace de un login (petición HTTP verificada o la renovación de un socket abierto en `SessionStore`) y `checked_at` tiene más de una hora, `KeycloakLogins` lanza en segundo plano, sin retrasar la petición, un refresh con el refresh token de ese login. Uno a la vez por login (Keycloak puede rotar el refresh token y detectar reutilización); el nuevo se guarda antes de soltar el turno.
  - `invalid_grant` (User deshabilitado o borrado, sesión revocada o caducada): el login termina y sus sesiones se revocan.
  - Error de red o 5xx: las sesiones siguen (decisión: disponibilidad por encima de una ventana corta; ver preguntas abiertas). El modal de Plataforma muestra «Keycloak no responde desde …».
  - Éxito: nuevo `checked_at` y `planGroupSync` con el ID token nuevo.
- **Back-channel logout** (`POST /oauth/keycloak/backchannel-logout`, formulario con `logout_token`, sin cookies): se verifica como un ID token, más `events` con `http://schemas.openid.net/event/backchannel-logout`, sin `nonce`, `iat` reciente y `jti` no visto (caché en memoria acotada). Con `sid`: termina los logins con ese `sid`. Solo con `sub`: todos los logins de esa identidad. Responde 200, o 400 si el token no vale. Si Keycloak no llega al Hub (Hub solo en Tailscale o LAN), la re-comprobación cubre la baja en menos de una hora.
- **Sesiones derivadas:** la aprobación de app sign-in (`AppSignIn.approve`), la de un cliente MCP (`McpOAuth`) y un enlace de pairing creado desde una sesión de Keycloak heredan su `identity_login_id`; al terminar el login terminan también. Por eso «Salir también de Keycloak» cierra también las apps aprobadas desde ese navegador, y la página lo dice.
- **Cerrar sesión:** `POST /api/auth/sign-out` sigue cerrando solo la sesión del Hub. Si la sesión nace de Keycloak, la página de salida ofrece «Salir también de Keycloak», que lleva al `end_session_endpoint` con `id_token_hint` y vuelve a `/sign-in`.
- Una baja en Keycloak no desactiva al User en el Hub: sus tareas programadas y turnos en marcha los para el Owner desactivándolo, como hoy (ver preguntas abiertas).

### Puertas y contratos

- **Contracts** (`packages/contracts`):
  - `SignInSettings` (sin el secret; `clientSecretSet: boolean`) y su petición de cambio (con `clientSecret` opcional, solo de escritura), `KeycloakGroupMapping`, `RegistrationMode`;
  - variante `keycloak` de `AuthReauth`;
  - en `/api/auth/session`, qué ofrece la página de inicio de sesión (`keycloak`, `localForMembers`);
  - en la cuenta (`AuthAccount`), la identidad vinculada (usuario, correo, URL de la cuenta de Keycloak);
  - Platform invitations en `Invitation` y en la vista previa (`kind: "platform"`);
  - acciones de auditoría nuevas en `audit.ts`: `signIn.settings.update`, `user.identity.link`, `user.register` (User creado sin Invitation), `invitation.*` ya existentes para las de plataforma, `membership.*` ya existentes con detalle `keycloakGroup`.
- **HttpApi** (`HTTP_ENDPOINT_RULES`): `POST /api/auth/keycloak/start` (sin sesión para `sign-in`, `invitation` y `reset`; con sesión de navegador para `link` y `step-up`), `GET/POST /api/installation/sign-in-settings` y `POST /api/installation/sign-in-settings/check` (Owner), `GET/POST /api/installation/invitations` (Owner; revocar por el `/api/invitations/revoke` de siempre).
- **Raw routes** (`RAW_ROUTE_RULES`): `GET /oauth/keycloak/callback` (redirección; pone la cookie de sesión) y `POST /oauth/keycloak/backchannel-logout`.
- **Cookies** (`AMBIENT_COOKIE_RULES`): la cookie `__Host-` del flujo, solo leída por el callback.
- **WS y MCP:** nada nuevo. La configuración de inicio de sesión y las Platform invitations son del Owner y por HTTP, como hoy las Invitations; un agente no las alcanza.
- Ningún endpoint devuelve el client secret, un refresh token, un ID token ni el código de autorización; ninguno aparece en logs, spans ni argumentos de proceso.

### Clientes

- **Web:** botón en `SignInSurface` (también dentro de `AppSignInSurface` y `ConnectAgentSurface`, que lo usan), página `/invite` con «Entrar con Keycloak para aceptar», reset con Keycloak, cuenta con «Conectar con Keycloak» o la identidad vinculada, sección «Inicio de sesión» del Owner (configuración, mapeos, modo de registro, inicio local, Platform invitations, estado de Keycloak), badge «Gestionada por Keycloak» en la lista de miembros.
- Con Keycloak activo y el inicio local apagado, el formulario local queda plegado bajo «Acceso del Owner»: sigue ahí para el break-glass.
- **Desktop:** sin código nuevo; su inicio de sesión ya pasa por `/app-sign-in` en el navegador del sistema.
- **Móvil:** sin código nuevo para entrar (`WebBrowser.openAuthSessionAsync`, donde Google y GitHub aceptan el broker de Keycloak). La pantalla de cuenta muestra la identidad vinculada o, si no la hay, «Conectar con Keycloak», que abre la página de cuenta del Hub en el navegador del sistema.
- **Paleta de comandos y atajos:** las secciones nuevas se alcanzan por donde se alcanza su modal o pantalla; no hay comandos sueltos.

## Testing Decisions

- Un buen test mira solo comportamiento externo: una identidad llega al callback y sale una sesión, un rechazo o un User nuevo; un token de logout llega y una sesión deja de servir. Nada de tests de cableado, textos ni tipos.
- **Seam 1, `KeycloakAdmission`:** una suite por tabla con todas las filas de la tabla de admisión, las intenciones (`link` con identidad ajena, `reset`, `step-up` con otra identidad o login no fuerte) y la regla de factor fuerte. Una regla nueva es una fila.
- **Seam 2, `planGroupSync`:** tabla con memberships manuales y gestionadas, grupos con y sin `/`, varios grupos para una Organization, Organization archivada, claim ausente.
- **Seam 3, frontera del servidor:** HttpApi y raw routes reales sobre SQLite en memoria (`UserAuth.testkit.ts`), con un Keycloak falso en proceso (`Keycloak.testkit.ts`): documento de descubrimiento, token endpoint (código, refresh, `invalid_grant`), key set con `Jwks.layerLocal` y tokens firmados con `Jwt.sign`. Cubre: inicio de sesión de punta a punta, `state`/cookie/`nonce`/PKCE/`iss` incorrectos, Invitation de plataforma y de Organization, vincular (con y sin step-up, credenciales borradas, Owner conserva las suyas), reset que vincula, inicio local apagado, re-comprobación (`invalid_grant` revoca y cierra el socket; error de red no), back-channel logout por `sid` y por `sub` (y repetición de `jti`), sesiones derivadas que caen con su login, auditoría de cada acción.
- No se repiten en el Seam 3 los casos de los Seams 1 y 2: allí se prueba que se consultan en cada camino.
- `AccessPolicy`: filas nuevas en su suite para memberships gestionadas.
- `DoorRules.test.ts`: el inventario falla si falta alguna puerta nueva.
- Reglas del repo: nada de sleeps, polling ni timeouts. `TestClock` para la caducidad del flujo (10 min), de la prueba de step-up (5 min), de la Invitation (7 días) y para la hora entre re-comprobaciones; la re-comprobación en segundo plano se espera por su `Deferred` o por el evento de revocación, no por tiempo.
- Prior art: `AppSignIn.test.ts`, `McpOAuth.test.ts`, `Invitations.test.ts`, `Memberships.test.ts`, `UserSessions.test.ts`, `PublicHub.test.ts`.
- Una prueba real única al final (ticket 11) contra un Keycloak de verdad en un contenedor, con web, desktop y móvil.

## Out of Scope

- Lo que hace Keycloak: registro, Google, GitHub, verificación de correo, recuperación de contraseña, captcha, MFA y su política. El Hub no envía correos.
- Otros proveedores OIDC o varios realms a la vez. El adaptador habla OIDC estándar, pero solo se prueba contra Keycloak.
- Aprovisionar desde Keycloak (SCIM, API de administración) Users que nunca han entrado, o reflejar en el Hub un User deshabilitado en Keycloak sin que haya sesión que re-comprobar.
- Planes, plan por defecto y límites para Users nuevos: `../plans-and-limits/`. Términos de uso y abrir el registro de verdad: `../platform-privacy/`.
- El modal de Plataforma y el de Usuario como tales: `../settings-modals/`. Este spec pone sus secciones donde estén cuando se construya.
- Cambiar los Roles o la tabla de `AccessPolicy` más allá de las memberships gestionadas.

## Further Notes

- AGENTS.md «Hit every surface»: entradas (página de inicio de sesión, `/app-sign-in`, `/connect-agent`, `/invite`, `/reset`, cuenta, Plataforma), clientes (web, desktop, móvil), providers (no aplica), agentes (nada nuevo por MCP, decidido arriba), contratos, estados inversos (activar/desactivar Keycloak, crear/revocar Platform invitation, vincular y su salida por reset link, inicio local encendido/apagado, mapeo añadido/quitado), modos de conexión (redirect con o sin `T3CODE_PUBLIC_URL`; back-channel inalcanzable en Tailscale o LAN) y docs.
- `docs/user/` se reescribe, no se amplía: el apartado de cuentas de `install.md`, el de inicio de sesión de `remote-access.md` y un apartado de Keycloak en `public-hub.md`. `docs/internals/environment-auth.md` reescribe «User accounts», «Sign-in rules», «Invitations» y «App sign-in» donde cambian, y añade lo que no se ve en el código: por qué `offline_access`, por qué el refresh es en segundo plano y falla abierto, y la herencia de `identity_login_id`.
- El modo abierto funciona desde este spec, pero Bezenti no debería activarlo hasta el último ticket de `../platform-privacy/` (términos de uso). El modal lo avisa al elegirlo.
- `GLOSSARY.md` ya debería tener Registration mode y Platform invitation (los añade el mapa); si no, el ticket de docs los añade en inglés.

## Preguntas abiertas

1. **¿Admite un grupo mapeado en el modo «solo con invitación»?** Recomendado: sí; es una invitación permanente que el Owner configuró a propósito. En «cerrado», no.
2. **Una membership manual de una Organization con grupo mapeado que casa, ¿pasa a ser gestionada?** Recomendado: sí (donde hay grupo, manda Keycloak). La alternativa, no tocar nunca las manuales, deja a alguien como Admin manual aunque salga del grupo de Admins.
3. **Keycloak caído durante la re-comprobación:** recomendado fallar abierto sin límite y avisar en el modal. La alternativa es cerrar las sesiones tras N horas sin poder comprobar, lo que deja a todos menos al Owner fuera durante una caída larga.
4. **`offline_access`:** recomendado pedirlo y avisar si no se concede. La alternativa es alinear la sesión SSO de Keycloak a 30 días y re-comprobar más a menudo que su idle.
5. **Segundo factor local para Users de Keycloak:** el mapa dice «si no, vale la regla local (passkey o TOTP en el Hub)». Leído como «para los Users locales». La otra lectura (un User de Keycloak registra passkey o TOTP en el Hub como segundo paso) devuelve credenciales locales que una baja en Keycloak no corta; no se recomienda.
6. **¿Reflejar en el Hub una cuenta deshabilitada en Keycloak** (parar turnos y tareas programadas) consultando la API de administración de Keycloak con una cuenta de servicio? Recomendado: no en esta fase; el Owner desactiva en el Hub.
7. **Modo por defecto en una Installation nueva:** recomendado «solo con invitación», que es el comportamiento actual.
