# 15: Uso de un Vault group prestado, para quien presta

Spec: ../spec.md

**What to build:** El prestador de un Vault group ve qué Space usó qué: por cada Grant, por día, User prestatario y nombre, cuántos procesos (turnos, terminales, scripts) recibieron ese nombre. Nunca Threads ni prompts. Los Admins del Space prestatario ven lo mismo de su Space. Separado del ticket 07 al diseñarlo (decisión 3 del diseño de 07).

**Blocked by:** 07.

**Status:** done (branch `feat/grants15`, migration 150 as a placeholder)

- [x] Tabla `vault_grant_usage (grant_id, day, user_id, name, deliveries)`, clave primaria de las cuatro primeras, día en UTC como `ai_usage_daily`.
- [x] Se suma una entrega por nombre prestado cada vez que `SecretDelivery.resolve` termina bien para un proceso que arranca. Un fallo al escribirla se registra en el log y nunca para el turno.
- [x] WS `grants.vaultUsage({ grantId })`: para quien puede `grant.viewGiven` y para los Admins del Space destino (o el dueño del Personal space). Nunca `threadId`. Puerta declarada en `RPC_SPACE_ACCESS` (lector: `grant.viewGiven` o `grant.return`) y barrida en `vaults/VaultDoors.test.ts` (el nombre contiene `vault`).
  - [x] Red-first: un Member del prestatario no la ve; otro Space tampoco; el prestador no ve nada de otros Grants.
- [x] «Préstamos dados» y «Prestado a este Space» muestran la tabla por día, User y nombre.
- [x] Las filas se borran con el Grant terminado al cabo de 90 días, o se quedan como historial (decidir al implementar). Decidido: se quedan como historial; las de un User eliminado también, como su uso de IA.
