# 25: Todo issue nuevo

**What to build:** Un disparador nuevo por configuración, apagado por defecto: «Every new issue». Encendido, un issue abierto en un repositorio escuchado arranca una tarea sin etiqueta, mención ni asignación, como hace `robobun` en `oven-sh/bun`, pero solo cuando su autor es alguien a quien la configuración responde (la misma comprobación de «Quién lo pide y si puede» que los demás disparadores). Los issues de cualquier otra persona se ignoran, con su motivo en la actividad, hasta que existan el Sandbox de Makita (15) y «Anyone» (16). Ver spec, «Cómo llegan los eventos», «Deduplicación e idempotencia», «Quién lo pide y si puede».

**Blocked by:** 09 (hecho). No construye 15 ni 16.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (autonomía estilo robobun)

**Seguridad:** sensible (gasto de IA por cada issue, entrada no confiable). Nota de diseño `25-design.md` antes de construir.

Spec: ../spec.md

- [ ] La configuración gana «Every new issue» (apagado por defecto). El formulario avisa que gasta uso de IA en cada issue así y dice que los issues de quien no está en la lista se ignoran hasta que Makita tenga su propio Sandbox y pueda responder a cualquiera.
- [ ] Un feed nuevo por repositorio (`GET /repos/{o}/{r}/issues`, del más nuevo al más viejo, con ETag) que solo se lee si alguna configuración viva lo tiene encendido. Clave `gh:new-issue:<id>`; exactamente una vez como los demás.
- [ ] Nunca barre issues viejos: la primera lectura de un repositorio solo fija el cursor, y al encender la opción solo cuentan los issues abiertos después.
- [ ] Un PR abierto por una persona no es un issue: no arranca nada ni se guarda.
- [ ] Autor permitido: `queued` / `new-issue`, y la tarea pasa por la misma cola (`queued`), pausa, parada y guardia de bucles; el tope de tareas simultáneas de quien lo construya se respeta porque nada se salta la cola. Autor no permitido: `ignored-not-allowed` / `new-issue`. Bots y Makita: ignorados. Configuración pausada: `ignored-paused`, sin reproducir al reanudar.
- [ ] Red-first (GitHub falso): un issue nuevo de alguien de la lista arranca una tarea una sola vez; el de un desconocido queda ignorado con motivo y sin escribir en GitHub; los issues abiertos antes de encender la opción o antes de la primera lectura no arrancan nada; un PR no arranca nada; apagar la opción para en el siguiente evento.
