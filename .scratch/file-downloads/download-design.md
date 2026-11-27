# Descargar archivos y carpetas desde el explorador (issue #24, primera parte)

## Qué cambia

- El menú contextual del explorador de archivos gana **Download** (archivo) y **Download as .zip**
  (carpeta).
- `assets.createUrl` acepta un recurso nuevo, `workspace-download { cwd, path }`:
  - archivo: se firma la misma URL `media-file-exact` con `download: true` que ya sirve "Save
    image"; el servidor la entrega como adjunto y enmascara el texto de un checkout para quien la
    pide (Spec 5), igual que hoy.
  - carpeta: se firma una URL `workspace-folder-zip` que, al pedirse, recorre la carpeta y envía un
    ZIP en streaming (modo _store_, ZIP64, nombres UTF-8). Sin temporales ni buffers del tamaño
    total; cada archivo de texto que el masker deba enmascarar se lee entero (≤ 16 MiB, el mismo
    tope que el visor).
- El ZIP nunca sigue symlinks ni sale de la carpeta pedida; omite `.git` y `node_modules`; los
  archivos que no se pueden leer o enmascarar se listan en `SKIPPED.txt` dentro del ZIP.

## Quién puede

- La misma puerta que ya decide `assets.createUrl` para `draft-workspace-file`: el scope
  `filesystem:read` y `RpcSpaceAccess` (`mayReadDirectory` sobre `cwd` + `path`). Quien no puede
  ver la carpeta recibe not-found. No hay ruta HTTP nueva: la URL firmada usa `/api/assets/*`, cuya
  puerta en `DoorRules` ya es `assets.createUrl`.
- La URL caduca a la hora, como el resto de assets.

## Cómo se deshace

- Es solo lectura: no escribe nada en el workspace ni en la base. Quitar el ítem del menú y el
  recurso del contrato lo revierte.

## Segunda parte (misma PR)

- `workspace-download` lleva `paths` (hasta 50), `includeAll` y `threadId`. El servidor hace un
  pre-escaneo (`planArchive`, sin seguir symlinks), lo parte en partes de hasta 2 GiB por orden de
  archivo y firma una URL por parte con su rango (`start`/`end`); devuelve archivos, bytes y partes.
- Límites: 200 GiB y 500 000 entradas por descarga; 3 ZIPs en curso por User (429).
- Audit: `workspace.download` (rutas, archivos, bytes, partes) al firmar.
- Un Thread en otra máquina: un archivo sale de esa máquina (ticket 15, hasta 512 MB); carpetas y
  selecciones se rechazan con un mensaje claro, nunca se arma el ZIP con la copia del Hub.
- Cliente: diálogo de confirmación (> 500 MiB o varias partes) y tarjeta de descargas con progreso,
  cancelar y reintentar. Con File System Access (Chromium, escritorio) escribe en disco mientras
  llega; si no, el navegador descarga la parte 1 y las demás tienen su botón.

## Pendiente

- ZIP de carpetas de un Thread en otra máquina (el issue lo deja como pregunta abierta).
- Excluir archivos ignorados por `.gitignore` (hoy solo `.git` y `node_modules`).
