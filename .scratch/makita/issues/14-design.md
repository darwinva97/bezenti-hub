# 14 design: follow the pull request's conversation

Ticket: `14-seguir-la-conversacion-del-pr.md`. Spec: `../spec.md` («Seguir la conversación», «Deduplicación e idempotencia», «Quién lo pide y si puede», «Amenazas de prompt injection», «Parar»). Builds on 09 (comment feeds, `decideComment`, waking a live task's Thread, `/makita stop`), 12 (`pr_number`: which pull request is Makita's) and 06 (`stopTasksWithin`, `MakitaStops`).

## What changes

- **Makita's pull request** is the `pr_number` of a live task (`running`, `waiting-ci`, `waiting-reply`) of a configuration that listens to the repository. On it nobody needs to mention Makita: what is said there is said to it. On the issue, nothing changes (mentions only).
- **What is read**, with Makita's token, in the feeds that already exist plus one:
  - conversation comments (`issue-comments` feed) and review comments, replies in review threads included (`review-comments` feed) whose number is Makita's pull request: candidates without a mention (keys `gh:issue-comment:<id>`, `gh:review-comment:<id>`, as 09);
  - **reviews** (new, `gh:review:<id>`): for each Makita pull request of the repository, `GET /repos/{o}/{r}/pulls/{n}/reviews` when the repository's `review-comments` feed is due (30 s with a live task), with an ETag kept in memory (a 304 costs no quota; a restart reads once more and every known key is skipped). A review counts when it is `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED` with text; an empty `COMMENTED` review is only the envelope of review comments, which arrive by their own feed. No cursor: the event key decides, so a review seen twice is decided once.
- **The decision** (pure, new `makita/makitaConversation.ts`; the intake writes it in its batch, as 09):
  1. Makita's own comments and reviews on its pull request are not stored (they are not said to it).
  2. A first line that is a `/makita …` command Makita does not know yet (`ok`, `merge`: tickets 11 and 13) is not stored: left for those tickets.
  3. A known command (`/makita stop`, `/makita retry`) is decided by `decideComment` with the task as the live one: `/makita stop` from someone on the list stops the task from the pull request as from the issue.
  4. Otherwise as every comment: ghost or `type: Bot` or `ignore_json` → `ignored-bot`; edited → `ignored-edited`; configuration not active → `ignored-paused`; author's numeric id not on the list → `ignored-not-allowed`; else `queued` / `conversation`.
- **The wake** (`MakitaTasks`, the path of 09's mention on a live task): the checks of a start (Makita and configuration not paused, Space open, creator active with `makita.use`, AI account usable); the comment or review read again by id (same author; a comment edited since is `ignored-edited`); the text framed with an unpredictable tag and mentions broken, saying who wrote it (`allowed`), where (conversation, review with its state, or review comment with file, line and id) and how to answer; `sendToThread` in mode `queue` as the creator with `CommandId` `makita:<event_key>` and `MessageId` `makita-message:<event_key>`; the task `running`, `replies_without_person = 0`; the event `started` / `conversation`. A task ended meanwhile wakes nothing (`ignored-no-config` / `task-ended`).
- **Answering where it was said** (`makita_comment`, no new tool): optional `on: "pull_request"` posts on the task's own pull request's conversation; optional `replyTo: <id>` answers in a review thread. The Hub reads that review comment from GitHub by id and refuses it unless it is on the task's own pull request (same repository, `pr_number`); the reply goes to the thread's first comment (`POST …/pulls/{pr}/comments/{id}/replies`). Destination built from the task row, never from the call. Same secret mask, token-shape refusal, pause and task checks, audit (`makita.github.comment`, `number` = where it was posted) and loop guard as a comment on the issue.
- **Reading the conversation** (`makita_read_issue`, no new tool): when the task has its pull request, the answer adds its conversation comments, reviews (state) and review comments (id, file, line, reply-to), up to 100 of each, each framed with its author and whether allowed.
- **Loop guard**: unchanged and per task, so it already counts Makita's comments on the issue and on the pull request together (5 in a row without a person, 30 in 24 hours; the Hub's own CI notices count too). Only an allowed person's wake resets the count.
- **Ending**: the issue-events feed carries the pull request's events. `merged` on Makita's pull request → the task is `done`. `closed` without merge → stopped `pr-closed` (the turn interrupted by `MakitaStops`); `locked` → stopped `pr-locked`. Stopping «the task of issue N» now also finds the task whose pull request is N (one repository numbers issues and pull requests together, so N is never both).
- **Activity**: a woken event reads «Continued on its pull request»; the events list already links `repo#n` to the pull request.

## What a stranger commenting on Makita's pull request can and cannot cause

- **Can:** one `makita_events` row per comment or review (`ignored-not-allowed`, kept 90 days, shown in the activity); and their text is in what the agent reads when an allowed person wakes it and it calls `makita_read_issue`, framed and marked «not allowed». That is prompt-injection surface, bounded as in the spec's table: the agent can only write on its own issue and pull request, push to its own `makita/` branch through the Hub's checks, and never merge or approve.
- **Cannot:** wake the Thread, start a task, spend AI tokens, make Makita post, reset the loop guard, stop or retry a task, approve a push, or turn an already decided comment into an order by editing it. A stranger's review wakes nothing, whatever its state. Bots and `ignore_json` logins get the same silence, so a bot commenting in a loop gets no answer at all.

## Who may do it

The intake and the wake run as the system and as the creator, as in 09. Only an allowed GitHub id (numeric) wakes a Thread. The agent's writes go only to its task's issue or pull request, checked on the Hub. No new RPC, route or MCP tool (two existing tools gain optional inputs and their door texts say so); no new audit action; no migration.

## How it is undone

Pausing the configuration, «Stop all», stopping the task, `/makita stop` on the issue or the pull request, or closing the pull request ends the following: the next pass finds no live task, so its pull request is not followed. Event rows age out at 90 days.

## Left for others (not built)

- Ticket 11: a push asked in a review by someone who is not an approver must wait for `/makita ok` (`approved_through`). Every wake is already an event row with its task, its author's id and its time on GitHub, which is what 11 needs to tell whether an approval came after the last instruction. Until 11 lands, pushes after the first follow 10's rule.
- Ticket 13: `/makita merge` and `makita_request_merge` (`kind: review`).

## Downsides (accepted)

- GitHub gives a review no edit time, so an edited review cannot be told from a new one; its body is read again when Makita acts and only feeds the agent, never a Hub decision.
- A review with several review comments wakes the Thread once per item; each message says more may follow.
- Live pull requests opened before this ships have their earlier reviews read once as new.

## Tests (red-first)

`makita/MakitaConversation.test.ts` over the fake GitHub (which gains reviews, a pull request's review comments with file and line, replies, and merged pull requests): a stranger's comment, review comment and `CHANGES_REQUESTED` review on Makita's pull request wake nothing; an `ignore_json` bot commenting in a loop gets no reply; an allowed person's comment, review and review-thread reply wake the Thread once each, framed, without a mention, and reset the guard; an edited comment does not; `/makita ok` is left untouched; `/makita stop` on the pull request stops the task; `makita_comment` posts on the pull request and replies in a review thread, refuses a review comment of another pull request, and the guard counts issue and pull request together; a merged pull request ends the task `done`, a closed one stops it.
