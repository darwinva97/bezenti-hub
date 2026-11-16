# 05: Sandbox en la máquina del Hub, sí o no

**What to build:** Un Plan dice si los Spaces que sostiene pueden correr trabajo en un Sandbox en la máquina del Hub. Si no, sus Threads solo se colocan en máquinas propias o prestadas (con o sin Sandbox en ellas, ADR 0011), y cuando no hay ninguna el error lo dice. Un Sandbox que ya existía conserva sus archivos y sus Threads se pueden mover. Ver spec, «Sandbox en la máquina del Hub».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `Sandboxes` (`apps/server/src/sandboxes/Sandboxes.ts`) y la colocación de Threads consultan `Plans.limitsForSpace(spaceId).hubSandbox` antes de crear o arrancar el Sandbox de la máquina del Hub. Rechazo con `PlanLimitReachedError` (`limit: "hubSandbox"`).
- [ ] Red-first: un Space sin `hubSandbox` no arranca su Sandbox del Hub para un turno nuevo ni para una terminal; un Thread sin Project (que hoy va siempre al Sandbox) se rechaza al crearlo con el mensaje; con una máquina propia, el Thread se coloca ahí.
- [ ] Bajar el límite con el Sandbox en marcha: los turnos en curso terminan; se para por inactividad como hoy; no se borra nada; mover sus Threads a otra máquina funciona.
- [ ] Web/desktop/móvil: el selector de Environment no ofrece el Sandbox del Hub a ese Space y dice por qué.
- [ ] Docs: `docs/internals/sandboxes.md` (una frase en «Lifecycle») y la fila en «Plans and limits».
