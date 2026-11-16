# 11: Inventario de puertas y pase completo

**What to build:** Revisión de inventario, como la del ticket 09 de `../../vaults/`, de quién puede leer y escribir cada recurso con dueño (máquinas, AI accounts, grupos, Secrets, Variables) por cada puerta: WS, HttpApi, raw routes (`/api/ai/*`), MCP, executor wire, rutas de invitado, logs, spans OTLP, argumentos de proceso y archivos del Hub. Cierra los huecos con la misma regla en cada puerta. Ver spec, «Puertas».

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `VaultDoors.test.ts` y un barrido igual para AI accounts y Environments: Owner, Ana, Admin, Member y Guest de Acme y de Globex llaman cada puerta de lectura y escritura; ningún nombre, Variable ni metadato ajeno sale y ninguna escritura ajena se acepta. Una puerta nueva sin llamada en el barrido hace fallar el test.
- [ ] Ninguna puerta devuelve un valor de Secret ni una credencial de AI account; solo `vaults.entries.list` y `list_secret_names` devuelven valores, y solo de Variables.
- [ ] Test de humo de fugas: un Secret multilínea y una credencial de AI account de Ana no aparecen en logs, spans, `/proc/*/cmdline` del Hub ni de la máquina, ni en archivos del Hub fuera del almacén cifrado, después de un turno, una terminal, un traspaso y un `request_secret`.
- [ ] Una sesión limitada a un Space (`spaceLimit`) no ve grupos, cuentas ni máquinas de otro.
- [ ] `DoorRules.ts`, `RPC_SPACE_ACCESS`, `HTTP_ENDPOINT_RULES`, `MCP_TOOL_RULES` y `CLIENT_GUARDED_RPC_SCOPES` declaran cada puerta tocada en esta fase.
- [ ] Red-first para cada hueco encontrado.
- [ ] Pase completo en un cliente real (web con `test-t3-app`, móvil con `test-t3-mobile`): Ana sin Organizations une su máquina, añade una API key y un Secret PEM, su Thread personal usa los tres y el historial muestra `[NAME]`; crea una Organization (ticket 18 de `../../identity-and-access/`), dedica la máquina, añade una cuenta y una Variable de la Organization; un Member invitado las usa y no ve nada de Ana.
- [ ] Docs: `docs/internals/secrets.md` («The door inventory») y `docs/internals/ai-gateway.md` («Doors») al día, reescritos, sin historia.
