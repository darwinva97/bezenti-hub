# 01: Los Secrets dejan de revelarse

**What to build:** Nadie vuelve a ver el valor de un Secret guardado, tampoco el Owner (ADR 0012). Desaparece «Reveal» de punta a punta: la puerta HttpApi `vaults.reveal` (`apps/server/src/vaults/http.ts`), `Vaults.authorizeReveal` y `Vaults.reveal` (`apps/server/src/vaults/Vaults.ts`), la acción `vault.reveal` de `AccessPolicy`, la regla `VAULT_REVEAL` de `DoorRules.ts`, la función de cliente en `packages/client-runtime/src/vaults.ts` y los botones de `VaultsSettings.tsx`. Un Secret se sustituye, renombra, describe o borra. Ver spec, «Secrets y Variables».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first: un test en `VaultDoors.test.ts` que pide el valor de un Secret como Owner con factor fuerte por cada puerta (WS, HttpApi, MCP) y espera que ninguna lo devuelva. Falla en `main` por `vaults.reveal`.
- [ ] `vaults.reveal` se quita del contrato (`EnvironmentHttpApi`), del servidor y de `HTTP_ENDPOINT_RULES`; `vault.reveal` sale de `Action` y de `VAULT_ACTIONS`; las filas de `AccessPolicy.test.ts` que la cubrían se borran.
- [ ] `DoorRules.test.ts` pasa de «solo `vaults/http.ts` llama a `reveal`» a «nadie lee un valor de Vault salvo `SecretDelivery` y `SecretMasker`».
- [ ] La auditoría deja de emitir `secret.reveal`; las filas viejas se siguen mostrando en el registro.
- [ ] Web y desktop: sin «Reveal», «Confirm and reveal», «Value of <NAME>» ni «Hide»; el temporizador de 60 s se borra. Móvil: `apps/mobile/src/features/vaults/noReveal.test.ts` sigue verde sin cambios de producto.
- [ ] La copia de la clave maestra (`vaults.masterKeyBackup`, `t3 secrets key export`) no cambia.
- [ ] Docs: `docs/internals/secrets.md` («Values out», «HTTP door», tabla de quién hace qué) se reescribe sin revelar; `docs/user/install.md` deja de mencionar revelar valores si lo hace.
