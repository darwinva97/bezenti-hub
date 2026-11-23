# 01: Emitir, usar y revocar una clave de acceso

**What to build:** Quien gestiona un Space crea en Space settings → AI accounts → «Access keys» una clave con una etiqueta y una validez, la ve una sola vez con «Copy setup» para Claude Code, Codex y otros clientes, y la revoca. Quien la recibe, sin cuenta en el Hub, la usa en `/api/ai/*` contra todas las AI accounts propias del Space, con cualquier modelo que sirvan, hasta que caduca o se revoca. Su uso queda en `ai_usage` sin User. Ver spec, «Qué es una access key», «Quién hace qué», «Validez», «`authorize`», «Lo que recibe el cliente» (filas de clave desconocida, caducada y Space archivado) y «Clientes».

**Blocked by:** nada (spec 4 tickets 04, 05, 10 y 16 hechos).

**Status:** ready-for-agent

**Tipo:** AFK

Spec: ../spec.md

- [ ] Migración `ai_access_keys` (número al integrar) con test. `ai_usage.access_key_id` (NULL salvo access keys).
- [ ] Contracts: `ACCESS_KEY_PREFIX = "t3ak_"`, `AccessKey` (lo que ve quien la gestiona: nunca la clave ni su hash), `AccessKeyCreateInput` (`spaceId`, `label`, `validity`: `{ days }` o `{ until }`), `AccessKeyCreateResult` (la clave Redacted, una vez), `AccessKeyError`. En esta versión `models: ["*"]`, `accounts: null` y sin topes («No token limit» implícito, que el ticket 05 hará explícito).
- [ ] `AccessPolicy`: `accessKey.manage` y `accessKey.view` con la tabla de la spec (Organization abierta: Admins y Owner; Personal space: su User; el Owner ve y revoca en todos). Tabla probada en `AccessPolicy.test.ts`.
- [ ] `ai/AccessKeys.ts`: `create`, `list`, `revoke` y sus gemelas `*ForSession` (solo la sesión de una persona: nunca un agente, el shell ni una sesión limitada a un Space). Crear: la comprobación del Space y el insert en una transacción de escritura; 50 vivas por Space.
- [ ] `AllowedAiAccounts.forSpace(spaceId)`: las cuentas propias del Space, sin condición de User; solo de gateway.
- [ ] `AiGatewayKeys.authorize`: con `t3ak_`, lee `ai_access_keys` y su Space; revocada o desconocida → 401; caducada → 403 con la fecha UTC; Space archivado, congelado o de un User deshabilitado → 403; sin cuentas → 403; `GatewayCaller` con `kind: "access"`, `userId: null`, `accessKeyId`. `last_used_at` como mucho una vez por minuto. `isGatewayKeyShaped` acepta los dos prefijos.
- [ ] `AiGatewayProxy` y `AiGatewayActivity`: sujeto de colas `ak:<id>`; 4 peticiones en curso por access key; `GatewayRequestRecord.accessKeyId`, `userId: null`. `AiUsage` escribe `user_id = ''` y `access_key_id`.
- [ ] Auditoría `access_key.create` y `access_key.revoke` (allow-list de detalle en `audit.ts`).
- [ ] WS `accessKeys.list|create|revoke` en `RPC_SPACE_ACCESS` y `clientRpcPermissions`.
- [ ] `@t3tools/shared/aiGatewayAccessKey`: setup de Claude Code, Codex y «Other clients» (con marcador cuando no hay clave), con su test.
- [ ] Web: `AccessKeysSettings` en Space settings → AI accounts: crear (etiqueta, validez en días o fecha), diálogo «solo una vez» con «Copy setup», lista (etiqueta, pista `…abcd`, creada por, caducidad, último uso), «Revoke»; aviso de ToS si el Space tiene alguna suscripción; aviso si el Hub es `http:` fuera de loopback.
- [ ] Red-first (`AiGatewayRoute.testkit.ts`, CLIProxyAPI falso):
  - [ ] una clave de Acme responde en las formas Anthropic, OpenAI y Gemini con una cuenta propia de Acme, y nunca llega a una cuenta de Globex ni a una prestada a Acme;
  - [ ] revocada → 401 en la siguiente petición; una en curso termina;
  - [ ] caducada (`TestClock`) → 403 con el mensaje y la fecha, y la que se admitió antes termina;
  - [ ] Organization archivada → 403; restaurada → vuelve a funcionar;
  - [ ] un Member, un Guest, un agente (MCP) y una sesión limitada a un Space no crean, listan ni revocan; otro Admin de Acme sí; el Owner revoca una de un Personal space ajeno pero no la crea;
  - [ ] la clave no está en la base (solo su hash) ni en logs ni en la auditoría; la respuesta de `create` es la única que la lleva;
  - [ ] el uso queda en `ai_usage` con `user_id = ''` y la clave.
- [ ] `DoorRules`: descripción de `/api/ai/*` ampliada; `ai_access_keys` solo la escribe `AccessKeys.ts`.
- [ ] Docs: `docs/internals/ai-gateway.md`, sección «Access keys» (lo de este ticket); `GLOSSARY.md`, «Access key».
- [ ] Prueba real: un Admin de Acme crea una clave en el Hub de desarrollo en WSL; Claude Code, configurado solo con el setup copiado en un `HOME` de prueba, hace una pregunta; la clave revocada da 401.
