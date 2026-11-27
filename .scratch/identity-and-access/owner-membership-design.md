# El Owner puede ser miembro de una Organization

Issue #18. El Owner no podía aceptar un préstamo a una Organization porque nunca tenía rol en ella:
ver todas las Organizations no es decidir en ellas (`grant.decide` pide Admin guardado).

## Qué cambia

- `InvitationService.joinLive` deja de rechazar al Owner. Recibe la membership con el rol de la
  Invitation, con las mismas condiciones que cualquiera: un Admin necesita factor fuerte.
- El código de rechazo `owner` sale de `InvitationConflictError`, de `KeycloakSignInFailure` y del
  texto de la web.
- `SpaceDirectory.createOrganization` da al Owner la membership de Admin de la Organization que crea,
  como a cualquier User.

Nada más cambia en `AccessPolicy`: con membership, el Owner decide préstamos, ve el contador y
`listReceived`, y aparece en la lista de Members. El directorio ya listaba cada Organization una vez,
con el rol del Owner si lo tiene.

## Quién puede

El Owner, solo con una Invitation que alguien con permiso de invitar crea (el Owner mismo puede
crearla, como antes). Sin membership, sigue sin decidir préstamos de una Organization ajena.

## Cómo se deshace

El Owner sale de la Organization como cualquier miembro (`membership.leave`). Unirse, salir y crear
ya se auditan (`invitation.accept`, `membership.leave`, `organization.create`).

## Fuera de alcance

Quitar al Owner el acceso universal (`../platform-privacy/spec.md`) y la migración que lo añade como
Admin de las Organizations que ya existen. Para una Organization existente basta con aceptar una
Invitation.
