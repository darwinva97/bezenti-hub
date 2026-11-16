# 05 — Diseño: Secret files y Template entries

Ticket: `05-secret-files-y-template-entries.md`. Decisiones del Owner (`triage/decisions-2026-11-16.md`) por encima del spec: Q6 aceptada (enmascarado multilínea y variantes); fase 1 = clientes **solo web**. Construye sobre 01 (`class`/`revealable`) y 02 (Provider entries, `ProviderReads`, `DeliveredValueStore`, filas `delivered:`).

## 1. Datos — migración 122 `VaultEntryDelivery`

- **122**, no 121 (la toma el 03). Reconstrucción de `vault_entries` como en la 120, porque cambia el CHECK de `kind`. **Se escribe sobre la forma que deje la 121**: si el 03 también reconstruye la tabla, la 122 se rebasa al final.
- `kind IN ('own','copy','link','provider','template')`.
- `delivery TEXT NOT NULL DEFAULT 'env' CHECK (delivery IN ('env','file','none'))`. Lo existente queda `env`.
- `template_text TEXT CHECK (length(template_text) <= 65536)`: solo nombres y texto literal, en claro.
- CHECK nuevos (tabla «Combinaciones válidas» del spec):
  - `(kind = 'template') = (template_text IS NOT NULL)`;
  - `kind = 'template'` ⇒ `value_id`, `linked_entry_id` y `provider_id` NULL, `revealable = 0`, `delivery <> 'none'`;
  - se amplía `(kind IN ('link','provider','template')) = (value_id IS NULL)`.
- **`none` no es un CHECK** porque cruza filas. Es un aviso de put, `not-used-by-template`, cuando ninguna plantilla del mismo Vault la nombra. El mismo aviso se da a las entradas que una plantilla borrada deja huérfanas.
- **`class` de una plantilla** se guarda para el CHECK y la lista: `variable` solo si todas sus entradas lo son.
  - `Vaults.putEntry` la recalcula, en la misma transacción, para las plantillas que nombran una entrada que cambia de clase o de nombre.
  - **Al entregar** se recalcula otra vez con las entradas vivas: si la fila dice `variable` y alguna entrada es Secret, gana Secret. Así falla hacia enmascarar.
- Test `122_*.test.ts`: las filas se conservan con `env`, y los CHECK rechazan una plantilla con valor, `none` o `revealable = 1`.

## 2. Executor contract 13 → 14

**Payload.** `SecretEnv` gana dos campos:

- `files: [{ name, content, mode: 0o400 | 0o600 }]`;
- `filesFolder`, un id opaco `[0-9a-f]{32}` igual a `HMAC(fingerprintKey, threadRoot ‖ userId)`. Es estable para (raíz del Thread, User) e imposible de adivinar sin la clave del Hub.

Límites: 64 KiB por archivo y 1 MiB en total. `name` pasa `secretNameProblem` y también es el nombre del archivo. Los cinco portadores (`provider.openSession`, `provider.startTurn`, `terminal.open`, `terminal.stream` y `launch.runSetupScript`) ya llevan `secretEnv`, así que no cambian de forma.

**Hello.** El hello del contrato 14 gana `secretFilesRoot: { path, inMemory } | null`. El Hub necesita la ruta para el filtro `path` (conflicto 3).

**Executor** (módulo nuevo `secrets/ThreadSecretFiles.ts`, el mismo en `EnvironmentAgent` y en la máquina del Hub):

- **Raíz:** `<XDG_RUNTIME_DIR | /dev/shm>/t3code-thread-files-<hash(stateDir)>/`.
  - Se comprueba con `statfs` que es tmpfs (`0x01021994`).
  - Reutiliza `ownFolder` de `SecretFilesDirectory`, que se extrae a un helper compartido: `mkdir 0700`, `lstat` sin seguir enlaces, dueño = uid.
  - Si no hay carpeta en memoria (macOS, Windows), `<stateDir>/thread-files/` 0700 en disco y `inMemory: false`. El Thread muestra un aviso, como hoy `request_secret`.
- **Escritura:** cada archivo se escribe en `.<name>.<rand>.tmp` con `O_CREAT|O_EXCL|O_NOFOLLOW` y modo 0600, y luego se hace `rename` atómico. Después, la función `materialize(secretEnv)` devuelve un `SecretEnv` **sin `files`**, con `NAME=<ruta>` como variable `plain`. Los adaptadores, `applySecretEnv` y el gestor de terminales no cambian.
- **Vida:** `hold(folder)` es un recurso con contador, ligado al Scope del proceso:
  - la sesión de provider usa su scope;
  - la terminal, `process.onExit` en `terminal/Manager.ts`;
  - el setup script, su ejecución.
  - Al soltar el último, se borra la carpeta.
  - Al arrancar, el executor barre su raíz entera (también el Hub barre la suya).
- **`secrets.refreshFiles { filesFolder, files }`:** operación nueva.
  - Reescribe con `rename` solo si la carpeta está retenida. Si no hay procesos, responde `not-held` y **nunca crea** la carpeta.
  - Cada `materialize` de un proceso nuevo también reescribe los archivos de una carpeta viva, así que los procesos más viejos ven el valor nuevo con la misma ruta.
- **Contenido:** nunca va en argv ni en logs. `knowSecrets` recuerda el contenido para enmascarar.

**Máquina con contrato < 14 y algún `file`**, falla cerrado en dos sitios:

1. `SecretDelivery.plan` falla con `SecretDeliveryError { reason: "outdated-machine-files" }`: «<máquina> needs an update to receive this Thread's secret files».
2. La última guarda de `RemoteEnvironments.invoke` rechaza un payload con `secretEnv.files` no vacío. No lo envía, no lo convierte a `env` y no lo escribe en disco.

Un executor 13 descodificaría `files` como clave sobrante y la ignoraría (el proceso arrancaría sin la variable), pero nunca la recibe. Sin archivos, todo sigue como hoy.

**Por máquina:**

- **Sandbox (Podman, dedicada):** el `t3 serve` del contenedor usa el `/dev/shm` privado del contenedor, que es tmpfs con `nosuid,nodev,noexec`. No hace falta cambiar `podman run`.
- **Personal Linux:** `$XDG_RUNTIME_DIR`.
- **macOS y Windows:** disco con aviso (regla del spec). En Windows 0700 no protege nada: se dice en el aviso.
- **Máquina del Hub:** igual que una personal Linux. Todos los Users comparten la uid (ADR 0004, riesgo aceptado del spec).

## 3. Template entries

**Sintaxis** (parser puro en `packages/contracts`, el mismo en web y server):

- `{{ NOMBRE }}` y `{{ NOMBRE | f1 | f2 }}`; los filtros se encadenan de izquierda a derecha.
- Filtros: `base64`, `base64decode`, `urlencode`, `json` (escapa como cadena JSON **sin** comillas, para escribir `"{{ X | json }}"`), `trim` y `path`.
- `path` va solo, y solo sobre una entrada con `delivery = file`.
- `{{"{{"}}` es el único escape. Cualquier otro `{{` sin cerrar, filtro desconocido o lógica → `template-syntax`, red-first.

**Validación al guardar:**

- cada nombre es una entrada **del mismo Vault**, nunca otra plantilla → `template-input`;
- se admiten `own`, `copy`, `link` y `provider`, y en el futuro `identity`;
- como mucho 64 referencias.

Un nombre que luego desaparece deja la plantilla «broken»: no se entrega y no hace fallar el arranque, igual que un link roto. **Link y copia de una plantilla** → `not-linkable` (conflicto 4).

**Resolución:**

- **En `plan`** no se lee ningún valor.
  - Las entradas de cada plantilla se buscan por entry id en su Vault, aunque estén sombreadas o sean `none`.
  - Las Provider entries entran en la misma ronda de lectura agrupada de `ProviderReads`.
  - Huella `[NOMBRE, "t:" + HMAC(template_text ‖ huellas de las entradas ‖ filesFolder)]`.
- **En `resolve`:**
  - se leen los valores propios;
  - los de proveedor vienen de la caché;
  - se renderiza con `path = secretFilesRoot/filesFolder/NOMBRE`;
  - la salida va a `variables` o `files` según `delivery`.
- **Fallos:** si una entrada falla, falla la plantilla con el error de esa entrada, y el arranque entero (Q3). `base64decode` inválido → `SecretTemplateError { template, input }`, sin valores.
- **Entradas `none`:** no forman parte del conjunto efectivo de nombres, así que no sombrean la del mismo nombre de otro Vault (conflicto 8). `turnNames` las excluye.
- **Clase:** una plantilla Secret se sella como `delivered:<hmac>` (patrón del 02) y se pasa a `remember`, y cada entrada Secret también. Una plantilla de solo Variables viaja `plain` y no se enmascara.

## 4. Enmascarado multilínea

- En `secretForms` (`packages/shared/src/secretMasking.ts`), si el valor tiene `\n`, se añade como forma cada línea que, sin `\r` y recortada, mide 20 caracteres o más y no tiene espacios. Por ejemplo, el cuerpo de un PEM o un token en su línea. A esas líneas no se les añaden variantes.
- El valor entero conserva sus formas de hoy.
- **Las variantes base64 (tres alineaciones) y urlencode ya existen** para todo valor de 6 caracteres o más, también los multilínea. Se mantienen: enmascaran de más, nunca de menos.
- El autómata sigue siendo uno: el índice de dos caracteres no cambia. Test de rendimiento: 50 secretos, 3 de ellos kubeconfigs, contra 1 MiB de texto, con un umbral fijado en el test.
- Lo mismo se aplica en el executor (`rememberKnownSecrets`) y en el Hub (`SecretMasker`).

## 5. Puertas y acceso

**`vaults.entries.put`** gana `delivery?` y `template?: { text }`, que excluye a `value` y a `provider`.

- Crear o editar una plantilla y cambiar `delivery` requieren `vault.edit` (Owner y Admin), salvo `delivery` de una Provider entry, que sigue siendo solo del Owner (`vault.providerEntry`).
- Avisos: `not-used-by-template` y `looks-like-credential` sobre el texto literal.

**`vaults.entries.preview` (WS, nueva):**

- entrada `{ vaultId, text }`; salida `{ rendered, problems }`, con `[NOMBRE]` en lugar de cada valor;
- requiere `vault.edit`;
- no llama a `readValue`, `ProviderReads` ni `DeliveredValueStore`, y `DoorRules.test.ts` lo comprueba.

**`VaultEntry`** gana `delivery` y `template: { text } | null`. El texto se trata como el valor de una Variable: Owner, Admin y Member lo ven, el Guest no (decisión 4).

**`vaults.reveal`** devuelve `sealed` para una plantilla. Una plantilla Variable tampoco muestra su valor renderizado en 05 (conflicto 11).

**Fuera de las puertas de Vaults:**

- **Executor:** contrato 14 (`files`, `filesFolder`, `secretFilesRoot` y `secrets.refreshFiles`).
- **MCP:** `list_secret_names` no lista las entradas `none`; la ruta del archivo llega en el 16.
- **Auditoría:** `secret.edit` con `op: add|template|delivery` y detalle `delivery`, nunca el texto.

**Web (`VaultsSettings.tsx`):**

- selector «Delivery» con Environment variable, File y Not delivered;
- fuente «Template» con editor y previsualización en vivo;
- insignias «File», «Not delivered» y «broken».

## 6. Tests red-first (se amplían los existentes)

- **`Vaults.test.ts`:**
  - plantilla con otro Vault, otra plantilla, sintaxis mala o `path` sobre una entrada `env` → rechazo;
  - `reveal` → `sealed`, con un store que falla en `get`;
  - clase Secret si alguna entrada lo es, y recálculo al cambiar la clase de una entrada;
  - link o copia → `not-linkable`;
  - aviso `none`;
  - el Guest no ve el texto.
- **`SecretDelivery.test.ts`:**
  - plan con contrato 13 y `file` → `outdated-machine-files`; sin archivos, sin cambios;
  - un fallo de proveedor de una entrada hace fallar la plantilla y no entrega nada;
  - render con los 6 filtros;
  - `none` no entra en las variables;
  - la huella cambia si rota una entrada.
- **`RemoteEnvironments`:** un link 13 nunca recibe un payload con `files` (guarda de `invoke`).
- **`ThreadSecretFiles.test.ts`** (nuevo, sobre un tmpfs falso con `T3CODE_SHM_DIR`):
  - 0600/0700;
  - un enlace plantado, otro dueño o un `filesFolder` con `../` → rechazo;
  - `rename` atómico;
  - `refreshFiles` sin carpeta retenida no crea nada;
  - el barrido al arrancar;
  - borrado con el último `hold`.
- **Testkit «Hub con Environments»:**
  - el archivo tiene 0600, `$NAME` lleva la ruta y `refreshFiles` cambia el contenido y no la ruta;
  - la carpeta desaparece al acabar el último proceso;
  - el contenido no aparece en `/proc/<pid>/cmdline`;
  - un kubeconfig mostrado con `cat` en una terminal sale enmascarado.
- **`SecretMasker.test.ts` y `secretMasking.test.ts`:** líneas de PEM y kubeconfig, base64 y urlencode, valores de un Thread cerrado, y el umbral de rendimiento.
- **Podman real** (`PodmanSandboxRuntime.testkit`): el archivo está en `/dev/shm` del contenedor con 0600, y `kubectl --kubeconfig "$KUBECONFIG" config view --raw` lo lee (conflicto 12).

## 7. Riesgos y fuera del ticket

**Riesgos:**

- Otro proceso de la misma uid lee los archivos: ADR 0004, se avisa en Settings.
- Sin enganche de salida, una terminal deja la carpeta viva hasta el barrido.
- El tmpfs de `/dev/shm` de Podman tiene 64 MiB; el límite de 1 MiB por entrega lo cubre.
- Más formas que enmascarar: se mide.
- El conflicto de migración con el 03.

**Fuera:**

- llamadas a `refreshFiles` por Lease o identidad (06 y 07; en 05 la operación existe y se prueba);
- `deliverTo` (14);
- `list_secret_names` con la ruta (16);
- clientes móvil y desktop nativos (16);
- valor renderizado de una plantilla Variable en la lista.

**Docs:** `docs/internals/secrets.md` gana «Secret files» y «Template entries».

## Conflictos y recomendación

1. **El ticket pide web y móvil, pero la fase 1 es solo web.** → Web, y desktop vía web; móvil en el 16.
2. **El brief pide un CHECK para «`none` solo si una plantilla la nombra»**, pero son dos filas y el spec dice «aviso». → Aviso, no CHECK.
3. **El spec hace que el executor elija la carpeta (`<aleatorio>`), pero `{{ X | path }}` se renderiza en el Hub.** → El Hub calcula `filesFolder` (HMAC estable, imposible de adivinar sin la clave) y la máquina publica `secretFilesRoot` en el hello del 14. El executor rechaza un id fuera de formato.
4. **La tabla del spec no define link ni copia de una plantilla.** → `not-linkable` en 05.
5. **El spec dice que `refreshFiles` se llama al renovar Leases o tokens, y en 05 no existe ninguno.** → La operación y el cliente se hacen en 05, pero solo los llaman 06 y 07. Además, cada proceso nuevo reescribe los archivos de una carpeta viva.
6. **El spec dice «se borra con el último proceso», y las terminales viven fuera de un Scope de petición.** → `hold` con contador, y en las terminales un enganche a `process.onExit` en `terminal/Manager.ts`.
7. **La clase de una plantilla depende de otras filas.** → Se guarda y se recalcula en el put. Al entregar se usa la clase viva, y gana Secret.
8. **El spec no dice si una entrada `none` sombrea a la del mismo nombre de otro Vault.** → No: queda fuera del conjunto efectivo de nombres.
9. **Q6 dice «variantes solo para Secrets de una línea», pero el código ya hace base64 y urlencode de todo valor de 6 caracteres o más.** → Se mantiene (más enmascarado), y se añaden solo las líneas.
10. **Migración: 121 es del 03.** → 122, escrita o rebasada sobre la forma final de la 121.
11. **Mostrar el valor de una plantilla Variable** sumaría una lectura de valores en `Vaults.ts` (`DoorRules` las cuenta). → No en 05.
12. **La imagen del Sandbox no trae `kubectl`.** → La prueba Podman instala `kubectl` en una imagen de test, o se pasa al pase real del 07 (kind/k3s). En 05 basta con `stat`/`cat` del archivo y el test de enmascarado.

## Cambios al construir (aprobados por el lead, 2026-11-16)

- **Sin respaldo en disco.** En macOS, Windows o cualquier máquina cuya raíz no esté en memoria (statfs ni tmpfs ni ramfs), una entrada `file` falla cerrada: `SecretDeliveryError files-not-in-memory` con la máquina y las entradas. Nunca se escribe en disco ni pasa a `env`; el Owner puede cambiarla a `env`. El hello dice `secretFilesRoot.inMemory: false`.
- **Sin puerta `vaults.entries.preview`.** La previsualización usa el parser compartido de contracts en el navegador, con `[NOMBRE]`, sin leer nada. Una puerta no añadía nada y sería superficie nueva.
- La 121 del ticket 03 solo añade tablas: la 122 reconstruye `vault_entries` sobre la 120.
