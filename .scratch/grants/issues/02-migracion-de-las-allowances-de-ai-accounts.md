# 02: Las allowances de AI accounts pasan a Grants

Spec: ../spec.md

**What to build:** Al actualizar, cada fila de `ai_account_allowances` se convierte en un Grant `active` del Owner, sin tope. Después la tabla se borra, junto con `aiAccounts.allow`, su UI y su puerta. Las allowances «a un User» pasan a su Personal space. Lo que se estrecha queda en una lista que el Owner revisa en Plataforma, con «Prestar a <Organization>» en un clic. Ver spec, «Migración de las allowances» y pregunta abierta 1.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Migración con su test (patrón de `118_AiAccountReachLoss.test.ts`):
  - [ ] Allowance al Personal space del Owner → nada.
  - [ ] Allowance a un Space → Grant a ese Space.
  - [ ] Allowance a un User → Grant a su Personal space.
  - [ ] Filas de Spaces o Users que ya no existen → descartadas.
  - [ ] Auditoría `grant.give` con vía `migration`.
- [ ] Red-first: tras migrar, `AllowedAiAccounts` responde lo mismo que antes para cada (User, Space) salvo los casos «a un User» fuera del Personal space, que aparecen en la lista de revisión.
- [ ] Lista de revisión: (cuenta, User, Organizations donde ese User la usó en los últimos 90 días según `ai_usage`).
  - [ ] Visible solo para el Owner.
  - [ ] «Prestar a <Organization>» crea el Grant; si el Owner es Admin o Steward de esa Organization, nace activo.
  - [ ] «Descartar» quita la fila.
- [ ] Se borran `ai_account_allowances`, `aiAccounts.allow` (contrato, ws, `RPC_SPACE_ACCESS`), `AiAccountReachLoss.dropAllowances` y la UI de allowances. `ai_account.allow` queda solo para leer el historial.
- [ ] `docs/internals/ai-gateway.md`: la regla de cuentas permitidas se reescribe con Grants.
