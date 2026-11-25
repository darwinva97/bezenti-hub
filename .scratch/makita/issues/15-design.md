# 15: «Where it works» en una máquina dedicada (nota de diseño)

Solo el punto «Where it works» del ticket 15. El segundo Sandbox por Space y su ADR quedan fuera.

## Lo que hay

- `makita_configs.environment_id` ya existe (migración 165, `NULL` = Sandbox del Space) y los
  contratos ya lo llevan (`MakitaConfig.environmentId`, `MakitaConfigFields.environmentId`).
  `MakitaConfigs.checkedInput` rechaza cualquier valor no nulo. **No hace falta migración.**
- Una máquina dedicada es una fila de `environments` con `kind = 'external'`, `mode = 'dedicated'`,
  `space_id` = el Space y sin dueño (migración 106; `environment.dedicate`). En ella corre un
  Sandbox de ese Space (Podman, mismas reglas de contenedor). Una personal es `mode = 'personal'`;
  una prestada por un Grant es otra fila, `kind = 'sandbox'`, `mode = 'lent'`, id `lent:<grant>`
  (los clientes la ven como «dedicated» con `lent`, la base no).
- La colocación de Makita es `placement: "space-work"` → `chooseForThread({ spaceWorkOnly })`, que
  ignora lo pedido y la preferencia del Project y va al Sandbox del Space. `MakitaMachines.makeWorktree`
  (ticket 10) usa lo mismo.
- Lo que el agente nunca tiene (Vault, MCP, gateway, token, `thread.move`) se decide por el
  `thread_id` de la tarea (`makitaTaskOfThread`), no por el tipo de máquina: vale igual en una
  dedicada. La ruta git y la subida de `makita_push` se deciden por el Active environment del Thread,
  igual para el Sandbox y una dedicada.

## Decisiones

1. **Quién reconoce una máquina dedicada:** `EnvironmentRegistry` (dueño de `environments`; DoorRules
   no deja nombrar la tabla fuera). Nuevo `dedicatedMachines(spaceId)`: las filas vivas
   `external` + `dedicated` de ese Space, `{ id, name }`. Una personal, una prestada o una de otro
   Space nunca aparecen, así que una sola regla cubre las tres negativas.
2. **Guardar:** `MakitaConfigs` acepta `environmentId` solo si está en `dedicatedMachines(space)`;
   si no: «Choose the Space's Sandbox or a machine dedicated to this Space.». Se guarda, se audita
   (`environment` en `changed` de `makita.config.update`, detalle `environment` en create/update).
3. **Al empezar cada tarea:** antes del worktree y del Thread, `MakitaTasks` vuelve a preguntar. Si
   la máquina ya no está dedicada al Space, la tarea queda `failed` con «This machine is no longer
   dedicated to this Space.», sin worktree ni Thread ni «On it.», y nunca pasa sola al Sandbox. La
   configuración lo muestra como aviso (`machine-not-dedicated`) mientras dure.
4. **Colocación:** `ThreadLaunchInput.spaceWorkOn` (solo con `space-work`) → `chooseForThread`
   `spaceWorkOn`: comprueba otra vez en el registro que la máquina es dedicada al Space del Thread
   (si no, `ThreadEnvironmentUnavailableError` nuevo motivo `not-dedicated`, mismo texto) y coloca
   con `placeOn` como el creador (`environment.use`: Admins y Members del Space, no Guests).
   `makeWorktree` recibe la misma máquina.
5. **Formulario:** «Where it works» ofrece «Space Sandbox (recommended)» y las máquinas dedicadas
   del Space (`space.machines` en `makita.configs.list`, solo para quien puede crear). Si el Hub no
   tiene Sandboxes (`space.sandboxesUnavailable`) lo dice junto al Sandbox. Con una máquina, avisa
   que los Threads de Makita comparten usuario del sistema con los demás Threads que corren en ella.

## Lo que no cambia y lo que queda dicho

- Sin RPC nueva (el formulario lee las máquinas en `makita.configs.list`): no hay puerta nueva.
- En la máquina dedicada los Threads de Makita comparten el Sandbox del Space de esa máquina con los
  Threads normales del Space (mismo usuario): el mismo riesgo que en el Sandbox del Space, en otra
  máquina. Por eso sigue siendo solo para listas de gente permitida.
- Una máquina dedicada no se arranca para el trabajo como el Sandbox del Hub: si está apagada la
  tarea falla («… is offline …»).
- Deshacer: elegir otra vez «Space Sandbox» en la configuración.
