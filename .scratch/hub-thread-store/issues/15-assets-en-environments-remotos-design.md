# 15 (diseño): previews y descargas de archivos en Environments remotos

Hueco del ticket 05: leer texto se reenvía a la máquina, pero las URLs de asset (preview HTML/imagen/PDF/vídeo, texto grande, descargas) siguen leyendo el disco del Hub.

## 1. Causa raíz

- **Web.** `FilePreviewPanel.tsx` pide `assets.createUrl` con la ruta absoluta que el Hub tiene registrada (`hubBase/...`): `workspace-file` para HTML e imágenes (`WorkspaceBrowserPreview` y `WorkspaceImagePreview`, vía `workspaceAssetResource`); `media-file` para PDF, documentos y binarios (`AttachmentFilePreview`); `media-file` + `disposition:"attachment"` para descargas (`downloadResource` en `AttachmentFilePreview.tsx:131`) y para el texto grande (`WorkspaceLargeTextPreview`). `MediaActions` y `ChatMarkdownMedia` usan los mismos tipos.
- **WS.** `ws.ts` `[WS_METHODS.assetsCreateUrl]` (~3161):
  - un `media-file` absoluto que no está en red va directo a `issueAssetUrl` **sin mirar el Thread**;
  - `workspace-file` y el `media-file` relativo usan `thread.worktreePath ?? project.workspaceRoot`, que son rutas del Hub.
- **Assets.** `AssetAccess.ts` `finalizeWorkspaceFileAsset` y `finalizeAbsoluteMediaFileAsset` (`resolveRelativePathWithinRoot`, `resolveCanonicalWorkspaceFile`, `realPath`, `openMediaFile`) inspeccionan el sistema de archivos del Hub. Después, `resolveAsset` y `http.ts` `layerAssetRoute` → `assetFileResponse` / `maskedAssetText` sirven los bytes desde el disco del Hub.
- **Consecuencia.** Si el archivo no existe en el Hub, «Unable to load file preview.». Si el Hub tiene su propia copia en `hubBase`, se sirve **en silencio una copia vieja**, distinta de la de la máquina. Ese segundo caso es el test rojo más fuerte.
- **El camino bueno.** `ThreadWorkspace.route()` → `forward.call("files.read", {root: remoteBase, …})`. En la máquina, `EnvironmentAgent` `inRoot` / `JoinedWorkspaceRoots.withRoot().inside()` resuelve los symlinks dentro del root. Para bytes en streaming, el precedente es `preview.proxyHttp` (`HubPreviews.forwardedTarget`: chunks base64 de 64 KiB y backlog por operación).

## 2. Diseño

1. **`ThreadWorkspace.assetRoute(threadId, caller)`.** Nuevo; expone el `route()` existente (`local | remote | offline | refused`) y `onMachine` / `relativeInside`.
   - En `assets.createUrl`, cualquier recurso con `threadId` (`workspace-file`, `media-file` absoluto o relativo, `tool-output-image` no) pasa primero por aquí.
   - `local`: el código de hoy, sin cambios.
   - `remote`: la ruta se convierte en relativa al workspace del Thread. Si queda fuera (por ejemplo, un `/tmp/x.png` de la máquina), se rechaza con un mensaje claro: solo se previsualizan archivos del workspace.
2. **Op `files.inspectAsset` (call, nueva).**
   - Entrada: `{root, relativePath, mode: "exact"|"html-entry"|"download"}`.
   - La máquina hace `withRoot` + `inside` (sigue symlinks), comprueba que es archivo regular, hace un open no bloqueante (FIFO) y `isServerInternalPath`.
   - Devuelve `{canonicalRelativePath, size, identity:{dev,ino}, revision, imageDimensions?}`.
   - El Hub aplica **las mismas listas** de hoy sobre la ruta pedida y sobre la canónica: `isWorkspacePreviewEntryPath`, `hostPreviewMimeTypeFromExtension` y `PREVIEW_ASSET_EXTENSIONS`. Así un `a.png → .env` dentro del workspace se rechaza igual que en local.
3. **Claim nuevo `thread-machine-file`.** No se reutilizan los kinds actuales, para que nunca se interpreten como ruta del Hub. Lleva `{threadId, environmentId, mode:"exact"|"html-base", relativePath | baseRelativePath, identity?, download?, viewer (obligatorio), expiresAt}`.
   - Mismo TTL y misma firma que hoy.
   - `identity` solo en `media-file` y descargas, con la semántica de hoy de `media-file-exact`: las ediciones in situ se siguen viendo, pero un reemplazo atómico pide URL nueva.
4. **Ruta HTTP.**
   - `resolveAsset` devuelve `{kind:"remote-file", …}` sin tocar el disco.
   - Para el modo `html-base`, la subruta del HTML (`<img src>`, css, js, fuentes) se valida con las reglas actuales (segmentos sin `.`, extensión en `PREVIEW_ASSET_EXTENSIONS`) y se une a `baseRelativePath`.
   - En `layerAssetRoute`, la rama nueva hace `route(threadId, {userId: viewer})`. Si no es `remote` con el mismo `environmentId` (el Thread se movió, se perdió el acceso, la máquina está offline), responde 404/503 al momento.
   - Después, **pull por ventanas**: `forward.stream("files.streamAsset", {root: remoteBase, relativePath, identity?, offset, length ≤ 8 MiB})`. La máquina responde una `head {size, canonicalRelativePath, identity}` y luego `chunk {base64}` de 64 KiB. El Hub pide la ventana siguiente solo cuando el cliente consume la anterior: contrapresión real, en vez de depender del backlog.
   - Límites:
     - `STREAM_BACKLOG["files.streamAsset"]=160` (10 MiB);
     - tope de 512 MiB por respuesta (413);
     - 15 s para recibir la `head` (504) y 30 s de inactividad entre chunks (se corta la conexión).
   - Headers con `assetResponseHeaders(relativePath, {download, fileName, mimeType})`, sin cambios: CSP de HTML y SVG, `nosniff`, `Content-Disposition`.
   - `Range` se reenvía como offset/length. Para `If-Range` se mantiene la regla actual: respuesta completa. El `Cache-Control` es el mismo de hoy; el Hub no escribe nada en disco.
5. **Máscara (spec 5).** `maskedAssetText` pasa a aceptar una fuente de bytes (`size` + un lector) además de una ruta.
   - En remoto se decide igual que en local: el MIME y el sniff de texto con los primeros bytes. El texto de hasta 16 MiB se reúne en memoria y se enmascara para el viewer; los binarios y la media pasan en streaming tal cual.
   - El texto remoto no se guarda en `maskedCache`.
   - `MaskedPaths`: `files.inspectAsset` → `none("metadata")`; `files.streamAsset` → `masked("vaults/maskAssets.ts")`.

## 3. Seguridad

- **Autorización.** `RpcAuthorization` (`AuthFilesystemReadScope`) y `RpcSpaceAccess.assetReadTargets` (`mayReadDirectory` sobre la ruta del Hub, igual que `projects.readFile`) no cambian. Se suma `usableBy` de `route()` al emitir **y** al servir, con el viewer del claim.
- **El claim ata** viewer, Thread, Environment y expiración. El root se recalcula en cada petición (`remoteBase`) y nunca viene del token.
- **TOCTOU.** La máquina vuelve a resolver `inside()`, vuelve a abrir sin bloquear y compara `identity` en cada ventana. Si no coincide, error y la conexión se corta.
- **Bytes.**
  - El Hub construye la petición solo con el claim (más una subruta ya validada) y usa un `subscriptionId` aleatorio; el demux de `forwardStream` descarta los frames ajenos.
  - Exige que `head.canonicalRelativePath` sea igual a la ruta pedida y corta si llegan más bytes que `length`.
  - Nunca hay fallback al disco del Hub.
- **Máquina offline o Sandbox parado** (una lectura no lo arranca): error inmediato `AssetEnvironmentUnavailableError` con `offlineMessage()` al emitir, y 503 al servir. `EnvironmentExecutorUnavailableError` se traduce sin esperas.

## 4. Descarga

- **Hoy.** El botón de `AttachmentFilePreview` (`prepareDownload` → `useAssetUrlRefresh(downloadResource)`) emite `media-file` + `attachment` → `media-file-exact {download}` sobre el disco del Hub, y por eso falla. `MediaActions` y `WorkspaceLargeTextPreview` usan lo mismo.
- **Después.** Mismo recurso; `createUrl` emite `thread-machine-file {mode:"exact", download:true}` y la ruta lo sirve en streaming con `Content-Disposition: attachment` y la máscara de texto. En la web solo cambia el mensaje: se muestra el `message` de `AssetEnvironmentUnavailableError` en lugar del genérico (`FilePreviewPanel.tsx:259`, `:1636`, `AttachmentFilePreview`).

## 5. Contrato

- Hoy `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION = 13`, y vault ticket 05 se queda el **14** (secret files).
- Este fix añade `REMOTE_ASSETS_CONTRACT_VERSION = 15` (las dos ops, `ENVIRONMENT_EXECUTOR_OPERATIONS.workspace`, `REMOTE_OPERATIONS`, `REMOTE_STREAM_ITEMS`) y sube la global a 15. Si vault 05 no ha entrado cuando esto se integre, se negocia el número: el gate usa su propia constante, así que da igual cuál entre primero.
- **Máquina antigua:** el Hub comprueba `forward.contractVersion() < 15` **antes** de llamar y responde `AssetEnvironmentUnavailableError {reason:"outdated"}`: «<máquina> necesita actualizarse para previsualizar y descargar archivos.» Falla cerrado: sin fallback al Hub ni a `files.read`.
- Contracts: se añade `AssetEnvironmentUnavailableError {reason: environment_offline|stopped|outdated, message}` a `AssetAccessError`.

## 6. Tests (red-first), riesgos y fuera de alcance

**Tests:**

- **Unit `AssetAccess.test`:** un claim `thread-machine-file` nunca resuelve a una ruta del Hub; la subruta de `html-base` aplica las reglas actuales; un claim manipulado o caducado da `null`.
- **Unit `EnvironmentAgent`:** `inspectAsset`/`streamAsset` rechazan un symlink que sale del root, una FIFO, un directorio, un archivo interno de `~/.t3` y un cambio de `identity` (symlink cambiado tras emitir).
- **Unit `http`:** headers idénticos a los locales para html, svg, pdf, png y descarga; `Range` → 206; exceso de bytes → corte; sin `head` → 504.
- **Unit `maskAssets`:** el texto remoto sale enmascarado.
- **Unit gate:** con contrato 14 → `outdated` sin llamada.
- **`HubWithEnvironments.assets.test.ts`** (testkit de máquina remota): workspace con `index.html` + `img/logo.png` + `doc.pdf`, y en `hubBase` una **copia vieja distinta**. Se emite por WS y se pide por HTTP:
  - el HTML trae la imagen relativa y el PDF y la descarga sirven los bytes de la máquina;
  - Thread movido → 404; máquina desconectada → 503 en menos de 1 s;
  - otro User sin acceso → `createUrl` rechazado y la URL ajena da 404;
  - Thread en la Hub machine → sin cambios.

**Riesgos:**

- Latencia de las ventanas en vídeos grandes (se mitiga con 8 MiB y `Range`).
- Memoria al enmascarar texto de hasta 16 MiB por petición (igual que en local).
- Thread movido entre emitir y servir (404 y la web vuelve a pedir URL como ya hace).

**Fuera de alcance:**

- Archivos del host de la máquina fuera del workspace.
- `draft-workspace-file`: sigue en la Hub machine, como `route()` hace con los borradores.
- Favicon de Project: es por Project, no por Thread; se lee del checkout del Hub y, si falta, cae en el icono genérico.
- Caché HTTP compartida.

**Conflictos con el spec / ticket 05 (recomendación):**

- 05 figura como hecho pero no cubría los assets: abrir 15 como continuación de 05.
- «Sin spool»: se cumple, porque el texto enmascarado se reúne en memoria por petición como en local, y nunca en disco.
- En un Thread remoto, las rutas absolutas de fuera del workspace se rechazan; en local se permiten con visibilidad del Space. Mantener esa asimetría, porque una ruta así no puede salir del Thread en otra máquina.
