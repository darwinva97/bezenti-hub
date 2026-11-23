# 10: Móvil

**What to build:** En la app móvil, quien gestiona un Space ve sus access keys (etiqueta, modelos, caducidad, último uso, uso frente a cada tope) y revoca una. Crear, editar y renovar siguen en web y desktop. Ver spec, «Clientes» (Móvil) e historia 28.

**Blocked by:** 06.

**Status:** ready-for-agent

**Tipo:** AFK

Spec: ../spec.md

- [ ] La forma de las filas (estado, «Expires in…», usado / tope / reinicio) en `packages/client-runtime` (junto a `ai-accounts-view`), compartida por web y móvil.
- [ ] `apps/mobile`: «Access keys» dentro de los ajustes de AI accounts del Space, solo con `accessKey.view` según el Hub; «Revoke» con confirmación.
- [ ] `noOwnerControls.test.ts` (o su gemelo): el código móvil nunca llama `accessKeys.create` ni `accessKeys.update`.
- [ ] Test de la pantalla con una clave caducada, una con el tope diario alcanzado y una sin topes.
- [ ] Docs: «Clients: desktop and mobile» de `ai-gateway.md`.
- [ ] Cómo construirlo para un dispositivo, como en spec 4 ticket 12 (no se ejecuta aquí).
