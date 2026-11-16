# 02: Los Spaces ajenos en Plataforma, sin contenido

**What to build:** El Owner tiene en el modal de Plataforma una lista de todos los Spaces de la Installation (Organizations y Personal spaces) con lo que necesita para operar: nombre, tipo, Steward, número de Members, número de Projects y Threads, fecha de creación, estado (activo, archivado, suspendido, congelado, borrado pendiente con fecha), tokens de IA de los últimos 30 días, disco y estado del Sandbox. En los Spaces ajenos no hay forma de pasar de ahí al contenido. En los propios, un enlace lleva al Space.

**Blocked by:** 01, `../settings-modals/` (modal de Plataforma), `../plans-and-limits/` (Steward y cuota de disco)

**Status:** ready-for-agent

Spec: ../spec.md («Operar frente a ver», «Lo que ve el Owner de un Space ajeno»)

- [ ] Hay un contrato `PlatformSpaceSummary` en `packages/contracts` sin campos de contenido: ni nombres de Projects o Threads, ni grupos de Vault, ni lista de Members.
- [ ] Un servicio `PlatformOverview.listSpaces` (acción de operador sobre la Installation) y una RPC en `INSTALLATION_RPC_METHODS`. El handler de `ws.ts` solo decodifica y llama al servicio.
- [ ] El consumo sale de los datos de uso existentes (`aiUsage`) y del disco que mide `../plans-and-limits/`. No se calcula nada nuevo por Thread.
- [ ] Test de frontera: el Owner recibe la lista con los Spaces ajenos y sus cifras, y un Admin recibe la negativa de operador.
- [ ] Web: sección «Spaces» del modal de Plataforma, con filtro por tipo y estado. Móvil: la misma pantalla en la división de `../settings-modals/`. Paleta: «Platform: Spaces».
- [ ] Sin herramienta MCP, como Users y auditoría hoy; la razón queda en una línea del ticket de cierre.

La lista solo enseña datos; las acciones de suspender y borrar llegan en el 03.
