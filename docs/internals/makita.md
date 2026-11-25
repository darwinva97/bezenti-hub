# Makita

Makita is the Hub's GitHub bot teammate: a normal GitHub account whose token the Owner registers in Platform → Makita. A Hub agent works behind it. ADR 0011 records the shape: Makita acts as whoever configures it, and its token never leaves the Hub. The spec and tickets live in `.scratch/makita/`.

## Pieces (`apps/server/src/makita/`)

| Module                 | Owns                                                     | Notes                                                                                                                                     |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MakitaGitHub.ts`      | the only reader of the sealed token (`MakitaTokenStore`) | Its own REST client over the Hub's `HttpClient`, never Source Control's credential; tracing off; a 401 marks the account `token-invalid`. |
| `MakitaAccount.ts`     | `makita_account`                                         | The Owner's: register or replace the token, «Stop all Makita work».                                                                       |
| `MakitaPermissions.ts` | `makita_permissions`                                     | «May use Makita» per User and Space, the Owner's.                                                                                         |
| `MakitaConfigs.ts`     | `makita_configs`                                         | A Space's configurations (repositories from each Project's checkout, callers by numeric id, a gateway AI account).                        |
| `MakitaIntake.ts`      | `makita_repo_cursors`, `makita_events`                   | The poller (ticket 04).                                                                                                                   |
| `MakitaTasks.ts`       | `makita_tasks`                                           | Tasks and their Threads, and the agent's GitHub writes (ticket 05).                                                                       |
| `makitaRows.ts`        | shared reads                                             | `permittedIn`, `pauseCreatorConfigsWithin`, `makitaTaskOfThread` (the seam other modules read).                                           |

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
  - Other MCP tools: the MCP auth middleware marks the scope `makita`, and `layerMakitaToolGate` (an `McpServer.visibility` gate) lists and runs only `makita_read_issue`, `makita_comment`, `thread_history` and `t3_background_wait`. Nobody else sees `makita_*`.
  - Makita's token.
  - A move to another machine: `thread.move` is refused for a Makita Thread.
- **The issue text** is framed with `webhookTemplate.frameUntrusted`: an unpredictable tag per request, with mentions broken. Each author is marked `allowed` or `not allowed`.
- **`makita_comment`** posts only on its task's issue. The Hub refuses it when Makita or the configuration is paused or the task has ended. It masks every value the creator's Threads hold (`SecretMasker.forUser`) and refuses anything shaped like a token. It allows at most 5 Makita comments in a row without a person in between (the sixth does not go out; the Hub posts «Waiting for a person before I continue.» once) and at most 30 per issue in 24 hours. Every comment is audited as `makita.github.comment`.
- **A closed or locked issue** stops its live task.

## What other tickets read

- The gateway (ticket 06): `makitaTaskOfThread` on the Thread of a gateway key gives the configuration and the task state. Answer 403 while paused or stopped.
- Usage (ticket 07): the same lookup gives `makita_config_id`.
