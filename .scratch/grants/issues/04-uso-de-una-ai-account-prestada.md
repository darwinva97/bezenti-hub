# 04: Uso de una AI account prestada, para quien presta y para quien la usa

Spec: ../spec.md

**What to build:** El prestador ve, por cada Grant, tokens, peticiones y peticiones sin tokens, por Space y User prestatario, día y modelo. Nunca ve Threads ni prompts. El prestatario ve lo suyo, y el Admin, lo de su Space, como hoy. Retoma el análisis de `../../ai-accounts-and-gateway/issues/16-el-uso-de-ia-no-se-ve.md`. Ver spec, «AI accounts prestadas» (Vistas).

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] `aiUsage.summary` gana el filtro y la dimensión `grantId` (contrato `packages/contracts/src/aiUsage.ts`).
- [ ] Visibilidad en `AiUsage.summary`: quien tiene `grant.viewGiven` ve las filas de sus Grants, por Space y User prestatario, sin `threadId`.
  - [ ] Red-first: el prestador no ve el uso propio del Space prestatario con otras cuentas, ni ningún Thread.
  - [ ] Red-first: un Member del prestatario no ve el uso de otro Member.
  - [ ] Red-first: el Owner ve consumo de Spaces ajenos y ningún Thread ajeno.
- [ ] «Préstamos dados» muestra el uso de cada Grant con un desglose; «Prestado a este Space», el del Space (Admin) o el propio (Member).
- [ ] La vista dice qué no puede contar en vez de mostrar cero: peticiones con tokens desconocidos, y nota de que fuera de la gateway no hay atribución.
- [ ] Prueba real: dos Users de Acme usan la cuenta de Ana, y Ana los ve separados sin títulos de Thread.
