# 06: Enlaces de préstamo y suscripciones prestadas a cualquier Space

Spec: ../spec.md

**What to build:** Para prestar a un Space del que no eres miembro, el prestador crea un enlace de un uso y 7 días. Quien lo abre elige uno de sus Spaces donde puede decidir y, al aplicarlo, acepta. Prestar una suscripción (Claude, ChatGPT…) muestra al dar y al aceptar un aviso corto de que los términos del proveedor lo prohíben y la cuenta puede ser suspendida. Ver spec, «Enlaces de préstamo» y «AI accounts prestadas».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] `grants.createOffer`, `grants.readOffer` y `grants.claimOffer`. El token se guarda solo como hash. Estado `offered` sin destino. Al aplicarlo, nace `active` en el Space elegido.
- [ ] Red-first:
  - [ ] un enlace usado, caducado o cancelado no sirve;
  - [ ] el receptor no puede aplicarlo a un Space donde no tiene `grant.decide`;
  - [ ] un segundo Grant al mismo destino da `already-granted`;
  - [ ] leer un enlace sin sesión no revela nada.
- [ ] La URL se construye con la URL pública del Hub (si no hay, con el origen actual). Web route `/grants/offer/<token>` con el resumen, los avisos y el selector de Space.
- [ ] El prestador ve y cancela sus enlaces abiertos en «Préstamos dados». Auditoría `grant.offer`.
- [ ] Aviso de ToS en suscripciones, en el formulario de dar, en la página del enlace y en «Por aceptar».
- [ ] Prueba real: Ana crea un enlace para su suscripción y Bob lo aplica a su Personal space desde otro navegador; se usa por la gateway.
