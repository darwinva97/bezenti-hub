# 17: El repositorio del Hub no crece con cada subida

**What to build:** Incidente del 2026-11-23. El volumen de estado de un Hub (20 GiB) se llenó al 100 %: `ENOSPC` y después `SQLITE_IOERR` en su base de datos. El repositorio del Hub de un solo Project tenía 61 packs, 18,65 GiB, con solo 2.985 objetos distintos (0,41 GB): cada objeto estaba unas 55 veces. Cada subida de checkpoint desde una máquina unida añadía un pack de ~300 MB con casi todo el Project (lleva un binario de ~220 MB), y nadie compactaba los packs. Se arregló a mano (un pack, 394 MiB). Este ticket lo arregla para todo Project y todo Hub: el Hub compacta, la máquina deja de reenviar lo que el Hub ya tiene, y el Hub no deja que las subidas llenen su disco.

**Blocked by:** —

**Status:** in progress

## Causa de que cada subida lleve todo (experimento con git 2.56)

`pack-objects --revs <nuevos> --not <tips>` (y `git push`, que hace lo mismo con los refs anunciados) solo deja fuera los ficheros de un tip **a través de los padres de los commits nuevos** (los commits «borde»): marca como no interesante el árbol de un padre excluido, no el árbol del tip excluido. Un checkpoint es hijo de HEAD (`commit-tree -p HEAD`), no del checkpoint anterior. Resultado, con un repo de prueba (un binario de 8 MB y 50 ficheros), tamaño del pack de cada subida:

| Caso                                                          | `--not <tips>` (hoy)                                                  | `+ ^<tip>^{tree}`                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| Mismo Thread, HEAD igual, cambio sin commit                   | 1,5 KB (pero reenvía cada fichero con cambios sin commit, cada turno) | 1,5 KB                             |
| Thread nuevo, el anterior todavía de esta máquina (anunciado) | 1,5 KB                                                                | 0,2 KB                             |
| Thread nuevo, ningún otro Thread anunciado a la máquina       | **8 MB (todo)**                                                       | 8 MB → con `packs/known`: lo nuevo |
| HEAD saltó a otra historia (orphan, rebase)                   | **8 MB (todo)**                                                       | 1,8 KB                             |
| Checkout sin ningún commit (cada checkpoint es raíz)          | **8 MB (todo), cada turno**                                           | 1,4 KB                             |

Un fichero con seguimiento modificado y sin commit (por ejemplo un binario grande) se reenvía en cada turno aunque todo lo demás vaya bien.

## Diseño

**a. Compactación en el Hub** (`HubRepositoryMaintenance`). Lo imprescindible: arregla el disco para cualquier máquina, también las viejas.

- `git repack -d --geometric=2`: junta los packs pequeños y los objetos sueltos hasta que cada pack sea al menos el doble del siguiente. Pocos packs, cada objeto una vez aprox., y cada subida se reescribe pocas veces. No un `repack -a` en cada subida: reescribiría el repositorio entero.
- Seguro frente a escrituras a la vez: guarda todo objeto de los packs que junta, alcanzable o no, y no toca un pack que aparece mientras tanto. Un push (`http-backend`) o un apply entre su `index-pack` y su `update-ref` no pierde nada. Aun así los applies de un repositorio esperan a la compactación (`exclusive`). No poda: borrar objetos es de `plans-and-limits/06`.
- Cuándo: 30 s después de un apply o un push (las subidas seguidas comparten una), y en un barrido de todos los repositorios un minuto tras arrancar (los repositorios ya crecidos) y cada hora.
- Disco: el pack nuevo se escribe antes de borrar los viejos. Solo corre si caben una copia de cada objeto (`cat-file --batch-all-objects --batch-check=%(objectsize:disk)`, sin duplicados) más el suelo de abajo; si no, avisa en el log y espera al siguiente barrido. Nunca empieza para fallar a medias.
- CPU y memoria (el pod tiene 3 GiB): `pack.threads=1`, `pack.windowMemory=128m`, `pack.deltaCacheSize=32m`, `core.bigFileThreshold=32m` (sin buscar deltas en ficheros grandes), sin bitmaps. Timeout 60 min.

**b. Subidas incrementales** (máquina, `HubRepository.pushRefs` y `HubPackUploadClient`).

- El pack por partes excluye también el árbol de cada tip (`^<tip>^{tree}`, `revisionsInput`). Las negaciones van como líneas `^` (git antes de 2.40 rechaza `--not` en `rev-list --stdin`).
- Si `git push` enviaría más de 8 MiB, la máquina pregunta al Hub cuáles de los últimos 64 commits de `refs/t3/` de su checkout son tips de algún ref del repositorio (de cualquier Thread): `POST /api/git/<repo>/packs/known` → `{ known }`. Solo tips: un ref se pone solo cuando todo lo que alcanza está, así que el pack puede dejarlo todo fuera. La respuesta solo nombra commits que la máquina ya tiene. Mismas comprobaciones de acceso que un push.
- Transporte: por partes si `git push` enviaría más de 64 MiB (como antes) o más de 8 MiB que el Hub ya tiene; si no, `git push`.
- Contrato: no cambia. Un Hub viejo responde 404 a `known`; la máquina sube como antes. Una máquina vieja sigue enviando de más y la compactación lo absorbe.

**c. Disco lleno.**

- El Hub guarda libre `max(512 MiB, 5 %)` de su volumen de estado: por debajo, un push o una parte se rechazan con 507. La máquina lo trata como fallo transitorio (backoff) y la base de datos nunca se queda sin sitio.
- El barrido avisa en el log por encima del 80 % usado (solo en un Hub con repositorios).
- Que el Owner lo vea en la app es otro ticket: [18](18-disco-del-hub-visible-para-el-owner.md).

## Hecho

- [ ] `HubRepositoryMaintenance` (compactación, `exclusive`, `compactSoon`, `uploadRefusal`, barrido) cableado en `server.ts` y en el testkit; los applies de `HubPackUploads` van con `exclusive` y piden `compactSoon`; `gitRoute` pide `compactSoon` tras un push y rechaza con 507 sin sitio.
- [ ] `revisionsInput` con árboles, `packs/known` (Hub y máquina), decisión de transporte en `pushRefs`.
- [ ] Docs: `docs/internals/overview.md` («What an upload leaves out», «Compaction», «A full disk»), `docs/user/install.md`.
- [ ] Tests, rojo primero:
  - `HubRepositoryMaintenance.test.ts` (git real): 8 subidas de copia completa (la forma del incidente) quedan en ≤ 2 packs y menos de 2× el binario, con todos los refs y `fsck --connectivity-only` bien; un apply a medias (pack sin ref) y objetos sueltos no se pierden con una compactación al lado; sin sitio no compacta nada ni rechaza menos, y con sitio sí.
  - `HubWithEnvironments.hubRepository.test.ts`, «a machine's uploads carry only what the Hub lacks, across its Threads»: tres Threads en una máquina con un binario sin commit, subidas por partes; el segundo y el tercero (sin ningún Thread anunciado) añaden menos de la mitad del binario. Sin el arreglo de la máquina añadían 618 KB (dos copias de 300 KB).

## Comments
