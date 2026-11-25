# 25 design: every new issue

Ticket: `25-todo-issue-nuevo.md`. Spec: `../spec.md` («Cómo llegan los eventos», «Deduplicación e idempotencia», «Quién lo pide y si puede», «Parar»). Builds on 04 (the intake, cursors, `makita_events`), 05 (tasks from `queued` events) and 08 (`allowedCallerIds`).

## What changes

- **Where the option lives.** Migration **174** adds `makita_configs.autonomy_json TEXT NOT NULL DEFAULT '{}'`: one JSON column for the three robobun-style tickets (25, 26, 27), read and written only through `makita/makitaAutonomy.ts`. Ticket 25 keeps `newIssues: boolean` and `newIssuesSince: <Hub time it was switched on>`; the contract shows `autonomy.newIssues` and the form sends it. Absent in an update: kept as stored. Turning it on or off is audited in `makita.config.update` with `new_issues` in `changed`; create and update audit `autonomy` (the options on, by name).
- **A fourth feed, `new-issues`**, per repository, read only while some live configuration listening to it has the option on (paused ones too, so what comes during a pause is `ignored-paused` and never replayed). Otherwise its cursor row is deleted, so switching it on later starts «now».
  - `GET /repos/{o}/{r}/issues?state=all&sort=created&direction=desc&per_page=100` with `If-None-Match`, paged like issue events (down to the cursor, at most 10 pages). The cursor is the highest issue number seen (issues and pull requests share numbers and they only grow).
  - **First read**: the cursor becomes the newest number, nothing is handled. Then only numbers above the cursor, oldest first, in the batch's transaction with the cursor (exactly once by key, as 04).
  - **Pull requests** (`pull_request` in the item) are skipped and not stored.
  - **Switched on later**: an issue counts for a configuration only when GitHub's `created_at` is at or after its `newIssuesSince`. This only matters for the minute between a poll and a switch while another configuration already reads the feed; the clocks of GitHub and the Hub differ by seconds at most.
- **The decision** (pure, `makita/makitaNewIssues.ts`), key `gh:new-issue:<issue id>`, caller the issue's author:
  1. candidates: configurations with the option on whose `newIssuesSince` is not after the issue; none: not stored;
  2. ghost author `ignored-bot`; Makita itself `ignored-self`; `type: Bot` or `ignore_json` `ignored-bot`;
  3. no active candidate: `ignored-paused`;
  4. the oldest active candidate whose list holds the author's numeric id: `queued` / `new-issue`; none: `ignored-not-allowed` / `new-issue`, filed under the oldest active one. Silence on GitHub.
- **The task** is ticket 05's start, unchanged: `MakitaTasks.startQueued` reads `new-issue` from `detail` (`makitaFollowUp.triggerOf`) and the first message says «GitHub user x (allowed) opened the issue below.». Every check of a start runs (pauses, creator, Space, AI account, issue still open and unlocked; one live task per issue). Nothing skips the `queued` rows, so a cap on simultaneous tasks applies to these too.
- **Web**: a new «On its own» section in the configuration form (`MakitaAutonomyFields.tsx`): «Every new issue», with the warning that it spends AI usage on every issue opened by someone it answers, and «Issues opened by anyone else are ignored (the activity shows them) until Makita has a sandbox of its own and can answer anyone.» A configuration may have only this trigger. The row lists it.

## Who may do it

Turning it on: the configuration's creator, with `makita.use` (as every edit). Starting a task: only an issue author on the configuration's list, by numeric id. A stranger causes at most one `INSERT` per issue they open; never a GitHub write, never a Thread. No new RPC, route or MCP tool.

## How it is undone

Untick «Every new issue»: the next pass stops reading the feed and deletes its cursor; nothing queued later. Pausing the configuration or «Stop all» works as in 04/06. Migration 174 only adds a column with a default.

## Tests (red-first)

`MakitaNewIssues.test.ts` over the fake GitHub (which gains the issues list with ETag, `created_at` and pull requests in it): first read handles nothing; an allowed author's new issue starts one task, once, even when the feed answers it twice; a stranger's is `ignored-not-allowed` / `new-issue` with no GitHub write; a pull request is not stored; an issue opened before the switch-on is ignored; switching off stops the reads and the cursor goes; a paused configuration gives `ignored-paused`; the option off by default reads nothing.
