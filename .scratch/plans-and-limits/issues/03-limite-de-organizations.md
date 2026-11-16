# 03: Límite de Organizations

**What to build:** Un User solo puede ser Steward de tantas Organizations no archivadas como diga su Plan. Se aplica al crear una (el **Create organization** del ticket 18 de identity-and-access, para cualquier User), al restaurar una archivada y al aceptar ser Steward. Bajar el límite no archiva ni quita ninguna. Ver spec, «Límites».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `PlanLimits.check("organizations", userId)` en `SpaceDirectory` (crear y restaurar) y en aceptar una oferta de Steward. Las archivadas no cuentan.
- [ ] Red-first: con `max_organizations = 1` y una Organization, crear otra devuelve `PlanLimitReachedError`; archivarla deja crear; restaurarla con otra ya creada falla; aceptar ser Steward de una tercera falla; con 0, ninguna.
- [ ] El método de servicio es el mismo para clientes y para un agente (si existe herramienta MCP de crear Organization): mismo error.
- [ ] Web/desktop: **Create organization** sigue visible; al fallar muestra el límite y «Change plan» si el User puede (enlace al modal Usuario → «Plan»). El modal Usuario → «Plan» muestra «Organizations 1 of 1».
- [ ] El Owner ve en Plataforma → Users cuántas Organizations sostiene cada User.
- [ ] Docs: la fila de Organizations en «Plans and limits» de `docs/user/install.md`.
