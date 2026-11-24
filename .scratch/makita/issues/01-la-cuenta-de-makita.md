# 01: La cuenta de Makita y el interruptor global

**What to build:** El Owner registra en Platform → Makita la cuenta de GitHub del bot pegando su token una vez. El Hub lo comprueba (`GET /user`, tipo `User`, scopes), lo guarda cifrado y muestra login, tipo de token, scopes, caducidad y estado. Rechaza un token con `workflow`, `delete_repo` o `admin:*`. «Stop all Makita work» queda guardado (aún no hay trabajo que parar: el ticket 06 le da efecto). Ver spec, «La cuenta de Makita», «Puertas» y «Auditoría».

**Blocked by:** nada.

**Status:** done (design: `01-design.md`)

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (credenciales). Nota de diseño `01-design.md` antes de construir (`bezenti/AGENTS.md`).

Spec: ../spec.md

- [x] Migración `makita_account` (número al integrar; hoy la siguiente libre es la 163) con test.
- [x] `ServerSecretStore`: almacén `MakitaTokenStore`; el token solo se escribe y se reemplaza; en la base, la pista de 4 caracteres.
- [x] `makita/MakitaGitHub.ts`: cliente propio con la credencial de Makita pasada explícitamente (URLs y regla de límites de `source-control-github`; no la política de `GitHubRest.ts`, que inyecta la credencial de Source Control y la invalida en un 401: ver `01-design.md`); nunca registrada en `GitHubCredentials` ni en Settings → Source Control.
- [x] Comprobación al guardar: `GET /user` (200, `type: "User"`), `X-OAuth-Scopes` (classic), `github-authentication-token-expiration`; rechazo de `workflow`, `delete_repo`, `admin:*` con el mensaje de la spec.
- [x] `AccessPolicy`: `makita.manageAccount` en `OWNER_ONLY`, con su fila en `AccessPolicy.test.ts`.
- [x] WS `makita.account.get|set|pauseAll|resumeAll` (solo la sesión del Owner; agente, shell y sesión limitada: `forbidden`), en `RPC_SPACE_ACCESS`, `RpcAuthorization` y `clientRpcPermissions`.
- [x] Auditoría `makita.account.update`, `makita.pause_all`, `makita.resume_all` (allow-list en `audit.ts`), nunca el token.
- [x] Web: Platform → Makita, sección de la cuenta (formulario con la explicación de scopes de la spec, «Replace token», estado, avisos de token inválido y caducidad en menos de 14 días) y el interruptor global.
- [x] Red-first: un Admin, un Member y un agente no leen ni cambian la cuenta; el token no está en la base, logs, spans, auditoría ni respuestas; un token con `workflow` se rechaza; un 401 de GitHub pone `status = token-invalid`.
- [x] `DoorRules`: `makita_account` solo la escribe `apps/server/src/makita/`.
