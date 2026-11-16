# 11: Móvil

**What to build:** La app móvil muestra el Plan y el uso del User, el uso y el Steward de una Organization, el aviso de cuota y los errores de límite, igual que web y desktop. El Owner ve los Users con su Plan y su uso y les cambia el Plan. Crear y editar Plans queda en web y desktop. Ver spec, «Clientes».

**Blocked by:** 01–10.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Pantalla Usuario → «Plan» con límites y uso (Personal space y Organizations que sostiene), con la lógica de `packages/client-runtime`.
- [ ] Pantalla Space → «Usage» (Admins y Steward) y «Steward» (quién es; aceptar o rechazar una oferta; ofrecer y cancelar).
- [ ] Aviso de cuota de disco o tráfico en el Thread y en el composer; los errores de límite al crear Thread, Project, Organization o Invitation muestran el mensaje compartido.
- [ ] Owner: lista de Users con Plan y uso; cambiar el Plan de un User. Sin crear ni editar Plans («Edit plans on web or desktop»).
- [ ] Prueba real con `test-t3-mobile`: un User en un Plan lleno ve el aviso y el error; el Owner le cambia el Plan desde el móvil y el aviso desaparece.
