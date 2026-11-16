# 04: Vault personal de cada User

**What to build:** Todo User tiene su vault personal, con su grupo `default` creado con su cuenta (y por migración para los que ya existen). Lo gestiona solo él: grupos, Secrets, defectos de su Personal space y choices de sus Projects ahí. Sus grupos llegan solo a su Personal space. El Owner ve en solo lectura los nombres del vault personal ajeno y no edita nada; deja de elegir los defectos de un Personal space ajeno. Ver spec, «Dueño» y «Vaults».

**Blocked by:** 03, `../../identity-and-access/issues/17-personal-space-siempre-disponible.md`.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en `AccessPolicy.test.ts`: Ana edita y gestiona su vault y elige en su Personal space; un Admin, otro User y el Owner no editan el de Ana; el Owner ve nombres; nadie más los ve. `vault.choose` en un Personal space: solo su User.
- [ ] El `default` personal se crea en la misma operación que el User (alta, aceptar una Invitation) y la migración lo crea para cada User existente sin uno.
- [ ] `VaultReach`: un grupo personal llega solo al Personal space de su dueño. Test en `EffectiveVaults.test.ts`: un Thread de Ana en Acme no recibe su `default` personal; uno en su Personal space sí.
- [ ] `vault.dangerousName` en el vault personal: su User, con la misma confirmación que hoy pide al Owner.
- [ ] `request_secret` en un Thread del Personal space ofrece a su User guardar en sus grupos.
- [ ] Web, desktop y móvil: sección «Mine» en Vaults para todo User; selector de defectos del Personal space para su User.
- [ ] Docs: `docs/user/install.md` gana un párrafo en la sección de Personal spaces (qué es tu vault y dónde llega); `docs/internals/secrets.md` («Who may») con la fila del vault personal.
- [ ] Prueba real: un Member de Acme sin otros permisos guarda un Secret en su `default`, su Thread personal lo recibe y lo enmascara; su Thread de Acme no lo recibe.
