# 06: Factor fuerte desde Keycloak

**What to build:** El Owner lista los valores de `acr` y `amr` que cuentan como factor fuerte. Un Admin (o el Owner) que entra por Keycloak con MFA entra; sin MFA, el Hub lo rechaza con «Tu Role necesita un segundo factor en Keycloak» y un botón que repite el flujo pidiéndolo (`acr_values`). Ascender a Admin a un User de Keycloak cierra sus sesiones sin factor fuerte. Las acciones que piden un factor fuerte reciente (aprobar el alta de una máquina) se confirman con un paso por Keycloak. Ver spec, «Factor fuerte».

**Blocked by:** 02, 05

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `strong_acr` y `strong_amr` editables en la sección del Owner (ticket 01); `identity_logins.strong` se calcula en el callback.
- [ ] `passwordRequiresTotp` se generaliza a `requiresStrongSignIn(user)` en `UserDirectory` y lo usan el inicio local y el de Keycloak; filas nuevas en `KeycloakAdmission` para login fuerte y no fuerte de Owner, Admin y Member.
- [ ] El rechazo se decide después de `planGroupSync` (las memberships cambiadas se quedan); el botón «Reintentar con segundo factor» repite `sign-in` con `acr_values` y `prompt=login`.
- [ ] Ascender a Admin (Hub o mapeo) termina los logins no fuertes del User, como `onPromotedToAdmin`.
- [ ] `hasStrongSignIn` y la consulta `strongSignIn` de `SpaceDirectory` cuentan una identidad de Keycloak como factor fuerte.
- [ ] Intención `step-up` (`prompt=login`, `max_age=0`, `acr_values`): comprueba `auth_time` posterior al inicio del flujo, misma identidad que la sesión y login fuerte; deja una prueba de un solo uso, 5 minutos, atada a la sesión, y vuelve a `returnTo` con su id en el fragmento.
- [ ] `AuthReauth` gana `{ method: "keycloak", proofId }`; `confirmStrongFactor` y `requireStepUp` la aceptan para un User con identidad.
- [ ] `/register-environment` (aprobar el alta de una máquina) ofrece «Confirmar con Keycloak» a quien no tiene credenciales locales y reanuda la aprobación al volver.
- [ ] Tests en la frontera del servidor con el Keycloak falso: Admin sin MFA rechazado y con MFA dentro; ascenso que revoca un login débil y cierra su socket; prueba de step-up caducada (`TestClock`), reutilizada, de otra sesión o con `auth_time` viejo.
