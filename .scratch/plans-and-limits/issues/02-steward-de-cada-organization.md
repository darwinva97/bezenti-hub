# 02: Steward de cada Organization

**What to build:** Cada Organization tiene un Steward: quien la crea, o el Owner para las que ya existen. Los límites de la Organization salen del Plan de su Steward. El Steward (o el Owner) ofrece el rol a otro Admin, que lo acepta o lo rechaza; quien ofreció puede cancelar. El Steward no puede salir ni dejar de ser Admin sin transferir antes. Quitar a un User de la plataforma pasa sus Organizations al Owner. Ver spec, «Steward».

**Blocked by:** 01; `../../identity-and-access/issues/18-cualquier-user-crea-organizations.md`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `spaces.steward_user_id` y `spaces.steward_offer_user_id` (solo Organizations); las existentes, con el Owner como Steward. Nota (identity-and-access 18): `spaces.created_by_user_id` (migración 138) ya guarda quién creó cada Organization desde el ticket 18; el Steward inicial es esa columna, y el Owner solo donde es NULL (las de antes).
- [ ] `SpaceDirectory.createOrganization` pone al creador como Steward en la misma operación que su membership `admin`.
- [ ] `Plans.limitsForSpace` usa el Plan del Steward para una Organization (sin límites si es el Owner). Las máquinas de una Organization (`../../owned-resources/`) cuentan contra `max_own_machines` del Plan de su Steward.
- [ ] Oferta, aceptar, rechazar y cancelar como métodos de servicio; solo un Admin de la Organization puede recibirla; una oferta a la vez. Aceptar comprueba el límite de Organizations del que acepta (el ticket 03 añade el límite; aquí se deja el punto de llamada).
- [ ] Red-first: el Steward no puede salir (`leave`), ni otro Admin o el Owner quitarle el rol de Admin o la membership, mientras sea Steward; el error dice «Transfer the Steward role first».
- [ ] Quitar a un User de la plataforma (`InstallationUserService`) pasa sus Organizations al Owner como Steward y anula las ofertas que tenía.
- [ ] Puertas: `spaces.stewardOffer`, `spaces.stewardOfferAccept`, `spaces.stewardOfferDecline`, `spaces.stewardOfferCancel` en `HTTP_ENDPOINT_RULES`. `SpaceSummary` (`packages/contracts/src/spaces.ts`) añade el Steward y la oferta pendiente para el viewer (opcionales, para servidores viejos).
- [ ] Auditoría `organization.steward.offer|accept|decline|cancel`.
- [ ] Web/desktop: modal Space → «Steward» (quién es; ofrecer a un Admin; aceptar o rechazar si la oferta es para ti; cancelar si la hiciste). Los Members ven quién es el Steward.
- [ ] Docs: `docs/user/install.md` («Spaces and organizations») explica el Steward en dos frases.
- [ ] Prueba real: Ada crea Acme, ofrece el Steward a Grace (Admin), Grace acepta; Ada intenta salir antes y después de la transferencia.
