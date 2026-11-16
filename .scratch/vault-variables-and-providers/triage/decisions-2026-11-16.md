Revisado el spec entero. Decisiones para pasarlo a `ready-for-agent`:

## Preguntas abiertas

| #   | Decisión                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Aceptada.** Lo existente sigue revelable; lo nuevo nace sellado. Añadir en Settings → Vaults una acción «Seal» por entrada (con aviso de que no se deshace sin valor nuevo), para poder sellar lo viejo sin re-escribirlo.                                       |
| 2   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 3   | **Aceptada.** Fallo tipado y «Retry», nunca el último valor conocido.                                                                                                                                                                                              |
| 4   | **Cambiada:** Owner, Admins y **Members** ven los valores de las Variables; los **Guests no** (una invitación de invitado puede salir fuera de la Organization). El Guest ve el nombre y «Variable». El aviso `looks-like-credential` se mantiene.                 |
| 5   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 6   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 7   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 8   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 9   | **Aceptada.**                                                                                                                                                                                                                                                      |
| 10  | **Aceptada.**                                                                                                                                                                                                                                                      |
| 11  | **Aceptada.**                                                                                                                                                                                                                                                      |
| 12  | **Aceptada.** Ojo: `/.well-known` ya tiene el bypass de Access, así que en cuanto exista una entrada `identity` el discovery es público desde internet; que el JWKS no exponga nada más que las claves públicas y que el 404 sea igual al de una ruta inexistente. |

## Alcance: por fases

Es mucho para construir de una vez. Propongo:

- **Fase 1 (lo que necesita el ticket 18):** 01 → 02 → 03 → 04 → 05 → 07, y un 17 reducido (puertas y docs de lo que entra en esta fase).
  - El **01 va primero y solo**: se puede desplegar y usar en cuanto esté.
- **Fase 2:** 06 (Dynamic secrets), 14 (restricciones y aprobaciones), 16 (clientes completos; en la fase 1 solo web).
- **Aplazados hasta que haya un caso real:** 08, 09, 10, 11, 12, 13, 15. Se quedan en `needs-triage`.

## Fuera del código, antes que nada

El ticket 18 no tiene que esperar a ningún código para lo urgente:

1. Quitar `KUBECONFIG` y `SSH_PASSWORD` del Vault `bezenti-ti`.
2. Rotar la CA de clientes de k3s (el certificado `system:masters` quedó en el contexto de un modelo).
3. Cambiar la contraseña root del nodo y dejar SSH solo con clave.

Mientras tanto, el fallback del propio spec sirve sin esperar a la fase 1: un ServiceAccount de solo lectura con un token de vida corta guardado como Secret normal.

## Al fusionar

Solo markdown: mejor fusionar con `[skip ci]` en el mensaje, para no redesplegar el Hub (y tener que actualizar hub-vps y las demás máquinas a la misma versión) por un cambio de documentación.
