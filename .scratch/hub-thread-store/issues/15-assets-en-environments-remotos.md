# 15: Previews y descargas de archivos en Environments remotos

**What to build:** Continuación de 05. En un Thread cuya Active environment es otra máquina, las URLs de asset de sus archivos (previews de imagen, PDF, HTML con sus recursos relativos, vídeo y audio, texto grande y descargas del panel Files) salen de esa máquina a través del Hub, nunca de una copia del Hub. Diseño: `15-assets-en-environments-remotos-design.md`.

**Blocked by:** 05.

**Status:** done

- [x] `assets.createUrl` (`workspace-file`, `media-file`) decide la máquina por el Thread (`ThreadWorkspace.machineAsset`); en otra máquina, `files.inspectAsset` mira el archivo allí y el token `thread-machine-file` nombra Thread, Environment, User y ruta relativa al workspace.
- [x] La ruta `/api/assets/*` vuelve a comprobar el Thread, la máquina y el User, pide `files.inspectAsset` (15 s) y transmite por ventanas de 8 MiB con `files.streamAsset`; bytes de más, de menos u otro archivo cortan la respuesta.
- [x] Máquina offline: error tipado (`AssetRemoteEnvironmentError`) al emitir y 503 al servir; máquina con contrato < 15: «needs an update», sin caer nunca en el disco del Hub. Rutas absolutas fuera del workspace: rechazadas.
- [x] El texto se enmascara igual que en local y no se escribe nada en el disco del Hub.
- [x] La web muestra el motivo (offline, actualizar) en lugar de «Unable to load file preview.». Docs: `docs/user/install.md`, `docs/internals/overview.md`.
- [x] Tests: `HubWithEnvironments.assets.test.ts` (rojo primero: el Hub servía su copia vieja), `MachineAssetResponse.test.ts`, `MachineAssets.test.ts`, `AssetAccess.test.ts`, `SecretMasker.test.ts` (mismas pruebas con origen remoto), `MaskedPaths.test.ts`, `client-runtime` `assets.test.ts`.

Fuera de alcance: `draft-workspace-file` (sigue en la Hub machine, como las lecturas de borradores), favicon del Project y archivos del host de la máquina fuera del workspace.
