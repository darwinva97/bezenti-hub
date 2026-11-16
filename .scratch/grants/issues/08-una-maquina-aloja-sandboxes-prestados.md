# 08: Una máquina prestada aloja un Sandbox por cada Space prestatario

Spec: ../spec.md

**What to build:** Ana presta su VPS a Acme con límites de CPU y memoria. Un Admin de Acme acepta tras el aviso de que Ana ve todo lo que corre en la máquina. Desde entonces la máquina, sin dejar de servir a Ana de forma nativa, mantiene un Sandbox para Acme (Podman rootless, imagen del Sandbox). Ese Sandbox es un Environment de Acme en el Hub, con credencial propia. Los Members de Acme lo eligen en el selector. Es el corte grande de máquinas (ADR 0011): generaliza `DedicatedHost` de un Space a una lista. El disco va en el 09 y la retirada en el 10. Ver spec, «Máquinas prestadas».

**Blocked by:** 01, owned-resources (dueño de una máquina).

**Status:** ready-for-agent

- [ ] La máquina informa `sandboxHost: { ready, reason }` (Podman rootless, imagen, `hostExposure`) y el Hub lo guarda.
  - [ ] Dar un Grant de máquina con `ready: false` se rechaza con el motivo.
  - [ ] Con estado desconocido se crea y avisa.
  - [ ] Solo External environments con dueño; un Sandbox del Hub da `not-lendable`.
- [ ] Contrato `EnvironmentSelfResult`: `sandboxes: [{ spaceId, grantId, limits, credential }]` en lugar de un solo `spaceId`. Incluye el Space propio de una máquina de Organization (lo que hoy es dedicada) y cada Grant `active`.
- [ ] `environments/DedicatedHost.ts` pasa a ser host de Sandboxes:
  - [ ] corre junto al servidor personal o solo, como hoy en las dedicadas;
  - [ ] mantiene un Sandbox por Space de la lista;
  - [ ] borra el home de cualquier Space que ya no esté.
- [ ] En el Hub, cada Sandbox prestado es un Environment (`kind = 'sandbox'`, `mode = 'lent'`, `space_id`, `grant_id`, `host_environment_id`) con su credencial (patrón de la migración 107).
  - [ ] Red-first: la credencial de un Space no conecta como otro ni lee repositorios de otro Space (git route).
  - [ ] Red-first: el executor rechaza trabajo de un Thread de otro Space (`boundSpaceOf`).
- [ ] `environment.use`:
  - [ ] Red-first: Admins y Members del prestatario sí; Guests no; los demás Spaces ni lo ven.
  - [ ] El prestador ve estado y recursos, nunca Threads.
- [ ] Límites de CPU y memoria del Grant, recortados a la máquina (`fitLimitsToHost`), en el siguiente arranque. `grants.setLimits` para máquinas. Aviso de sobrecompromiso en el formulario.
- [ ] Colocación: se ofrece en el selector y como preferido de Projects del Space, nunca por defecto (`previewThreadPlacement`).
- [ ] Aviso al aceptar y distintivo permanente en el Environment (texto del spec).
- [ ] Tests en `HubWithEnvironments.testkit.ts` con runtime process: máquina personal de Ana con Grants a Acme y Globex; turnos de cada uno en su Sandbox; Ana sigue usando la máquina nativa.
- [ ] Grupo Podman (`sandboxes/PodmanSandboxRuntime.test.ts`): dos Sandboxes prestados en un host no se leen entre sí ni leen el home del dueño, y se aplican sus límites de memoria y PIDs.
- [ ] `docs/internals/sandboxes.md`: «Dedicated machines» reescrito como host de Sandboxes con varios Spaces.
- [ ] Prueba real en WSL con Podman: Replay provider en el Sandbox prestado a Acme.
