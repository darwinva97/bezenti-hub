# 05: Variables

**What to build:** Cada grupo guarda, junto a los Secrets, Variables: configuración no sensible que se ve y se edita siempre, llega al agente como variable de entorno y no se enmascara. Una Variable puede pasar a Secret; un Secret nunca a Variable. `list_secret_names` distingue los dos tipos y devuelve el valor de las Variables. Ver spec, «Secrets y Variables» y «Herramientas del agente».

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `vault_entries.type` (`secret` | `variable`, por defecto `secret`) y `value_text` (solo Variables; `CHECK` de que un Secret no lo tiene y una Variable no tiene `value_id`).
- [ ] Red-first en `Vaults.test.ts`: `vaults.entries.list` devuelve `value` de una Variable a quien ve el grupo y nunca de un Secret; Secret → Variable se rechaza (`secret-is-write-only`); Variable → Secret sella el valor, vacía `value_text` y lo enmascara desde el siguiente turno, en una sola transacción.
- [ ] `DoorRules.test.ts`/`VaultDoors.test.ts`: la regla «ninguna respuesta lleva `value`» pasa a «solo entradas `variable` llevan `value`».
- [ ] `EffectiveVaults` y `SecretDelivery` entregan Variables en `secretEnv`; `SecretMasker` y `thread_secret_values` las ignoran. Caso en `HubWithEnvironments.secretEnv.test.ts`: el proceso recibe una Variable y el historial la muestra sin enmascarar.
- [ ] `list_secret_names`: cada elemento con `type` y, solo en Variables, `value` (`OrchestratorMcpListSecretNamesResult`). Descripción nueva; eval `evals/mcp-tool-use` corrido antes y después, con un caso nuevo que falla antes: el agente lee la Variable de la respuesta y usa `$NAME` para el Secret.
- [ ] Instrucciones de desarrollador de los agentes: la línea de secretos menciona Variables.
- [ ] Web y desktop: al añadir, elegir «Secret» o «Variable» (con el texto «Visible to everyone who receives this group»); las Variables se muestran con su valor y se editan en área de texto; acción «Make secret» con aviso de que lo ya impreso sigue visible. Panel «Secrets» del Thread con valores de Variables. Móvil igual, en `apps/mobile/src/features/vaults/`.
- [ ] Auditoría `secret.edit` con `type` y `op: "to-secret"`; nunca el valor de una Variable.
- [ ] Docs: `docs/internals/secrets.md` (modelo y masking, una frase cada uno); `docs/user/install.md` explica Secret frente a Variable en la sección de vaults.
