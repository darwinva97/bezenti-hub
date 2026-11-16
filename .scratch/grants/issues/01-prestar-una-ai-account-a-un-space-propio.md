# 01: Prestar una AI account a un Space del que formas parte

Spec: ../spec.md

**What to build:** El primer corte de punta a punta del modelo de Grants, con un solo tipo de recurso. Ana presta una AI account suya a Acme (de la que es Member), un Admin de Acme lo acepta, los Threads de Acme la usan por la gateway, y Ana la retira o Acme la devuelve. Incluye:

- la tabla `grants`;
- el servicio `Grants` con todos sus estados (pendiente, activo, rechazado, cancelado, terminado);
- la tabla de `AccessPolicy`;
- la lectura en `AllowedAiAccounts`;
- las listas de dados y recibidos en web.

Sin topes (todo Grant es «sin tope» hasta el ticket 03) y sin enlaces (ticket 06). Ver spec, «Modelo», «Quién hace qué», «AI accounts prestadas».

**Blocked by:** owned-resources (dueño de una AI account y su uso en el Space propio).

**Status:** ready-for-agent

- [ ] Migración `grants` con los tres `resource_kind`, `target_kind` `space` | `plan`, los estados y el índice único parcial (un `pending` o `active` por recurso y destino). Test de migración.
- [ ] `packages/contracts/src/grants.ts`: `Grant`, `GrantState`, `GrantLimits` (unión por tipo), errores tipados (`not-allowed`, `illegal-transition`, `already-granted`, `not-lendable`, `plan-target-unavailable`) y las RPC.
- [ ] `apps/server/src/grants/Grants.ts`: `give`, `accept`, `reject`, `cancel`, `end` (revocar por el prestador o devolver por el destino), `listGiven` y `listReceived`. La tabla de transiciones tiene un test por cada transición ilegal (red-first).
- [ ] Nace `active` cuando quien da también tiene `grant.decide` en el destino.
- [ ] `AccessPolicy`: `grant.give`, `grant.revoke`, `grant.cancel` y `grant.viewGiven` se deciden sobre el dueño del recurso (el User, o los Admins y el Steward de la Organization). `grant.decide`, `grant.return` y `grant.viewReceived` se deciden sobre el destino.
  - [ ] Red-first: un Member no Admin no presta lo de su Organization; un Member no ve los pendientes de su Space; el Owner no presta recursos ajenos.
- [ ] `AllowedAiAccounts.for` = propias del Space ∪ Grants `active` al Space, cada una con `via`.
  - [ ] Pendiente, rechazado y terminado no dan nada.
  - [ ] Terminar un Grant corta la siguiente petición de la gateway (test con el CLIProxyAPI falso).
- [ ] Las AI accounts `direct` se rechazan con `not-lendable`. El destino `plan` se rechaza con `plan-target-unavailable`.
- [ ] Terminar un Grant aplica `AiAccountReach` a los Threads del Space que la tenían elegida (pasan a la siguiente permitida o a «needs an AI account») en la misma transacción.
- [ ] Auditoría `grant.give`, `grant.accept`, `grant.reject`, `grant.cancel`, `grant.end` (allow-list y etiquetas).
- [ ] Puertas: las RPC en `RPC_SPACE_ACCESS` y `CLIENT_GUARDED_RPC_SCOPES`, con test de permisos.
- [ ] Web/desktop:
  - [ ] «Prestar…» en la fila de la AI account, con selector de Spaces donde el User es Member.
  - [ ] «Préstamos dados» y «Por aceptar» / «Prestado a este Space» en los modales de Usuario y de Space (o en sus secciones de Settings si los modales aún no existen).
  - [ ] Selector de AI account con «de <prestador>».
- [ ] Prueba real: Ana presta, un Admin de Acme acepta, un turno con Replay pasa por la gateway con esa cuenta, Ana retira y la siguiente petición se rechaza.
