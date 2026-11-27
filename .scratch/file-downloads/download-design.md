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

## Pendiente (siguientes ramas)

- Pre-escaneo, umbrales, diálogo de confirmación y división en partes `-part-i-of-N`.
- Panel de progreso persistente con cancelar/reintentar.
- Límite de descargas concurrentes y entrada en el audit log.
- Casilla para incluir `.git` / `node_modules`.
