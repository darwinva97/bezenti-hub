# 18: El disco del Hub, visible para el Owner

**What to build:** Tras el incidente de [17](17-el-repositorio-del-hub-no-crece-con-cada-subida.md), el Hub ya no deja que las subidas llenen su volumen de estado (507 por debajo de `max(512 MiB, 5 %)` libre) y avisa en el log por encima del 80 % usado. Pero el Owner no lo ve hasta que algo falla: el log no se mira. Este ticket lo pone en la app.

**Blocked by:** —

**Status:** ready-for-agent

- [ ] El Hub mide su volumen de estado (libre y total, `statfs` del state dir) y el tamaño de `hub-repositories` (suma de `count-objects -v`), en el barrido de `HubRepositoryMaintenance` (cada hora) y no en cada petición.
- [ ] El Owner lo ve en Plataforma (junto a la vista de Users o de máquinas): «Hub disk: 14.2 GiB of 20 GiB used (repositories 3.1 GiB)», con aviso por encima del 80 % y otro cuando el Hub ya rechaza subidas.
- [ ] Una máquina cuyas subidas se rechazan por disco dice por qué en su fila de Settings y en «Checkpoint not uploaded yet» (`HubRepositoryUploadIssues`): hoy git solo muestra «HTTP 507».
- [ ] Contrato: un campo nuevo en la respuesta que ya lee el Owner; web y móvil.
- [ ] Coordinar con `plans-and-limits/06` (disco por Space y poda): esa poda debe dejar un margen de tiempo a los objetos sin ref, porque una subida puede contar con un tip que la máquina vio (anunciado o por `packs/known`) justo antes de borrarse; el apply lo detecta (`rev-list`) y la subida se reintenta, pero sin margen se repetiría.
- [ ] Tests: la medición con un `diskSpace` falso; el aviso y el rechazo en la vista del Owner.
