# 06 design: stop for real

Ticket: `06-parar-de-verdad.md`. Spec: `../spec.md` («Parar», «Atribución» table, «Puertas», «Auditoría»). Builds on 04 (the global switch already stops the poller and drops every cursor) and 05 (`makitaRows.makitaTaskOfThread`, the tasks, `makita_comment`'s own pause check).

## What changes

- **One way to stop tasks**, `makitaRows.stopTasksWithin(sql, { actor, scope, reason })`, run inside the caller's transaction: every live task in scope (`state NOT IN ('done','stopped','failed')`, so `awaiting-approval` too: a pending approval is cancelled with it) becomes `stopped` with `failure = <reason>`, each audited `makita.task.stop` (`space`, `repo`, `number`, `makita`, `reason`). Scopes and reasons:
  - a configuration paused (`config-paused`) or deleted (`config-deleted`), by its creator, an Admin of its Organization or the Owner (`MakitaConfigs`, the transaction that pauses it);
  - «Stop all Makita work» (`makita-paused`): every live task, in the Owner's transaction (`MakitaAccount`);
  - a creator's configurations paused by the Hub (`permission-revoked`, `creator-left`, `creator-disabled`): `pauseCreatorConfigsWithin` stops their tasks in the same transaction (the permission revoke, the User removed, a check at start);
  - an issue closed or locked (`issue-closed`, `issue-locked`, as the system): the intake's batch, as in 05;
  - one task (`stopped`), by a person: new WS `makita.tasks.stop { taskId }`.
- **The turn is interrupted outside the transaction**, by a new Scheduler source `makita-stops` (`makita/MakitaStops.ts`, runs every 5 s like the intake, beside it in the orchestration layer): each task that became `stopped` in the last hour and was not handled yet by this process gets `thread.stop` on its Thread, as the system (the Scheduler's fiber has no actor), `CommandId` `makita-stop:<taskId>` (a repeat after a restart replays nothing), reason «Makita stopped this work: <why>.», delegated tasks stopped too. A failed dispatch is retried on the next pass, three times at most. Why a sweeper and not a call from each door: the doors that stop tasks live below the orchestration (`MakitaConfigs`, `MakitaAccount`, the User-removal transaction), and one sweeper also covers a crash between the commit and the interrupt. The interrupt lands within one tick (≤ 5 s); spending stops before that, at the gateway.
- **The gateway refuses at once.** `AiGatewayKeys.authorize`, for a Thread key, reads `makitaTaskOfThread` in the same parallel batch as the Thread's Space, owner and move (one indexed read, no extra round trip; nothing for User keys and access keys). A Makita Thread whose task is not live, whose configuration is paused or deleted, or with Makita stopped (or unregistered) gets **403 «Makita is stopped for this work.»**; the key is refused, not revoked. `MakitaThreadTask` gains `halted` (why it may not work now, or null); the caller gains `GatewayCaller.makitaConfigId` (null outside Makita; ticket 07 writes it on usage).
- **Starting cannot slip past a stop.** `MakitaTasks.startOne` reads the task again right before the launch and launches nothing for a task already stopped.
- **`makita_*` tools** already refuse while paused or after the task ends (05); they read the same `halted`.
- **Resume replays nothing.** Configuration: what came while paused is `ignored-paused` (04), stopped tasks stay stopped and are asked for again. Global: the poller dropped every cursor while stopped (04), so each repository starts from «now».
- **GitHub hears nothing** about a stop: no comment, no reaction (`/makita stop` from GitHub is ticket 09).
- **Web**: the configuration's «Stop now» and its paused state with who paused it already exist (03); the copy now matches what happens. A per-task «Stop» needs a list of tasks, which is ticket 07's activity view: this branch gives it the door (`makita.tasks.stop`) and the client command.

## Who may do it

- Pause a configuration: its creator, an Admin of its Organization, the Owner (`makita.pause`, as in 03). Resume: its creator or the Owner; one paused by the Owner only the Owner (03, unchanged).
- Stop one task: whoever may pause its configuration (`makita.pause` on the task's configuration). Someone who cannot see the configuration gets not-found. A person's own WS session only, never an agent, the shell or a one-Space session (`RPC_SPACE_ACCESS`, door sweeps).
- «Stop all Makita work»: the Owner (`OWNER_ONLY`, 01).
- The interrupt and the gateway refusal: the Hub itself.

## How it is undone

Resume the configuration (or Makita). Stopped tasks are not resumed: the next trigger makes a new task. Threads stay in the Space with their history. No migration.

## Tests (red-first)

- `MakitaStops.test.ts`: pausing interrupts the running Thread as the system with its reason, once (a second pass and a restart dispatch nothing new); the Owner's stop, a closed issue and a task stopped by hand do too; the creator cannot resume what the Owner paused; nothing is written on GitHub by any stop.
- Gateway over `AiGatewayRoute.testkit.ts` and the fake GitHub: a Makita Thread's key answers 200, then 403 «Makita is stopped for this work.» on its next request after the pause, the global stop and a stopped task; a Thread that is not Makita's is untouched.
- `makita_comment` after a pause writes nothing (05's test kept).
- `makita.tasks.stop`: the creator and an Admin stop, a Member who cannot see it gets not-found, an agent session is refused; door sweeps (`DoorRules`, `RpcAuthorization`) list it.
