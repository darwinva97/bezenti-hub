# 06: Renovar, ampliar y cambiar topes

**What to build:** Quien gestiona el Space renueva o extiende una access key (también una caducada), sube o baja sus topes y cambia modelos, cuentas y etiqueta, con efecto en la siguiente petición y sin cambiar la clave, así que quien la tiene no toca su setup. Una revocada no se renueva. Ver spec, «Validez», «Topes de tokens» y «Auditoría».

**Blocked by:** 02, 03, 05.

**Status:** done (design: `06-design.md`)

**Tipo:** AFK

Spec: ../spec.md

- [x] WS `accessKeys.update {keyId, label?, validity?, models?, accounts?, limits?, unlimited?}` con `access:write` y `accessKey.manage`; la fila se relee en la transacción y se cambia solo desde lo leído («changed meanwhile»); revocada → `invalid`; Space archivado o congelado → `forbidden`.
- [x] Validez nueva: como mucho 366 días desde el cambio; una caducada vuelve a funcionar.
- [x] Auditoría `access_key.update` con `changed`, los nuevos `expiresAt` y `limits`, `via: renew` cuando solo cambia la caducidad.
- [x] Web: «Renew» (con «Used X of Y total» y la opción de subir el total), «Edit» (topes, modelos, cuentas, etiqueta); la lista enseña las caducadas con «Renew».
- [x] Red-first: renovar una caducada la hace funcionar con la misma clave; bajar el tope diario por debajo de lo usado rechaza la siguiente petición; subir el total devuelve el servicio; quitar un modelo lo rechaza en la siguiente; una revocada no se renueva; un Member no puede.
- [x] Docs: «Access keys» → cambios.
