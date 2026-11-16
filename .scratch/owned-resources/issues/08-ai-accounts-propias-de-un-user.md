# 08: AI accounts propias de un User

**What to build:** Cualquier User registra AI accounts suyas (API key, suscripción, credencial directa) en Settings → AI accounts, las ordena, renombra, deshabilita, sustituye y borra. Solo se usan en su Personal space y nadie más las ve, salvo el Owner, que ve nombre, proveedor, dueño y estado. Las cuentas existentes pasan a ser del Owner con sus allowances. `AllowedAiAccounts` pone primero las del dueño del Space y luego las permitidas por el Owner. Ver spec, «AI accounts».

**Blocked by:** `../../identity-and-access/issues/17-personal-space-siempre-disponible.md`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `ai_accounts.owner_kind`/`owner_id` (las existentes, del Owner), nombre único por dueño, prioridad comparada por dueño.
- [ ] Red-first en `AccessPolicy.test.ts`: `aiAccount.manage` sobre el dueño (Ana crea y gestiona las suyas; nadie más las gestiona; el Owner no edita las de Ana); `aiAccount.allow` solo el Owner y solo sobre cuentas suyas.
- [ ] Red-first en `AiGatewayRoute.test.ts`: una petición de un Thread de Ana en Acme no usa la cuenta de Ana (rechazo de cuenta no permitida); en su Personal space sí; el failover de mismo proveedor sigue el orden «dueño del Space, luego permitidas».
- [ ] `aiAccounts.create|update|delete|reorder|login.*|import*` pasan a `access:write` en `clientRpcPermissions.ts`; `RpcAuthorization.test.ts` con una sesión estándar de un User.
- [ ] Suscripción de un User: el inicio de sesión de `subscriptionLogin.ts` funciona para él; el aviso de ToS no habla de compartir cuando el dueño es un User.
- [ ] `aiAccounts.list` devuelve a cada User las suyas más las que puede usar; el selector del composer y el defecto de un Thread nuevo usan la regla.
- [ ] Web y desktop: sección «Mine» en `AiAccountsSettings.tsx` para todo User; allowances solo en cuentas del Owner. Móvil (`apps/mobile/src/features/ai-accounts/`): las propias en solo lectura; `noOwnerControls.test.ts` sigue verde.
- [ ] Auditoría `ai_account.*` con el dueño.
- [ ] Docs: `docs/internals/ai-gateway.md` («AI accounts», «The AI account of a Thread»); `docs/user/install.md` («The AI gateway») explica cómo añadir tu propia cuenta.
- [ ] Prueba real: un Member añade una API key `openai-compatible` contra un servidor falso, su Thread personal la usa por la gateway y Settings → Usage la cuenta; su Thread de Acme no la ve en el selector.
