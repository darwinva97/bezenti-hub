# 13: Inventario de puertas y pase completo

Spec: ../spec.md

**What to build:** Una revisión de inventario, como la del ticket 09 de `../../vaults/` y la del 13 de `../../ai-accounts-and-gateway/`, de todas las puertas por las que se da, acepta, ve o usa un Grant: WS, HttpApi, raw routes (`/api/ai/*`, `/api/environments/self`, git route), MCP, executor wire, socket del Sandbox, logs, spans OTLP y argumentos de proceso. Cierra los huecos que encuentre y hace un pase real con todos los tipos. Ver spec, «Puertas» y «Hit every surface» de `AGENTS.md`.

**Blocked by:** 01–12.

**Status:** ready-for-agent

- [ ] `DoorRules.ts` y `RPC_SPACE_ACCESS` declaran todas las puertas de Grants; el test de inventario falla si una nueva no declara su regla.
- [ ] Barrido `grants/GrantDoors.test.ts`: Owner, Steward, Admin, Member y Guest de Acme y Globex, más Ana sin Organization, llaman a cada puerta de Grants. Nadie ve Grants pendientes ajenos, uso ajeno fuera de sus Grants, valores de Secrets prestados ni tokens de enlace.
- [ ] Ninguna herramienta MCP da, acepta ni retira Grants, ni devuelve Grants ajenos (test).
- [ ] Humo de fugas: tokens de enlace y credenciales de Sandbox prestado no aparecen en logs, spans ni `/proc/*/cmdline` del Hub ni del host.
- [ ] Puertas inversas, una por una: dar ↔ cancelar o retirar; pendiente ↔ aceptar o rechazar; activo ↔ devolver; enlace ↔ cancelar; tope ↔ cambiar; máquina ↔ mover sus Threads.
- [ ] Red-first para cada hueco encontrado.
- [ ] Prueba real completa en WSL con Podman, en una sesión: AI account con tope, Vault group y máquina prestados a Acme; uso visto por Ana y por Acme; un enlace aplicado por Bob; retirar los tres; revisión de allowances migradas con datos copiados.
