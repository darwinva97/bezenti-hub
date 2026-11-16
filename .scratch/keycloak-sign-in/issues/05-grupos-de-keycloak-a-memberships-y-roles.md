# 05: Grupos de Keycloak → memberships y Roles

**What to build:** El Owner mapea grupos de Keycloak a una Organization y un Role (`bezenti` → Member de Bezenti, `bezenti-admin` → Admin). Quien entra por Keycloak con ese grupo aparece en la Organization con ese Role; si sale del grupo, pierde la membership que el grupo le dio. Las memberships que gestiona un grupo se ven como «Gestionada por Keycloak (grupo X)» y nadie las cambia ni quita en el Hub. Las manuales sin grupo que aplique no se tocan. Se aplica en cada inicio de sesión (la re-comprobación del ticket 07 lo aplicará también). Ver spec, «Grupos → memberships».

**Blocked by:** 03

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `space_memberships.managed_by_keycloak`.
- [ ] `planGroupSync` puro con su suite por tabla: manual y gestionada, grupos con y sin `/` inicial, varios grupos para una Organization (gana el Role mayor), Organization archivada, claim ausente como lista vacía, manual que pasa a gestionada.
- [ ] El callback aplica los cambios en `MembershipService` en la misma transacción que la sesión, con auditoría `membership.*` (actor `system`, detalle `keycloakGroup`); los sockets de quien cambia se enteran después del commit, como hoy.
- [ ] Fila nueva en `KeycloakAdmission`: identidad nueva con grupo mapeado crea User en abierto y «solo con invitación», no en cerrado.
- [ ] `AccessPolicy`: `MembershipResource.managedByKeycloak`; cambiar Role, quitar o salir de una gestionada es Deny para todos, filas nuevas en `AccessPolicy.test.ts`.
- [ ] Sección «Inicio de sesión» del Owner: nombre del claim de grupos y lista de mapeos (grupo, Organization elegida de la lista, Role), con alta y baja. Auditoría `signIn.settings.update`. Borrar una Organization borra sus mapeos.
- [ ] Lista de miembros (web y móvil): badge «Gestionada por Keycloak» y controles de Role y quitar desactivados con el motivo.
- [ ] Tests en la frontera del servidor con el Keycloak falso: primer inicio de sesión con `bezenti` y `bezenti-admin`; segundo inicio sin el grupo quita la gestionada y deja una manual de otra Organization; un Admin no puede quitar una gestionada.
- [ ] Un mapeo de grupo solo puede apuntar a una Organization de la que el Owner es Admin o Steward; si deja de serlo, el mapeo se desactiva y se avisa. Así el Owner no puede meterse en una Organization ajena con un grupo de Keycloak (ADR 0008; pregunta abierta 7 de `../../platform-privacy/spec.md`).
