# 09: Límite de disco por préstamo en máquinas prestadas

Spec: ../spec.md

**What to build:** Cada Grant de máquina lleva un límite de disco. El host mide el home de cada Sandbox prestado y lo informa. Por encima del límite, el Hub rechaza turnos nuevos en ese Sandbox con un error claro y no borra nada, como las cuotas del Hub. Hoy las dedicadas no aplican disco (`docs/internals/sandboxes.md`, «Limits»). Ver spec, «Máquinas prestadas» (Límites).

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] El host mide el tamaño de cada home prestado (cuota del volumen si el backend la soporta, si no medición periódica) y lo informa al Hub con los recursos de la máquina.
- [ ] Red-first: con el home por encima del límite, `thread.turn.start` en ese Sandbox se rechaza con un error tipado que nombra el límite y el uso; terminales y lectura de archivos siguen funcionando para poder limpiar.
- [ ] El prestador y el prestatario ven el disco usado del Sandbox prestado.
- [ ] Subir el límite (`grants.setLimits`) desbloquea en la siguiente medición.
- [ ] Test en el testkit con runtime process y un medidor falso; nada de esperas reales.
