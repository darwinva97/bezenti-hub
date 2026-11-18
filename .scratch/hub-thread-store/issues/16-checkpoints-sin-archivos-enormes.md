# 16: Checkpoints sin archivos enormes

**What to build:** Regla de producto tras el incidente del 2026-11-18. Un Project sin `.gitignore` ("aliados") hacía checkpoints de unos 392 MiB, con un vídeo de 210 MiB: las subidas chocaban con el límite de 100 MB de Cloudflare y se reintentaban en bucle. Backoff, subidas por partes y `uploadIssues` ya están. Faltaba que ningún Project pudiera volver a hacerlo, y que deshacer un turno no borrara nunca lo que el checkpoint no guardó.

**Blocked by:** —

**Status:** done

## Diseño

**Hoy.** `GitVcsDriver.checkpoints.captureCheckpoint` llena un índice temporal (copia del índice del usuario, o HEAD) con `git add -A -- .`, y luego hace `write-tree`, `commit-tree -p HEAD` y `update-ref`. Al ser un `git add` normal, respeta `.gitignore`, `.git/info/exclude` y `core.excludesFile`.

- Un repo anidado con commit queda como gitlink (solo el id, sin contenido); uno sin commit se excluye tras fallar el add.
- Los symlinks se guardan como enlace y nunca se siguen.
- `node_modules`, `dist` y similares entraban enteros si nadie los ignoraba.
- El restore hace `git restore --source <ckpt> --worktree --staged -- .`, luego `git clean -fd -- .` y luego `reset`. El clean borra todo archivo sin seguimiento y no ignorado que el checkpoint no tenga. Por eso cambiar solo la captura habría hecho que deshacer un turno **borrara** el vídeo y `node_modules`.

**Regla** (`apps/server/src/vcs/CheckpointExclusions.ts`). Constantes en la máquina que corre git, sin ajuste.

- Se omiten los archivos **sin seguimiento** de más de 50 MiB (el umbral en que avisa GitHub). Los archivos con seguimiento se guardan siempre.
- Las carpetas sin seguimiento llamadas `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.gradle`, `target` y `dist` se omiten a cualquier profundidad. `build` no está en la lista porque a menudo es código fuente.
  - Funcionan como reglas de ignore de la prioridad más baja: un excludes file generado lleva primero los defaults y después el contenido del `core.excludesFile` efectivo del usuario (o del `~/.config/git/ignore` de XDG).
  - Se pasa solo a cada comando, con `git -c core.excludesFile=<tmp>`. Nunca se tocan la config, `.gitignore`, `info/exclude` ni la config global del usuario.
  - Un `!dist/` en `.gitignore` recupera esa carpeta.
- Los archivos grandes van como pathspecs `:(top,literal,exclude)`, por `--pathspec-from-file` en `add` y `restore`.
- No hay límite total por checkpoint: contaría archivos sin cambios que ya se subieron.

**Restore.** Nunca borra ni sobrescribe lo que la regla omite. Antes de `git restore` y `git clean` vuelve a mirar los archivos actuales y protege los que pasan del límite. `clean` lee además el mismo excludes file, así que las carpetas por defecto sobreviven.

- No guarda estado, así que también cubre un archivo que creció tras capturarse pequeño, o que el usuario cambió después.
- `git clean` no acepta pathspecs desde un archivo. Si las exclusiones no caben en 16 KiB de argumentos, el restore falla en vez de borrar. Con un git sin `--pathspec-from-file` pasa lo mismo en `add` y `restore`.

**Informe.** `captureCheckpoint` devuelve un `OrchestrationV2CheckpointSkipped`: `{ maxFileBytes, files[≤50], fileCount, folders[≤50], folderCount }`, con rutas relativas al repositorio.

- Por el cable va como `UndefinedOr`, porque una máquina anterior responde null.
- Se guarda como `skipped` opcional dentro del `payload_json` del checkpoint, así que no hace falta migración.
- `uploadIssues` no encaja: es por máquina, vive en memoria y lo ve quien gestiona la máquina.

**UI.**

- La tarjeta del turno muestra «1 file not saved» / «N files not saved». Se muestra aunque no haya otros cambios.
- Tooltip: «Not saved in this checkpoint, so reverting leaves it as it is:» seguido de `ruta (210 MiB)` y «Files over 50 MiB are left out of checkpoints. Add them to .gitignore to hide this note.».
- Las carpetas por defecto no salen en la tarjeta, porque son lo esperado. El panel de diff del turno las nombra: «Dependency and build folders are not in checkpoints: dist/, node_modules/. To keep one, add a line like !dist/ to .gitignore.».

**Diffs.** Una ruta omitida no está en el árbol del checkpoint. El resumen `files` del turno y `CheckpointDiffQuery` la quitan, como ya hacen con `isGitImport`, para que un archivo que creció no salga como borrado.

## Hecho

- [x] Regla y excludes file por comando (`CheckpointExclusions.ts`, `GitVcsDriver.ts`). La configuración del usuario queda intacta (test).
- [x] Restore que protege archivos grandes y carpetas por defecto. Falla en vez de borrar si no puede protegerlos.
- [x] Informe por el cable (`RemoteExecutorWire`, null de máquinas viejas), en el checkpoint (`CheckpointService`) y en el contexto de diff (`ProjectionStore.getCheckpointContext` → `skippedFiles`).
- [x] Web: etiqueta y tooltip en `ChangedFilesCard`, nota en `DiffPanel`. Textos en `client-runtime` (`checkpointSkippedFilesNote`, `checkpointSkippedFoldersText`).
- [x] Docs: `docs/user/install.md`, `docs/internals/overview.md`.
- [x] Tests, rojo primero y sobre un repo git real en un directorio temporal:
  - `CheckpointLargeFiles.test.ts`, 9 tests:
    - archivo grande omitido y reportado;
    - el restore lo conserva aunque el usuario lo cambiara;
    - el restore conserva un archivo pequeño que creció;
    - `.gitignore` respetado;
    - carpetas por defecto omitidas, con seguimiento guardadas y `!dist/` recuperada;
    - ignores globales y XDG respetados;
    - restore que falla sin borrar;
    - repo del usuario intacto.
  - `CheckpointService.test.ts`: informe en el checkpoint, y el archivo omitido no sale en `files`.
  - `CheckpointDiffQuery.test.ts`: el patch no incluye el archivo omitido.
  - `client-runtime` `threadCheckpoints.test.ts`: textos.
  - `MessagesTimeline.browser.test.tsx`: la tarjeta muestra el mensaje.

Fuera de alcance:

- Mover un Thread a otra máquina no lleva los archivos omitidos, porque viajan por checkpoint.
- Una máquina con contrato anterior sigue capturándolo todo.
- Una máquina nueva con un Hub viejo falla la captura: el `Schema.Void` del Hub no lee el informe. Hay que actualizar el Hub primero, como siempre.
