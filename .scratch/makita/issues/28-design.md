# 28 design: removing a finished task's worktree

Ticket: `28-limpiar-worktrees.md`. Spec: `../spec.md` («Empujar», «Abrir el PR», «Parar»). Builds on 10 (`workspace_json`, `MakitaMachines.makeWorktree`), 12 (`pr_number`), 13 (`landed_sha`, `afterMerge`), 14 (`merged`/`closed` events of Makita's pull request) and 27 (`pr_closed_at`).

## What changes

- **Column set on `makita_tasks`** (migration 177): `worktree_removed_at` (removed, or found already gone), `worktree_failing_since`, `worktree_next_try_at`, `worktree_failure` (the last reason, one line), `worktree_gave_up_at`, and `branch_cleanup` (`pending` → `deleted` | `failed`).
- **A new executor call `move.remove`** (contract 18), the counterpart of `move.prepare`: `{ checkout, projectId, threadId, cwd }` → `removed` | `absent` | `refused` with a reason. The machine removes `cwd` only when it is exactly `movedWorktreePath(worktreesDir, projectId, threadId)` (where `move.prepare` made it), it is listed by the Project checkout's `git worktree list`, and it is not the checkout; then `git worktree remove --force --force` and `git worktree prune`. A folder that is gone and unlisted answers `absent`. Anything else is `refused` and left untouched. **Machines need this new code.** The Hub never calls it on a machine whose contract is below 18 (an older machine): it records `outdated-machine` and looks again every 6 hours, with no network call, until the machine is updated.
- **The pass**, Scheduler source `makita-worktrees` (`MakitaWorktrees.ts`, registered by `MakitaCleanup.layerScheduled` so the wiring cannot be left out), at most every 5 minutes, 20 tasks a pass, nothing while «Stop all» is on. A task's worktree is removed when it has one (`workspace_json`), it was not removed or given up, no push is waiting, its state is `done`, `stopped` or `failed`, and:
  1. its pull request is merged or closed (`landed_sha` or `pr_closed_at`): now;
  2. it never opened one: 7 days after it ended (its `updated_at`). `/makita retry` and a mention on an ended task start a **new** task with a new Thread and worktree; nothing reuses an ended task's worktree, so the 7 days are only for a person to look at or rescue what was never pushed;
  3. its pull request still looks open: kept. The pass asks GitHub (`GET pulls/{n}`) at most every 6 hours; not open → `pr_closed_at`, removed in the same pass. This also covers tasks that ended before this ticket.
     A live task, or an ended one whose pull request is open, keeps its worktree.
- **Offline or failing machine**: the removal is retried after 10 minutes, doubling up to 6 hours; after 14 days of failures it gives up (`worktree_gave_up_at`, audit `outcome: gave-up`). An outdated machine never counts as a failure. A refusal (by the Hub or the machine) is final at once (audit `outcome: refused`).
- **A person merges or closes Makita's pull request on GitHub**: the intake already ends a live task (`merged` → `done`, `closed` → stopped `pr-closed`). Now, on those events, when the actor is not Makita's account, the task did not land it and `pr_closed_at` is empty, it also sets `pr_closed_at` and `branch_cleanup = 'pending'`; the pass deletes the `makita/…` branch (best effort as in `afterMerge`; 404 or 422 counts as gone; GitHub unreachable or rate-limited: tried again next pass), audit `makita.github.delete_branch`. The 6-hour GitHub check never deletes a branch: only an event seen live does.
- **Audit** (system): `makita.task.remove_worktree` (`repo`, `number`, `makita`, `environment`, `outcome` removed | gone | refused | gave-up, `why` pr-closed | ended) and `makita.github.delete_branch` (`repo`, `number`, `makita`, `pr`, `branch`). Both labelled in `AUDIT_ACTION_LABELS`.

## Safety

The Hub reads the machine and path only from `workspace_json`, which it wrote itself when it made the worktree; never from an agent or GitHub. Before calling, it checks that the path's last two folders are the ones `movedWorktreePath` gives for that task's Project and Thread (folder names alone, so a Windows machine's path works too); otherwise refused without calling. The machine then checks the full path, the checkout's worktree list and that it is not the checkout. Never the Project's checkout, never another Thread's worktree.

## Who may do it

The Hub alone. No new RPC, route or MCP tool.

## How it is undone, and what is lost

A removed worktree is not brought back. **Uncommitted or unpushed changes in it are lost on purpose**, as are its installed dependencies. What was pushed stays on GitHub; the Thread's checkpoints stay in the Hub repository. A person still working by hand in an ended Makita task's Thread loses that folder after the 7 days, or at once once its pull request is closed. A deleted branch comes back with GitHub's «Restore branch» button.

## Tests (red-first)

`MakitaWorktrees.test.ts` over the fake GitHub and the fake machine: a worktree removed after a person merges the pull request (and its branch deleted once), kept while the pull request is open, kept through the 7 days for a failed task and removed after, retried when the machine is offline, an outdated machine waited for, a second pass that does nothing, and a refusal of a path that is not the task's recorded worktree. `MovedWorkspace.test.ts`: `move.remove` on real git removes the planned worktree, answers `absent` once gone, refuses another path, the checkout and an unlisted folder.
