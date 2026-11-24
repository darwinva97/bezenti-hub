# 07: Uso y actividad de Makita

**What to build:** Cada petición de un Thread de Makita queda con su configuración en `ai_usage` y `ai_usage_daily`. Usage muestra «Makita: <name>» junto a Users y access keys. La vista de actividad de cada configuración muestra lo que hace ahora, las tareas recientes, el uso de hoy, la semana y el mes por repositorio, por tarea y por caller, y los eventos ignorados con su motivo. Ver spec, «Uso» y «Clientes».

**Blocked by:** 05 (06 en paralelo).

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 1

**Seguridad:** sensible (uso de AI, migración que reconstruye `ai_usage_daily`). Nota de diseño `07-design.md` antes de construir.

Spec: ../spec.md

- [ ] Migración: `ai_usage.makita_config_id`; `ai_usage_daily` reconstruida con `makita_config_id` en la clave primaria e índice parcial (como la 160), test con golden.
- [ ] `AiUsage`: escribir `makita_config_id` desde `GatewayCaller`; sujeto «Makita: <name>» en `summary` con las reglas de visibilidad de la spec.
- [ ] `makita.activity {configId|spaceId}`: «Now» (con lo no escrito de `AiGatewayActivity`), recientes, hoy/semana/mes de `ai_usage_daily`, por repositorio/tarea/caller de `ai_usage` (90 días), eventos ignorados.
- [ ] Web: «Makita activity» desde Space settings → Makita; el sujeto en `AiUsageSettings.tsx`; uso de hoy en cada fila de la lista.
- [ ] Red-first: los tokens de un Thread de Makita cuentan en su configuración y en el creador; un Member que no ve el uso del Space no ve el de una configuración ajena; otro Space no ve nada.
