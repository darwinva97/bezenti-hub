# Makita

Makita is the Hub's GitHub bot teammate: a normal GitHub account whose token the Owner registers in Platform → Makita. A Hub agent works behind it. ADR 0011 records the shape: Makita acts as whoever configures it, and its token never leaves the Hub. The spec and tickets live in `.scratch/makita/`.

## Pieces (`apps/server/src/makita/`)

| Module                  | Owns                                                     | Notes                                                                                                                                     |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MakitaGitHub.ts`       | the only reader of the sealed token (`MakitaTokenStore`) | Its own REST client over the Hub's `HttpClient`, never Source Control's credential; tracing off; a 401 marks the account `token-invalid`. |
| `MakitaAccount.ts`      | `makita_account`                                         | The Owner's: register or replace the token, «Stop all Makita work».                                                                       |
| `MakitaPermissions.ts`  | `makita_permissions`                                     | «May use Makita» per User and Space, the Owner's.                                                                                         |
| `MakitaConfigs.ts`      | `makita_configs`                                         | A Space's configurations (repositories from each Project's checkout, callers by numeric id, a gateway AI account).                        |
| `MakitaIntake.ts`       | `makita_repo_cursors`, `makita_events`                   | The poller (ticket 04).                                                                                                                   |
| `MakitaTasks.ts`        | `makita_tasks`                                           | Tasks and their Threads, and the agent's GitHub writes (ticket 05).                                                                       |
| `makitaRows.ts`         | shared reads                                             | `permittedIn`, `pauseCreatorConfigsWithin`, `stopTasksWithin`, `makitaTaskOfThread` (the seam other modules read), `configNames`.         |
| `MakitaStops.ts`        | nothing (reads `makita_tasks`)                           | Interrupts the turn of each stopped task (ticket 06).                                                                                     |
| `MakitaActivity.ts`     | nothing (reads)                                          | `makita.activity` and `makita.threads` (ticket 07): what Makita does and spends.                                                          |
| `makitaFeeds.ts`        | nothing (pure)                                           | The comment feeds, mentions, `/makita` commands and their decision (ticket 09).                                                           |
| `makitaFollowUp.ts`     | nothing (pure)                                           | How each trigger reads in the first message, and the message that wakes a Thread (ticket 09).                                             |
| `MakitaPushes.ts`       | `makita_tasks.workspace_json`, `head_sha`, push state    | A pushing task's worktree and `makita_push` (ticket 10): validates and pushes through `MakitaGitHub`.                                     |
| `MakitaMachines.ts`     | nothing                                                  | The machine side of a push over executor calls every machine serves (`move.fetch`, `move.prepare`, `captureCheckpoint`, upload).          |
| `makitaBranch.ts`       | nothing                                                  | Names built by the Hub: `makita/<n>-<slug>`, its refs in the Hub repository, the bot's `noreply` identity, the worktree setup command.    |
| `GitHubIdentities.ts`   | `github_identities`, `github_link_codes`                 | Each User's linked GitHub account and the one-time codes that prove it (ticket 08).                                                       |
| `makitaCallers.ts`      | nothing (reads)                                          | Whom each configuration answers now, by numeric GitHub id (ticket 08).                                                                    |
| `MakitaPullRequests.ts` | `makita_tasks.pr_number`, `ci_*`, `ci_fix_attempts`      | A pushing task's pull request (`makita_open_pull_request`), the CI watch (`makita-ci`) and `makita_ci_logs` (ticket 12).                  |
| `makitaCi.ts`           | nothing (pure)                                           | A commit's CI verdict, the pull request's required sections and footer, what Makita says about CI.                                        |

Only `makita/` names these tables (`DoorRules.test.ts` checks it). Other modules ask `makitaRows.makitaTaskOfThread`.

## Listening (ticket 04)

The Scheduler runs `makita-intake` every tick: `MakitaIntake.pollDue`, then `MakitaTasks.startQueued`.

- **What is read.** For every repository a live configuration listens to, `GET /repos/{o}/{r}/issues/events?per_page=100` with `If-None-Match`. A paused configuration's repositories are still read, so its events are stored as `ignored-paused` and never replayed. «Stop all», or no account, reads nothing and deletes every cursor, so on resume each repository starts from now. A refused token stops the poller.
- **When.** Every 30 s for a repository with a trigger in the last 30 minutes or a live task, otherwise every 2 minutes. Never sooner than `X-Poll-Interval`. A rate limit, including GitHub's secondary limit, holds every repository until it resets, at least 60 s: there is one token and one quota.
- **Once.** Each candidate event is inserted by its key (`gh:issue-event:<id>`) with `ON CONFLICT DO NOTHING`, in the same transaction that moves the cursor. The first read of a repository only sets the cursor. 403 and 404 mark the repository `unreachable_since`; both its configuration and Platform → Makita warn `repo-unreachable`.
- **Who.** The caller is the event's actor. In order: Makita itself is `ignored-self`; a `Bot` or a login in `ignore_json` is `ignored-bot`; then the oldest active configuration whose label matches and whose list holds the actor's numeric id gets the event as `queued`. If none of them does, the event is `ignored-not-allowed`, filed under the oldest one. Pull requests come later. Each event names one configuration, so no Space sees another Space's events.

## A task and its Thread (ticket 05)

- **Start.** Every check is read again at start: Makita and the configuration are not paused; the Space is open; the creator is active, still in the Space and has `makita.use` there; the AI account is still a gateway one they may use; the issue is open and not locked. If the creator fails a check, their configurations pause with the reason (`creator-disabled`, `creator-left` or `permission-revoked`).
- **Order.** The task row goes first, holding a Thread id derived from the event key. Then `ThreadLaunchService.launch` runs as the creator (`CommandActor.actAsResolved`), with `CommandId` `makita:<event_key>`. The Thread is placed with `placement: "space-work"`: where the Space's work runs, never a requested machine and never the Project's preference. Last, Makita comments «On it. I'll report back here.», once per task. A restart before the launch replays it with the same ids.
- **What the agent never has.**
  - Vault values: `EffectiveVaults` returns an empty set for a Makita Thread, so no workload identity is signed either.
  - Other MCP tools: the MCP auth middleware marks the scope `makita`, and `layerMakitaToolGate` (an `McpServer.visibility` gate) lists and runs only `makita_read_issue`, `makita_comment`, `thread_history` and `t3_background_wait`, plus `makita_push` when its configuration may push (ticket 10). Nobody else sees `makita_*`.
  - Makita's token.
  - A move to another machine: `thread.move` is refused for a Makita Thread.
- **The issue text** is framed with `webhookTemplate.frameUntrusted`: an unpredictable tag per request, with mentions broken. Each author is marked `allowed` or `not allowed`.
- **`makita_comment`** posts only on its task's issue. The Hub refuses it when Makita or the configuration is paused or the task has ended. It masks every value the creator's Threads hold (`SecretMasker.forUser`) and refuses anything shaped like a token. It allows at most 5 Makita comments in a row without a person in between (the sixth does not go out; the Hub posts «Waiting for a person before I continue.» once) and at most 30 per issue in 24 hours. Every comment is audited as `makita.github.comment`.
- **A closed or locked issue** stops its live task.

## Mentions, assignment and commands (ticket 09)

- **Three feeds per repository**, each with its own cursor row, ETag and cadence: issue events, `issues/comments` and `pulls/comments` (both with `since`, oldest change first). Every feed is read page by page, at most 10 pages a poll. A comment feed's cursor is the `updated_at` and id of the last comment handled; what the cap leaves is read on the next poll. The issue events feed is read down to its cursor; past 10 pages the rest is lost and logged.
- **What is decided.** A comment is decided only when it mentions Makita (`@login` as a whole word, outside a `>` quote) or its first line is `/makita stop` or `/makita retry`. Keys are `gh:issue-comment:<id>` and `gh:review-comment:<id>`. A comment edited before Makita saw it is `ignored-edited`. Makita, bots and logins in `ignore_json` are ignored. An `assigned` event whose assignee is Makita's account starts a task for configurations with `triggers.assigned`, with the assigner as the caller.
- **Who decides.** With a live task on the issue, that task's configuration and its list decide. Without one, the oldest active configuration with `triggers.mention` whose list holds the author's numeric id takes it. A mention on a pull request starts a comment-only task of kind `pull`.
- **Continuing.** A mention by someone on the list, on an issue with a live task, wakes that task's Thread instead of starting a second one. The checks of a start run first. The comment is read again from GitHub by id and must be unedited and by the same author. It is framed like the first message and sent with `sendToThread` in mode `queue`, as the creator, with `CommandId` `makita:<event_key>`. The task goes `running` with `replies_without_person = 0`, and the event becomes `started` / `continued`.
- **Commands.** `/makita stop` stops the issue's live task (`github-stop`, through `stopTasksWithin`). Makita answers with a 👍 reaction, audited as `makita.github.reaction`, and no text. `/makita retry` starts a new task only when the issue's newest task `failed`. Otherwise the event is `command` / `nothing-to-stop` or `nothing-to-retry`.

## Linked GitHub accounts (ticket 08)

- **The proof.** In User settings → Account → «GitHub account», the User types their GitHub login. The Hub resolves it to its numeric id with Makita's token and makes a code: 8 characters, 15 minutes, one use, kept only as SHA-256, **bound to that id**. A newer code ends the older ones; at most 10 an hour. The User posts `@<makita> link <code>` as the first line of a new comment, from that account, on any issue or pull request of a listened repository.
- **The intake** handles that line before mentions, so it never starts or wakes a task. Edited comments, bots and Makita itself are ignored. In the batch's transaction the code must be unused, unexpired, bound to the author's id and its User active. A match links the account (replacing the User's earlier one, both audited: `github_identity.link`, `github_identity.unlink` with `replaced`). If another User holds that account, the code ends `taken` and the User's page says «That GitHub account is linked to someone else on this Hub.», never who. After the commit Makita reacts 👍 or 😕; nothing else ever writes to GitHub, so a stranger's or a copied code gets silence. The event row is `command` / `link` with no configuration.
- **Whom a configuration answers** (`makitaCallers.allowedCallerIds`, read on every intake pass and at each task's framing of «allowed»): `creator`, the creator's linked id; `list`, the list plus the creator's linked id; `members`, the linked ids of the Space's current Admins and Members (not Guests), or the Personal space's User. Only active Users count. Nothing is copied into the configuration, so unlinking, leaving the Space or being disabled counts at the next event.
- **Unlink**: the User, or the Owner for anyone (WS `githubIdentity.unlink { userId? }`). Removing a User from the Hub deletes their link in the same transaction (`reason: user-removed`).
- **Doors**: WS `githubIdentity.get`, `.linkCode`, `.unlink`, a person's own session only (AccessPolicy `githubIdentity.manage` and `githubIdentity.unlink`). No door returns another User's link.

## Stopping (ticket 06)

- **One way to stop.** `makitaRows.stopTasksWithin` runs in the transaction of whatever stops the work. It marks each live task `stopped` with its reason in `failure` and audits `makita.task.stop`. A pending approval is cancelled with it. The callers and their reasons:
  - a configuration paused (`config-paused`) or deleted (`config-deleted`);
  - «Stop all Makita work» (`makita-paused`);
  - the creator's configurations paused by the Hub (`permission-revoked`, `creator-left`, `creator-disabled`), through `pauseCreatorConfigsWithin`;
  - an issue closed or locked (`issue-closed`, `issue-locked`);
  - a person's Stop on one task (`manual`), WS `makita.tasks.stop`, for whoever may pause its configuration.
- **The turn.** `MakitaStops` is a Scheduler source (`makita-stops`, every 5 s) beside the intake. It sends `thread.stop` as the system to each task stopped in the last hour that this process has not handled yet, with `CommandId` `makita-stop:<taskId>`, so a repeat after a restart replays nothing. A failed dispatch is retried twice more.
- **The gateway.** `AiGatewayKeys.authorize` reads `makitaTaskOfThread` for every Thread key, in the same parallel batch as the Thread's Space and owner. `halted` says whether Makita may work: Makita is stopped or has no account, the configuration is paused or deleted, or the task has ended. Any of these answers 403 «Makita is stopped for this work.», so a turn the interrupt has not reached yet stops spending at its next request. The key is refused, not revoked.
- **Starting.** `startOne` reads the task again right before the launch, so a task stopped in between gets no Thread.
- **Its account.** `AiAccountChoice.settle` refuses, on a Makita Thread, a model selection whose provider instance or AI account differs from the one the Thread has, and any delegated task from it. A creator therefore cannot move a Makita Thread to a direct account and get out of the pause and the usage attribution.
- **Resuming** replays nothing. Stopped tasks stay stopped and the next trigger makes a new task. Events that came while a configuration was paused are `ignored-paused`. While Makita is stopped no cursor is kept, so each repository starts from now.
- **GitHub** hears nothing about a stop.

## Usage and activity (ticket 07)

Makita has no token limits, so its use is always visible.

- **Attribution.** `AiGatewayKeys.authorize` reads `makitaTaskOfThread` for a Thread key and puts `makitaConfigId` on the caller. `AiUsage` writes it to `ai_usage.makita_config_id` and to `ai_usage_daily`, where it is part of the key (migration 168). `user_id` stays the creator's: the tokens count on the creator and on the configuration. Until the usage log writes a request, `AiGatewayActivity` holds it under `makita-config:<id>` and `makita-thread:<threadId>`, so «Now» includes it.
- **Usage screen.** `AiUsage.summary` rows carry `makitaConfigId`, and the labels name the configuration, shown as «Makita: <name>» beside Users and access keys. Which rows a session sees does not change. The name goes only to the Owner, to whoever reads that Space's usage and to the creator; on a row a lender sees through a Grant, the configuration is left out.
- **`makita.activity {configId | spaceId}`.** A person's own session only. `makita.view` on the configuration's Space; another Space's configuration answers not-found, another Space by id forbidden. Without either it is the Owner's view of every configuration. The answer has the configurations (usage today, this week and this month), «Now», recent tasks, recent events with their outcome and detail, and usage per repository and per caller. Usage is null except for the creator, whoever reads the Space's AI usage, and the Owner. A task's Thread id is given only if its Space is one the viewer sees. The numbers come from `AiUsage.makitaUsage`, which reads the usage tables; Makita's tables are read in `makita/`.
- **`makita.threads {}`.** The Makita tasks of the Threads the viewer may see, for the Thread header («Makita · repo#n · asked by @caller», linked to the issue) and the Thread list's «Makita» filter.
- **Web.** Space settings → Makita shows today's tokens on each configuration and «Activity». Platform → Makita shows the Hub-wide activity next to «Stop all Makita work».

## Pushing branches (ticket 10)

A configuration with «Also push branches» (`capability: push`) lets its tasks change code. The agent never holds Makita's token.

- **Its own worktree.** Before the launch, the Hub fetches the base (`base_branch`, else GitHub's default) with Makita's token into the Project's Hub repository at `refs/t3/project/makita/<taskId>/base`. On the Space's work place (`chooseForThread` with `spaceWorkOnly`), `move.fetch` brings it into the Project's checkout and `move.prepare` makes a worktree there whose setup command checks out `makita/<n>-<slug>` at the base and sets the bot as author in that worktree's config only (`extensions.worktreeConfig`). The task row keeps it in `workspace_json`, so a restart never makes it twice. Making it may take minutes, so it and the launch run in a fiber off the intake's tick (which also carries stops); the event stays `queued` until the launch ends, a restart replays it, and a task stopped meanwhile gets no Thread. The Thread launches with `existing_worktree`: `ThreadLaunchService` and `ThreadManagementService.placeThread` allow a worktree off the Hub machine only for that `space-work` launch of a pushing Makita Thread, and the Project's setup script does not run for it.
- **`makita_push {}`.** Listed only when the configuration may push. The Thread's machine captures its worktree into `refs/t3/threads/<threadId>/makita/push` (a commit whose parent is `HEAD`) and uploads it with its own credential; `gitRoute.ts` already lets only the Thread's Active environment write there. In the Hub's bare repository the Hub takes the capture's parent and checks: it descends from the last pushed tip (else the start commit); the new commits are at most 100 and about 64 MiB, each authored and committed by the bot's `noreply` address, none changing `.github/workflows/**`, and their messages and added lines pass the creator's secret mask and the token-shape refusal. Then GitHub's branch must be where Makita left it, and `MakitaGitHub.pushBranch` pushes `<sha>:refs/heads/makita/…` without `+`. Audited `makita.github.push`.
- **Approval seam (ticket 11).** With `approval: others`, the first push for a caller who is not an approver is kept in `pending_push_json` and not sent.
- **The token.** Only `MakitaGitHub` reads it. Its git commands run on the Hub host in the Hub's bare repository, naming GitHub by URL, with the token in the environment of that one process through `HubRepository.withEnvironmentCredential`'s helper: never in an argument, a URL, a config file or a log.
- **Stopping.** Every push reads the task again under a per-Thread lock and once more right before `git push`; a stop clears `pending_push_json`.

## The pull request and its CI (ticket 12)

- **`makita_open_pull_request { title, body }`.** Listed only when the configuration may push. The task must be an issue's, its branch already pushed, and without a PR yet (one per task). The body needs the headings Problem, Fix, Verified and Downsides, each with text; a missing one is refused by name. Title and body go through the creator's secret mask, anything token-shaped is refused, and so is a link to the Hub. The Hub opens the PR from the task's `makita/…` branch into `base_branch` (else GitHub's default branch) and appends «Opened by Makita for @<caller> (#<n>)». If GitHub already has one from a restart, it is adopted only when Makita's account opened it. The task records `pr_number` and goes `waiting-ci`. Audited `makita.github.pull_request`; linked to the Thread with `thread.pull-request.link`.
- **The watch.** `MakitaPullRequests.watchCi` is a Scheduler source (`makita-ci`). It reads every task with `ci_state = pending` at most every 30 s, and never while the intake's rate-limit hold lasts; a rate limit here sets that same hold. It skips paused configurations, a stopped Makita and ended tasks. It reads `commits/{ci_sha}/check-runs` and `/status`: the exact commit Makita pushed. A `makita_push` with the PR open makes the new head the watched commit.
  - **GREEN:** every check run completed with success, neutral or skipped, and every status success (`ciVerdictOf`, the rule ticket 13 lands on). Makita says so once on the issue, the fix count resets, and the task waits.
  - **RED:** everything finished, something failed. The Thread is woken (`sendToThread`, queue, as the creator, `CommandId` `makita-ci:<taskId>:<sha>`) with the failing checks' names framed. At most 3 times in a row; the fourth RED does not wake it, and Makita says once on the PR «CI is still failing after 3 fixes; I'm stopping here.»
  - **No CI:** no check 10 minutes after the push. **Timeout:** checks still running after 90 minutes. Each is said once on the PR, and the task waits for a person.
  - A PR closed meanwhile (`closed`) or moved by someone else (`moved`) ends the watch without a word. Every Hub comment goes through the loop guard.
- **`makita_ci_logs { job }`.** Only a failing check of the last RED, and only a GitHub Actions job. `MakitaGitHub.tail` streams the job's log and keeps its last 64 KiB. The text is masked, colour codes removed, and framed.

## What other tickets read

- The gateway: `makitaTaskOfThread` on the Thread of a gateway key gives the configuration and `halted`. `GatewayCaller.makitaConfigId` carries the configuration.
- Usage (ticket 07): `GatewayCaller.makitaConfigId` gives `makita_config_id`.
- Approvers (ticket 11): `GitHubIdentities.linkedUserOf(sql, githubUserId)` names the Hub User who linked a GitHub id; `linkedIdsOf(sql, userIds)` the ids these Users linked. Whether the User may still act is the caller's check.
- Landing (ticket 13): `MakitaPullRequests.ciOf(repo, sha)` gives the verdict of one commit («GREEN on the exact head»); the row has `pr_number`, `head_sha` and `last_push_at`.
- The PR conversation (ticket 14): `pr_number` names Makita's own PR.
