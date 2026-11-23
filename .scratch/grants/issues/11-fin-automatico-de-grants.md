# 11: Fin automático de Grants

Spec: ../spec.md

**What to build:** Un Grant termina solo, con su motivo visible para las dos partes, cuando ocurre alguno de estos casos:

- su recurso se borra o cambia de dueño;
- su Space destino se borra;
- su prestador (User u Organization) desaparece.

Archivar el destino no lo termina. Cada caso pasa por el mismo camino que «Retirar» de su tipo, dentro de la transacción que lo causa. Ver spec, «Fin automático».

**Blocked by:** 02, 07, 10.

**Status:** done (design: 11-design.md)

- [x] Recurso borrado (AI account, Vault group, máquina) → `resource-gone`. Cambio de dueño (si `owned-resources` lo permite) → `owner-changed`: hoy no lo permite (máquina prestada: `machine-lent`); dedicar una máquina cancela sus enlaces abiertos.
- [x] Organization destino borrada (flujo de borrado de `OrganizationLifecycle.ts`) o Personal space borrado → `target-gone`. Archivada → sigue `active` sin uso; al restaurarla vuelve a usarse.
- [x] User prestador borrado (borrado de cuenta de `platform-privacy`) u Organization prestadora borrada → `lender-gone`.
- [x] Red-first por cada caso: después no queda acceso (gateway, conjunto efectivo, conexión de Sandbox) y la auditoría registra `grant.end` con el motivo.
- [x] Que el prestador deje la Organization destino no termina el Grant (test).
- [x] «Préstamos dados» y «Prestado a este Space» muestran los terminados con su motivo y fecha.
