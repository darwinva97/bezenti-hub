# 01 — Diseño: Variables y Secrets sellados

Ticket: `01-variables-y-secrets-sellados.md`. Decisiones del Owner (`triage/decisions-2026-11-16.md`) por encima del spec: Q1 añade «Seal» por entrada; Q4 cambia, **los Guests no ven valores de Variables** (ven el nombre y «Variable»).

## 1. Datos — migración 119 `VaultEntryClass`

Ninguna rama usa 119 (comprobado). Sobre `vault_entries` (spec 5, migración 111):

- `class TEXT DEFAULT 'secret'` y `revealable INTEGER DEFAULT 0`: **por defecto sellado**, así un INSERT que olvide la columna falla cerrado.
- Relleno: `UPDATE vault_entries SET revealable = 1 WHERE kind <> 'link'` (lo existente queda revelable) y `SET class = NULL, revealable = NULL WHERE kind = 'link'` (un link hereda de su original).
- CHECK (en `ADD COLUMN`, SQLite ≥ 3.37 los prueba contra las filas existentes): `(kind = 'link') = (class IS NULL)`, `(kind = 'link') = (revealable IS NULL)`, `class IN ('secret','variable')`, `revealable IN (0,1)`, `class <> 'variable' OR revealable = 0` (en una Variable, revealable no significa nada).
- «La copia de un sellado es sellada» no cabe en un CHECK (son dos filas): lo impone `Vaults.fromMain`, que copia `class` y `revealable` del original. Test de migración: lo de antes queda `secret`/1, los links NULL/NULL, y un INSERT inválido falla.
- Sin columnas de provider, template, entrega ni identidad (tickets 02+).

## 2. Puertas

- **Contratos** (`packages/contracts/src/vaults.ts`): `VaultEntryClass = "secret" | "variable"`. `VaultEntry` gana `class`, `sealed: boolean` (en un link, los de su original; en un link roto, `secret` + sellado) y `value: optionalKey(String)`, que solo lleva una Variable. `VaultEntryPutInput` gana `class?` y `allowReveal?`. `VaultWarning` gana `"looks-like-credential"`. `VaultErrorReason` gana `"sealed"` y `"needs-new-value"`.
- **`vaults.entries.list` y los resultados de put, link y copy (WS):** `value` solo si `class = variable` **y** `can("vault.readVariables")`. Es la única lectura nueva de valores en `Vaults.ts` (`readValue` pasa de 2 a 3), solo de filas Variable. `vaults.threadEnvironment` añade `class` y sigue sin valores; el spec dice que las Variables no viajan en lo del Thread.
- **`vaults.reveal` (HttpApi):** `authorizeReveal` mira `class`/`revealable` (de su original si es un link) y falla `sealed` antes de pedir el factor y antes de llamar a `readValue`. En HTTP, error nuevo `VaultSealedError` (409, `{ name }`) en el endpoint, para que el cliente lo distinga de un 403. Una Variable se puede revelar como hoy (el Owner ya ve su valor).
- **`vaults.entries.put` (WS):** reglas en este orden, cada una red-first:
  - Alta: `class` por defecto `secret`, sellado salvo `allowReveal: true` (requiere `value`, que el alta ya exige). `request_secret` → `SecretRequests` → `putEntry` sin `allowReveal`, así que guarda sellado.
  - **Seal**: `allowReveal: false` sobre un revelable. Sin valor. Para quien edita (reduce la exposición). Una sola dirección.
  - **Allow reveal**: `allowReveal: true` sobre un sellado **sin `value`** → `needs-new-value`. Con `value`, se escribe un value id nuevo y se borra el viejo sin leerlo (`withNewValue` + `removeValue`, como un replace).
  - **Variable → Secret**: quien edita; queda sellado salvo `allowReveal` con valor nuevo.
  - **Secret → Variable**: siempre con `value` (sin él → `needs-new-value`), por quien edita (equivale a borrarla y añadir una Variable). Sin puerta nueva: el camino «revelable + factor fuerte, sin valor» del spec queda para cuando alguien lo pida (decisión del lead, 2026-11-16).
  - En un link, `class`/`allowReveal` → `not-linkable` («cámbialo en el original»).
- **MCP:** `list_secret_names` no cambia (clase y valor de Variables: ticket 16). `request_secret` ya queda cubierto por el alta sellada.
- **Executor:** `SecretEnvVariable` gana `plain: optionalKey(true)` para las Variables; `EnvironmentAgent.knowSecrets` las salta. Un executor viejo ignora la clave y las enmascara en sus propios logs (sobra enmascarado, pero no se filtra nada), así que no hace falta subir de contrato.
- **Auditoría:** `secret.edit` con `op` `seal`, `allow-reveal` o `class` (detalle nuevo `class: "secret"|"variable"`, que se añade a la allowlist de `audit.ts`).

## 3. Enmascarado

- `EffectiveVariable` gana `class` (de su original si es un link). `SecretMasker.effectiveSet` filtra `!unmasked && class === "secret"`.
- La consulta del arranque para `rememberKnownSecrets` añade `AND class = 'secret'`.
- `SecretDelivery.resolve` pasa a `masker.remember` solo los Secrets: `thread_secret_values` nunca guarda Variables.
- Los Secrets no cambian: el aviso `short-value` y `unmasked` solo cuentan para `class = secret`.
- **Aceptado y documentado:** pasar una Variable a Secret no enmascara lo que ya se guardó en claro. Pasar un Secret a Variable deja enmascarado su historial anterior (de más, nunca de menos).

## 4. Acceso (`AccessPolicy`: acción nueva `vault.readVariables`)

| Acción                                                                                      | Owner             | Admin                                        | Member | Guest  |
| ------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------- | ------ | ------ |
| Ver nombre, clase y «Sealed»                                                                | sí                | sí                                           | sí     | sí     |
| Ver valor de Variable                                                                       | sí                | sí                                           | sí     | **no** |
| Añadir/editar Variables y Secrets, Seal, Variable→Secret, Secret→Variable (con valor nuevo) | sí                | sí (como `vault.edit`)                       | no     | no     |
| Allow reveal (siempre con valor nuevo)                                                      | sí                | sí (como `vault.edit`; solo el Owner revela) | no     | no     |
| Reveal de revelable (y de Variable, sin botón)                                              | sí, factor fuerte | no                                           | no     | no     |
| Reveal de sellado                                                                           | nadie             |                                              |        |        |

`vault.readVariables` es `vault.view` restringido a los roles `admin` y `member` (`ROLES_THAT_CREATE_PROJECTS`). En un Vault propio del Owner permitido: un User permitido directamente, o un Space permitido donde el User no es Guest. El Main vault: solo el Owner.

## 5. `looks-like-credential`

Una función pura `looksLikeCredential(name, value?)` en `packages/contracts` (junto a `secretNameRisk`), la misma en web (aviso en vivo en el formulario) y en el server (`warnings` del resultado de put). Sin valor (un cambio de nombre), solo mira el nombre. Detecta:

- nombres `*_TOKEN|_SECRET|_PASSWORD|_KEY|_PAT`;
- prefijos `ghp_ github_pat_ glpat- sk- xox AKIA -----BEGIN`;
- JWT de tres partes base64url;
- valores sin espacios, de 20 caracteres o más, que no son URL, con entropía de Shannon ≥ 4 bits/carácter.

**Nunca bloquea.**

## 6. Cliente web (`VaultsSettings.tsx`, `environments/primary/vaults.ts`)

- «Add a secret to <Vault>»: selector «Kind» (Secret, Variable) y casilla «Allow reveal» (desmarcada, oculta para una Variable). El aviso aparece en vivo y tras guardar.
- Lista:
  - insignias «Sealed» y «Variable»;
  - el valor de una Variable si viene; si no viene (Guest), solo «Variable»;
  - «Reveal <NAME>» solo en un revelable;
  - acción «Seal <NAME>» con confirmación: «no se deshace sin un valor nuevo»;
  - «Allow reveal» en un sellado abre el campo de valor nuevo;
  - «Make variable» abre el campo de valor nuevo, como «Allow reveal».
- Móvil y desktop quedan para el ticket 16. Los campos nuevos son opcionales, así que el móvil actual sigue funcionando y no muestra valores de Variables.

## 7. Tests red-first (se amplían los existentes, como pide `AGENTS.md`)

- `Vaults.test.ts`:
  - reveal de un sellado (propio, copia y link a un sellado) → `sealed`, con un `VaultValueStore` que falla si se le pide `get`;
  - Allow reveal sin valor → `needs-new-value`; con valor, el viejo no se lee (el mismo store) y se borra;
  - Seal: revelable → sellado sin valor; volver atrás sin valor se rechaza;
  - Secret→Variable por WS sin valor → rechazo; con valor → ok;
  - copia de sellado sellada; copia de Variable Variable;
  - link: muestra la clase y el sellado del original;
  - `list` como Guest: la Variable sin `value`; como Member, Admin y Owner, con `value`; un Secret nunca lleva `value`;
  - `request_secret` guardado → sellado (en `SecretRequests.test.ts`);
  - el aviso no bloquea.
- `http` de vaults: un sellado → 409 sin pedir el factor.
- `119_VaultEntryClass.test.ts`: filas existentes `secret`/1, links NULL; los CHECK rechazan combinaciones inválidas.
- `DoorRules.test.ts`:
  - la única respuesta WS de `vaults.*` con `value` es `VaultEntry.value`;
  - `readValue` aparece 3 veces en `Vaults.ts` (reveal, copia, Variables de la lista).
- `SecretMasker.test.ts` y `SecretDelivery.test.ts`: una Variable no se enmascara, no entra en `thread_secret_values` ni en `rememberKnownSecrets`, y viaja con `plain`.
- `AccessPolicy.test.ts`: tabla de `vault.readVariables`.
- Contracts: tabla de `looksLikeCredential`, con aciertos y falsos positivos típicos (URL, región).

## 8. Riesgos y fuera del ticket

- **Riesgos:**
  - el umbral de entropía (falsos positivos: se ajusta con la tabla de tests);
  - un Admin con «Allow reveal» deja al Owner leer lo que el Admin escribió (aceptable: el Owner ya lo recibe en sus Threads);
  - el executor viejo enmascara Variables en sus logs;
  - lo ya guardado en claro de una Variable que luego pasa a Secret.
- **Fuera:** Secret → Variable sin valor nuevo (revelable + factor fuerte), columnas o fuentes de provider/template/identity, entrega `file`, `deliverTo`, `list_secret_names` con clase y valor, clientes móvil y desktop (ticket 16), y enmascarado multilínea o de variantes.
- **Docs:** `docs/internals/secrets.md` gana «Variables y sellado» y «Lo que sellar no cubre».
