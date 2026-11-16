# 08: Vault, AI accounts y máquinas en User settings y Space settings

**What to build:** Montar en su modal las secciones por dueño que construye `../owned-resources/` (componentes que reciben el dueño). Con dueño = el User, en User → Vault, AI accounts (con su uso, `AiUsageTab`, y las Local CLI keys, `LocalCliKeysSection`) y Machines (máquinas personales, cada una enlazada a su página del ticket 07). Con dueño = la Organization, en Space → Vault, AI accounts y Machines (dedicadas, cada una enlazada a su página, y el estado del Sandbox del Space). En el Personal space, esas secciones listan lo propio y llevan a User settings para gestionarlo. Lo prestado lo añade `../grants/`.

**Blocked by:** 03, 07; y en `../owned-resources/` los tickets de vault personal, máquinas propias y dedicadas y AI accounts de User y de Organization (04 y 06–09 según el orden de su spec)

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `/settings/vaults`, `/settings/ai-accounts` y `/settings/connections` redirigen a la sección de User settings que corresponde; las anclas de Organization, a Space settings del Space actual.
- [ ] Un Admin gestiona el Vault, las AI accounts y las máquinas de su Organization en Space settings; un Member los ve como le permite `../owned-resources/`.
- [ ] Space → Machines muestra el Sandbox del Space; la lista completa de Sandboxes sigue en Platform → Sandboxes.
- [ ] `CommandPalette` («Connect environment») y `HostedEmptyState.tsx` llevan a User → Machines.
- [ ] El Owner ve los recursos del Personal space de otro User en su Space settings en solo lectura, hasta `../platform-privacy/`.
- [ ] Sin sondeo nuevo: el refresco de `HubEnvironmentsSettings` solo corre con la sección abierta.
- [ ] Filas nuevas en las tablas de redirección y visibilidad.
