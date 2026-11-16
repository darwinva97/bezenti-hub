# 09: Descargar mis datos

**What to build:** Un User pide desde su modal de Usuario (o desde la puerta de términos, o desde la pantalla de borrado pendiente) una exportación de sus datos. El Hub la prepara en segundo plano y la deja descargable 7 días en un `.zip`. Incluye su perfil, los metadatos de los Projects de su Personal space, sus Threads (los del Personal space y los que creó en Organizations de las que sigue siendo Member) en JSON y en un Markdown legible con sus adjuntos, su vault personal (Variables con valor y Secrets solo con nombre), los Grants dados y recibidos y su consumo de IA. Nunca lleva el valor de un Secret ni Threads de otros.

**Blocked by:** `../settings-modals/` (modal de Usuario), `../owned-resources/` (vault personal con grupos, Secrets y Variables)

**Status:** ready-for-agent

Spec: ../spec.md («Descargar mis datos»)

- [ ] Servicio `AccountExport` con una tabla de exportaciones (estado, archivo y caducidad), una sola a la vez por User. Una exportación pendiente se reanuda si el Hub se reinicia.
- [ ] RPC para pedirla y ver su estado (`unscoped`: la cuenta propia de la sesión) y descarga por HTTP solo para su User.
- [ ] Primero tests en rojo: el zip contiene un Thread propio en una Organization y ninguno de otro Member; el valor de un Secret no aparece en ningún byte del zip; la descarga de otro User se niega; a los 7 días la exportación caduca (`TestClock`).
- [ ] Hay `AuditAction` `account.export`.
- [ ] La lista de permitidas de la puerta de términos (07) incluye pedir y descargar la exportación, y también la de la Organization suspendida (03) para sus Members.
- [ ] Web: «Download my data» en el modal de Usuario, con estado y enlace. Paleta: «Download my data». Móvil: pedirla y abrir la descarga en el navegador del sistema.
- [ ] Sin herramienta MCP (es una acción de la persona sobre su cuenta).
- [ ] `docs/user/install.md`: sección «Your account», con qué incluye y qué no.
