# bezenti: cómo se despliega este fork

Este repositorio (`darwinva97/bezenti-hub`) es el fork que usa bezenti de
[`EijunnN/bezenti-hub`](https://github.com/EijunnN/bezenti-hub) (a su vez un fork multiusuario de T3 Code).
Todo lo propio de bezenti está en esta carpeta y en `.github/workflows/bezenti.yml`; el resto del repo es
el código de Eijun (más los arreglos de compilación de abajo).

| Pieza            | Dónde                                                              | Qué                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Hub              | clúster k3s de `darwinva97/infra-contabo`, namespace `bezenti-hub` | `https://claude.bezenti.com` (temporal; luego `code.bezenti.com`). Guarda personas, permisos, hilos y secretos. **No ejecuta agentes.** |
| Máquina dedicada | la VPS personal (IP en las notas privadas), usuario `t3`           | Ejecuta el trabajo de la organización `bezenti` dentro de un Sandbox (Podman sin root).                                                 |

Documentación completa del despliegue (red, Access, Owner, VPS, riesgos): sección «T3 Code Hub» del
README de `darwinva97/infra-contabo`.

## Qué hay aquí

- `Dockerfile`: dos etapas. `compilar` (Debian 12 + Vite+ con Node 26.12.1 + Rust) compila servidor y web y
  empaqueta la CLI `t3` autocontenida para Linux x64 igual que la Release del original
  (`scripts/build-cli-archive.ts`, con su prueba `scripts/smoke-cli-archive.ts`). `hub` es Debian 12 slim con
  ese mismo árbol en `/opt/t3` (el ejecutable lleva Node 26.12.1 dentro), git, ssh, certificados,
  util-linux y tini; usuario 1000:1000; sin Chromium. `archivo` solo sirve para sacar el `.tar.gz`.
- `arranque.sh`: punto de entrada de la imagen. Ejecuta `t3 <args>` y quita de su salida el token de
  emparejamiento que `t3 serve` imprime en cada arranque (con su QR): vale 5 minutos y, aun con el Owner
  creado, deja emparejar un dispositivo **como el Owner**, y los logs los leen VictoriaLogs, Grafana,
  Backstage… El enlace queda en `/tmp/t3-acceso` dentro del contenedor (solo el usuario del Hub; se
  pierde al reiniciar): `kubectl -n bezenti-hub exec deploy/bezenti-hub -- cat /tmp/t3-acceso`.
- `Dockerfile.dockerignore`: lo que no entra en el contexto (`.git`, `.repos`, `node_modules`…).
- `../.github/workflows/bezenti.yml`: el CI (ver su cabecera).
- `../.github/workflows/bezenti-verify.yml`: la verificación de ramas (ver «Verificación de ramas en CI»).

## Versiones: Hub y VPS, siempre la misma

Un push a `main` **ya no despliega por sí solo**. `bezenti.yml` corre en ventanas (lun-vie a las 12, 15, 18 y 21
UTC, es decir 07, 10, 13 y 16 en Perú) y a mano:

- En cada ventana despliega el HEAD de `main` con todo lo acumulado, en una sola ejecución, solo si hay algo
  nuevo desde la última ejecución correcta y no es solo `docs/`, `.scratch/`, Markdown o archivos de prueba
  (`*.test.ts(x)`). Si no, termina en verde sin compilar, sin Release y sin tocar infra-contabo.
- **Desplegar ahora** (fix urgente): Actions → bezenti → «Run workflow» sobre `main`, o
  `gh workflow run bezenti.yml --ref main`. Despliega siempre, aunque ese commit ya esté desplegado.
- Si GitHub retrasa o no dispara un cron (pasa; además lo desactiva tras 60 días sin actividad del repo),
  se lanza a mano.

Cada despliegue produce la versión `<versión de apps/server/package.json>-bezenti.<número de ejecución>`
(por ejemplo `0.1.7-bezenti.3`; las ventanas saltadas también gastan número, así que habrá saltos) y,
**de la misma compilación**:

- la imagen `ghcr.io/darwinva97/bezenti-hub:v<versión>` (también `:sha-<7>` y `:latest`; se despliega
  `v<versión>` porque `sha-<7>` se repite al relanzar el mismo commit);
- la Release `v<versión>` de este repo con `t3-<versión>-linux-x64.tar.gz` y `SHA256SUMS`.

El CI anota las dos cosas en infra-contabo (`manifiestos/bezenti-hub/workloads.yaml`: la imagen y la anotación
`bezenti.com/t3-version`). El Hub y sus máquinas dedicadas no son compatibles entre versiones distintas:
**después de cada despliegue del Hub hay que actualizar la VPS a la misma versión** (ver infra-contabo).

Instalar la CLI de una versión en cualquier Linux x64 (no hace falta Node):

```bash
T3CODE_VERSION=0.1.7-bezenti.3 \
T3CODE_RELEASE_BASE_URL=https://github.com/darwinva97/bezenti-hub/releases/download \
  sh scripts/install.sh
```

## Arreglos sobre el código de Eijun (para que compile el ejecutable)

El flujo de Release del original nunca se había ejecutado en el fork de Eijun (usa runners de Blacksmith), y
tres cosas rompían el ejecutable único de Node:

1. `apps/server/src/environments/sshInstall/SshClient.ts` + `scripts/lib/cli-external-packages.ts`: `ssh2` va
   fuera del paquete y se carga con `createRequire` (su CommonJS lee `__dirname`, que no existe en el
   paquete ESM: el servidor no arrancaba; y su binding opcional `cpu-features` rompía `vp pack`).
2. `apps/server/src/preview/PreviewProxy.ts`: `undici` se carga con `createRequire`, como ya hacía
   `outboundHttp.ts` (un ejecutable único no puede `import` paquetes del disco).

Conviene proponérselos a Eijun para que no haga falta mantenerlos aquí.

## Arreglos de comportamiento (también para proponer a Eijun)

- **Hilos nuevos en un Hub sin agentes** (2026-11-14). El composer ofrecía los providers de la máquina del
  Hub (sin CLIs: «Not found»), así que un borrador nunca tenía provider («Enable a provider in Settings to
  send a message») ni selector de Environment. Ahora ofrece los de la máquina donde correrá el hilo (la
  elegida, o la preferida del proyecto / el Sandbox), tal como esa máquina los reporta en la lista de
  Environments (`providersOnEnvironment` en `packages/client-runtime/src/environment/hubEnvironments.ts`), y
  la vista previa de colocación cuenta una máquina dedicada al Space como utilizable (antes solo las
  personales del propio usuario). Archivos: `ChatView.tsx`, `HubEnvironmentSelector.tsx`,
  `useHubEnvironments.ts`, `aiAccountPicker.ts`, `packages/contracts/src/hubEnvironments.ts` y sus pruebas.

## Traer cambios de Eijun sin perder lo nuestro

Lo nuestro vive en archivos que Eijun no toca (`bezenti/`, `.github/workflows/bezenti.yml`) más los
arreglos de arriba, así que un merge normal casi nunca da conflictos:

```bash
git remote add eijun https://github.com/EijunnN/bezenti-hub.git   # una vez
git fetch eijun
git checkout -b actualizar-eijun origin/main
git merge eijun/main            # si hay conflicto en los archivos de arriba: quedarse con lo de Eijun
                                # si él ya lo arregló, o reaplicar nuestro cambio si no
git push -u origin actualizar-eijun
# revisar, y fusionar en main: en la siguiente ventana el CI compila, publica imagen + Release y despliega
# el Hub (o lanzar bezenti a mano para desplegar ya)
```

O desde la web: botón «Sync fork» de GitHub (hace el mismo merge en `main`).
Después de desplegar, actualizar la VPS a la versión nueva (infra-contabo, «T3 Code Hub»).

Si Eijun publica algún día sus propias Releases, no se usan: la VPS y el Hub siempre salen de este CI.

## App de Android

`.github/workflows/bezenti-android.yml` corre después de cada `bezenti` de `main` que desplegó (o a mano con el
tag de una Release) y añade a esa misma Release `bezenti-hub-<versión>.apk` y su línea en `SHA256SUMS`,
compilado del mismo commit que el Hub (la app y el Hub tienen que ir en la misma versión). En el móvil:
abrir `https://github.com/darwinva97/bezenti-hub/releases/latest`, descargar el `.apk`, permitir
«instalar apps desconocidas» para el navegador e instalar; cada versión se instala encima de la anterior.

Firma: secretos `BEZENTI_ANDROID_KEYSTORE_B64` (PKCS12 en base64) y `BEZENTI_ANDROID_KEYSTORE_PASSWORD`.
GitHub no deja leerlos de vuelta: la copia de la clave se guarda fuera (gestor de contraseñas). Si se
pierde, los móviles tienen que desinstalar la app para instalar una firmada con otra clave.

## App de escritorio para Windows

`.github/workflows/bezenti-desktop.yml` corre después de cada `bezenti` de `main` que desplegó (o a mano con el
tag de una Release) y añade a esa misma Release el instalador `T3-Code-<versión>-x64.exe` y su `.sha256`,
compilado del mismo commit que el Hub. Usa `release-desktop.yml` del original (que sigue desactivado como
workflow: solo se llama) con runners normales de GitHub, y lleva dentro, para el backend de WSL, la CLI de
Linux de la propia Release. La app no se actualiza sola: cada versión nueva del Hub se instala encima.

No está firmado (no hay certificado de firma de código de Windows), así que SmartScreen avisa la primera
vez: «Más información» → «Ejecutar de todas formas». La suma está en el `.sha256` de al lado.

Para conectarla al Hub: Settings → Environments → This app → apagar **Local environment**, luego **Add Hub**
con `claude.bezenti.com` y **Sign in in browser**. Para que el PC ejecute agentes del Hub: **Use this
computer as an Environment** → **Join**.

## Verificación de ramas en CI

`.github/workflows/bezenti-verify.yml` hace en GitHub Actions el mismo recibo que la verificación local,
para no cargar el PC y para que varias ramas se verifiquen a la vez. No publica ni despliega nada: eso sigue
siendo `bezenti.yml`, solo en `main`.

- **Cuándo**: en cada push a una rama que no sea `main` (`feat/…`, `fix/…`, `ui/…`, `ci/…`) y a mano
  (Actions → bezenti-verify → «Run workflow», o `gh workflow run bezenti-verify.yml --ref <rama> -f base=<commit>`).
  Un push nuevo a la misma rama cancela la ejecución anterior.
- **Contra qué**: el diff entre el merge-base con `main` y el commit empujado (o contra `base`, si se da).
- **Qué corre** (lo decide el trabajo `plan`, que lo deja en el resumen; `.github/scripts/bezenti-verify-plan.cjs`):
  - lint: `vp lint` del repo entero (salvo si solo cambió Markdown);
  - tipos: `effect-tsgo tsrs --noEmit` en cada paquete dueño de un archivo cambiado y en sus dependientes
    (`ci-changes.cjs`); server, web, mobile y desktop en un runner cada uno, los demás en grupos. Se toleran
    lo mismo que en local: los avisos (effect-tsgo sale con 2 solo por ellos) y el error conocido
    `ThreadTabStrip.browser.test.tsx:134`;
  - pruebas: las cambiadas, las de al lado de cada fuente cambiada (`foo.ts` → `foo.test.ts`,
    `foo.*.test.ts(x)`) y, si cambió `apps/server/`, los barridos de puertas (`DoorRules`, `RpcAuthorization`,
    `MaskedPaths`, `HubWithEnvironments.environmentDoors`, `AuditLog`). Por paquete, Node y navegador por
    separado (`*.browser.test.tsx` con el Chromium de Playwright), en shards de ~1 minuto, con las opciones del
    script `test` de cada paquete.
- **Veredicto**: el trabajo `verdict` junta las líneas `PASS`/`FAIL` en el recibo, que termina en
  `RESULT GREEN` o `RESULT RED`, y falla si algo falló o no llegó a comprobarse (un trabajo que murió antes deja
  `FAIL … (no result: …)`). El recibo está en el resumen de la ejecución, con el principio de cada fallo, y en
  el artefacto `bezenti-verify-receipt` (`receipt.txt` y `receipt-details.md`).
- **Esperarlo desde una terminal**: el ayudante local `ci-receipt.sh <rama> <sha>` (fuera del repo, junto a la
  verificación local) espera la ejecución de ese commit exacto consultando cada 30 s, imprime el recibo y los
  fallos, y sale con 0 solo si es GREEN (`CI_RECEIPT_EVENT=workflow_dispatch` para una ejecución lanzada a
  mano). A mano es lo mismo que:

  ```bash
  gh run list --workflow bezenti-verify.yml --branch <rama> --json databaseId,headSha,status,conclusion
  gh run download <id> -n bezenti-verify-receipt && cat receipt.txt
  ```

- **Diferencias con la verificación local**: los tipos se comprueban también en los paquetes dependientes, no
  solo en los que se nombran; corren también las pruebas de `scripts/`, `evals/` e `infra/`; en `apps/server`
  se salta la prueba «refuses a second run to the same machine», que falla en Linux con o sin cambios
  (`localhost` resuelve antes a `::1`; `bezenti.yml` hace lo mismo). `ubuntu-latest` ya es Ubuntu 26.04 y el
  Playwright del repo aún no la reconoce: los trabajos de pruebas corren en `ubuntu-24.04`.
- **Tiempos**: ~1,5 min si solo hay lint; ~2,5 min con server, web y los barridos de puertas.

El plan reutiliza `readWorkspace` y `decide` de `.github/scripts/ci-changes.cjs`, que es del original: si un
merge de Eijun lo cambia, comprobar que el plan sigue eligiendo lo mismo.

## Workflows del original

Están **desactivados** en este fork (Actions → cada workflow → «Disable workflow», o `gh workflow disable`):
usan runners de Blacksmith que aquí no existen y se quedarían en cola para siempre. Solo corren `bezenti`,
`bezenti-verify`, `bezenti-android` y `bezenti-desktop` (este llama a `release-desktop.yml`, que sigue desactivado).
Si un merge de Eijun añade workflows nuevos, desactivarlos también.
