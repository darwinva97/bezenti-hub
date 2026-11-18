# 06: Enlaces de préstamo y suscripciones prestadas a cualquier Space

Spec: ../spec.md
Diseño: 06-design.md

**What to build:** Para prestar a un Space del que no eres miembro, el prestador crea un enlace de un uso y 7 días. Quien lo abre elige uno de sus Spaces donde puede decidir y, al aplicarlo, acepta. Prestar una suscripción (Claude, ChatGPT…) muestra al dar y al aceptar un aviso corto de que los términos del proveedor lo prohíben y la cuenta puede ser suspendida. Ver spec, «Enlaces de préstamo» y «AI accounts prestadas».

**Blocked by:** 01.

**Status:** done (salvo la prueba real; ver abajo)

- [x] `grants.createOffer`, `grants.readOffer` y `grants.claimOffer`. El token se guarda solo como hash. Estado `offered` sin destino. Al aplicarlo, nace `active` en el Space elegido.
- [x] Red-first:
  - [x] un enlace usado, caducado o cancelado no sirve;
  - [x] el receptor no puede aplicarlo a un Space donde no tiene `grant.decide`;
  - [x] un segundo Grant al mismo destino da `already-granted`;
  - [x] leer un enlace sin sesión no revela nada.
- [x] La URL se construye con la URL pública del Hub (si no hay, con el origen actual). Web route `/grants/offer#token=<token>` (fragmento, no ruta: el token no llega a ningún servidor, log ni Referer) con el resumen, los avisos y el selector de Space.
- [x] El prestador ve y cancela sus enlaces abiertos en «Préstamos dados». Auditoría `grant.offer`.
- [x] Aviso de ToS en suscripciones, en el formulario de dar, en la página del enlace y en «Por aceptar».
- [ ] Prueba real: Ana crea un enlace para su suscripción y Bob lo aplica a su Personal space desde otro navegador; se usa por la gateway. **Sin verificar en navegador** (sin servidores de desarrollo en esta ronda). La cubre un test de servidor con el CLIProxyAPI falso (`ai/AiGatewayRoute.grants.test.ts`): Grace crea el enlace, Gus (sin Space en común) lo aplica a su Personal space, su Thread la usa por la gateway y, tras retirarla Grace, la siguiente petición se rechaza.

Decisiones (aprobadas): un `invalid` para todo enlace muerto (el motivo solo en la lista del prestador); como mucho 10 enlaces abiertos por recurso (`too-many-offers`); límites fijos (cancelar y crear otro); quien creó el enlace debe poder seguir prestando al aplicarlo. Migración 147 (número provisional) reconstruye `grants` para permitir `cancelled` sin destino.

**Seguimiento: enlaces de máquinas.** Hoy `createOffer` de un `environment` da `not-lendable`. Aplicar un enlace de máquina la deja activa, y eso pide el factor fuerte de quien decide (como `accept`, por HTTP: `POST /api/grants/claim-offer` con `prepareClaim`) y abrir su Sandbox (`openLentSandbox`). Los Vault groups llegan con el ticket 07.
