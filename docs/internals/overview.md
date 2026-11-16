# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Every protocol-2 environment advertises `threadPullRequests`. Once an environment's server config
has loaded, clients use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread
lookup. Before that, they hide linking actions.

Environments keep advertising `threadPullRequestLinking`, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field, because older clients still read them. That
hostless field includes only links in the thread project's own repository. Retain the legacy wire
fields, projection column, and replay support.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

Orchestration state is decided as events, and projections are the source of truth once they apply
them. The [v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

The event log only keeps what live readers need: about a day of history for reconnect replay and
command-id retries.
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
older events the projections cover, so projections cannot be rebuilt from the log. It keeps each
stream's newest event (high-water marks, stream versions, snapshot sequences), `thread.created`
(the legacy importer's marker), every `running` run update (Codex usage history reads the first
of each attempt), and prompt anchors that retained subagent rows reference. A client whose cursor
is below both its thread's newest event and the recorded pruned-through sequence missed pruned
events, so it resumes from a snapshot; an idle thread's cursor resumes without one. Resumes
recheck that sequence after reading the replay, since a pass can prune during the read. V2 command
receipts stay for idempotency: a retry older than the retained history is still deduplicated,
but its replay comes back without the pruned events. Receipts of imported legacy commands are
removed once their threads are imported.

Retained events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Environment executors

Everything that needs a machine sits behind one
[Environment executor](../../apps/server/src/environment/EnvironmentExecutor.ts) per Environment:
the provider adapters (sessions, turns, interrupt, steer, respond, rollback, detach, events), the
workspace (checkpoints, runtime policy and cwd, files, search, browse, terminals, previews) and the
host (resources and provider capabilities). The Hub machine registers an in-process executor under
`HUB_MACHINE_ENVIRONMENT_ID`; a joined Environment's executor
([RemoteEnvironments](../../apps/server/src/environment/RemoteEnvironments.ts)) carries the same
operations, catalogued and versioned in
[the executor contract](../../packages/contracts/src/environmentExecutor.ts), over its WebSocket,
and is registered only while that socket is open. The payload codecs of each operation
([RemoteExecutorWire](../../apps/server/src/environment/RemoteExecutorWire.ts)) live in the server
beside the adapter schemas they are built from; both halves of the server share them.

`ProviderAdapterRegistryV2`, `RuntimePolicyV2` and `CheckpointStore` reach the orchestration as
layers over the executors. Calls that carry a Thread resolve its Active environment each time: a
session opens there, and its runtime policy and capabilities come from there. Checkpoint calls
carry only a cwd, so the effect worker runs every effect that needs the Thread's machine
(`ENVIRONMENT_BOUND_EFFECT_TYPES`) with its Thread's Environment as the checkpoint target;
`HUB_EFFECT_TYPES` run on the Hub. The Active environment is the projection's
`active_environment_id` (migration 096, absent in the payload for the Hub machine), read on each
call, and the registry takes the resolver when it is built: a reference read at call time would
see the caller's fiber, not the server's. An effect bound to a machine whose Environment has no
executor is never claimed (`claimNext` filters on the projection), so it spends no attempt while
the machine is away and runs when its socket returns; anything else that reaches a missing executor
gets a typed error and retries.

The Orchestrator reads capabilities through `EnvironmentCapabilityCache`. For the Hub machine that
reads the live adapter, as before. A remote executor answers from its last snapshot, the newest by
`observedAt`, which every hello and heartbeat carries, so deciding makes no network call. The Hub
machine also publishes a snapshot at startup, when provider instances change, and on every
heartbeat; instances it cannot describe are listed with the reason. The Orchestrator also resolves
runtime policy while deciding (a checkpoint scope's cwd), so a remote executor computes it on the
Hub from the reported checkout and runtime modes, never by asking the machine.

### Turns on a joined Environment

The Hub decides where a new Thread runs (`EnvironmentRegistry.chooseForThread`, called by
`ThreadManagementService` for every `thread.create`): the User's choice, else the Project's
preferred Environment while it can take the Thread, else the Space's Sandbox. The Hub machine runs
Threads only with the development setting `T3CODE_HUB_RUNS_AGENTS`, and is then the fallback instead
of the Sandbox ([Sandboxes](./sandboxes.md#the-hub-runs-no-agents)). Another Environment must be one the User may use
for the Thread's Space (`environment.use`: a personal machine is its owner's alone, the Owner
included; a [Sandbox](./sandboxes.md) runs only its own Space's Threads, and counts while stopped:
the work starts it), online, and have the
provider. The client never picks by load.

On the machine, the [agent](../../apps/server/src/environments/EnvironmentAgent.ts) runs each call
on its own in-process executor. Constraints that span both halves:

- Each session event carries `(providerSessionId, seq)`. The machine keeps what the Hub has not
  acknowledged and resends it after a reconnect; the Hub drops a `seq` it already has and
  acknowledges in one frame per burst. `command_output.delta` has no `seq`: it is live only.
- The Hub drops (and logs) an event for a session it retired, or from a machine that is no longer
  the Thread's Active environment, before it reaches the session manager.
- A call made by an effect carries `effectId:<operation>:<n>`, the same on a resend and on the
  effect's next attempt. The Hub resends it on the next socket (waiting a bounded time for one);
  the machine runs a key once, joins a resend to the running call and answers later ones from
  memory. A failed answer is not kept, so a retry runs again.
- The hello names the sessions the machine still runs: the Hub ends the ones it lost and tells it
  to drop the ones the Hub no longer has (`provider.retired`, as after a Hub restart). A session's
  end is spooled in its event order, so it is reported even if it happened while offline.
- A stopping Hub (`ProviderSessionManager.shutdown`, which raises `hubStopping` on the executor
  registry first) sends `provider.detach` only to machines connected then; it does not wait for
  one that is away, which drops the session through `provider.retired` when it next connects.
- The Hub acknowledges an event only once it has delivered or refused it. If the Thread cannot be
  read, it delivers nothing more for that session until the machine resends after a reconnect.
- Machine work for a Thread whose Environment is away waits without holding back the Hub's own
  effects on that Thread; work for a removed Environment fails on its first attempt, and its
  cleanup is skipped (`threadEnvironmentRemoved`). See «Disconnections» below.
- The agent reaches the Hub's MCP: the Hub issues the per-Thread credential as for a local session,
  and the machine points it at `<the Hub URL it joined>/mcp`. Its own MCP server is not used.
- Attachments stay on the Hub. A turn sends each one's id and SHA-256; the machine fetches the ones
  it lacks with `attachment.read`, which answers only attachments a live session's turn sent to
  that machine, while the Thread still runs there.
- The machine uses the Project's checkout where it is, else makes it from the Hub's copy of its own
  checkout (see «New checkouts from the Hub» below), cloning the Hub checkout's `origin` only when
  the Hub has no checkout of the Project in a trusted repository; when the Hub repository has the Thread's checkpoints, the session's open names them and
  the checkout fetches the ones it lacks. New worktrees are still made on the Hub machine only, so
  placing a Thread that asks for one (a launch strategy, or a `thread.create` with a worktree) on
  another Environment is refused; only a move (below) makes one elsewhere.

### Hub repository

The Hub keeps one bare repository per Project under `<state dir>/hub-repositories`
([HubRepository](../../apps/server/src/checkpointing/HubRepository.ts)), so a turn's checkpoint
outlives the machine that captured it. After `checkpoint.capture` commits, the
[uploader](../../apps/server/src/orchestration-v2/CheckpointUploadService.ts) asks the Thread's
Active environment to push the refs of every ready checkpoint not yet uploaded, in batches that
fall back to one ref at a time, and marks each pushed one with `checkpoint.uploaded` (column
`uploaded_to_hub`, migration 097). It runs outside the effect lane, so a slow or failing upload
never holds back the Thread's next turn: failures retry with backoff, at once when an Environment
connects, and from the projection after a restart. A ref the current machine lacks (captured on
the one the Thread left) is set aside until the Thread runs elsewhere instead of failing the rest.
It is tracked per checkpoint, not as an ordinal per scope, because a rollback reuses its ordinals:
a mark is written only if the checkpoint still has the ref and capture time that were pushed.

The Hub machine pushes to the repository on disk through the same executor operation
(`checkpoint.push`), so there is one path; joined machines use `/api/git/<projectId>`
([gitRoute](../../apps/server/src/environments/gitRoute.ts)), git smart HTTP relayed to
`git http-backend` with no system or user git config. Each request carries the Environment
credential, which `t3` hands git through a credential helper in the process environment that
answers only the Hub's own protocol and host (redirects are not followed), after an empty helper
that drops the user's own. The route checks the credential on every request, so a removed machine
loses access at once, and serves only Projects where the machine's owner may start Threads. Within
one, a machine sees and writes only the refs of Threads it is the Active environment of (their
checkpoint scopes, `refs/t3/threads/<id>/`, `refs/t3/recovered/<id>/`, the id percent-encoded):
`transfer.hideRefs` hides the rest, and the ref updates of a push are read and checked before git
sees them. The target of a Thread's running move also reads (never writes) that Thread's refs, so
it can fetch what the Thread continues from before the Thread is its own. Anything under
`refs/t3/recovered/` is only ever created (its old value must be none), by every machine: a move's
set-asides go under `<id>/move/<time>/…`, and recovered changes under `<id>/return/<time>`. A
machine a Thread moved away from writes only the exact ref the Hub granted it
(`RemoteEnvironments.grantRecovery`: one push, a few minutes, at most 256 MiB) and reads nothing;
the granted ref is unhidden for that push alone, and does not exist yet, so nothing is advertised.
Nobody deletes a ref; an update need not fast-forward, since a rollback reuses its own
checkpoint refs. Transfers always name the Hub repository by URL or path, never a remote of the
checkout, so nothing reaches `origin`.

#### New checkouts from the Hub

A machine without a Project's checkout (a Sandbox, a dedicated or personal machine) makes it from
the Hub repository, not from the Project's own remote: inside a Sandbox an `origin` that is a path
on the Hub does not exist, and a private remote needs credentials no machine should hold.

- **The Hub's copy of its checkout:** `refs/t3/project/` in the Project's repository holds the
  branches (`heads/`), `origin`'s tracking refs (`remotes/origin/`, without `origin/HEAD`) and the
  commit HEAD is on (`checkout/HEAD`) of the repository the Project's `workspaceRoot` is in, copied
  from that repository's top (`HubRepositories.mirrorCheckout`). The copy is forced and pruned: the
  Hub's checkout is authoritative, so a rebase or a deleted branch there shows in the next
  checkout made. The Hub's checkout itself is only read.
- **Only the Hub writes it.** Every machine the route serves for the Project reads `refs/t3/project/`
  (every machine whose owner may start Threads in its Space, a Guest's personal machine included,
  and the Space's Sandbox and dedicated machines); no machine writes there (`refPrefixesFor` gives it
  no write prefix, so the route refuses the push before git sees it). A machine's own branches never
  reach the Hub; its uploads carry checkpoint refs only. A Thread's own repository
  (`/api/git/thread/<id>`) has no copy.
- **When it is copied:** only for a new checkout. Its fetch sends `X-T3-Checkout`
  (`HubRepository.CHECKOUT_HEADER`); on that upload-pack advertisement the route first copies the
  Hub's checkout. One copy runs at a time per Project; a clone that asked before a copy started
  that then succeeded takes that copy, and a failed copy counts for nobody. A copy has the time of
  a transfer (10 minutes). A failure is logged and the fetch is served as the repository is.
  Routine checkpoint fetches never send the header and never wait on a copy.
- **Only from a trusted repository:** the copy is made only when today's root rule trusts the
  Project's `workspaceRoot` and the repository it is in (`SpaceVisibility.trustedProjectRepository`:
  the `directoryRoots` rules the directory checks use, `isTrustedProjectRoot` and
  `projectRepository`, whose top holds none of the Hub's own folders). A top above the Project's
  root is trusted only when it holds no other Project of any Space, passes the root rule itself and
  is no home folder (`isHomeFolder`), so one Space's Project never carries another's code. From any
  other, nothing is copied and no `fromHub` is sent.
- **The Hub's reads never fail a session:** git failing in the Hub's checkout, unable to start
  there, or the folder gone means no `fromHub` (and no `cloneUrl` when `origin` cannot be read);
  the machine uses the checkout it has, or clones what it can.
- **Which machines:** `fromHub` and `subfolder` go only to machines of executor contract 9 or later,
  which send the header. A machine from before gets the old checkout, a clone of
  `cloneUrl` at `<workspace root>/<slug>`.

The session's open and `move.fetch` carry `WireCheckout.fromHub` when the Hub has such a checkout
with a commit: `projectId`, the branch the Hub's checkout is on (none when its HEAD is detached), and
the Hub's branches whose upstream is `origin` (`branch.<b>.remote/merge`). The machine
(`HubRepository.cloneFromHub`) runs `git init` in a sibling folder and fetches, with its
Environment credential and the header, the copy's branches as its own, its tracking refs as
`refs/remotes/origin/*` and the HEAD commit. It checks out that branch, else that commit (detached),
else `main` or `master`; adds `origin` as the Project's own remote; gives each branch the upstream
it has on the Hub and no other; and renames the folder into place (a rename another process briefly
holds is tried again unless the target appeared meanwhile; the staging folder is removed on every
path). The Hub's URL and credential never enter the checkout's config. Only a transient failure
(the network, a 5xx, a timeout) is tried again (3 times, backing off from a second), all within the
time a clone of `origin` gets; a refusal or a Hub with nothing to check out fails at once. A failure
is never replaced by a clone of `origin`.

**A Project in a folder of its repository** (`/repo/packages/web`): the copy is the whole
repository's, from its top. The default checkout on a machine is then
`<workspace root>/<slug>/packages/web` (`WireCheckout.subfolder`, `ProjectCheckouts.environmentPaths`
with `subfolderOf`): the repository is made at `<workspace root>/<slug>` and the Project works in
its folder. A repository folder that exists without that folder is reported, not overwritten.

Without `fromHub` (no trusted repository with a commit, or a machine from before contract 9) the
machine clones `cloneUrl` as before. `cloneUrl`, and the `origin` of every new checkout, is the Hub
checkout's `origin` with its password removed, a user that is itself a token (`ghp_…`, `glpat-…`,
32+ characters, or one that does not decode) removed, and query parameters named like credentials
(`token`, `key`, `secret`, `auth`, `sig`, …) removed (`remoteWithoutCredentials`); a user name and
other parameters stay, and a URL that does not parse keeps no user information at all. That token
never leaves the Hub, so a fallback clone of a remote that needs it fails, as it should; pushes to
`origin` stay the User's business, with their own credentials.

Turn and Thread diffs read the Hub repository once both checkpoints are marked uploaded (a ref
there may be an older capture of a reused ordinal), so they work with the machine offline; until
then they run on the Thread's Active environment. A restore whose ref is missing in the workspace
(a move, or refs dropped there) fetches it from the Hub repository first.

### Threads without a Project

A Thread without a Project is a Thread in the scratch Project, whose workspace root is the Hub's
`<base dir>/scratch` ([ManagedProjectFolders](../../apps/server/src/project/ManagedProjectFolders.ts)).
Its worktree is its own folder there, made with `git init` when git is there (best effort: without
git the Thread still works, with no checkpoints, and a move says why it can't). A folder from before
gets its repository where the Thread runs, at its next checkpoint or move (`checkpoint.ensureScratch`).
Only such a folder (directly in the scratch folder, of the scratch Project) is stored relative to the
checkout for a Thread on another Environment, where it resolves under that machine's checkout of the
scratch Project (`<workspace root>/scratch/<folder>`); left null until the Project is projected. Every
other worktree elsewhere stays host-bound, and `ThreadManagementService` still places those on the Hub
machine only. A machine opening a session for one makes the folder, with git, instead of cloning
(`WireCheckout.scratch`).

[ScratchWorkspace](../../apps/server/src/environment/ScratchWorkspace.ts) (`makeScratchThreads`,
reached as `HubRepositories.threads`) alone decides whether a Thread has no Project, its folder and
its repository; whether a Project is the scratch one is read once per Project. Its checkpoints go to
a Hub repository of its own: `HubRepositoryKey { projectId, scratchThreadId }`, under
`hub-repositories/threads/`, served at `/api/git/thread/<threadId>`. Every transfer carries
`scratchThreadId`; a read that fails is an error that retries (503 on the route), never a fallback to
the Project's key, and `HubRepositories.ensure` refuses the scratch Project's own key, so no shared
repository exists. The route authorizes as for a Project and then serves only the Thread's Active
environment and the target of its running move (which may write only `refs/t3/recovered/<id>/`);
anyone else gets 403. Diffs read it once uploaded, as a Project's.

A move of one keeps its folder name and moves the folder's own history: at `final-checkpoint` the
source publishes its branches and HEAD under `refs/t3/threads/<id>/scratch/<moveId>/`
(`move.publishScratch`) and pushes them with the final checkpoint; repositories nested in the folder
are in no checkpoint, so the timeline says they stay behind. `move.fetch` with `scratch` makes
`<the target's checkout of the scratch Project>/<folder>` (with git) and fetches those refs;
`move.prepare` with `scratch` works in that folder (no worktree, no setup script): what it had that
differs is captured to `refs/t3/recovered/<id>/<time>/workspace`, a branch the source's replaces to
`.../branch/<name>`, both pushed to the Hub, then the source's branches and HEAD and the checkpoint's
files are laid over it.

### Moving a Thread

`thread.move { threadId, targetEnvironmentId, ifRunning }` is a client command. The Hub checks the
target first (`ThreadManagementService`: the sender may use it, it is online and has the Thread's
provider, as for placing a new Thread), then the Orchestrator applies the Role rules of continuing
the Thread (`commandAccess.ts`), refuses a move without its User or while one runs, and records the
move on the Thread (`thread.move-updated`, field `move`) at its first step. Everything else is
[ThreadMoveService](../../apps/server/src/orchestration-v2/ThreadMoveService.ts), outside the
effect lane: each step is written to the Thread under its lock, so clients show it and a restart
resumes from the recorded step. While a move runs, the Orchestrator refuses whatever would start or
continue work on the source (`BLOCKED_WHILE_MOVING`: messages, the queue, prepared-run retries,
rollbacks, forks, provider switches; answering the running turn's requests stays allowed while the
move waits for it) and holds the queue, which resumes on wherever the Thread runs once the move ends.

1. `waiting-for-turn`: the service asks the Orchestrator to leave it (`thread.move.advance`),
   which decides with the Thread's runs, so no run starts between the check and the step. It wakes
   on each change to the Thread's runs, says when the turn waits on the User (`waitingOn`), and
   with `stop` sends `thread.stop` once.
2. `final-checkpoint`: only with the source online. The source captures its workspace (manual
   changes included) to `refs/t3/threads/<id>/moves/<moveId>`, one ref per move so a fetch never
   sees a stale one, and pushes it. An offline source (or one that drops here) skips the step.
3. `fetching`: the move records what it continues from (`continuesFrom`: that final checkpoint,
   else the newest checkpoint marked uploaded, else nothing) and the target fetches it into the
   Project's checkout, cloning it first when the machine has none (`move.fetch`); the checkout is
   recorded (`targetCheckout`).
4. `preparing` (`move.prepare`, [MovedWorkspace](../../apps/server/src/environment/MovedWorkspace.ts)):
   the Thread always gets a worktree of its own on the target,
   `<worktrees>/<project id>/<thread id>`, never the Project's shared checkout. One is reused only
   if that checkout's `git worktree list` names it (a worktree it had there before, kept in
   `knownWorktrees`); a folder there that it does not name is refused. A branch the target had
   that the source's commit does not contain is kept under
   `refs/t3/recovered/<id>/<time>/branch/<branch>` first, a reused worktree's changes under
   `.../workspace`; a branch checked out in another worktree leaves this one detached. The
   checkpoint's files are laid over it and, in a new worktree only, the Project's setup script
   runs (resolved with the User's settings, with a terminal's environment); its output is a
   timeline item. A worktree the move made is removed if a later part fails.
5. `handoff`: writes what the agent on the target is told (`move.handoff`, below).
6. `switched`: one batch sets `activeEnvironmentId` and the Thread's worktree (stored as the
   target's host path), clears `activeProviderThreadId` so the next turn opens a new native
   conversation on the target, detaches the Thread's provider sessions
   (`provider-session.detached`) and adds the timeline entries (`environment_move`: source, target,
   actor, `continuesFrom`; then `environment_handoff`: who wrote the summary and the exact
   `context` the agent receives, with how many recent messages follow). Then `RemoteEnvironments.threadMoved` drops the cached Active
   environment, so the source's late events are refused, and each source session is detached
   outside the effect lane (an offline source drops it on reconnect).

`thread.move.cancel` (same rule as moving) ends a running move before `switched`; the Thread stays
where it was and the timeline says «Move to X cancelled». A failure before `switched` marks the
move `failed` with the step and git's or the script's message. The audit log records `thread.move`
when it starts, switches, fails or is cancelled, with the allow-listed detail. After a restart a
machine that has not said hello yet is unknown, not offline: the move gives each one a minute
(`RECONNECT_GRACE`) before going on without the source or failing for the target. Scope cwds
recorded before a move are still the source machine's paths, so rolling back to a turn from before
the move is not supported yet.

#### The agent's memory after a move

A Thread that stays on its Environment resumes its native session (`nativeThreadRef`), as always.
A moved one starts a new native session on the target, so the `handoff` step
([MoveHandoff](../../apps/server/src/orchestration-v2/MoveHandoff.ts)) prepares what it is told:

- **Notes (summary):** one model call through the machine's own text generation
  (`EnvironmentExecutor.textGeneration.threadHandoff`, wire operation
  `textGeneration.threadHandoff`; `TextGeneration.generateThreadHandoff`, with the Thread's
  provider instance, or the machine's text generation model when it lacks that instance, and the
  instance used is recorded). The source writes them when online. When it is offline the Hub
  machine writes them only for the Owner's Threads (its provider sign-ins are the Owner's in spec 2);
  any other User's history is never sent to the Owner's account, and the notes are assembled.
  The prompt fences the conversation as untrusted data and asks for instructions found in it to be
  reported, not followed; the agent receives the notes framed as possibly wrong, to be checked.
- **Never fails the move:** the whole step (reads included) falls back to notes assembled from the
  history (`mechanicalSummary`: title, turns, last requests and reply, changed files), with
  `writtenBy: fallback` and the reason, on any error, an empty answer or a call past
  `T3CODE_MOVE_HANDOFF_TIMEOUT_MS` (three minutes). A timed-out call is interrupted, which a joined
  machine hears as `textGeneration.cancel` and stops. No second call is made: the call carries the
  idempotency key `move:<id>:handoff` (a resend after a Hub restart gets the machine's answer) and
  the result is kept in `orchestration_v2_move_handoffs` (migration 099) as soon as it arrives, so
  the step reuses it after a restart.
- **Secrets:** the transcript sent, the notes and the recent messages kept are passed through
  `redactSecrets` (common token shapes, `NAME=value` lines whose name says key, secret, token or
  password, private key blocks, URL passwords).
- **Recent messages:** the newest history messages, at most 12 and 12,000 bytes; one longer than
  4,000 bytes is cut, never dropped, and the User's latest request is kept whole when it fits.
- **`context`:** the framed notes, pointing at the `thread_history` MCP tool.

The Thread's shell (`move.handoff`, sent to every client) carries only who wrote the notes, the
instance, a 200-character preview and the fallback reason. `switched` writes the
`environment_handoff` timeline item with all of it; on the wire the item has a preview and
`detailOmitted`, and the text comes with `getTurnItem` for whoever may read the Thread. A Guest's
item read gets the wire form only. The first turn on the target (`ProviderTurnStartService`)
reads that item and turns it into a context handoff record (`context-handoff:move:<id>`,
`full_thread_summary`, `history.coverage` = `context`, the item's redacted recent messages), which
the usual delivery budgets, injects or prepends to the prompt, and marks delivered; the record's
id makes it go once per move.

`thread_history` (`apps/server/src/mcp/toolkits/threadHistory/`) is a Thread caller's tool over
the visible history of the caller's own Thread, read with its User's Space visibility
(`readThread`) and only the conversation's item types: `search` (case-insensitive on the text
itself, snippets, `total` = matches, paged over the matches) and `read` (paged, cut per item), each
oldest or newest first. Naming any other Thread is refused (`capability_denied`).

The new turn item needs clients that know it: `ORCHESTRATION_PROTOCOL_VERSION` is 3 (an older
client is told to update before it connects) and `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION` 7 (an
older joined machine answers «unknown method» and the notes are assembled).

### Disconnections

A machine that drops keeps running: its agent spools each session's events (bounded per session,
`SPOOL_LIMIT`) until the Hub acknowledges them and resends them on the next socket, so a turn
whose process survived goes on with nothing lost or doubled. Clients show such a Thread
«paused, environment offline» (a turn under way, its machine not online; derived from the
Thread's runtime and the Environment's live status). The hello lists the sessions still alive;
one the machine lost fails on the Hub with `EnvironmentSessionLostError`, which
[RunExecutionService](../../apps/server/src/orchestration-v2/RunExecutionService.ts) turns into
an interrupted turn (a `run_interrupt_result` saying why) instead of a failed one, so the queue
goes on there. Whichever way the Hub ends a turn itself (a lost session, or HubRunInterrupt
below), a request it had open to the User (an approval, a question) is cancelled with it
(`not_resumable`), so clients stop offering Approve or an answer and the Thread can take new work
or move. While a Thread's machine is away, a User's message that would steer or start
work goes to the queue (`ThreadManagementService`, `queueWhileAway`). A move with **Stop the
turn** from a machine that is away ends its sessions on the Hub
(`RemoteEnvironments.abandonSessions`) and its unfinished runs there too
([HubRunInterrupt](../../apps/server/src/orchestration-v2/HubRunInterrupt.ts), as Force stop does),
so the move goes on even when the Hub no longer knows the sessions (after a restart); the machine
drops them when it returns. A start that fails because its machine went away (session lost,
released under the start, or no executor) also ends interrupted; the failed start waits a bounded
time for the event stream to settle it first.

[EnvironmentReturnService](../../apps/server/src/orchestration-v2/EnvironmentReturnService.ts)
handles the rest. When an Environment is removed (`EnvironmentRegistry.removed`, and at startup
for removals not yet handled) its sessions end (`environmentRemoved`), each of its Threads gets
`activeEnvironmentId: null` («needs an environment»: history intact, no new messages, its queue
held, movable, the move's source then null) and its unfinished runs end on the Hub, whether or not
the Hub still knows their sessions. Each time a joined machine connects it is asked
(`move.recover`), one Thread at a time per machine and under the Thread's lock, about every
Thread that moved away from it; a Thread with a move under way to or from it is asked again when
that move ends. Only the Thread's own worktree there is read (`knownWorktrees`): it is captured
into a granted `refs/t3/recovered/<id>/return/<time>` and compared with what the machine last
handed over (the move's `continuesFrom`, or the previous recovery) and with the trees it already
handed over. A difference is pushed and noted in the Thread (`recovered_changes`, a Thread-level
item placed when it happened, with the ref, the machine and the tree); otherwise the local ref is
deleted. A Thread that ran in the machine's shared checkout and moved while the machine was away
gets a notice that changes may remain in that folder; the shared checkout is never read. Nothing
the machine has is ever changed.

### Workspace RPCs

A client's files, search, browse, terminal and preview RPCs name a folder, not a machine, so
[ThreadWorkspace](../../apps/server/src/environment/ThreadWorkspace.ts) takes the machine from the
Thread the call names (`threadId`, optional on the file, search and browse inputs): its Active
environment, or the Hub machine for a call that names none, a draft, or a Thread on the Hub
machine. A client path never picks a machine. Before forwarding, the Hub checks the spec 1 rules
(`RpcSpaceAccess`: a named Thread is not hidden for reads and is the User's work for writes,
terminals and previews) and `environment.use`, then locates every folder and path inside the
Thread's workspace (its worktree, else its Project's checkout), as the Hub records it or as the
machine reported it, and resolves it onto the machine. Anything outside is refused, including
absolute paths elsewhere and `..`; on another machine only the workspace itself can be browsed.

A forwarded call carries no idempotency key, so a dropped socket fails it at once as
`environment_offline` (`TerminalEnvironmentUnavailableError`, `PreviewEnvironmentUnavailableError`
for terminals and previews): nothing typed or saved waits to run later. Terminal output and
preview events are streams the Hub opens with a request; the machine sends their items as
`workspace.stream` frames, outside the provider events' `seq`, spool and acknowledgements, and
stops on `workspace.streamCancel` or when the socket closes, where the Hub ends them as offline and
the client reopens them. Each connected machine streams its preview events to the Hub for as long
as its socket lives. A joined machine treats every workspace as known, since the Hub authorized
and resolved the path. Server-rendered preview frames (`/api/preview-stream`) still come from the
Hub machine's own browser only. A dev server's port on the Thread's machine opens through the Hub
at `/preview/<token>/`, relayed over the same streams and checked on every request; see
[Previews through the Hub](./sandboxes.md#previews-through-the-hub).

A Thread's file served by URL (`assets.createUrl` for `workspace-file` and `media-file`: image,
PDF, HTML and media previews, large text and downloads) follows the same rule
([ThreadAssets](../../apps/server/src/assets/ThreadAssets.ts)). For a Thread on another machine
the Hub asks the machine to look at the file (`files.inspectAsset`, contract 15: inside the
workspace, links followed, a regular file, not the machine's own state), applies the Hub machine's
preview types to the path asked for and to where it leads, and signs a `thread-machine-file`
token naming the Thread, the Environment, the User and a path relative to the workspace there.
Fetching it ([MachineAssetResponse](../../apps/server/src/assets/MachineAssetResponse.ts)) checks
the Thread is still on that machine for that User (another signed-in User gets 404), has the
machine inspect the file again (15 s, else 504; offline 503), and streams it in windows of at most
8 MiB (`files.streamAsset`), each re-resolved and pinned to the inspected file; a window with
another file or bytes it did not announce cuts the response, whose `Content-Length` was announced.
Text is masked as for the Hub machine's files and nothing is written on the Hub. A machine before
contract 15 answers «needs an update», never a Hub copy.

### Logical workspace paths

A Project's checkout is a per-Environment fact. The Hub machine's checkout is always the Project's
`workspaceRoot`; another Environment uses the checkout chosen there
(`environment_project_checkouts`) or `<its workspace root>/<Project slug>`
([ProjectCheckouts](../../apps/server/src/environment/ProjectCheckouts.ts)). A path the projection
records (a Thread's `worktreePath`, a checkpoint scope's `cwd`) is still the Hub machine's absolute
path, which every Hub-local reader keeps using. Beside it the projection stores its
[logical form](../../apps/server/src/environment/WorkspaceLocation.ts): relative to the checkout,
or, when the path is not plainly inside it (a managed worktree, `..`, another folder), absolute and
bound to the Environment that recorded it. Only a form that resolves back to the identical string
is relative, so the Hub machine sees no change. A Thread on another Environment records its scope
cwds as that machine's paths, since its runtime policy resolves there; their logical forms are
still computed against the Hub machine's checkout, which a move between machines must revisit.

`RuntimePolicyV2` passes the recorded worktree through on the Hub machine. On another Environment
it resolves the stored logical form on that executor, or, when the row has none or its recorded
path has changed since, one computed against the Hub machine's checkout. A host-bound path on
another Environment is a `RuntimePolicyResolveError`, never a wrong directory. Scope cwds are
stored in logical form but still reach `CheckpointStore` as recorded; a Thread that runs or moves
elsewhere must resolve them the same way. A form is stored only once its Project's checkout is
known: a row projected before its Thread or Project stays null (a scope is filled when its Thread
row is written), so a missed join never freezes a path as host-bound.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. Each forge's
definition names its CLI's commands in `changeRequestCloseCommand`. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
