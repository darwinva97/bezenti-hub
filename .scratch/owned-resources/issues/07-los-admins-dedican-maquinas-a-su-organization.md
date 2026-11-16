# 07: Los Admins dedican máquinas a su Organization

**What to build:** Un Admin de una Organization dedica una máquina a ella (página «Register this machine», `t3 join --dedicated` o instalación por SSH), y renombra, quita o mueve a otra Organization que administra las máquinas dedicadas a la suya. La máquina dedicada pasa a ser de la Organization. Cambiar el modo o el Space de una máquina pide poder en el origen y en el destino, como mover un Project. Ver spec, «Environments».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en `AccessPolicy.test.ts`: `environment.dedicate` decidido sobre la Organization de destino (Owner o Admin de ella; un Member, un Admin de Globex y un Admin de una archivada, no). Renombrar y quitar una dedicada: Owner o Admin de su Organization. Cambiar de Organization: Admin de las dos. Personal → dedicada: su dueño, si es Admin del destino; dedicada → personal: un Admin de su Organization, que pasa a ser el dueño.
- [ ] `EnvironmentRegistry.ts` y `environments/sshInstall/` usan la nueva regla; `HubWithEnvironments.dedicated.test.ts` y `HubWithEnvironments.sshInstall.test.ts` añaden el caso de un Admin.
- [ ] La página de alta y `t3 join --dedicated` ofrecen solo las Organizations que el User administra.
- [ ] El contrato de Environments (`packages/contracts/src/hubEnvironments.ts`) expone el dueño de una dedicada; el cliente lo muestra.
- [ ] Web, desktop y móvil: Settings → Environments muestra a cada Admin las dedicadas de sus Organizations con renombrar, quitar y cambiar de Organization.
- [ ] Auditoría `environment.register` con el dueño.
- [ ] Docs: `docs/user/install.md` («Dedicate a machine to an organization», «Add a machine over SSH») dicen que lo hacen los Admins; `docs/internals/sandboxes.md` si nombra quién dedica.
- [ ] Prueba real: un Admin de Acme dedica una máquina con `t3 join --dedicated`, un Member de Acme corre un Thread en ella y uno de Globex no la ve.
