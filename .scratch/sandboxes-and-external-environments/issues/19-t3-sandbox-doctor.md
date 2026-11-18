# 19: `t3 sandbox doctor`: dejar una máquina lista para prestar su Sandbox

**What to build:** Cuando un User intenta prestar su máquina personal («Lend…»), el diálogo puede bloquear el préstamo: hay servicios de la máquina escuchando en `0.0.0.0` que los contenedores alcanzarían (en VPS 86 fueron `:22` sshd y `:5355` LLMNR de systemd-resolved), o los límites de CPU, memoria y procesos no se aplican. Hoy el User tiene que entender el aviso y arreglarlo a mano (root para apagar LLMNR, `T3CODE_SANDBOX_HOST_PORTS` en `~/.t3/service.env`, reiniciar el servicio). Este ticket da un comando que diagnostica y arregla lo que no necesita root, y da la línea exacta para lo que sí.

**Blocked by:** —

**Status:** in progress

- [ ] `t3 sandbox doctor` informa lo mismo que el Hub ve en el diálogo de préstamo (un solo origen de verdad: el informe del host que ya usa `LendMachineDialog`), en palabras: puertos expuestos (con el proceso dueño si se sabe), límites aplicados o no, disco.
- [ ] Por cada puerto: si es sshd con solo llaves (`PasswordAuthentication no`), ofrece permitirlo (`T3CODE_SANDBOX_HOST_PORTS`); si es un servicio sin uso en un servidor (LLMNR, mDNS), da el comando root para apagarlo; si no se reconoce, explica las dos opciones (bind a 127.0.0.1 o permitirlo) sin decidir por el User.
- [ ] `--fix` aplica solo lo que no necesita root y que el User confirma: escribe `~/.t3/service.env` (sin tocar otras claves) y reinicia el servicio t3; nunca usa sudo por su cuenta.
- [ ] Límites no aplicados: explica la causa encontrada (ver la investigación de VPS 86, 2026-11-18) y el paso root exacto si hace falta.
- [ ] El diálogo «Lend…» enlaza a este comando en vez de solo mostrar el texto rojo.
- [ ] Nunca imprime valores de `service.env` ni secretos.
- [ ] Tests: parseo de puertos/servicios, sshd con y sin contraseña, `service.env` con otras claves preservadas, idempotente.

**Origen:** préstamo de VPS 86 a otro Space (2026-11-18): se apagó LLMNR a mano (root) y se añadió `T3CODE_SANDBOX_HOST_PORTS=22`. Es una vez por máquina; este comando evita que cada User que preste su máquina tenga que descubrirlo.
