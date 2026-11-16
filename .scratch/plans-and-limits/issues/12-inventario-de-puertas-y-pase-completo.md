# 12: Inventario de puertas y pase completo

**What to build:** Una revisión de inventario, como la del ticket 09 de Vaults, de todas las puertas que crean algo limitado o empiezan trabajo, y de las que devuelven uso. Cada límite se aplica en todas sus entradas, y ninguna respuesta de uso lleva contenido ajeno. Cierra los huecos que encuentre. Ver spec, «Puertas».

**Blocked by:** 01–11.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `DoorRules.ts` declara las puertas nuevas; `DoorRules.test.ts` y `RpcAuthorization.test.ts` fallan si una nueva no declara su regla.
- [ ] Barrido por límite: cada entrada que crea Organizations, Invitations, máquinas, Projects, Threads, turnos o previews (WS, HttpApi, MCP, tareas programadas, webhooks de tareas, gateway con claves de CLI local) devuelve `PlanLimitReachedError` con un Plan lleno. Una entrada nueva sin fila falla.
- [ ] Barrido de privacidad: `plans.usage` y `spaces.usage`, leídos por el Owner, un Admin y un Member de dos Organizations, no llevan títulos de Threads, nombres de Projects, rutas ni nombres de archivos; un Member no lee el uso de su Organization ni el de otro User.
- [ ] Ningún camino borra ni para algo al bajar un límite: test que baja cada límite a 0 con todo en uso y comprueba que todo sigue y solo lo nuevo se rechaza.
- [ ] Red-first para cada hueco encontrado.
- [ ] Prueba real completa con `test-t3-app` y datos copiados: el Owner crea «Free» y «Pro», cambia el por defecto, un User nuevo recibe «Free» y choca con cada límite; Ada transfiere su Organization a Grace; el Owner pasa a Ada a «Pro» y todo se desbloquea; los Grants de «Pro» aparecen en su siguiente turno.
