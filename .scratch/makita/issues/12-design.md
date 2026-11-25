# 12 design: open the pull request, watch its CI, fix the RED

Ticket: `12-abrir-el-pr-y-arreglar-el-red.md`. Spec: `../spec.md` («Abrir el PR, esperar la CI, arreglar el RED», «Amenazas de prompt injection», «Seguir la conversación» loop guard, «Parar», «Puertas», «Auditoría»). Builds on 05 (task, framing, `makita_comment`'s mask and token-shape refusal, loop guard), 06 (`halted`), 07 (activity) and 10 (`makita_push`, `head_sha`, `last_push_at`).

## What changes

- **Migration `171_MakitaTaskCi`**: `makita_tasks` gains `ci_sha` (the commit whose CI is watched), `ci_state` (`pending`, `green`, `red`, `gave-up`, `no-ci`, `timeout`, `closed`, `moved`), `ci_since` (when that commit was pushed) and `ci_failing_json` (the failing checks of the last RED: id, name, whether it is a GitHub Actions job). All nullable; nothing else changes.
- **New module `makita/MakitaPullRequests.ts`** (writes only those columns, `pr_number`, `state` and `ci_fix_attempts`), and the pure `makita/makitaCi.ts` (the verdict, the PR body rules, the texts).
- **`makita_open_pull_request { title, body }`** (listed only when the configuration may push, like `makita_push`). On the Hub, one call per Thread at a time:
  1. Checks: the Thread is a Makita task's, Makita and the configuration not paused, the task live, capability `push`, kind `issue`, the branch already pushed (`head_sha`), no PR yet (`pr_number` null: one PR per task; a second call answers with the one it has).
  2. Text: title one line, 1–200 characters; body at most 50 000 characters with the four sections Problem / Fix / Verified / Downsides as headings, each with text (a missing or empty one is refused, naming it); both through `SecretMasker.forUser(creator)` and refused if anything still has a token's shape; refused if they name the Hub (its public host, `t3-thread://`). The Hub appends the fixed footer «Opened by Makita for @<caller> (#<issue>)».
  3. `POST /repos/{repo}/pulls` with `head` = the task's `makita/…` branch and `base` = `base_branch` (else the repository's default branch, read from GitHub): both from the task row, never from the call; never another repository. If GitHub says one already exists (a restart after the POST), the open PR of that head into that base is adopted, only if Makita's account opened it.
  4. The row: `pr_number`, `state = waiting-ci`, `ci_sha = head_sha`, `ci_state = pending`, `ci_since = last_push_at`. Audit `makita.github.pull_request` (`agent` as the creator; `repo`, `number`, `makita`, `pr`, `branch`, `base`). The PR is linked to the Thread with `thread.pull-request.link` (`source: agent`, as the creator), so it shows in the Thread's UI; a failed link is logged, not fatal.
- **`makita_push`** after the PR is open (one line in `MakitaPushes`): the new head becomes the watched commit (`ci_sha`, `ci_state = pending`, `ci_since = now`, `state = waiting-ci`). Before the PR there is nothing to watch.
- **The watch** (a Scheduler source `makita-ci`, beside `makita-intake` and `makita-stops`; not `watch_pull_request`, which reads with Source Control's credential and wakes on anyone's comment). For each task with `ci_state = pending` whose `halted` is null (Makita and its configuration not paused, task live), at most every 30 s (the intake's fast cadence), and never while the intake's rate-limit hold lasts (a rate limit here sets that same hold: one token, one quota):
  - `GET /repos/{repo}/commits/{ci_sha}/check-runs` and `/status`: the exact commit Makita pushed, nothing else.
  - **GREEN** = every check run completed with `success`, `neutral` or `skipped` and the combined status `success` or no statuses (the same rule ticket 13 lands on; exported as `ciVerdictOf` and `MakitaPullRequests.ciOf(repo, sha)` for it). **RED** = everything completed and at least one failing. Anything still running is pending.
  - Before acting on a verdict, the PR is read once: closed or merged → `ci_state = closed`, nothing said; its head is no longer `ci_sha` (someone else pushed) → `moved`, nothing said.
  - GREEN: `ci_fix_attempts = 0`, `state = waiting-reply`, Makita comments once on the issue «CI passed on `<sha>`. The pull request #<pr> is ready for review.»
  - RED with fewer than 3 fixes so far: `ci_fix_attempts + 1`, `state = running`, the failing checks kept in `ci_failing_json`, and the Thread is woken (`sendToThread`, mode `queue`, as the creator, `CommandId` `makita-ci:<taskId>:<sha>`: a replay sends nothing twice) with the failing checks' names framed as untrusted data and how to read a log.
  - The fourth RED: the agent is not woken; Makita comments once on the PR «CI is still failing after 3 fixes; I'm stopping here.», `state = waiting-reply`, `ci_fix_attempts = 0` (a person's next mention starts a new count).
  - No check at all 10 minutes after the push: `no-ci`, Makita says on the PR «No CI ran on `<sha>` within 10 minutes; I'm treating this pull request as having no CI.», `waiting-reply`. Checks still running 90 minutes after the push: `timeout`, «CI hasn't finished in 90 minutes; I'll pick this up when you mention me.», `waiting-reply`.
  - The Hub's comments go through the loop guard like any Makita comment: they count in `replies_without_person` and the 30 per day, are audited `makita.github.comment` (`by: hub`), and one over the limit is not posted.
- **`makita_ci_logs { job }`**: `job` is the name or id of one of the failing checks of the last RED on the current `ci_sha` (anything else is refused). Only a GitHub Actions job has a log: `GET /repos/{repo}/actions/jobs/{id}/logs`, read by a new `MakitaGitHub.tail` that keeps only the last 64 KiB of the stream (at most 64 MiB read). The text is masked with the creator's secrets, colour codes removed, and framed with an unpredictable tag and mentions broken.
- **`makita_comment`** keeps `waiting-ci` when the task waits for CI (a comment does not stop the watch): one `CASE` in its `UPDATE`.
- **First message** (push): open one PR with `makita_open_pull_request` once the branch is pushed, with the four sections; the Hub watches its CI and wakes the agent with a RED; never merge or approve.
- **MCP gate**: both tools join `MAKITA_ALLOWED_TOOLS` and the push-only set. Door sweeps (`MCP_TOOL_RULES`, the `makita_` list), `MaskedPaths`, `agentContextBudget.json` measured.
- **Activity (07)**: each task gains `prNumber` and `ci` (`ci_state`); the web activity shows «PR #n» linked to GitHub and the CI state.
- **Audit**: `makita.github.pull_request` in the allow-list, its detail keys and its label.

## Seams left for 13 and 14 (not built)

- 13: `ciVerdictOf` / `ciOf(repo, sha)` give «GREEN on the exact head»; `pr_number`, `head_sha` and `last_push_at` are on the row. Mergeability and the workflow check of the PR's files are 13's.
- 14: `pr_number` tells the intake which PR is Makita's; following its reviews and comments is 14's.

## Who may do it

Only a Makita Thread's agent, on its own task, through the two tools; no RPC. Everything that reaches GitHub is built on the Hub from the task row: repository, head, base. The agent has no merge or approve tool; the watch runs as the system, the wake as the creator (the Thread is theirs).

## How it is undone

Pause the configuration, «Stop all» or stop the task: the watch skips any task whose `halted` is set (the next pass, ≤ 30 s), the tools refuse, and the gateway already refuses the woken turn. Turning `push` off hides both tools. A PR is ordinary: close it on GitHub (the watch then stops, `closed`). The migration only adds nullable columns.

## Tests (red-first)

`makita/MakitaPullRequests.test.ts` over the fake GitHub (which gains PR creation and reads, check runs, combined status and job logs) and the push testkit: no PR before a push; a body without «Downsides» is refused naming it, and nothing reaches GitHub; a token-shaped body, a creator's secret, a Hub link are refused; a valid call opens one PR from `makita/12-…` into the base with the footer, audited, linked to the Thread; a second call opens nothing; a RED wakes the Thread once with the failing names framed; three REDs wake three times and the fourth only comments; GREEN comments once on the issue and resets the count; no checks in 10 minutes and 90 minutes unfinished comment once; a paused configuration and a stopped task are not watched or woken; `makita_ci_logs` returns the framed tail of a failing job and refuses a job that is not failing; the token is in no request body or answer. Migration test for 171; MCP gate test; door sweeps.
