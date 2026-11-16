# bezenti: cómo se despliega este fork

Este repositorio (`darwinva97/bezenti-hub`) es el fork que usa bezenti de
[`EijunnN/bezenti-hub`](https://github.com/EijunnN/bezenti-hub) (a su vez un fork multiusuario de T3 Code).
Todo lo propio de bezenti está en esta carpeta y en `.github/workflows/bezenti.yml`; el resto del repo es
el código de Eijun (más los arreglos de compilación de abajo).

| Pieza            | Dónde                                                              | Qué                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Hub              | clúster k3s de `darwinva97/infra-contabo`, namespace `bezenti-hub` | `https://claude.bezenti.com` (temporal; luego `code.bezenti.com`). Guarda personas, permisos, hilos y secretos. **No ejecuta agentes.** |
| Máquina dedicada | VPS `hub-vps` (72.60.66.80), usuario `t3`                          | Ejecuta el trabajo de la organización `bezenti` dentro de un Sandbox (Podman sin root).                                                 |

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

## Versiones: Hub y VPS, siempre la misma

Cada push a `main` produce la versión `<versión de apps/server/package.json>-bezenti.<número de ejecución>`
(por ejemplo `0.1.7-bezenti.3`) y, **de la misma compilación**:

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
# revisar, y fusionar en main: el CI compila, publica imagen + Release y despliega el Hub
```

O desde la web: botón «Sync fork» de GitHub (hace el mismo merge en `main`).
Después de desplegar, actualizar la VPS a la versión nueva (infra-contabo, «T3 Code Hub»).

Si Eijun publica algún día sus propias Releases, no se usan: la VPS y el Hub siempre salen de este CI.

## App de Android

`.github/workflows/bezenti-android.yml` corre después de cada `bezenti` correcto en `main` (o a mano con el
tag de una Release) y añade a esa misma Release `bezenti-hub-<versión>.apk` y su línea en `SHA256SUMS`,
compilado del mismo commit que el Hub (la app y el Hub tienen que ir en la misma versión). En el móvil:
abrir `https://github.com/darwinva97/bezenti-hub/releases/latest`, descargar el `.apk`, permitir
«instalar apps desconocidas» para el navegador e instalar; cada versión se instala encima de la anterior.

Firma: secretos `BEZENTI_ANDROID_KEYSTORE_B64` (PKCS12 en base64) y `BEZENTI_ANDROID_KEYSTORE_PASSWORD`.
GitHub no deja leerlos de vuelta: la copia de la clave se guarda fuera (gestor de contraseñas). Si se
pierde, los móviles tienen que desinstalar la app para instalar una firmada con otra clave.

## Workflows del original

Están **desactivados** en este fork (Actions → cada workflow → «Disable workflow», o `gh workflow disable`):
usan runners de Blacksmith que aquí no existen y se quedarían en cola para siempre. Solo corren `bezenti` y `bezenti-android`.
Si un merge de Eijun añade workflows nuevos, desactivarlos también.
