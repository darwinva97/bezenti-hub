# Diseño: MCPs y Skills por Space, con credenciales desde el Vault

Issue: darwinva97/bezenti-hub#10. ADRs: 0004, 0006, 0008. Vocabulario: `GLOSSARY.md` (Space, Vault,
Vault group, Secret, Variable, Provider entry, Grant, Environment).

Estado: **decidido** (2026-11-26, darwinva97 en #10 delega las cinco preguntas: se toman las
recomendaciones de abajo). Base: `main` `5506cd13027`.

Decisiones:

1. Prestar un MCP con referencias: **A** (el Grant lleva sus Vault groups, con aviso y rotación). B
   para MCPs http, en otro ticket.
2. MCPs stdio: **solo Owner y Admin, con audit entry**. Sin lista de comandos permitidos por ahora.
3. Dónde corre: **en el Environment del Thread**, lanzado por el provider.
4. Skills de disco: **coexisten**; a igual nombre gana la del Space y el panel lo dice.
5. Alcance: **los providers que ya aceptan `mcpServers` y `secretEnv`**; el resto, «Not supported»
   escrito por adapter (§11).

## 0. Lo que ya existe y en qué se apoya

- **El proceso del provider ya recibe el Vault.** `SecretDelivery` entrega el conjunto efectivo
  (`EffectiveVaults.forThread`) como `secretEnv` de `provider.openSession`, solo al abrir la sesión,
  y el Hub no guarda los valores. Un MCP stdio que lanza el provider hereda ese entorno.
- **El cambio de conjunto ya reabre la sesión.** `ProviderSessionManager` compara el fingerprint del
  conjunto en cada apertura: una rotación o un Grant retirado llega al siguiente turno.
- **El enmascarado ya cubre lo entregado.** `SecretMasker` enmascara cualquier valor entregado al
  Thread (`thread_secret_values`).
- **Hoy no hay MCPs de terceros.** `mcpServers` va vacío en `ClaudeProvider.ts` y en
  `AntigravityDriver.ts`. Los providers solo reciben el MCP propio del Hub (`apps/server/src/mcp`).
- **Las Skills vienen del disco.** `provider/Drivers/ClaudeSkills.ts` las descubre en carpetas con
  scope `user` y `project`.

La idea central: **una referencia al Vault se resuelve en la máquina, desde el `secretEnv` que ya
llega**. El Hub nunca pone un valor en la configuración del MCP ni en otro campo del cable.

## 1. Glosario (a añadir a `GLOSSARY.md` al construir)

- **Space MCP** (no «MCP configurado», para no confundirlo con las tools MCP del Hub): un servidor
  MCP de terceros que pertenece a un Space y que el Hub pasa al provider de los Threads que lo eligen.
- **Space Skill**: un `SKILL.md` (con frontmatter) y sus archivos de apoyo, guardados en un Space y
  entregados a los Threads que la eligen. No contiene Secrets.
- **Vault reference**: `${NOMBRE}` dentro de un valor de un Space MCP. Nombra una entrada del Vault
  por su variable de entorno, nunca su valor.

## 2. Datos (migración: la siguiente libre en `public-hub-1`)

- `space_mcps`: `mcp_id` PK, `space_id`, `name` (UNIQUE por Space, `[a-z0-9-]+`, es la clave que ve
  el provider), `transport` (`stdio` | `http`), `config_json`, `enabled` (0/1), `created_by`,
  `created_at`, `updated_at`.
  - `config_json` stdio: `{ command, args[], env{} }`; http: `{ url, headers{} }`.
  - Cada valor de `args`, `env` y `headers` es un texto que puede llevar `${NOMBRE}`. **Nunca** un
    valor de Secret: al guardar se rechaza (`secret-literal`) un valor sin ninguna `${…}` en una
    cabecera `Authorization`, `Cookie` o `*-Token`/`*-Key`, o en una variable cuyo nombre contenga
    `TOKEN`, `KEY`, `SECRET` o `PASSWORD`. Es una regla nueva y propia (`secretNameRisk` no clasifica
    credenciales); no pretende ser completa, solo cerrar el error obvio.
- `space_skills`: `skill_id` PK, `space_id`, `name` (UNIQUE por Space, del frontmatter),
  `description`, `files_json` (ruta relativa → contenido; `SKILL.md` obligatorio; tope de tamaño
  total, p. ej. 256 KiB), `expects_json` (nombres de Vault que espera, solo nombres), `enabled`,
  `created_by`, `created_at`, `updated_at`.
- Elección, como los Vault groups: `space_mcp_defaults` / `space_skill_defaults` (Space, orden) y
  `project_mcp_choices` / `project_skill_choices` (`add` | `remove`).
- `grants.resource_kind` gana `space-mcp` y `space-skill`.

## 3. Referencias al Vault: al guardar y al arrancar

- **Al guardar** (`SpaceMcps.put`): cada `${NOMBRE}` debe existir en un Vault group que **alcance
  ese Space** (`VaultReach.reachesSpaceSql`). Si no, `unknown-reference` con el nombre tal como lo
  escribió el Admin, **sin decir si existe en otro Space**. El error es el mismo para «no existe en
  ningún sitio» y «existe en otro Space» (test red-first).
- **Al arrancar** (`ProviderSessionManager.open`, antes de abrir la sesión): por cada Space MCP
  efectivo se comprueban sus referencias contra `SecretDelivery.plan` (nombres, sin leer valores).
  - Si todas llegan: el MCP va en `provider.openSession` como `mcpServers` **con las referencias sin
    resolver**.
  - Si alguna no llega (no existe, grupo no elegido, `withheld` por `lent-dangerous` o
    `lent-machine`, Provider entry «broken», Lease fallido): ese MCP **no se envía** y el Thread lo
    muestra «Unavailable: `GITHUB_TOKEN` is not delivered to this Thread (<motivo>)». Nunca arranca
    con un valor vacío.
- **En la máquina** (`EnvironmentAgent`, junto a `openSessionWithSecrets`): se sustituye cada
  `${NOMBRE}` con el `secretEnv` recibido y se pasa al adapter. Si falta un nombre (carrera con una
  rotación), se descarta ese MCP y se informa como arriba. El valor queda en memoria del proceso,
  igual que hoy el resto del `secretEnv`.
- **Fingerprint:** el de la sesión incluye ahora la lista de Space MCPs (id + `updated_at`), así
  editar un MCP reabre la sesión en el siguiente turno, como una rotación.
- Funciona con todo lo que el Vault ya entrega: Secrets sellados, Provider entries, Dynamic secrets
  (con su Lease), Template entries y Secret files (su variable es la ruta del archivo).

## 4. Skills

- En la sesión, el Hub envía las Skills efectivas (nombre + archivos) en `provider.openSession`.
  La máquina las escribe en una carpeta temporal **propia de la sesión** (fuera del worktree, con
  permisos 0700) y la pasa al provider por su mecanismo de Skills; se borra al cerrar la sesión.
- `expects_json`: el panel del Thread cruza los nombres con `vaults.threadEnvironment` y avisa
  «This Skill expects `GITHUB_TOKEN` and this Thread does not receive it». No bloquea.
- **Decisión 4 (Skills de disco):** coexisten sin más en el primer corte. Si una Skill
  del Space y una de disco comparten nombre, gana la del Space y el panel lo dice. Importar y ocultar,
  en otro ticket.

## 5. Por provider (decisión escrita por adapter)

Ver tabla en §11. Regla: un provider que no acepta MCPs externos o Skills los marca «Not supported by
<provider>» en el panel del Thread; nunca falla el turno por ello. Un provider que rechaza
`secretEnv` (Cursor, Antigravity hoy) tampoco recibe un Space MCP con referencias: queda
«Unavailable: <provider> cannot receive secrets».

## 6. Quién hace qué

| Acción                                                     | Owner | Admin (de la Org) | Member | Guest |
| ---------------------------------------------------------- | ----- | ----------------- | ------ | ----- |
| Crear, editar, desactivar, borrar un Space MCP **http**    | sí    | sí                | no     | no    |
| Crear o editar un Space MCP **stdio** (ejecuta un comando) | sí    | sí                | no     | no    |
| Crear, editar, desactivar, borrar una Space Skill          | sí    | sí                | no     | no    |
| Elegir por Space (defaults) y por Project                  | sí    | sí                | no     | no    |
| Ver nombres, transporte, estado y Skills                   | sí    | sí                | sí     | sí    |
| Ver la configuración (con referencias, nunca valores)      | sí    | sí                | no     | no    |
| Prestar / retirar (Grant)                                  | sí    | sí                | no     | no    |
| Aceptar / devolver un préstamo                             | sí    | sí                | no     | no    |

En un Personal space, su User hace lo del Admin. `AccessPolicy` gana `spaceMcp.view`,
`spaceMcp.viewConfig`, `spaceMcp.manage`, `spaceMcp.manageStdio`, `spaceSkill.view`,
`spaceSkill.manage`. Quien no ve el Space recibe not-found en todas.

**Decisión 2:** en el primer corte basta Owner/Admin + audit entry. Una lista de
comandos permitidos por el Owner (como los comandos de Secret providers) queda como ticket aparte si
el Owner la quiere; añadirla después no cambia los datos.

## 7. Préstamos (Grants)

- `space-skill`: misma mecánica que un Vault group. Aparece enlazada y de solo lectura en el Space
  prestatario, se elige como las propias y deja de llegar en el siguiente turno al retirarla.
- `space-mcp`: **Decisión 1: A.** El Grant del MCP **lleva obligatoriamente los Vault
  groups de los que depende**: al dar el préstamo se crean, en la misma transacción, los Grants de
  esos grupos (o se exigen ya activos), con el aviso de siempre («X's agents can read these
  Secrets») y la lista para rotar al retirar. Al retirar el MCP se retiran los grupos que se
  prestaron con él. Las referencias se resuelven en el prestatario como cualquier otra.
  - Los nombres `dangerous` no se entregan desde un préstamo (regla existente): un MCP prestado que
    dependa de uno queda «Unavailable».
  - El prestatario ve nombre, transporte y estado; **nunca** `config_json`.
  - Un MCP prestado no se vuelve a prestar (`not-lendable`, como un `default`).
  - B (el Hub inyecta la credencial para MCPs http, como la AI gateway) queda como ticket siguiente.
- `Grants.endRow` / `GrantEnding.endGone` limpian defaults y elecciones del prestatario, como
  `VaultReachLoss.forgetLentReach`.

## 8. Puertas, auditoría, agente

- **WS** (en `RPC_SPACE_ACCESS` y `CLIENT_GUARDED_RPC_SCOPES`): `spaceMcps.list|get|put|setEnabled|
  delete`, `spaceSkills.list|get|put|setEnabled|delete`, `spaceMcps.spaceDefaults.set`,
  `spaceMcps.projectChoices.set` (y lo mismo para Skills), `spaceMcps.threadStatus` (por Thread:
  nombre, estado, motivo). `list` nunca lleva `config`; `get` lo lleva solo con `viewConfig`.
- `DoorRules.test.ts` y `RpcAuthorization.test.ts`: todas las puertas nuevas; ninguna respuesta lleva
  `value`, `valueId`, `secretEnv`.
- **Audit:** `space_mcp.create|update|enable|disable|delete` (con `transport` y, si stdio, `command`
  sin argumentos), `space_skill.create|update|enable|disable|delete`, `space_mcp.choose`,
  `space_skill.choose`. Etiquetas en `AUDIT_ACTION_LABELS`.
- **Tool MCP del Hub:** `list_space_mcps_and_skills` (sin parámetros, `Tool.EmptyParams`): nombres,
  estado y motivo por Thread. Nunca configuración. Cambio medido en `agentContextBudget.json`.

## 9. Cómo se deshace

- Desactivar ↔ activar (fila queda, deja de llegar al siguiente turno).
- Borrar: borra la fila, sus elecciones y termina sus Grants (`resource-gone`); los préstamos de
  grupos hechos con él siguen su propio ciclo.
- Devolver o retirar un préstamo: como cualquier Grant; se ve en la lista de Grants.
- La migración se revierte borrando las tablas nuevas; nada existente cambia de forma.

## 10. Cortes (cada uno se sostiene solo)

1. Datos + servicio + puertas + audit de Space MCPs y Skills (sin entrega). Tests de puertas,
   referencias al guardar (red-first: referencia de otro Space), Member sin config, not-found.
2. Entrega a Claude y Codex: referencias en la máquina, «Unavailable» con motivo (red-first: grupo
   desvinculado, Grant retirado, Lease caducado), fingerprint. Skills a Claude.
3. Resto de providers según §11 (o «Not supported» escrito).
4. Grants `space-skill` y `space-mcp` (opción A).
5. Web (Settings del Space), móvil, tool MCP del Hub, docs (`docs/internals/secrets.md` «Who reaches
   what», `docs/user/`).

**Decisión 5:** el primer corte cubre los providers que ya aceptan `mcpServers` y
`secretEnv`; el resto queda «Not supported» escrito por adapter hasta su ticket.

**Decisión 3:** el MCP corre donde corre el provider (el Environment del Thread),
como hoy los comandos. Un MCP alojado en el Hub o el Sandbox del Space es la opción B de la
Decisión 1 y va con ella.

## 11. Soporte por provider

Los siete adapters ya inyectan el MCP propio del Hub (`t3-code`) al abrir sesión o turno: ahí se
añaden los Space MCPs, uno por nombre, sin tocar el `t3-code`.

| Provider    | Dónde añadir Space MCPs                                                      | Skills hoy                                    | Recibe `secretEnv`           | Primer corte                                                                |
| ----------- | ---------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| Claude      | `claudeMcpQueryOverrides` (`ClaudeAdapterV2.ts`), `mcpServers` del SDK       | `ClaudeSkills.ts` (disco); SDK `plugins`      | sí                           | MCPs y Skills                                                               |
| Codex       | `codexThreadRuntimeParams`: `mcp_servers.<nombre>` en el `config` por Thread | `skills/list` del app-server; sin ruta propia | sí (app-server propio)       | MCPs; Skills a investigar (override de `config`), si no «Not supported»     |
| Grok        | ACP compartido (`provider-acp` `acpMcpContext`), array `mcpServers`          | catálogo del CLI                              | sí                           | MCPs; Skills «Not supported»                                                |
| Kiro        | ACP compartido                                                               | ninguna                                       | sí                           | MCPs; Skills «Not supported»                                                |
| OpenCode v1 | `client.mcp.add` (`provider-opencode` `adapter.ts`)                          | `app.skills` del servidor                     | sí (sin `serverUrl` externo) | MCPs; Skills «Not supported»                                                |
| OpenCode v2 | `client.mcp.add` (`v2/adapter.ts`)                                           | `app.skills`                                  | no                           | MCPs sin referencias; con referencias «Unavailable»                         |
| Cursor      | `cursorMcpServers()` (`provider-cursor` `adapter.ts`)                        | `skills.ts` (disco)                           | no (SDK en proceso)          | MCPs sin referencias; con referencias «Unavailable»; Skills «Not supported» |
| Antigravity | ACP compartido (`mcpOverHttp`)                                               | `AntigravitySkills.ts` (disco)                | no                           | MCPs http sin referencias; resto «Unavailable»; Skills «Not supported»      |

Las Skills por carpeta temporal (§4) son baratas para quien ya lee carpetas (Claude con `plugins` o
`additionalDirectories`, Cursor, Antigravity), pero escribir en `~` o en el worktree mezclaría el
Space con la máquina: solo se hace donde el provider acepta una ruta por sesión.

## 12. Paso 2, tal como quedó

- Un Space MCP **activado** llega a todos los Threads de su Space. La elección por Project (como
  los Vault groups) queda para un paso posterior: hoy se desactiva el MCP entero.
- Al abrir la sesión, `SpaceTools.forSession` decide cada MCP con `decideSpaceMcps`: «not-supported»
  (el provider no los recibe), «outdated-machine» (executor < 17), «no-secrets» (el provider no
  recibe `secretEnv` y el MCP tiene referencias), «not-delivered» (con los nombres que faltan). Solo
  los disponibles viajan en `provider.openSession` (`spaceMcps`, contrato 17), sin resolver.
- La máquina los resuelve con `resolveSpaceMcps` desde el `secretEnv` de la sesión; si falta un
  nombre, descarta ese MCP entero.
- El fingerprint de la sesión incluye los MCPs enviados (id + `updated_at`): editar o desactivar uno
  abre un proceso nuevo en el siguiente turno. Un Thread cuyo Space tiene MCPs recibe su propia
  sesión (`Orchestrator.receivesSecrets`), como uno con Secrets.
- Claude (`mcpServers` del SDK) y Codex (`mcp_servers.<nombre>` por Thread) los reciben. El resto de
  adapters no declara `receivesSpaceMcps`: «not-supported» hasta el paso 3.
- `spaceTools.threadStatus` (puerta `thread`) muestra disponible / no disponible y el motivo según
  lo que el Vault entrega al Thread.

## 13. Paso 3, tal como quedó: decisión por adapter

| Provider    | Space MCPs                                                        | Space Skills                                            |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Claude      | sí (`mcpServers` del SDK)                                         | sí: carpeta de plugin local de la sesión (`plugins`)    |
| Codex       | sí (`mcp_servers.<nombre>` del Thread)                            | no soportado: el app-server no toma una ruta por sesión |
| Grok        | sí (ACP `mcpServers`; http solo si el agente lo anuncia)          | no soportado: su catálogo viene del CLI                 |
| Kiro        | sí (ACP, igual que Grok)                                          | no soportado: no tiene Skills                           |
| OpenCode v1 | sí (`client.mcp.add`, solo con servidor propio de la sesión)      | no soportado: `app.skills` lee del disco                |
| OpenCode v2 | no soportado: no recibe `secretEnv`                               | no soportado                                            |
| Cursor      | no soportado: el SDK corre en el proceso del Hub, sin `secretEnv` | no soportado                                            |
| Antigravity | no soportado: no recibe `secretEnv`                               | no soportado                                            |

- Las Skills van en `provider.openSession` (`spaceSkills`, contrato 17). Claude las escribe en una
  carpeta temporal de la sesión (`.claude-plugin/plugin.json` + `skills/<nombre>/…`) que se borra
  al cerrarla; un path que salga de su carpeta se ignora también en la máquina. Claude las muestra
  con el prefijo del plugin (`space:<nombre>`).
- `spaceTools.threadStatus` lista además las Skills activadas y los nombres de Vault que esperan y
  el Thread no recibe.
