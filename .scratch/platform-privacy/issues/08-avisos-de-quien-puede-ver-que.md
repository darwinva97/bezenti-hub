# 08: Avisos de quién puede ver qué

**What to build:** Una frase clara en cada sitio donde alguien decide qué compartir. Al aceptar los términos: el operador ve consumo y datos de cuenta, no contenido, y es una garantía de la aplicación. En el Personal space: solo tú ves su contenido. Al aceptar una Invitation: los Members de la Organization ven sus Projects y Threads. Al aceptar una máquina prestada: su dueño puede ver todo lo que corre en ella. Al compartir un grupo de Vault: los agentes de esa Organization pueden leer sus Secrets. Al aceptar un grupo de Vault: su dueño puede cambiar los valores. Los textos salen de un solo módulo compartido por web y móvil. Además, `docs/user/install.md` gana una tabla corta, «Who can see what».

**Blocked by:** 01, 07, `../grants/` (aceptar un Grant de máquina, compartir y aceptar un grupo de Vault)

**Status:** ready-for-agent

Spec: ../spec.md («Avisos de quién puede ver qué»)

- [ ] Hay un módulo de textos en `packages/client-runtime` que usan web y móvil, sin copias.
- [ ] Términos: el resumen va encima de los documentos en la página del 07 (web) y en la pantalla nativa (móvil).
- [ ] Personal space: el recordatorio del selector (`apps/web/src/components/sidebar/SpaceSelector.tsx` y su equivalente móvil) y el modal del Space del Personal space (`../settings-modals/`).
- [ ] Invitation: `apps/web/src/components/auth/InvitationSurface.tsx` y la aceptación en móvil.
- [ ] Máquina prestada: la pantalla de aceptación de `../grants/` nombra al dueño de la máquina. Si ese spec ya pone un aviso, aquí solo se unifica el texto.
- [ ] Grupo de Vault: el aviso aparece al compartir (quien presta) y al aceptar (el Admin).
- [ ] Un test de navegador por pantalla de decisión comprueba que el aviso está montado. El texto no se testea. Una pasada en móvil real.
- [ ] `docs/user/install.md`: tabla «Who can see what» (operador, Members, dueño de una máquina prestada, agentes de un Space que recibe un grupo de Vault), con la línea sobre los límites de la garantía.
