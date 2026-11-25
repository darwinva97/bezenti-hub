# 26 design: close issues with a verdict

Ticket: `26-cerrar-issues.md`. Spec: `../spec.md` («Amenazas de prompt injection», «Seguir la conversación», «Parar», «Puertas», «Auditoría»). Builds on 05 (`makita_comment` and the loop guard), 08 (`allowedCallerIds`) and 09 (commands read again by id, reactions).

## What changes

- **Configuration** (`autonomy_json`, migration 173): `closeIssues` (off), `closeMinConfidence` (0.5–1, default 0.8), `closePerDay` (1–50, default 10). Audited as `close_issues` in `changed`.
- **Table `makita_issue_closes`** (migration 173), one row per issue Makita ever closed: `(host, repo, number)` primary key, `config_id`, `task_id` (unique), `verdict`, `ref_number`, `confidence`, `state_reason`, `claimed_at`, `closed_at`, `reopened_at`, `reopened_by_github_id`, `reopened_by_login`, `reopened_via`. The key makes «at most once per issue, ever» and «at most once per task» a constraint; it is never deleted except a claim whose close GitHub refused.
- **MCP tool `makita_close_issue { verdict, ref?, confidence, reason }`**: `verdict` is `wanted`, `not-wanted`, `duplicate`, `cannot-reproduce` or `already-fixed`; `ref` is the `#n` of a duplicate or of what fixed it (required for those two, refused otherwise). The state follows the verdict: `already-fixed` and `wanted` close as completed, the others as not planned. Listed only when the configuration has `closeIssues` (`makitaTaskOfThread.mayCloseIssues`, `McpInvocationContext.toolAllowedFor`); the agent learns its rules from the tool description, so the first message does not change.
- **The Hub decides** (`MakitaIssueCloses.closeForThread`), every check on the Hub, in order; any refusal answers only the agent and writes nothing on GitHub:
  1. the calling Thread's task; Makita and the configuration not paused, the task live, `closeIssues` on, the task an issue's;
  2. the input: a known verdict, `ref` as above and not the issue itself, `0 ≤ confidence ≤ 1`, a reason of 1–300 characters, masked with the creator's secrets and refused when token-shaped;
  3. `confidence ≥ closeMinConfidence`;
  4. no row for this issue (Makita closed it before; a person reopened it or it is still closed) and none for this task;
  5. fewer than `closePerDay` claims by this configuration in the last 24 h;
  6. the issue read now from GitHub: open, not locked, not a pull request; its author's numeric id is on the configuration's list now, **or** the task's caller (who labelled, assigned, mentioned or opened it) is: a stranger's issue is closed only when someone it answers handed it to Makita, never on a stranger's word alone;
  7. `ref` read from GitHub in the same repository (`issues/{ref}`: an issue or a pull request); 404 refuses;
  8. the loop guard (5 in a row, 30 a day) allows one more comment;
  9. the claim: `INSERT … ON CONFLICT DO NOTHING` (a race loses here), then the stop checks of 1 once more.
- **On GitHub**: one comment, then `PATCH issues/{n} { state: closed, state_reason }`. The comment, in robobun's shape: «Triage verdict: not wanted (confidence 0.85). <reason>» / «Closing as not planned. If that is wrong, reopen this issue or comment `/makita reopen`: Makita will not close it again.». If the close fails, the claim is deleted and the agent told (the comment stays; it says what was meant). Then, in one transaction: `closed_at`, the task `done`, audit `makita.github.close_issue` (`agent` as the creator; `repo`, `number`, `makita`, `verdict`, `ref`, `confidence`, `stateReason`) and the comment's `makita.github.comment`. The `closed` event the intake reads later finds no live task.
- **Reopening wins forever.**
  - On GitHub: a `reopened` issue event on an issue with a row and no `reopened_at`, by someone the row's configuration answers now, records `reopened_at`, who and `via: github`; the event row is `command` / `reopened`. Makita never closes that issue again anyway (the primary key).
  - `/makita reopen` (first line, any case, trimmed) in a new issue comment on such an issue, by someone that configuration answers: the intake stores `command` / `reopen`; the closes pass (`makita-cleanup` source) reads the comment again by id (unedited, same author, still the command), skips it while Makita or the configuration is paused (`ignored-paused`), then `PATCH state: open`, records the row, reacts 👍 and audits `makita.github.reopen_issue` (system; `repo`, `number`, `makita`, `by`). The event ends `command` / `reopen:done`. Strangers, bots, edited comments and Makita itself: silence (`ignored-not-allowed`, `ignored-bot`, `ignored-edited`, `ignored-self`).
- **Activity**: the task ends `done`; the comment and close are in the audit; reopenings are events.

## Who may do it

Turning it on: the creator, with `makita.use`. Asking: only the agent of a live task of that configuration, about its own issue. Deciding: the Hub. Undoing: anyone the configuration answers (reopen or `/makita reopen`), or anyone with Triage on GitHub (reopening is GitHub's). Strangers cannot cause a close: their issues are refused unless someone allowed handed them over, and their comments never wake the agent (05, 09).

## How it is undone

Untick «May close issues»: the tool is gone at the next request (the MCP door reads the configuration each request). An issue Makita closed is reopened on GitHub or with `/makita reopen`, and stays open. Pausing or «Stop all» refuses at check 1 and again before the write.

## Risks that stay

The verdict comes from a model reading untrusted text, so a wrong close can happen on an allowed person's issue. The threshold, the daily cap, once per issue, the public reason, and the one-step reopen bound it.

## Tests (red-first)

`MakitaIssueCloses.test.ts` over the fake GitHub (which gains `PATCH issues/{n}` with `state_reason`, and reopen events): refused with the capability off, paused, task stopped, under the threshold, a missing `ref`, a stranger's issue asked for by nobody allowed, twice in one task, over the daily cap, an issue already reopened; a valid close comments once and closes with `not_planned` / `completed`, ends the task and audits; an allowed reopen is recorded and blocks another close; `/makita reopen` from an allowed person reopens and reacts, from a stranger nothing. The door sweeps list the tool.
