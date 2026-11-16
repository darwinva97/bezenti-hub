# 03: Modos de registro y primer inicio de sesión

**What to build:** Alguien sin User pulsa «Entrar con Keycloak» (o se registra en Keycloak desde ahí) y el Hub decide según el Registration mode: en abierto le crea su User; en «solo con invitación» o cerrado le explica que necesita una invitación o que el registro está cerrado. Quien abre una Invitation de Organization pulsa «Entrar con Keycloak para aceptar» y entra ya como Member (o el Role de la Invitation), con User nuevo si no lo tenía y el modo lo permite. La decisión es un módulo puro, `KeycloakAdmission`, con la tabla del spec. Ver spec, «Admisión».

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `KeycloakAdmission.decide` puro, con su suite por tabla: todas las filas de la tabla de admisión del spec (sin la de Platform invitation ni la de grupo mapeado, que añaden los tickets 04 y 05 como filas nuevas) y las intenciones `sign-in` e `invitation`.
- [ ] El callback crea el User (`login_name` nulo, `display_name` de `name` o `preferred_username`), su identidad, el login y la sesión en una transacción; con Invitation de Organization, también la membership y el gasto condicional de la Invitation. Una negativa dentro deja la Invitation sin gastar.
- [ ] Un User existente con Invitation de Organization se une con las mismas negativas que `/api/invitations/join`.
- [ ] Intención `invitation` en `start`, con el token de la Invitation; `/invite` ofrece «Entrar con Keycloak para aceptar» cuando Keycloak está activo, y la aceptación con credenciales locales sigue mientras el inicio local esté permitido.
- [ ] La página de inicio de sesión muestra el motivo de un rechazo («solo con invitación», «registro cerrado»).
- [ ] El selector de modo del ticket 01 ya cambia el comportamiento; elegir «Abierto» muestra un aviso de que falta lo de `../platform-privacy/` (términos de uso).
- [ ] Auditoría: `invitation.accept` como hoy; acción nueva `user.register` en `audit.ts` para el User creado sin Invitation (registro abierto, y grupo mapeado en el ticket 05).
- [ ] Tests en la frontera del servidor con el Keycloak falso: una fila por modo para identidad nueva sin nada y con Invitation de Organization; Invitation caducada o revocada con `TestClock`; dos callbacks que compiten por la misma Invitation, uno gana.
