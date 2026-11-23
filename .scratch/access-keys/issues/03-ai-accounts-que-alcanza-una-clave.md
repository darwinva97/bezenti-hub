# 03: AI accounts que alcanza una clave

**What to build:** Quien crea una access key elige a qué AI accounts propias del Space llega: todas (por defecto, también las que el Space añada después) o una lista. La gateway enruta y hace failover solo entre ellas, evaluadas en cada petición; una cuenta que deja el Space deja de contar, y una clave sin cuentas lo dice. Ver spec, «AI accounts que alcanza».

**Blocked by:** 01.

**Status:** done (design: `03-design.md`)

**Tipo:** AFK

Spec: ../spec.md

- [x] Contracts: `AccessKeyCreateInput.accounts` (`null` = todas, o ids); al crear, cada id debe ser una cuenta de gateway propia del Space (si no, `invalid`).
- [x] `authorize`: `forSpace(spaceId)` ∩ `accounts_json` en cada petición; ninguna → 403 «No AI account this access key may use is available now.».
- [x] Enrutado con `planRoute` (`keyKind: "user"`): `acct-<id>/` fuera del alcance → 403; failover solo dentro del alcance y del mismo proveedor.
- [x] La lista y el formulario muestran tachada «No longer in this Space» una cuenta de la lista que el Space ya no tiene.
- [x] Web: selector de cuentas («All of this Space's accounts» por defecto, o una lista), con el aviso de ToS si alguna es una suscripción.
- [x] Red-first: una clave con solo la cuenta A no llega a B ni en failover; con `null`, una cuenta nueva del Space entra sin tocar la clave; deshabilitar la única cuenta de la clave da 403 en la siguiente petición; una cuenta `direct` del Space nunca es alcanzable.
- [x] Docs: «Access keys» → cuentas.
