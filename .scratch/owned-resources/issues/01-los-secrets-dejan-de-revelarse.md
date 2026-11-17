# 01: Los Secrets dejan de revelarse

> Reescrito el 2026-11-16 sobre lo ya construido en `../../vault-variables-and-providers/` (tickets 01–05 y 07, migraciones 119–123): las entradas ya tienen `class` (`secret` | `variable`), `revealable`, `kind` (`own`, `copy`, `link`, `provider`, `template`, `identity`) y `delivery`. Este ticket solo quita revelar; no toca `class`, `kind` ni `delivery`.

**What to build:** Nadie vuelve a ver el valor de un Secret guardado, tampoco el Owner (ADR 0012). Hoy un Secret puede ser `revealable` (los que existían antes de la migración 119 lo son, y uno nuevo si se creó con `allowReveal`) y el Owner lo revela con factor fuerte. Desaparece «Reveal» de punta a punta y todo Secret queda sellado. Las Variables (`class = 'variable'`) no cambian: se siguen leyendo con `vault.readVariables`. Ver spec, «Secrets y Variables».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first: un test en `VaultDoors.test.ts` que pide el valor de un Secret `revealable` como Owner con factor fuerte por cada puerta (WS, HttpApi, MCP) y espera que ninguna lo devuelva. Falla hoy por `vaults.reveal`.
- [ ] Migración (siguiente número libre al integrar): `UPDATE vault_entries SET revealable = 0 WHERE revealable = 1`. La columna se queda (la CHECK de `class`/`revealable` la usa); deja de tener sentido y el código deja de leerla. Test de migración: un Secret revelable queda sellado; una Variable y un link no cambian.
- [ ] Servidor: fuera la puerta HttpApi `vaults.reveal` (`apps/server/src/vaults/http.ts`), `Vaults.authorizeReveal`, `Vaults.reveal`, la acción `vault.reveal` de `AccessPolicy` (y de `VAULT_ACTIONS`), la regla `VAULT_REVEAL` de `DoorRules.ts` y su entrada en `HTTP_ENDPOINT_RULES`. `allowReveal` deja de existir en `vaults.entries.put`; toda escritura de Secret es sellada. Las filas de `AccessPolicy.test.ts` que cubrían `vault.reveal` se borran.
- [ ] Contratos (`packages/contracts/src/vaults.ts`): fuera `vaults.reveal` de `EnvironmentHttpApi`, `allowReveal`, el campo `sealed` del resumen de entrada (todo Secret lo es) y el motivo `sealed` de `VaultError`. Cambio de contrato: los clientes viejos dejan de ver el botón porque la puerta no existe; anotarlo en el commit.
- [ ] `DoorRules.test.ts` pasa de «solo `vaults/http.ts` llama a `reveal`» a «nadie lee el valor de un Secret salvo `SecretDelivery` y `SecretMasker`; el de una Variable, además `Vaults.list` con `vault.readVariables`».
- [ ] Cambio de clase: Variable → Secret sigue igual (sella). Secret → Variable sigue pidiendo un valor nuevo (ya lo hace `Vaults.ts` ~1727): no se rechaza, porque no expone el valor viejo; se documenta así en vez de `secret-is-write-only`.
- [ ] La auditoría deja de emitir `secret.reveal`; las filas viejas se siguen mostrando en el registro.
- [ ] Web y desktop: sin «Reveal», «Confirm and reveal», «Value of <NAME>», «Hide», la casilla «Allow reveal» ni el temporizador de 60 s. Móvil: `apps/mobile/src/features/vaults/noReveal.test.ts` sigue verde sin cambios de producto.
- [ ] La copia de la clave maestra (`vaults.masterKeyBackup`, `t3 secrets key export`) no cambia.
- [ ] Docs: `docs/internals/secrets.md` («Values out», «HTTP door», tabla de quién hace qué) sin revelar; `docs/user/install.md` deja de mencionar revelar si lo hace.
