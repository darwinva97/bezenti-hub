# 09 design: mentions, assignment, `/makita stop` and `/makita retry`

Ticket: `09-menciones-y-asignacion.md`. Spec: `../spec.md` («Cómo llegan los eventos» feeds 2 and 3, «Deduplicación e idempotencia», «Quién lo pide y si puede», «Seguir la conversación»). Builds on 04 (the intake), 05 (tasks, framing, loop guard) and 06 (one way to stop).

## What changes

- **Three feeds per repository**, each its own row in `makita_repo_cursors` (`feed`: `issue-events`, `issue-comments`, `review-comments`), each with its ETag, cadence, `X-Poll-Interval` and failure marks as in 04. A rate limit on any of them holds every repository (one token).
  - `issue-events` (04) is **paginated**: page after page (`page=2…`) while a page is full and its oldest event is still newer than the cursor, at most 10 pages (1 000 events) per poll. Beyond that GitHub's feed is too far behind; the poller logs it and moves on.
  - `GET /repos/{o}/{r}/issues/comments` and `GET /repos/{o}/{r}/pulls/comments` with `sort=updated&direction=asc&since=<cursor>&per_page=100`, paginated the same way (at most 10 pages a poll; what is left comes next poll, since the cursor only moves over what was handled). The cursor is `<updated_at>|<id>` of the last comment handled, so comments sharing a second are not lost or replayed. The first read of a repository asks for the newest comment only and starts from it: nothing older than listening is replayed (as 04).
  - Keys: `gh:issue-comment:<id>`, `gh:review-comment:<id>`. Only comments that mention Makita (`@<login>`, a whole word, not in a `>` quote) or whose first line is a command are stored; others are not.
- **Only creation counts.** A candidate comment whose `updated_at` differs from `created_at` and whose key is unknown is stored `ignored-edited`; one already decided keeps its row (`ON CONFLICT DO NOTHING`). When Makita acts on a comment it reads it again from GitHub by id and refuses it if it changed or its author is not the one decided on.
- **The decision** (pure, in `makitaFeeds.ts`; the intake writes it in the batch's transaction):
  1. ghost author `ignored-bot`; Makita itself `ignored-self`; `type: Bot` or `ignore_json` `ignored-bot`; edited `ignored-edited`.
  2. `assigned` issue event whose assignee is Makita's account, caller the event's actor; configurations with `triggers.assigned`. On a pull request: `ignored-no-config` / `pull-request`, as the label.
  3. A mention on an issue or pull request **with a live task**: that task's configuration decides. On its list: `queued` / `mention` (the Thread is woken). Not on it: `ignored-not-allowed`. The trigger flags do not matter here: they say what starts a task.
  4. A mention **without a live task**: configurations with `triggers.mention`, oldest active one whose list holds the author: `queued` / `mention`. Mentions on pull requests start a task (`kind: pull`, comment only).
  5. `/makita stop` (first line, case-insensitive, nothing else on it): the live task's configuration's list decides; `queued` / `stop`. No live task: `command` / `nothing-to-stop`.
  6. `/makita retry`: the newest task of the issue is `failed` and none is live: that task's configuration decides; `queued` / `retry`. Otherwise `command` / `nothing-to-retry`.
  7. Strangers get silence (`strangers` is still `ignore` only).
- **`MakitaTasks.startQueued`** reads the trigger from the queued event's `detail` (null = `label`):
  - `stop`: `stopTasksWithin` (reason `github-stop`, a new stop reason; `MakitaStops` interrupts the turn), a 👍 reaction on the comment (audited `makita.github.reaction`, new action), the event `command` / `stop`. No text is written.
  - `mention` on an issue with a live task: **continue** instead of a second task. The checks of a start run first (Makita and configuration not paused, Space open, creator active with `makita.use`, AI account usable). The comment is read again (unedited, same author), framed like the first message (unpredictable tag, mentions broken, author `allowed`), and sent with `ThreadManagementService.sendToThread` in mode `queue`, as the creator, `CommandId` `makita:<event_key>` and `MessageId` `makita-message:<event_key>` (a replay after a restart sends nothing twice). Then the task goes `running` with `replies_without_person = 0` (the author is an allowed person) and the event `started` / `continued`.
  - `label`, `assigned`, `mention` (no live task), `retry`: a new task as in 05, with the trigger in the first message, in `makita.task.start` (`trigger`) and in the event's `detail`. A label or assignment on an issue with a live task stays `task-open`.
- **Configurations** accept `assigned` and `mention` (the label may then be empty); at least one trigger. The web form gets two checkboxes; the row lists the triggers. The activity view shows `detail` already; one line shows `started` / `continued` as «Continued a task».

## Who may do it

Nobody calls it: the intake runs as the system. Only an allowed GitHub id (by numeric id, on the configuration's list) starts, wakes, stops or retries anything; strangers, bots and Makita itself get silence, at most one `INSERT` each. No new RPC, route or MCP tool; no migration (`makita_events.outcome` already allows `ignored-edited` and `command`).

## How it is undone

Unticking a trigger stops it at the next poll. Pausing a configuration or «Stop all» works as in 04/06 (events `ignored-paused`, nothing replayed). A woken Thread is stopped like any task. Event rows age out at 90 days.

## Tests (red-first)

`MakitaIntake.test.ts` / `MakitaMentions.test.ts` over the fake GitHub (which gains both comment feeds with `since`, pages, edits, reads by id and reactions): a mention in an edited comment does not trigger; a stranger's mention does not wake an open Thread; two mentions on one issue make one task; an allowed mention wakes a `waiting-reply` Thread with the framed comment and resets the guard; assignment to Makita starts a task, to someone else nothing; `/makita stop` from an allowed person stops the task and reacts, from a stranger nothing; `/makita retry` restarts a failed task only; 150 events between two polls are all handled.
