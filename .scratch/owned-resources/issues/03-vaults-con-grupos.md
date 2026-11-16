# 03: Vaults con grupos

**What to build:** Cada dueño (un User o una Organization) tiene un único Vault formado por grupos: un `default` que no se borra, no se renombra ni se archiva, y grupos con nombre. La fila de `vaults` pasa a ser un grupo (`vault_groups`, con dueño e `is_default`) y las tablas que la nombran pasan a nombrar grupos, para que el spec de Grants preste un grupo sin otra migración. La migración convierte lo que existe: el Main vault en el `default` del Owner, los demás Vaults del Owner y los de cada Organization en grupos con nombre (con allowances, defectos y choices), y los Secret links y copias en Secrets independientes. En este ticket solo el Owner y los Admins de cada Organization editan; el vault personal de cada User llega en el 04. Ver spec, «Vaults: un Vault por dueño, grupos como filas».

**Blocked by:** 01.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración (siguiente número libre): `vaults` → `vault_groups` (`group_id`, `owner_kind`, `owner_id`, `is_default`; sin `space_id` ni `is_main`), un `default` por dueño existente (el Owner y cada Organization), nombres únicos por dueño, `default (old)` para un Vault que ya se llamaba así; `vault_entries` sin `kind` ni `linked_entry_id`, con cada link vivo convertido en Secret propio con el valor actual del original (`value_id` nuevo) y los links rotos borrados. Auditoría `secret.edit` `op: "unlinked"`.
- [ ] Test de migración con Main vault, otro Vault del Owner permitido a Acme y a un User, dos Vaults de Acme con defectos y choices, un link vivo, uno roto, una copia y un Vault llamado `default`: filas esperadas y el mismo conjunto efectivo (`EffectiveVaults.forThread`) para cada Thread de prueba antes y después, salvo el link roto.
- [ ] `VaultReach.ts` y `EffectiveVaults.ts` sobre grupos: `default` es defecto fijo de su Space; desaparece `MAIN_VAULT_ID`. Precedencia sin cambios. Los casos de `EffectiveVaults.test.ts` se reescriben sobre grupos sin añadir casos nuevos salvo `default`.
- [ ] `AccessPolicy`: `VaultResource` con dueño e `is_default`; `vault.manage` (crear, renombrar, archivar, borrar grupos) para el Owner y los Admins de la Organization dueña; `default` rechaza borrar, renombrar y archivar (`default-group`). Filas red-first en `AccessPolicy.test.ts` con Admin, Member y Guest de Acme y de Globex.
- [ ] Contratos (`packages/contracts/src/vaults.ts`): `VaultGroupId`, dueño en el resumen, `vaults.groups.list/create/update/delete` sustituyen `vaults.list/create/update/delete`; se borran `vaults.entries.link` y `vaults.entries.copy` con su `VaultEntryKind`. `RPC_SPACE_ACCESS`, `CLIENT_GUARDED_RPC_SCOPES` y `DoorRules` al día.
- [ ] Web y desktop: Settings → Vaults agrupa por dueño («Mine» para el Owner, una sección por Organization administrada), cada sección con sus grupos; `default` sin acciones de borrar ni renombrar. Aviso de una vez para el Owner con las entradas que eran links. `VaultChoices.tsx` elige grupos.
- [ ] Móvil (`apps/mobile/src/features/vaults/`) y el panel «Secrets» del Thread (web y móvil) muestran grupo y dueño en vez de Vault.
- [ ] `request_secret` «Also save to Vault» ofrece grupos.
- [ ] Docs: `docs/internals/secrets.md` («Vaults», «Allowing Vaults», «The effective set») se reescriben con grupos; GLOSSARY quita «Secret link»; `docs/user/install.md` donde nombra vaults de una organization.
- [ ] Prueba real con datos sembrados: tras migrar, un Thread del Owner y uno de Acme reciben las mismas variables que antes; un Admin de Acme crea un grupo, lo pone de defecto y un Thread nuevo lo recibe.
