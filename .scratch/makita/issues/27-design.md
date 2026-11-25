# 27 design: cleaning up Makita's pull requests

Ticket: `27-limpieza-de-prs.md`. Spec: `../spec.md` («Abrir el PR, esperar la CI, arreglar el RED», «Aprobación», «Parar», «Auditoría»). Builds on 06 (`stopTasksWithin`, `MakitaStops`), 11 (`isApproverNow`, pending pushes), 12 (`pr_number`) and 13 (branch deletion).

## What changes

- **Configuration** (`autonomy_json`, migration 173): `closeIdlePrsDays` (null = off; 7–180, the form suggests 90) and `badWorkLabel` (null = off; up to 50 characters, the form suggests `slop`). Audited as `close_idle_prs` / `bad_work_label` in `changed`.
- **Column `makita_tasks.pr_closed_at`** (migration 173): when the Hub saw or made the task's pull request closed, so the sweep never reads it again.
- **(a) The idle sweep**, Scheduler source `makita-cleanup` (`MakitaCleanup.ts`), at most once every 10 minutes, nothing while «Stop all» is on, the token is refused or the intake's rate-limit hold lasts:
  1. Candidates: tasks of live, unpaused configurations in open Spaces with `closeIdlePrsDays`, with a `pr_number`, no `pr_closed_at`, state not `running`, `awaiting-approval` or `done`, no `pending_push_json`, and the Hub's `updated_at` older than N days; 20 a pass.
  2. `GET pulls/{n}`: not open → `pr_closed_at` and nothing else; opened by another account, or its head not the task's `makita/…` branch → skipped (never touched). Idle: GitHub's `updated_at` (any comment, review, push or label moves it) N days before GitHub's own clock (the answer's `Date`), so the two clocks are never mixed.
  3. Right before writing, the task and configuration are read again (same conditions).
  4. One comment on the PR: «Closing this pull request: nothing happened here for N days. Reopening it is fine (restore its branch first); Makita will not close it again.», `PATCH pulls/{n} { state: closed }`, `DELETE git/refs/heads/makita/…` (best effort). In one transaction: `pr_closed_at`, the task stopped with reason `pr-idle` if still live (`stopTasksWithin`), audit `makita.github.close_pull_request` (system; `repo`, `number`, `makita`, `pr`, `branch`, `reason: idle`, `days`) and the comment's `makita.github.comment`.
- **(b) The bad-work label.** The intake, on a `labeled` issue event of a pull request whose label (case-insensitive) is the `badWorkLabel` of the configuration of the task that owns that PR (`pr_number`, newest task) and that configuration listens to the repository: Makita itself `ignored-self`, bots `ignored-bot`, paused `ignored-paused`, otherwise `command` / `bad-work` (decided after the batch). The same `makita-cleanup` pass, each tick:
  - `isApproverNow(config, actor)` false → `ignored-not-approver` / `bad-work`, silence;
  - Makita or the configuration paused meanwhile → `ignored-paused`;
  - `GET pulls/{n}`: not open, not Makita's or not the task's branch → `command` / `bad-work:not-open` or `bad-work:not-makita`;
  - otherwise `PATCH pulls/{n} { state: closed }`, the branch deleted, then in one transaction `pr_closed_at`, the task stopped with reason `bad-work` (MakitaStops interrupts its turn), audit `makita.github.close_pull_request` (`reason: bad-work`, `by`: the approver's public login, `byId`), the event `command` / `bad-work:closed`. No comment: the label says it.
- **Activity**: the task's `failure` reads `pr-idle` or `bad-work`; the label shows as an event.

## Who may do it

Turning either on: the creator, with `makita.use`. (a) The Hub alone, only Makita's own open PR of a known task of that configuration, never with a pending approval or a running turn. (b) Only an approver now (the creator's linked account or a listed approver who is an active Admin or Member); anyone else's label does nothing. No new RPC, route or MCP tool.

## How it is undone

Untick the option or empty the label: the next pass reads the configuration again. Pause or «Stop all»: nothing is closed. A closed PR is reopened on GitHub (its branch restored with GitHub's button); `pr_closed_at` keeps the sweep away from it.

## Tests (red-first)

`MakitaCleanup.test.ts` over the fake GitHub (which gains `PATCH pulls/{n}`, a PR's `updated_at` and a `Date` header): an idle PR is closed once with its comment and branch deleted and the task stopped; an active PR, another account's PR, a PR with a pending push, a running task, a paused configuration and the option off are left alone; an approver's label closes and stops at once; another person's label does nothing; a paused configuration ignores the label.
