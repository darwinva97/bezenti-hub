# 04: Límite de Members por Organization

**What to build:** Una Organization solo puede tener tantas memberships (Admin, Member, Guest) más Invitations pendientes como diga el Plan de su Steward. Se aplica al crear una Invitation y al aceptarla. Bajar el límite no quita a nadie. Ver spec, «Límites».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `PlanLimits.check("membersPerOrganization", spaceId)` en `InvitationService` al crear y al aceptar (`apps/server/src/spaces/InvitationService.ts`). Revocar o dejar caducar una Invitation libera su hueco.
- [ ] Red-first: con límite 3, dos Members y una Invitation pendiente, crear otra falla; revocar la pendiente deja crear; si el límite baja a 2 con una pendiente, aceptarla falla con el límite y no crea User huérfano ni membership a medias; los tres Members siguen.
- [ ] Al aceptar una Invitation que falla por el límite, la pantalla de aceptación dice qué Organization está llena y quién es su Steward.
- [ ] Web/desktop: el diálogo de Invitations muestra «Members 3 of 5» y el error. El modal Space → «Usage» muestra el uso a Admins y al Steward.
- [ ] Puerta `spaces.usage` en `HTTP_ENDPOINT_RULES` (Admins, Steward, Owner); un Member o Guest no la lee.
- [ ] Docs: la fila de Members en «Plans and limits».
