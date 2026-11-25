# 22 design: a cap on simultaneous tasks

Ticket: `22-tope-de-tareas.md`. Spec: `../spec.md` («La tarea y su Thread», «Parar»). Builds on 04–07 (`makita_events` queued, `startQueued`, `stopTasksWithin`, the activity).

## What changes

- **Migration `172_MakitaTaskCaps`**: `makita_configs.max_tasks INTEGER NOT NULL DEFAULT 3 CHECK (max_tasks BETWEEN 1 AND 20)` and `makita_account.max_tasks INTEGER NOT NULL DEFAULT 10 CHECK (max_tasks BETWEEN 1 AND 100)`. Existing rows take the defaults. Test: 171 then 172, defaults, the checks refuse 0 and 21/101.
- **What counts**: tasks at work, the activity's «Now»: `running`, `waiting-ci`, `awaiting-approval`. A task waiting for a person (`waiting-reply`) holds no slot: it may wait for days. A woken task becomes `running` and counts from then on, but the wake itself never waits.
- **`MakitaTasks.startQueued`**: reads the queued events in arrival order (`seen_at, rowid`, at most 500), the counts per configuration and for the Hub, each configuration's `max_tasks` and the Hub's. An event is a **new task** when it is a trigger (`label`, `assigned`, `mention`, `retry`), has no task row yet (a restart's own task is resumed, not counted), its configuration is active (paused ones go through and are ignored as today), and no live task holds its issue or pull request. A new task whose configuration is at its cap, or with the Hub at its ceiling, stays `queued` and is skipped; later ones of the same configuration wait behind it. Everything else (wakes, `/makita ok`, `/makita stop`, conversation, merges) runs as today, never delayed. At most 20 are processed per pass as before; waiting ones do not use that budget. Each started task counts at once, so one pass never overshoots.
- **Removing what waits**: `stopTasksWithin` (pause, delete, «Stop all», a creator paused, `/makita stop`, an issue or Makita's PR closed or locked) also ends, in the same transaction, the queued trigger events of its scope that have no task yet (`makitaQueue.dropWaitingWithin`): `ignored-paused` with the stop's reason, or `ignored-no-config` for an issue's. So a resumed configuration never replays them (the spec's «during a pause, events are not replayed»). Stopping one task by id drops nothing.
- **Survives a restart**: waiting events are rows of `makita_events` with `outcome = 'queued'`; nothing lives in memory.
- **Activity**: `MakitaActivityResult.waiting`: per visible configuration, its waiting events (repository, number, kind, caller login, since, position in its configuration's line). Positions are within the configuration only: another Space's work is never counted or named. `MakitaActivityConfig.maxTasks` for the label.
- **Configuration**: `maxTasks` (optional in the input: absent means 3 on create and unchanged on update), checked 1–20, audited in `changed` as `max_tasks`.
- **Hub ceiling**: `MakitaAccountView.maxTasks`; WS `makita.account.setTaskLimit { maxTasks }` (1–100), the Owner only (`makita.manageAccount`), audited `makita.account.limit` with `from`/`to`.
- **Web**: the form's «At most [3] tasks at once»; the row says «up to N at once»; the activity's «Waiting» list («2nd in line»); Platform → Makita: «At most [10] tasks at once across all configurations».

## Who may do it

A configuration's cap: its creator, as any edit. The ceiling: the Owner. Nobody else changes either; agents never.

## How it is undone

Raise the cap or the ceiling and the next pass starts what waits; lower it and running tasks keep going while new ones wait. Migration adds two columns with defaults.

## Doors added

| Door                             | Rule                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| WS `makita.account.setTaskLimit` | `MAKITA_ACCOUNT`: the Owner's own session (`makita.manageAccount`), `access:write`. |

## Risks said

- A task stuck in `running` (an agent that ended its turn without commenting, a provider failure) holds its slot until someone stops it («Stop now» in the activity). The Hub has no turn-end signal for Makita tasks yet; follow-up.

## Tests (red-first)

`makita/MakitaQueue.test.ts` over the Makita testkit: with cap 1, a second label waits (`queued`, shown waiting at position 1) and starts once the first task ends; three in arrival order start in that order; a mention on a live task's issue is sent at once with the cap full; the Hub ceiling 1 holds a second configuration's event; pausing, `/makita stop` and closing the issue drop the waiting event; a new service instance (a restart) starts it later. Migration test for 172. Door sweeps for `makita.account.setTaskLimit`; audit labels.
