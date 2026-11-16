# 10: Retirar o devolver una máquina prestada

Spec: ../spec.md

**What to build:** Cuando el prestador retira el Grant de una máquina, o el prestatario la devuelve:

- el Hub deja de aceptar turnos en ese Sandbox;
- interrumpe los que corren, con su checkpoint;
- anula la credencial;
- el host borra el home.

Los Threads quedan en «needs an environment». La vista del Grant ofrece moverlos al Sandbox del Space con el movimiento de `../../hub-thread-store/issues/08-mover-un-thread.md`. Ver spec, «Máquinas prestadas» (Retirar o devolver).

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] `grants.end` en un Grant de máquina: en la transacción, se rechazan turnos nuevos y los Threads cuyo Active environment es ese Sandbox pasan a `released`. Un effect interrumpe los turnos en curso y espera su checkpoint (como mucho 2 minutos), y después anula la credencial. Con la máquina apagada, la anula al momento.
- [ ] Red-first: tras terminar, la credencial vieja no conecta ni lee el repositorio; un turno nuevo se rechaza.
- [ ] Test con el worker drenado: retirada con un turno en marcha, el checkpoint se sube y el Thread queda liberado.
- [ ] El host borra el home en la siguiente respuesta de `/self` sin ese Space (test en el testkit).
- [ ] «Mover» por Thread y «Mover todos» al Sandbox del Space, desde el último checkpoint subido. El timeline muestra «Moved from A to B».
- [ ] Aviso al prestador antes de retirar: los Threads de <Space> se paran, y los cambios hechos a mano desde el último turno pueden perderse.
- [ ] Borrar la máquina o quitar su host termina sus Grants con `resource-gone` por el mismo camino.
- [ ] Prueba real en WSL: retirar con un turno de Replay en marcha y mover el Thread al Sandbox de Acme.
