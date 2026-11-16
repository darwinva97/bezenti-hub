# 09: AI accounts de una Organization

**What to build:** Los Admins de una Organization registran AI accounts de ella y las gestionan como un User las suyas. Las usa quien trabaja en esa Organization (misma regla que crear un Thread allí). Ver spec, «AI accounts».

**Blocked by:** 08.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en `AccessPolicy.test.ts`: crear y gestionar una cuenta de Acme lo hacen sus Admins y el Owner; un Member de Acme y un Admin de Globex, no; una Organization archivada no admite cambios.
- [ ] Red-first en `AiGatewayRoute.test.ts`: un Thread de Acme usa la cuenta de Acme; uno de Globex y uno del Personal space de un Member de Acme, no.
- [ ] Quitar a alguien de Acme: la siguiente petición de sus Threads de Acme ya no puede usar las cuentas de Acme (`AiAccountReachLoss.ts`).
- [ ] Web y desktop: una sección por Organization administrada en `AiAccountsSettings.tsx`; Members ven nombre, proveedor y estado de las de su Organization. Móvil: igual, en solo lectura.
- [ ] Docs: `docs/user/install.md` (las organizations tienen sus propias AI accounts) y `docs/internals/ai-gateway.md` (fila de la regla), sin apartados nuevos.
