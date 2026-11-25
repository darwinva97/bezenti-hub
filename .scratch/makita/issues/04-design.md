# 04 design: listening by polling, deduplicated

Ticket: `04-escuchar-por-sondeo.md`. Spec: `../spec.md` («Cómo llegan los eventos», «Deduplicación e idempotencia», «Quién lo pide y si puede», «Parar»). Builds on 01–03: Makita's own client (`MakitaGitHub`), the account row and global switch, the configurations and their repositories (`MakitaRepos`).

## What changes

- **Migration `166_MakitaIntake`**: two tables, written only by `makita/`.
  - `makita_repo_cursors (host, repo, feed, etag, cursor, next_poll_at, last_error, unreachable_since, PRIMARY KEY (host, repo, feed))` — one row per repository and feed, shared by every configuration (one token). Batch 1 reads one feed, `issue-events`; its `cursor` is the highest event id handled.
  - `makita_events (event_key PRIMARY KEY, host, repo, number, kind, actor_github_id, actor_login, created_at_github, seen_at, config_id, task_id, outcome, detail)` with `CHECK` on `kind` (`issue`, `pull`) and `outcome` (the spec's list), indexes on `(config_id, seen_at)` and `(outcome, seen_at)`. Rows older than 90 days are deleted by the poller, as `ai_usage`.
- **`makita/MakitaIntake.ts`**, registered with `scheduling/Scheduler.ts` (`makita-intake`, ticks every 5 s; it does work only when a repository is due):
  1. Reads the account. No account, `token-invalid`, or `global_paused_at` set: reads nothing. While paused globally (or with no account) every cursor row is deleted, so on resume each repository starts «now».
  2. The repositories listened to: every live, unpaused configuration's Projects resolved to `owner/name` (`MakitaRepos`, cached 60 s). A repository no active configuration listens to is not read and its cursor rows are deleted («cursors to now» on resume, for a configuration's pause as for the global one).
  3. For each due repository: `GET /repos/{o}/{r}/issues/events?per_page=100` with `If-None-Match: <etag>` through `MakitaGitHub.rest`. **304**: nothing written but `next_poll_at`. **200** on a repository read for the first time: the cursor becomes the newest id and nothing is handled (nothing older than listening is replayed). Otherwise events with `id > cursor`, oldest first.
  4. **One write transaction per batch**: each candidate event (`labeled` with a label some active configuration of that repository uses) is inserted with `INSERT … ON CONFLICT (event_key) DO NOTHING RETURNING`, with its decision; then the cursor (`etag`, `cursor`, `next_poll_at`, `last_error = NULL`, `unreachable_since = NULL`) advances. A crash before the commit re-reads the batch; one after it finds the keys taken: each event counts once. Events of other kinds are not stored.
  5. **Cadence**: 30 s when the repository had a trigger in the last 30 minutes (or, from ticket 05, an open task), else 2 minutes; never sooner than `X-Poll-Interval`. A rate limit (`retry-after`, `x-ratelimit-reset`, GitHub's secondary limit as `isRateLimited` reads it) holds **every** repository until the reset (at least 60 s): one token, one quota.
  6. **Errors**: 403/404 set `unreachable_since` (kept from the first failure) and `last_error`, retried every 10 minutes; a configuration with such a repository shows the warning `repo-unreachable`, and Platform → Makita shows `repo-unreachable` too. 401: `MakitaGitHub` already marks the account `token-invalid`; the poller stops (step 1) until the Owner replaces the token. Unreachable GitHub: `last_error`, retried in 2 minutes.
- **The decision** for a `labeled` event (key `gh:issue-event:<id>`; the caller is the event's `actor`):
  1. the actor is Makita's own account (`github_user_id`): `ignored-self`;
  2. the actor's `type` is `Bot`, or its login is in a candidate configuration's `ignore_json`: `ignored-bot`;
  3. candidate configurations: live configurations of the Space whose Projects resolve to this repository and whose label matches (case-insensitive), **oldest first**. None active (all paused): `ignored-paused` (not replayed on resume). Among the active ones, the oldest whose list holds the actor's **numeric id** takes it: `queued` (ticket 05 turns it into a task). None: `ignored-not-allowed`, filed under the oldest active candidate. No candidate at all: the event is not stored.
  4. A label on a pull request: `ignored-no-config` with `detail = pull-request` (pull requests come with ticket 12).
     The event row names one configuration, so one Space's activity never shows another's.
- **`MakitaGitHub.testkit.ts`** grows into the spec's fake GitHub: per-repository issue events with ETags and 304s, `X-Poll-Interval`, failures per repository (401, 403, 404, 429 / secondary limit), and a record of every request (path, `if-none-match`), never the token.
- **Contracts**: `MakitaConfigWarning` and `MakitaAccountWarning` gain `repo-unreachable`; the web shows them («Makita cannot read one of its repositories. Check that the bot is a collaborator there.»).

## Who may do it

Nobody calls it: it runs inside the Hub as the system. No new RPC, route or MCP tool. What strangers on GitHub can cause: one `INSERT` per label they put (putting labels already needs Triage on GitHub), never a GitHub write, never a Thread.

## How it is undone

Pausing a configuration or «Stop all Makita work» stops the effect at once (events `ignored-paused`, or not read at all); resuming starts from «now». Rows age out at 90 days. The migration only adds tables.

## Logs

The poller logs repository, feed and the error's reason, never a token, header, issue text or login.

## Tests (red-first)

`makita/MakitaIntake.test.ts` over the Makita testkit and the fake GitHub, with a fixed clock: the first read sets the cursor and handles nothing; a label by someone on the list is `queued` once even when the feed returns it twice and after a forced re-read with the cursor rolled back (crash between write and cursor); someone not on the list `ignored-not-allowed`; a `Bot`, `ignored-bot`; Makita itself, `ignored-self`; a 304 writes nothing; the oldest of two configurations on one repository takes it; a paused configuration gives `ignored-paused` and, after resume, nothing old is replayed; global pause reads nothing; 404 marks the repository unreachable and the warning shows; a 401 stops the poller and marks the account; a rate limit holds every repository until its reset; `X-Poll-Interval` and the 30 s / 2 min cadence. Migration test for 166.
