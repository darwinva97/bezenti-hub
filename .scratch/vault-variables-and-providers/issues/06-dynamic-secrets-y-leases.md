# 06: Dynamic secrets y Leases

**What to build:** Provider entries dinámicas (`issue`): una emisión compartida por petición normalizada, Lease por raíz de Thread, User y scope, reutilización, renovación o reemisión según su vida restante, refresco en caliente de los Secret files, y revocación en cada «Losing reach», al archivar o borrar, tras inactividad y en el barrido al arrancar. En OpenBao: `kubernetes/creds`, `database/creds`, `aws/creds|sts` y `pki/issue`. Ver spec, «Dynamic secrets y Leases».

**Blocked by:** 04, 05

**Status:** needs-triage

- [ ] Migración: `secret_leases` (`lease_id` sellado).
- [ ] Contrato de driver: `issue`, `renew`, `revoke`; sintaxis `MÉTODO ruta?param=v#campo` con prefijos permitidos en `allowed_dynamic` del scope.
- [ ] Red-first: `DB_USER` y `DB_PASSWORD` de la misma petición salen de un solo Lease; dos Users del mismo Thread tienen Leases distintos.
- [ ] Con `TestClock`: reutiliza por encima de 1/3, renueva si es renovable y cabe en `max_ttl`, reemite si no; la reemisión refresca los archivos (`secrets.refreshFiles`) y cambia la huella para `env`.
- [ ] Red-first: revoca al archivar o borrar el Thread, al dar de baja al User, al quitar el permiso del Vault o del scope, al cambiar el Project de Space y tras una hora sin procesos; barrido de `revoking` y caducados al arrancar; fallo de revocación con reintento y auditoría.
- [ ] Los valores emitidos se registran en `delivered_values` y siguen enmascarados en el historial cuando el Lease ya caducó.
- [ ] Panel «Secrets» del Thread con la caducidad de cada Lease; `list_secret_names` con `expiresAt`.
- [ ] Auditoría `lease.issue|renew|revoke`.
- [ ] Prueba real: OpenBao con el motor `kubernetes` emite un token de solo lectura que `kubectl get pods` acepta y deja de valer tras revocarlo.
