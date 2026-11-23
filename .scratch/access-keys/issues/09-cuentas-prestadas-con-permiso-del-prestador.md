# 09: Cuentas prestadas con permiso del prestador

**What to build:** Una access key llega también a las AI accounts que un Grant presta a su Space, solo si quien presta lo permite en ese Grant. Una petición por una cuenta prestada tiene que caber a la vez en los topes de la clave y en los del Grant, y el prestador ve el uso de las claves en el uso de su préstamo. Ver spec, «AI accounts que alcanza» y pregunta abierta 1.

**Blocked by:** 06.

**Status:** needs-triage

**Tipo:** HITL: necesita la decisión de la pregunta abierta 1 (si se hace, y si el permiso es por Grant y por defecto apagado).

Spec: ../spec.md

- [ ] `AiAccountGrantLimits.accessKeys: boolean` (por defecto `false`; los Grants que ya existen lo leen como `false` sin migrar filas), que solo el prestador cambia (`grants.setLimits`, auditado `grant.limits.change`).
- [ ] `AllowedAiAccounts.forSpace` incluye las prestadas con `accessKeys: true`, con su `via`; `accounts_json = null` las incluye, una lista puede nombrarlas.
- [ ] `AiGatewayProxy`: por una cuenta prestada, primero el tope de la clave, después el del Grant; el mensaje de un tope del Grant no nombra la clave ni el uso de nadie.
- [ ] Uso del préstamo (Loans → «Use»): las filas de access keys aparecen como «Access key» del Space que la recibe, sin su etiqueta (es de ese Space).
- [ ] Web: interruptor «Access keys of <Space> may use it» en el diálogo de prestar y en los límites de un Grant; aviso de que quien reciba una clave será alguien de fuera.
- [ ] Red-first: con el permiso apagado, una clave nunca llega a la cuenta prestada, ni fijada ni en failover; encendido, sí, y el tope del Grant la para; apagarlo rechaza la siguiente petición.
- [ ] Docs: `grants.md` («AI accounts») y «Access keys».
