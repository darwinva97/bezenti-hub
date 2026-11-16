# 04: Invitations de plataforma

**What to build:** El Owner crea una Platform invitation (sin Space) desde la sección «Inicio de sesión», copia el enlace y se lo manda a alguien. Esa persona lo abre, entra o se registra en Keycloak y tiene su User, sea cual sea el Registration mode. Es la forma de dar de alta a mano. Las Platform invitations duran 7 días, son de un solo uso y se pueden revocar. Ver spec, «Modelo» y «Admisión».

**Blocked by:** 03

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `space_invitations.space_id` y `role` nulos juntos (CHECK); una fila sin Space es una Platform invitation.
- [ ] `InvitationService`: crear, listar y revocar Platform invitations (Owner; `AccessPolicy` con una acción nueva o la de Owner); la vista previa devuelve `kind: "platform"`; el resto de lecturas de Invitations por Space no las ven.
- [ ] `GET/POST /api/installation/invitations` (Owner), revocar por `/api/invitations/revoke`. Declarados en `HTTP_ENDPOINT_RULES`.
- [ ] Filas nuevas en la suite de `KeycloakAdmission`: identidad nueva con Platform invitation crea User en los tres modos; un User existente recibe «ya tienes cuenta» y la Invitation queda sin gastar.
- [ ] Aceptar una Platform invitation con credenciales locales funciona igual mientras el inicio local esté permitido (o Keycloak apagado), sin crear membership.
- [ ] Web: lista de Platform invitations pendientes con «Copiar enlace» al crear y «Revocar»; `/invite` dice «Invitación a <Hub>» sin nombre de Organization.
- [ ] Auditoría `invitation.create`, `invitation.accept`, `invitation.revoke` sin Space.
- [ ] Tests en la frontera del servidor: crear como Owner y 403 para un Admin; aceptar en modo cerrado; caducidad con `TestClock`; uso único; revocada.
