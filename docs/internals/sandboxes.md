# Sandboxes

A Space's Sandbox (ADR 0004) is a joined T3 server the Hub runs for that Space. It is an
Environment like any joined machine, `kind = 'sandbox'` with the Space's `space_id` and no owner,
so remote execution, checkpoints, the Hub repository, moves and disconnections apply unchanged. Its
lifecycle is a row in `sandboxes` (migration 100).

## Identity and credential

A Space has one Sandbox id for its whole life, `sandbox:<spaceId>`
(`sandboxEnvironmentIdOf`). With a runtime on, the Environments list shows it, `stopped`, for every
Space the viewer may run Threads in before it exists, so the composer can offer it; choosing it in
`chooseForThread` makes it, stopped ([Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts)). The Hub
issues the credential itself, with no approval: the Sandbox keeps it in its home, the Hub only its
hash, as for `t3 join`. A home lost while the row stays gets a new credential on its next start.

What the credential reaches is decided by the Space, never by a User:

- `environment.use` on a Sandbox needs the Thread's Space to be the Sandbox's (`workSpaceId` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)), so placement, moves and forwarded
  workspace calls never put another Space's Thread on it, whoever asks. Callers that place or
  forward pass the Thread, or the Space a new one is claimed in (`ThreadLaunchService` claims it
  before placing, as `thread.create` will).
- The executor refuses to open a session or start a turn on a Sandbox for a Thread whose Space is no
  longer the Sandbox's (`SandboxSpaceMismatchError`): the last guard behind
  [Moving a Project to another Space](#moving-a-project-to-another-space), which releases them.
- The [git route](../../apps/server/src/environments/gitRoute.ts) serves a Sandbox only the
  repositories of its own Space: a Project's, or a Thread's own repository by the Thread's Space.
  A Sandbox makes a new checkout of a Project from the Hub's copy of its own checkout in that
  repository (`refs/t3/project/`, which only the Hub writes and the Sandbox only reads), with the
  credential; `origin` in the checkout is the Project's own remote, without its password or token.
  A transient Hub failure (network, 5xx, timeout) is tried again, within a clone's time; any
  failure then fails the checkout: it never falls back to `origin`, which inside the container may
  be a path on the Hub or a private remote. Only when the Hub has no checkout of the Project with a
  commit in a repository the directory rules trust is `origin` cloned instead. A Project in a
  folder of its repository gets the whole repository, and works in its folder (overview, «New
  checkouts from the Hub»).
- A Sandbox never `leave`s, and is not renamed or removed as a machine. Archiving its Organization
  stops it and nothing starts it meanwhile; deleting the Organization revokes the credential and
  removes its row and home.

A runtime must never let one Sandbox see another's home: each credential lives in its own home
only, so a container gets its own volume and nothing else of the Hub's (the Podman runtime).

## Runtime

Only implementations of [SandboxRuntime](../../apps/server/src/sandboxes/SandboxRuntime.ts) touch
processes or containers. Without one that runs Sandboxes the Hub offers none (not even one made earlier) and placement refuses
them (`sandbox-unavailable`).

[Which one runs](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts):
`T3CODE_SANDBOX_RUNTIME=podman`, `process` or `off`. Unset, a production Hub (no `--dev-url`, not
joined) runs Podman when `podman info` says rootless and the image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`, the [base image](#base-image)) exists; otherwise none (a
Hub started before the first build runs Sandboxes once it restarts). Both checks
run once per Hub, together, with a 5-second timeout each. Every runtime needs the Hub to answer on
loopback; Podman Sandboxes need it to listen on loopback **only** (`T3CODE_HOST=127.0.0.1`, or `::1`),
since a container reaches every address of the host but its loopback: a Hub on `0.0.0.0` or a LAN
address offers none. A production Hub binds loopback and is published through a reverse proxy
(or `t3 up`); one that binds elsewhere while rootless Podman is here warns at startup that its
Sandboxes are off for that reason.

### Podman

The [Podman runtime](../../apps/server/src/sandboxes/PodmanSandboxRuntime.ts) runs each Sandbox's
server in its own rootless container, `t3-<sandboxId>` (labels `io.t3code.sandbox=<id>` and
`io.t3code.sandbox-root=<Sandboxes root>`), made on each start and removed on stop:

- **Home.** `<Hub home>-sandboxes/<sandboxId>` is bind mounted as `/home/sandbox`, the server's
  base dir, `HOME` and workspace root (`/home/sandbox/projects`). A bind-mounted directory rather
  than a named volume: no Podman call to create or inspect it, and it survives the container
  (stop/start keeps it). No runtime limits a directory's size, so the disk limit is the Hub's own
  check (see [Limits](#limits)).
- **What the Hub writes stays out of the home.** The credential and `joined-hub.json` live in
  `<Sandboxes root>/.state/<sandboxId>/`, which only the Hub writes, and are mounted read-only
  over their paths in the home (`userdata/secrets/environment-credential.bin`,
  `userdata/joined-hub.json`). The Hub never writes in, reads or walks a home the Sandbox has used:
  it makes `userdata/secrets` only in a new home, and before a start (no container running) it
  `lstat`s those paths and refuses a link or a special file there (a FIFO would hang the mount).
  `delete` removes the home without following links, outside the runtime's lock.
- **User.** `--userns=keep-id`: inside it is the Hub's own uid, not root, so the home the Hub made
  is the server's without `chown`; `--cap-drop=all`, `no-new-privileges`, `--init` (reaps agents'
  orphans). It is still the Hub's user on the host, as in any rootless container.
- **Nothing else of the Hub** is mounted, besides the directory of its Hub socket (read-only). The
  [base image](#base-image) runs its own `t3`. Only a dev Hub run from source, given a dev image
  (one the Hub did not build: Debian, git and Node, no version label), mounts `apps/server`,
  `packages` and `node_modules` of its checkout read-only at their own paths
  ([devCodeMounts](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts)) and runs
  `node <checkout>/apps/server/src/bin.ts`. A start is refused when a code mount holds the Hub's
  home, the Sandboxes root or a `.env*` file.
- **Image.** Each start runs the image its tag names then, by id (a build meanwhile changes nothing
  mid-start), and reports that image's version, which `sandboxes.image_version` keeps. A tag that
  names no image fails the start, saying to build it.
- **Network.** `slirp4netns:allow_host_loopback=false`: its own namespace with internet, no host
  loopback (`10.0.2.2` leads nowhere), and no other container's ports (none publishes any). Other
  host addresses are reachable as from the LAN, hence the loopback-only rule above.
- **The Hub socket.** [SandboxHubSocket](../../apps/server/src/sandboxes/SandboxHubSocket.ts): per
  Sandbox the Hub listens on `<Sandboxes root>/.hub/<hash>/hub.sock` (short: a UNIX socket path has
  ~107 bytes), mounted at `/run/t3-hub`. It forwards to the Hub's loopback listener only
  `/api/environment/connect` (upgrade included), `/api/git/…`, exactly `/mcp` and the AI gateway
  layer `/api/ai/…` (never CLIProxyAPI itself; a gateway key decides there), normalized,
  dropping `Forwarded`/`X-Forwarded-*`, `TE` and `Trailer`; anything else gets 404 without reaching
  the Hub. A refused upgrade is answered and the connection closed. Seen from the Hub these
  requests come from loopback, which is what lets the credential cross plain HTTP.
- **Inside**, the container's first process is a small Node script (passed with `node -e`, so any
  image with Node works) that listens on the container's own `127.0.0.1:47231`, pipes each
  connection to the socket, and starts the server. The Hub URL it is given is
  `http://127.0.0.1:47231`, so the joined server, its WebSocket and git (with the credential
  helper, as on any machine) need no UNIX-socket support. That port is the container's loopback,
  not the host's.
- **Lifecycle.** Each container is named by the id `podman run --detach` printed in every later
  call, so cleaning up an old one never touches a newer one with the same name. `exits` comes
  from `podman wait`; a failed wait is not an exit until `podman inspect` says it stopped. A
  container that ends without `stop` has its scope (container, socket) closed under the runtime's
  lock before the exit is reported. On start the runtime removes every container labelled with its
  root (a Hub that crashed left them), and before each start that Sandbox's; a container of that
  name with another root is another Hub's and fails the start. The Hub's containers stop with it; one whose Hub died without stopping it (killed, crashed) stops by
  itself once its Hub socket has not answered for 30 seconds. Logs go to `<Sandboxes root>/<sandboxId>.log`, rotated at 10 MB.

Requirements: rootless Podman 3.4 or newer (Ubuntu 22.04's works) with `slirp4netns`, subuid and
subgid ranges for the Hub's user (`/etc/subuid`, `/etc/subgid`), and `XDG_RUNTIME_DIR`. Without a
systemd user session (a `wsl -e` shell, a service without lingering) the runtime passes
`--cgroup-manager=cgroupfs`, and then enforces no CPU, memory or PIDs limit (see [Limits](#limits)). Newer Podman defaults to pasta; this runtime asks for slirp4netns
explicitly, so it must be installed.

The [process runtime](../../apps/server/src/sandboxes/ProcessSandboxRuntime.ts) is for tests and
development only, on with `T3CODE_SANDBOX_RUNTIME=process`: it isolates nothing from the Hub's user,
so every Sandbox could read the others' credentials. It runs `t3 serve --base-dir
<Hub home>-sandboxes/<id>`, beside the Hub's home rather than in it, as a child of the Hub with the
environment stripped to `PATH`, locale and temp dirs, `HOME` the Sandbox's home, and a start token;
a dev Hub passes its `--dev-url`, so its Sandboxes have the Replay provider. The Hub address it
gives is always loopback; a Hub bound only to another address runs no Sandbox. Its children end
with the Hub; one left by a Hub that crashed is found by the pid file beside its home and stopped,
once its command line and start token prove it is that server, before another starts on the home.

A Sandbox counts as started once its socket is ready: `markReady` on the attached socket (not a
replaced one) after the welcome, the recorded hello and the executor's registration, so work that
waited for it finds its providers and executor. A server that ends first fails the start at once
with its exit code. A launch runs with the runtime's own services, never those of whoever asked
for the start.

## The Hub runs no agents

What nobody places on another machine runs in its Space's Sandbox, never in the Hub's process
([EnvironmentRegistry](../../apps/server/src/environments/EnvironmentRegistry.ts) `chooseForThread`,
previewed by clients with `previewThreadPlacement`): the User's choice, else the Project's preferred
Environment while it can take the Thread (usable, online or a Sandbox not failed, with the
provider, and never a Sandbox this Hub has no runtime for), else the Space's Sandbox, made if
missing and counted while stopped or even failed (its work starts it, or says why). Work the Hub
places with no User (a scheduled task without a creator) goes to the Sandbox of the Thread's Space
too. Every path that makes a Thread goes through it: the composer, MCP-launched Threads
(`thread.create` through `ThreadManagementService`), scheduled tasks and other launches
(`ThreadLaunchService`), Threads without a Project (their scratch Project's Space). Forks,
delegated subagents and Threads an agent creates over MCP run where their parent runs (the Hub
checks that choice like any other); a parent with no Environment leaves it to placement. A new
worktree is made only on the Hub machine until Environments check out from the Hub repository, so
a worktree Thread anywhere else is refused when it is made (MCP, the composer), and a scheduled
task with a worktree strategy is refused when it is saved.

**`HubRunsAgents`** ([HubRunsAgents](../../apps/server/src/environment/HubRunsAgents.ts)) says whether
the server's own machine runs agents. A joined machine (a Sandbox included) always does. A Hub does
only in development: `T3CODE_HUB_RUNS_AGENTS` (`1`/`true`, `0`/`false`) is honored only for a server
the dev runner started (`T3CODE_DEV_RUNNER=1`, set by `vp run dev`, with `--dev-url`); anywhere else
a value that turns it on is ignored with an error in the log. Under the dev runner it is on by
default only with no Sandbox runtime (`T3CODE_SANDBOX_RUNTIME` unset or `off`), so contributors
without Podman keep working as before Sandboxes; with `process` or `podman` it is off. While on, the
Hub machine is listed and is the fallback instead of the Sandbox. Anything the server does not
provide it to (a CLI command, another entry point) reads it off: it fails closed. Tests that run
work in the Hub's process provide it on (the testkit's `hubRunsAgents`, on by default), and the
tests of this rule turn it off.

While off, the Hub machine runs nothing, whatever asks:

- Its executor opens no provider session (`HubRunsNoAgentsError`, «The Hub runs no agents»), has no
  text generation and prepares no moved workspace; `TerminalManager` opens no shell (setup scripts
  included) and `TextGeneration` runs no provider CLI (`hub_runs_no_agents`).
- Workspace calls (`ThreadWorkspace`) for a draft (a Thread not placed yet) or with no Thread still
  read the Hub's copy of the Project: listings, search, reading files, browsing folders, which run
  no code. Since nothing places them, the folder they name must be one the User may read: a
  Project of a Space they see, or a Thread's working folder there (`mayReadDirectory`; a write,
  one they may work in), else they answer like a missing Project (`RpcSpaceAccess`). The same goes
  for a Thread on the Hub machine. What is checked is what the call opens
  ([localWorkspaceTargets](../../apps/server/src/workspace/localWorkspaceTargets.ts)): an absolute
  folder, no `~` and no `..` anywhere, a browse path absolute or explicitly relative (`./`); links
  count where they lead (both sides resolved). Browsing folders with no Thread keeps to them as
  well (only the Owner browses anything). Anything that acts (writing a file, opening or typing in a terminal, opening a preview)
  is refused until the Thread is placed. A Thread not projected yet resolves to no Environment
  (`ActiveEnvironmentResolver`), never the Hub machine.
- Titles are written on the Thread's Active environment (`textGeneration.threadTitle`, in its
  workspace there; attachments stay on the Hub); a machine away or without text generation leaves
  the title as it is. A moved Thread whose source is offline gets its summary from the target
  (`writtenBy: target`), or an assembled one. A pull request's text comes from its commits, and a
  review guide says the Hub runs no agents.
- The Hub machine is not in the Environments list, and choosing it (a new Thread or a move) is
  refused (`hub-machine`). A Project's «Preferred environment» offers no preference, named after the
  Space's Sandbox, and the User's own machines.
- Its own provider catalog (no CLIs: «Not found») is not what a Thread can use. The composer
  offers the providers of the machine the Thread runs on, a draft's being where it would be placed
  (`useDraftPlacement`, before any provider is chosen), as that machine reports them in the
  Environments list (`providersOnEnvironment`); the Hub's settings still say which are enabled.
- With no Sandboxes either, a new Thread nobody placed is refused, never run on the Hub:
  «No Environment can run this Thread: <why>» (`no-environment`). The why is the Sandbox runtime's
  own (`sandboxRuntimeFromConfig`: no rootless Podman or image, the Hub not on loopback only,
  turned off), also in the list as `sandboxesUnavailable`, so the composer says it before sending
  and still offers the User's own machines. The Hub logs it at startup.
- As the Hub starts, before it recovers its runs, every Thread whose Active environment is the Hub
  machine needs an environment, as for a removed machine (`EnvironmentReturnService`, built before
  `serverRuntimeStartup` recovers anything): its history stays, unfinished turns end, and it moves
  to the Sandbox or a machine of its User's. So does every Thread in a Sandbox once the Owner turned
  Sandboxes off (`T3CODE_SANDBOX_RUNTIME=off`, `sandboxesTurnedOff`), and only then: a runtime that
  is away for now (the image of a new version not built yet, `podman info` failing, the Hub bound
  elsewhere) releases nothing, which could not be undone; those Threads wait, offline, and can be
  moved meanwhile.

`request_secret` with `delivery: "file"` hands the agent a path on the Hub machine (a folder in
memory there, see [secrets.md](secrets.md)): it applies only when the Hub machine runs the agent.
An agent in a Sandbox or on a joined machine cannot read that path; it uses a `secretRef`.

## Limits

Each Sandbox has CPU, memory, PIDs and disk limits
([sandboxLimits](../../apps/server/src/sandboxes/sandboxLimits.ts)): the Installation's defaults
(`sandbox_limit_defaults`, migration 104, one row: 2 CPUs, 4 GiB, 4096 processes and threads,
20 GiB; null there is no limit) and each Space's own values in `space_sandbox_limits` (migration
108, which moved them out of `sandboxes`; null or no row takes the default), kept and read by
[sandboxLimitStore](../../apps/server/src/sandboxes/sandboxLimitStore.ts) for a Hub's Sandbox and a
dedicated machine alike, so a Space with only a dedicated machine has them too (deleted with the
Space). `Sandboxes` reads them at every start and passes the effective ones to the runtime as
`start(sandboxId, { limits })` (`SandboxStartOptions`), so a change applies on the next start;
dedicated machines get the same effective limits (see [Dedicated machines](#dedicated-machines)).

- **CPU, memory, PIDs** are the runtime's. `SandboxRuntime.limitSupport` says which ones it
  enforces on this host and why not, in words for the Owner; Settings and the Hub's log (one
  warning at startup, `Sandbox limits not enforced on this host`) show it, never a limit that is
  not applied. The process runtime enforces none. Podman reads `podman info` once
  ([podmanLimitSupport](../../apps/server/src/sandboxes/PodmanSandboxRuntime.ts)): only cgroups v2
  with the **systemd** cgroup manager gives a rootless container a cgroup of its own, and then
  each of `cpu`, `memory`, `pids` counts if it is delegated to the Hub's user
  (`/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/cgroup.controllers`). Under
  **cgroupfs** (no systemd user bus at `$XDG_RUNTIME_DIR/bus`, as in a `wsl -e` session, where
  `dbus-user-session` is not installed) a rootless container shares its caller's cgroup: Podman
  3.4 records `--memory`/`--pids-limit` and ignores them, or fails the run outright with
  «could not find cgroup mount» from the root cgroup, and `--cpus` is dropped. So the runtime passes
  `--cpus`, `--memory` (with `--memory-swap` equal: no swap beyond it) and `--pids-limit` only
  for what is enforced, and labels every container with what it was started with
  (`io.t3code.limit.cpus`, `.memory-bytes`, `.pids`, `io.t3code.limits-enforced`) for
  `podman inspect`. A container killed under an enforced memory limit (exit 137) is reported as
  having gone over it. To enforce them on a host: run the Hub as a systemd user service (or
  `loginctl enable-linger`) with `dbus-user-session` installed, and delegate the controllers
  (`Delegate=cpu cpuset io memory pids` for `user@.service`, the default on recent systemd).
  Measured in the dev WSL (Ubuntu 22.04, Podman 3.4.4): cgroup v2, user slice delegates
  `memory pids`, no user bus from `wsl -e`, so nothing is enforced there and the Podman test that
  checks enforcement skips with that reason.
- **Disk** is the Hub's: a home is a bind-mounted directory, so `Sandboxes` measures it
  (`SandboxRuntime.measureHome`): Podman with `podman unshare du -skx`, as root of the Hub user's
  namespace, so a directory the Sandbox made unreadable is still read (checked on Podman 3.4);
  the process runtime with plain `du`. A measurement is either a total from a clean exit or a
  failure (any other exit, a timeout, too much output), never a smaller size. Exit 1 where every
  one of `du`'s own errors is `du: cannot access '…': No such file or directory` (a file deleted
  while `du` ran; read with `LC_ALL=C`, line by line, never kept) is still a failure, but with its
  total as a lower bound (`atLeastBytes`): a Sandbox can make real files vanish that way too
  (renaming a big directory in a loop, as `fts` defers the `stat`), so the total may be far short.
  Such a measurement is taken again at once (a build's churn usually passes; the larger lower
  bound of the two is kept); a lower bound already over the limit stops the Sandbox as full,
  otherwise it counts as a failed measurement, and below the Hub's disk floor as a Sandbox
  growing. Any other error, a directory gone (`cannot read directory`) or the walk failing
  (`fts_read failed`), is a plain failure. GNU `du` quotes a name with a newline and puts the
  error after the name, so no name passes for that error. `du` runs in a process group of its own, killed whole (and its own
  process, should the group kill fail) on a timeout, an interrupt, or the Hub's process exiting,
  so the `du` that `podman unshare` runs in its child does not outlive it. Each failure is counted
  per Sandbox; three in a row count as over the limit (fail closed: «Its disk use could not be
  measured 3 times in a row …»), so a Sandbox cannot make itself unmeasurable. Such a Sandbox
  starts again on a User's own action or the Owner's Start, to repair its home: a failed
  measurement never refuses a start (only one over the limit does), and the count starts from
  none, so it runs for about three checks before it is stopped again unless its home can be
  measured by then; the message says so. At most two `du` run at once for the checks, and two
  more for starts, so a slow home measured by a check never holds back another Space's start.
  Checks run every `T3CODE_SANDBOX_DISK_CHECK_SECONDS` (default 60) for running Sandboxes, at once
  when a limit changes, and before each start; a check reads the limit, status and start again
  under the Sandbox's lock before it stops anything, so a limit raised or a restart meanwhile is
  never stopped on a stale reading. One over its limit is stopped (audit `sandbox.stop`, via
  `disk-full`). Every stop ends the server first, marked stopping (waiting work neither starts it
  nor takes it as ready meanwhile): a stop that fails leaves it `running`, for the next check to
  stop again, never recorded `failed` or `stopped` while its server runs (and each check stops any
  server still running for a Sandbox recorded `stopped` or `failed`; a start that finds its server
  running records it `running`). Waiting work's start that queued on the lock during a stop checks
  again under the lock what the stop left (held, `failed`) and withdraws. Then it is set `failed` with
  why in one status write (never `stopped` on the way, which waiting work would start again); its
  provider sessions end (`Sandboxes.sessionsEnded` → `RemoteEnvironments.sandboxSessionsEnded`),
  so its turns end interrupted with «… ran out of disk space …» (`EnvironmentSessionLostError`,
  reason `sandbox-disk-full`), and its socket closes with the close reason `sandbox-disk-full`
  (4418, final). It starts again only on a User's own action once its home fits (the Owner raises
  the limit, or its files go). Without `du` the disk limit is not enforced and Settings says so.
- **The Hub's own disk.** A bind-mounted home is on the Hub's filesystem, so between two checks a
  Sandbox can fill it, with the Hub's database on it. The floor is 5% of the Sandboxes root's
  filesystem (at most 10 GiB) (`minHostFreeBytes`). Below it each check stops the Sandboxes
  writing to it (via `host-disk-low`, failed with «The Hub's disk for Sandboxes is almost full
  …»): first, without measuring anything, each whose last two measurements grew more than 16 MiB,
  or whose last one failed; then, unless the disk is now below half the floor, it measures the rest
  and stops each that grew more than 16 MiB since it was last measured, or that cannot be measured
  now. One that is not writing keeps running, since stopping it frees nothing (the cause may be no
  Sandbox at all, such as the Hub's logs). Below half the floor every running Sandbox stops, without
  measuring. The stops run at once, each under its own lock. No Sandbox starts until
  half as much again as the floor is free (`minHostFreeBytesToStart`, 15 GiB on a large disk), so
  a little room freed (a log rotated) does not start them all, to be stopped again at the next
  write. This is a limitation, not a quota: for a real one put the
  Sandboxes root (`<Hub home>-sandboxes`) on a filesystem of its own, sized for them, apart from
  the Hub's home: a separate disk or partition, an XFS filesystem with a project quota per home
  (`xfs_quota -x -c 'project -s …'`), or a size-capped mount (a loop-mounted image). Moving homes
  onto Podman volumes with a quota is later work.
- **Use** shown in Settings comes from two background samplers, never from the request: CPU and
  resident memory every 10 s for running Sandboxes, summed over the container's processes
  (`podman top … rss pcpu`, CPU averaged over each process's life; read from processes, since a
  cgroupfs container's cgroup is shared), and each home's size from the disk checks (a stopped
  one measured once). Uptime is from `sandboxes.started_at`. The process runtime reports no CPU or
  memory. Settings shows the limits a running Sandbox was started with and, when they changed
  since, «Applies on next restart: …»; an exit 137 under an enforced memory limit names that
  container's limit. What it was started with is kept in memory only, which is enough: a Hub
  that starts finds no Sandbox running (Podman removes its leftover containers by label, the
  process runtime stops its leftover servers), so none outlives the Hub that knew its limits.
- **Validation.** CPUs at least 0.1, memory at least 256 MiB, processes and threads at least 64,
  disk at least 1 GiB, and none above what the Hub's machine has (its CPUs, its memory, the size
  of the Sandboxes' disk); anything else is refused with which (400
  `EnvironmentSandboxLimitsInvalidError`). A Space with a dedicated machine may be given more
  CPUs and memory than the Hub has, for a bigger machine; the Owner sets them on the Space's Hub
  Sandbox or on the dedicated machine itself (`POST …/sandboxes/limits` with its `environmentId`),
  which works without a Hub Sandbox for that Space, and without a Sandbox runtime on the Hub. Every
  start (on the Hub or a dedicated machine) uses at most the CPUs and memory its machine has
  (`fitLimitsToHost`), since Podman refuses more CPUs than the machine's. A change is partial:
  only the values given change and an explicit null clears one; the answer adds `changed`, the
  defaults or that Space's own values with the limits its Sandboxes start with.
- **Defaults on dedicated machines.** The Installation's defaults apply to a dedicated machine's
  Sandbox too, where the Space has no value of its own (intended: a machine is never unlimited by
  accident, and `fitLimitsToHost` caps them at its size); give the Space its own values for a
  bigger machine. Settings lists only Hub Sandboxes, so a Space with only a dedicated machine has
  no row there yet (follow-up in ticket 13); its limits are set through the API meanwhile.
- **The Owner's stop holds.** A stop from Settings sets `sandboxes.held_at` in the same write as
  `stopped`, before its socket closes, while the Sandbox is marked stopping: waiting work
  (`EnvironmentDemand.request`, work that is not a User's own action) does not start it again,
  neither during the stop nor after; a User's message, «Try again» or the Owner's Start does, and
  ends the hold. Its turns end interrupted, «The Owner stopped … Send a message to start it
  again and continue.» (`EnvironmentSessionLostError`, reason `sandbox-stopped`), since a held
  Sandbox does not come back by itself to resume them. Audit `sandbox.stop` with `hold: true`.
  Settings asks before stopping or restarting a Sandbox with turns running, saying how many.

**Settings → Environments «Sandboxes»** (`GET /api/environments/sandboxes`,
`POST …/sandboxes/action` with `start`, `stop` or `restart`, `POST …/sandboxes/limits` with or
without an `environmentId`): `sandbox.inspect` (the Owner, an Organization's Admins, a Personal
space's User) sees status, uptime, use, limits, image version (`image_version`, filled by ticket 06) and the enforcement note; `sandbox.manage` (the Owner) acts and changes limits and defaults.
Someone who may not inspect a Sandbox gets 404 for it; a start of an archived Organization's
Sandbox is refused until it is restored. Audit: `sandbox.start`/`sandbox.stop` with via
`settings` (with `hold`), `restart`, `disk-full` or `host-disk-low`, and `sandbox.limits.change` with scope (`defaults` or `space`) and
the new values.

For the Owner the list also carries `dedicatedSpaces`: each Space with machines dedicated to it
and no Hub Sandbox listed, with its own and effective limits, so a Space whose only Sandbox is a
dedicated machine has a limits row («<Space> · dedicated», **Limits**); the change goes through
`POST …/sandboxes/limits` with one of its machines' `environmentId`. Disk is marked not enforced
there: it is the Hub's own check, for its own Sandboxes.

**Every machine for the Owner** (`GET /api/environments/overview`, DoorRules `OWNER`): the
Owner's list with each machine's mode, Space and owner by name, status and start error; a Sandbox is listed once it has run
(`isListedMachine` in contracts, the rule web Settings uses too). Anyone else gets 403. Mobile's read-only «Machines on this Hub» reads it.

## Base image

Every Sandbox runs one image, [the Containerfile](../../apps/server/sandbox-image/Containerfile):
Debian bookworm-slim, Node of the repository's `engines` (from nodejs.org, checked against its
SHASUMS), git, git-lfs, ripgrep, `build-essential`, Python and the usual shell tools, the CLIs of the
providers that ship one, and the T3 server of the Hub's own version as `t3`. Node is an `ARG`
checked against nodejs.org's SHASUMS; the CLIs are
[clis/package.json](../../apps/server/sandbox-image/clis/package.json) with its `package-lock.json`,
so their whole dependency tree, platform binaries included, is locked with integrity hashes:

| Piece                 | Version   | Installed as                            |
| --------------------- | --------- | --------------------------------------- |
| Node                  | 26.12.1   | nodejs.org tarball, SHASUMS256          |
| Claude Code, `claude` | 2.1.319   | `@anthropic-ai/claude-code` (npm)       |
| Codex, `codex`        | 0.167.0   | `@openai/codex` (npm)                   |
| OpenCode, `opencode`  | 1.19.5    | `opencode-ai` (npm)                     |
| Pi, `pi`              | 1.5.0     | `@earendil-works/pi-coding-agent` (npm) |
| Grok, `grok`          | 1.0.77    | `@xai-official/grok` (npm)              |
| T3 server, `t3`       | the Hub's | the Hub's own (below)                   |

Cursor runs inside the server (its SDK). Kiro, Fx, Muse and Antigravity ship no npm CLI; whoever
needs one installs it in the Sandbox's home.

The image runs `npm ci --ignore-scripts` on the lockfile, then `npm rebuild` for exactly two
packages: Claude Code and OpenCode ship a placeholder `bin` that their postinstall replaces with the
binary of their platform package (an optional dependency, already in the lockfile and checked by
its hash); neither downloads anything. Grok's postinstall only copies its binary into the installing
user's `~/.grok`, and its `bin` runs the locked binary without it; protobufjs's only prints a
version warning; @google/genai's (a dependency of Pi; 2.21.0) has only a `preinstall` that echoes «no-op»
and a `prepare` npm never runs for a registry package; Codex and Pi have none. So none of the five
packages the lockfile marks `hasInstallScript` fetches anything at build time.
`clis/package.json` says the same as npm's `allowScripts` policy (Claude Code and OpenCode
allowed, the other three denied), which npm 12 requires for the rebuild to run their scripts; npm
refuses `--allow-scripts` on a project's `rebuild` (`EALLOWSCRIPTS`). Only `Containerfile`,
`clis/package.json` and `clis/package-lock.json` go into the build context (and the release
archive), so nothing else left in that directory (a stray `clis/node_modules`, an `.npmrc`) ends up in
a layer.

To bump: Node, its `ARG` and this table. A CLI, its version in `clis/package.json`, then in that
directory `npm install --package-lock-only --ignore-scripts` (with the repository's Node), check
whether its install scripts changed (`npm view <pkg>@<version> scripts`, for every package the
new lockfile marks `hasInstallScript`), update `allowScripts`, the paragraph above and this table,
and rebuild.

**Building.** `t3 sandbox image build` on the Hub's machine, or **Build image** in Settings →
Environments («Sandbox image», the Owner's), builds it with the Hub's rootless Podman, one build at
a time ([SandboxImage](../../apps/server/src/sandboxes/SandboxImage.ts)). With the Hub running, the
command asks it as the shell (`POST /api/sandboxes/image/build`) and prints the build's output as
Settings shows it (`GET /api/sandboxes/image?after=<lines>`: only the lines after the ones a client
has). Output lines split on carriage returns and newlines, each cut at 2 KiB; the Hub keeps the last 400 lines and
at most 256 KiB. With no Hub running the command builds in its own process and records the build
itself. One build at a time: claimed in one step, so two requests never both build (the other gets
409). The status reads `podman info` until it says rootless Podman is here (then never again); a
«cannot build» answer stands 5 seconds (polls share one check), so a timeout or a Podman set up later
is not kept. It reads the image at most every 5 seconds (again after
each build), and every Sandbox's version and busy state in one query. Every build is audited on
the Hub machine (`environment:hub-machine`), a build the Hub stopped during included. The build is the Hub's: a client that stops following
it does not stop it. It is plain `podman build` (`--file`, `--tag`, `--build-arg`), so Podman 3.4,
which has no BuildKit, builds it.

The server goes in **from the Hub itself**, so the image always has the Hub's version:

- A `t3` release (a single executable) copies the tree it runs from: the executable, its client and
  its runtime `node_modules`. The release archive carries `sandbox-image/` for this.
- A Hub run from a checkout (source or `dist`) runs
  [stage-sandbox-server.ts](../../scripts/stage-sandbox-server.ts) into the build context, the
  Hub's own 0700 `mkdtemp` (it refuses a directory that does not exist, and never makes or
  replaces one at a path): `vp pack` (never into `apps/server/dist`), and the runtime externals for this Linux, staged as the release stages
  them (pnpm, with the repository's patches). It adds the dev Replay agent where the bundle looks
  for it, so the Sandboxes of a dev Hub (`--dev-url`) offer «Replay (dev)». It runs with a minimal
  environment (HOME, USER, locale, TMPDIR and XDG dirs; the proxy and CA settings `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`; and the
  package managers' own `npm_config_*` and `PNPM_*`; no provider keys, tokens or build settings),
  the Hub's Node first on PATH and, in WSL, without the Windows directories the login shell adds
  (their `pnpm` cannot run).

Before the build, everything under the context is made readable by all (directories and
executables searchable), whatever umask made it: the image keeps these modes and the Sandbox runs as
a plain user. The context directory itself stays 0700. The context is `Containerfile`, `server/` (to `/opt/t3/app`), `modules/` (its `node_modules`, a layer
of its own, so a new server rebuilds little) and `extras/` (to `/opt/t3`). The build fails without
rootless Podman, or when this `t3` is neither a release nor a checkout.

**Versions.** A build is `<Hub version>-<UTC time>` (`0.1.7-20261107143509`), which the Containerfile
puts in the label `io.t3code.image-version` (a layer of its own, so every build is a new image).
It is tagged as the configured image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`) and as `<repository>:<version>`. After a build, older builds
of that repository lose their version tag; one that a running container uses stays until the next.
Each Sandbox records the version it started with; the Owner's view shows them and the newest.

**Updating.**

- A stopped Sandbox runs the newest build from its next start; nothing else is needed.
- A running one moves only when the Owner asks (**Update** beside it in «Sandbox image»,
  `POST /api/sandboxes/image/update`): the Hub stops it and starts it again (`sandbox.stop` and
  `sandbox.start` via `update`), under its lock and marked stopping as an idle stop is, so work that
  arrives meanwhile waits and then runs on the new image.
- Never mid-turn, checked before and again under its lock with it marked stopping (so work arriving
  after waits for the restart): refused with why when a turn runs on it, as its connection reports
  turns (`EnvironmentDemand.turnStarted`, from each `provider.startTurn` until its `turn.terminal`
  or its session ends) or the projection has a run in progress, «A turn is in progress on it
  (1 Thread). Update it once its turns end.»; or when a User sent it work in the last 10 seconds
  whose turn has not reported in, «Work was just sent to it. Update it once that work has ended.»;
  and while it starts or stops. Only dispatched work claims it (`EnvironmentDemand.claim`, scoped
  to the dispatch of each machine-decided command): each dispatch holds its own claim while it runs,
  which then stands until a turn reports in or 10 seconds pass (lapsed ones are dropped whenever
  claims are read). A turn never takes a claim still held, whatever work started it; previews,
  files and terminals never claim it. A
  `provider.startTurn` that fails, and a session that is lost, end their turns too. The Owner's view
  shows a claimed Sandbox as busy.
- Never into a start that cannot succeed: with no newest image (the tag names none, or one the Hub
  did not build) it is refused, «The newest image is missing», and keeps running. Already on the
  newest image it answers `up-to-date`; not running, `next-start`.
- Audited as `sandbox.image.update`. A build: `via` (`settings`, `cli`), `outcome` (`built`,
  `failed`), `version` or `reason`, on the Hub machine. A move: `via: restart`, `from`, `version` and
  `outcome`, on the Sandbox.
- Only the Owner (signed in, enabled) or the Hub's shell sees or does any of this; anyone else, an
  Admin of the Sandbox's Organization included, gets 403 «Only the Owner manages the Sandbox image.».

**Dedicated machines** run their Sandbox from the same image, built on that machine: `t3 join
--dedicated` refuses until `T3CODE_SANDBOX_IMAGE` (default `localhost/t3code-sandbox:<version>`)
exists there and says to run `t3 sandbox image build`. On a joined machine that command always
builds in its own process (its server answers only `/health`, and the audit log is the Hub's), with
the same tags and versions; the machine's Sandbox runs it from its next start. A machine whose
`t3 serve` found no image waits for one, reporting `restarting` with why (Podman asked again every
15 seconds, `awaitDedicatedRuntime`; a failed `podman info` then is waited out too), and starts
its Sandbox once it is built, without a restart.

**Provider logins** in the Sandbox's home (`~/.claude`, `~/.codex`, …) are no longer used by Hub
turns (spec 4 ticket 06): Claude Code, Codex, OpenCode and Pi run on the Hub's AI gateway with a
provider home of the Thread's own (`<home>/userdata/provider-homes/<thread>/<driver>`), and a Sandbox
turn without an allowed AI account fails with «No AI account is allowed to you in this Space»
instead of falling back to a login. See [ai-gateway.md](./ai-gateway.md), «Agents through the
gateway».

**Tests.** The testkit runs Sandboxes from no image; a runtime that reports versions
(`sandboxImageVersion`) and a fake builder (`sandboxImageBuilder`) test the policy
([HubWithEnvironments.sandboxImage.test.ts](../../apps/server/src/environments/HubWithEnvironments.sandboxImage.test.ts)).
[SandboxImage.build.test.ts](../../apps/server/src/sandboxes/SandboxImage.build.test.ts) builds the
real image from the checkout (`localhost/t3code-sandbox-test:latest`, kept for its layers), starts a
Sandbox from it whose own `t3 serve` connects through the socket, and moves it to another build
keeping its logins. It is slow, so it runs only with rootless Podman and
`T3CODE_TEST_SANDBOX_IMAGE_BUILD=1`.

## Lifecycle: started for work, stopped when idle

`sandboxes.status` is `stopped`, `starting`, `running` or `failed` (with `last_error`). The
Environments list shows a Sandbox `starting` from the moment its start begins until it is ready,
`failed` with `startError` when its last start failed, online once running and connected, and
`stopped` otherwise. Clients read it from the shared Environments list (polled every second while
anything is starting, or while a send waits on a Sandbox): the Thread says «Starting the
Sandbox…», or «The Sandbox could not start» with the reason and «Try again»
(`POST /api/environments/start`, for Users who may run Threads in its Space, disabled while the
request is out).

**A start belongs to the Hub.** [Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts) runs one
supervised start per Space in its own scope: asking again joins it, and whoever asked only waits
for it, with a timeout of their own, so a caller that gives up never leaves it half-started. The
per-Space lock is held only to make it and mark it `starting`, to mark it `running`, and to stop
it; never across the boot. Every start ends `running` or `failed`; a server that did not become
ready in time (or at all) is stopped first, and the runtime waits for it to end, so nothing runs
that the Hub does not track. Each start is audited `sandbox.start` with `via` (`demand`, `retry`),
`outcome` (`started`, `failed`) and the trimmed `reason`, naming the User whose action caused it.

Placing a Thread never starts it. Work goes through
[EnvironmentDemand](../../apps/server/src/environment/EnvironmentDemand.ts), which only the
Sandboxes provide:

- A User's own action starts it and waits (`awaitStarted`, `explicit`): commands the Orchestrator
  decides with the machine (`message.dispatch`, rollback, provider switch, starting a queued run, a
  move onto it), and workspace calls that act (opening or typing in a terminal, writing a file,
  opening a preview). A failed start refuses the command with `ThreadEnvironmentUnavailableError`
  (`sandbox-failed`). A guest's message does not start it.
- Reads (listings, search, reading files, preview and terminal lists) on a Sandbox that is not
  running answer «Sandbox stopped» at once (`ready`), start nothing and count as no use, so a
  client that polls never keeps a Sandbox up.
- Machine-bound effects wait unclaimed, spending no attempt; when the worker finds nothing to claim
  it asks the Sandboxes their work waits for to start (`EffectOutbox.environmentsAwaited`, cleanup
  effects aside).
- A `failed` Sandbox starts again only for a User: «Try again», or their own action after a ten
  second backoff. Waiting work never restarts it.

A running Sandbox stops after `T3CODE_SANDBOX_IDLE_SECONDS` (30 minutes by default) with no run in
progress on it (a projection that cannot be read counts as busy), nothing holding it, and no use
since (`sandbox.stop` via `idle`). Use is `EnvironmentDemand.touch` (every action and start) and
`EnvironmentDemand.hold`, keyed per holder, for as long as something stays open (an attached
terminal stream; previews served through the Hub call the same). Each Space is checked on its own.
The stop marks the Sandbox stopping under its lock before checking again, so work that arrives
meanwhile waits for the stop to end and then starts it again. Only the wait between checks reads
`SandboxLifecyclePolicy`'s clock (a TestClock in tests); the policy also sets the start timeout.

A server that exits by itself while running is `stopped` with why, and its socket is closed at
once, so its Threads are away as on any machine that dropped (spec 2: «paused, environment
offline»). If a run was in progress on it, the Hub starts it again: the hello lists no sessions,
so the turn ends interrupted and its history stays. Every such exit counts: more than three in ten
minutes leaves it `failed` until a User starts it. A start under way reports its own failure; an
exit never overwrites it.

## Moving a Project to another Space

Spec 1's `project.move` (the Project and every Thread in it) adds what Sandboxes need
([ProjectService](../../apps/server/src/project/ProjectService.ts) `move`/`movePlan`,
[ProjectMoveThreads](../../apps/server/src/orchestration-v2/ProjectMoveThreads.ts)).

- **One rule:** `spaceRefusalOf(environment, space)` / `servesSpace`
  ([sandboxSpace](../../apps/server/src/sandboxes/sandboxSpace.ts)). The Hub machine serves every
  Space. A removed machine (`revoked`), or one the Hub has no row for (`unknown-machine`), none. A
  Sandbox or dedicated machine only its own Space (`other-space`); a dedicated machine between
  dedications, none (`undedicated`). A personal machine while its owner, enabled, is the Owner or
  in that Space with any Role, Guests included (`owner-left`). The executor's check before a turn
  uses it, with one message per refusal.
- **The plan first.** `POST /api/projects/move-plan {projectId, spaceId}` answers `running`
  (Threads the move stops), `needsEnvironment` (Threads whose Active environment does not serve
  the destination) and `vaultsLost` (spec 5 ticket 07: the Vaults its Threads stop receiving,
  `EffectiveVaults.projectMove`; see secrets.md, «Losing reach»). `POST /api/projects/move` moves and answers `{ project, released }`, the
  Threads it actually released. Both (DoorRules) follow the rule of `projects.mutate`, checked as
  the move is (`project.move` on both Spaces; a hidden Project answers like a missing one), and run
  once the Hub is ready, as `projects.mutate` does.
- **Stopping.** A running Thread (an unfinished run, an open request, a background command or
  delegated task, or a move between machines not switched yet) refuses the move with 409 unless
  `stopThreads: true`, which the dialog sends once the mover saw them. Then, with the Project marked
  moving (nothing new starts), each such Thread's move is cancelled and its turn stopped
  (`thread.stop` on a reachable machine; one that is away, or a Thread with no Environment, ends
  on the Hub at once). The wait follows the Threads' events; after 15 seconds whatever still runs
  ends on the Hub as Force stop does. Each is checked again under its lock; one still running
  refuses the move with nothing moved, and it can be tried again. `ProjectMoveHooks` is one per
  server (provided in `server.ts`) and a declared requirement of the orchestration, so the Project
  service always reaches it; without one (a Project service alone) a running Thread refuses.
- **Releasing, durably.** In the transaction that gives a Thread the new Space, a Thread whose
  machine does not serve it gets `activeEnvironmentId: null` («needs an environment»), its live
  sessions are recorded detached, and a row in `thread_environment_releases` (migration 109) names
  the machine and every session the Thread had there. `drainReleases` then cuts that machine off,
  out of the Thread's lock: its events, attachment reads, terminals and preview streams for the
  Thread are decided anew (`RemoteEnvironments.threadMoved` ends each workspace stream, preview
  relays included, tagged with a Thread no longer on that machine), its MCP credential is revoked,
  and its sessions there are detached (`provider.detach`) and dropped; only then is the row
  deleted. Each move drains its Project's Threads' rows, and the Hub drains every row as it starts,
  so a release cut short is finished. Threads on the Hub machine, or on a machine that serves the
  destination, stay. A preferred Environment that does not serve the destination is cleared.
- **The Hub repository.** The git route checks the Project's Space on every request, so the old
  Space's Sandbox and dedicated machines get 403 for the Project, its `refs/t3/project/` copy and
  its Threads' refs. Each request holds the Project's access (`SpaceDirectory.holdProjectAccess`,
  checked against the move count and registered in one synchronous step). Once a move's checks
  passed and it goes ahead (`projectAccessEnds`: never for a refused move or a rerun that changes
  nothing), every held request ends (a fetch or push mid-stream fails, never completes short);
  while the Project moves, or after a move went ahead since the request was checked, the route
  answers 503 and the machine is checked anew when it retries.
- **Previews** end with the Thread leaving the machine (checked on every request; live sockets on
  the access change the move publishes; a response in flight by the stream cut). **MCP:** besides
  the revocation, a credential scoped to the old Space (`spaceLimit`) neither sees nor acts on a
  Thread now in another Space.
- **Afterwards** the dialog offers «Move all to <destination> Sandbox» for the Threads the move
  released, sending spec 2's `thread.move` (stopping a running turn) as the mover; one the mover may
  not move is listed with why. A 409 (a Thread started since the plan) shows the plan again, to
  confirm with «Stop Threads and move». Moving the Project back gives no machine back by itself.
- **Not undone:** what the old machine already has on disk (its checkout of the Project) stays in
  its home; it can no longer fetch, push or run anything for the Project.

## Previews through the Hub

A dev server started in a Thread's terminal or by its agent listens on its machine's loopback,
which nobody else reaches: a Sandbox's container, a dedicated machine, a laptop behind NAT. The Hub
serves it at an address of its own, `/preview/<token>/`, and relays each request to that port over
the Environment channel ([HubPreviews](../../apps/server/src/preview/HubPreviews.ts),
[the route](../../apps/server/src/preview/hubPreviewRoute.ts)). It works the same for a Sandbox and
any joined machine.

- **Never the Hub itself:** a Thread on the Hub machine gets no address (its loopback is the Hub's),
  nor does any port the Hub answers on: its configured port, the port its HTTP server listens on,
  the dev web server's. With the process runtime (`T3CODE_SANDBOX_RUNTIME=process`, whose Sandboxes
  share the Hub's loopback) neither does any port the Hub process listens on (read from `/proc`).
  The dev server sees `Host: localhost:<port>` and `Origin: http://localhost:<port>`, never the
  Hub's own credentials.
- **Asking:** `preview.proxyUrl { threadId, port }` (the client's «Open preview» in the Thread
  details, Preview section) answers `{ path, url?, expiresAt }`. It follows the rule of the other
  preview RPCs (`work`: the Thread's own User) and `environment.use`, and binds the address to the
  session's User (a principal without one acts as the Owner, as everywhere in spec 1), that session,
  the Thread, its Active environment and the port. Asked again it gives the same address while that
  lasts. `url` is absolute only with `T3CODE_PUBLIC_URL`; the client otherwise puts `path` on the
  Hub address it is connected to.
- **The address alone opens nothing.** Every request must carry the User's Hub session or the
  address's preview cookie. A browser opening the page (`Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`) must carry the Hub session, which top-level navigations always send;
  the answer then sets `t3_preview` (HttpOnly, Secure, SameSite=None, `Path=/preview/<token>/`,
  bound to the address, its User and session), which the page's own requests and WebSockets carry
  from its opaque origin. A leaked link fetched without either answers 401; another User's Hub
  session, 404.
- **Every request checks again:** the session is still live, the User still works the Thread
  (`SpaceVisibility.claimWork`: a Member of another Space, or another Member of the same Space, is
  refused), the Thread is still on that Environment (read on every request: a move ends the address
  at once) and the User may still use it. The rest is answered from the last 2 seconds unless a
  Space or Membership changed. A live WebSocket is checked again on each access change and every
  30 seconds, and closes once the check fails or its session ends. A refusal is a 404 like an
  unknown address. A machine away answers 503 «Environment offline: <name> is not connected.»; a
  port with nothing listening, 502; a dev server that does not answer in time, 504; a machine whose
  T3 predates these operations, 502 asking to update it (executor contract 8, which machines now
  report in their hello).
- **Addresses:** in memory, so a Hub restart ends them all (the client asks again). One expires
  after an hour unused; a User keeps at most 32, and past that their least recently used goes,
  never another User's. A session that ends takes its addresses with it.
- **Origin:** a path on the Hub's own origin would let the page's scripts call the Hub's API with
  the User's cookies. The Hub serves every response with `Content-Security-Policy: sandbox …`
  without `allow-same-origin`, so the page runs in an opaque origin: it cannot read or use the
  Hub's cookies, storage or API. Nothing the dev server answers sets or clears state on the Hub's
  origin (`Set-Cookie`, `Clear-Site-Data`, `Strict-Transport-Security` are dropped). Never sent on:
  `Cookie`, `Authorization`, `Proxy-Authorization`, `Expect` and every client address header
  (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, …).
  `CONNECT`, `TRACE` and `TRACK` answer 501. `Referrer-Policy: no-referrer` keeps the token out of
  other sites' logs. Redirects to the dev server itself stay under the address.
- **Trade-off:** the sandboxed page has no cookies or `localStorage` of its own; root-absolute URLs
  (`/src/main.ts`) leave the address, so a dev server must use relative URLs or a base path (`vite
  --base /preview/<token>/`); and requests the page makes in CORS mode with default credentials
  (`fetch()`, module scripts) send no cookie from an opaque origin, so they are refused. Classic
  subresources (`<script src>`, `<img>`, `<link>`), forms and WebSockets work. The preview cookie
  needs a secure context (HTTPS, or `localhost`). A wildcard subdomain per preview
  lifts all of this: see [Previews on their own origin](#previews-on-their-own-origin).
- **Proxies:** the route sits behind the same client admission as every other one
  (`T3CODE_TRUSTED_PROXIES` decides which forwarded addresses and schemes count) and needs nothing
  of the public URL beyond the absolute `url`.
- **On the wire:** `preview.proxyHttp` and `preview.proxySocket` are workspace streams (spec 2's
  `workspace.stream`): a response's head, then its body in base64 chunks of up to 64 KiB; a
  socket's open (with the subprotocol the dev server chose), messages and close.
  `preview.proxySocketSend` carries the browser's messages in order. The Hub holds at most 512
  chunks of a response (1,024 messages of a socket) for a reader that has not taken them, and the
  machine at most 1,024 socket messages; past that the stream fails, so a slow client never holds
  the machine's socket and a cut response never reads as complete. Request bodies are capped at
  8 MiB. The machine gives a dev server 30 seconds to answer a request's head and 15 to finish a
  WebSocket handshake; the Hub waits 45 for the machine.
- **A stopped Sandbox starts for it.** Opening a preview is a User's own action: asking for an
  address, and every request under it that finds the Sandbox not running, start it and wait
  (`EnvironmentDemand.awaitStarted`, `explicit`), so a page opens on a stopped Sandbox instead of
  answering 503; a start that fails answers 503 with why. Each request served is use (`touch`), and
  an open preview WebSocket holds the Sandbox (`hold`) until it closes, so it does not stop while
  the page is live. Nothing read-only starts it.

## Previews on their own origin

With `T3CODE_PREVIEW_ORIGIN` set to a wildcard origin, `https://*.<zone>` (spec 3 ticket 15), each
preview address is served at an origin of its own, `https://<id>.<zone>`, where the page runs as
itself: its cookies, `localStorage`, `fetch()`, ES modules and Vite's HMR socket work, with no
sandbox and no base path. Without the setting nothing changes: the sandboxed path above, and a
startup line saying so. Parsing and matching live in
[PreviewOrigin](../../apps/server/src/preview/PreviewOrigin.ts); the relay in
[the route](../../apps/server/src/preview/hubPreviewRoute.ts).

- **The setting.** `https://` (plain `http://` only under `localhost`, which browsers treat as a
  secure context), a zone of at least two labels, an optional port. The Hub's own host
  (`T3CODE_PUBLIC_URL`, the bind host) must not fall inside the zone, or the server refuses to
  start. It needs wildcard DNS and a wildcard certificate, and a proxy that keeps `Host` (or sends
  `X-Forwarded-Host` from a trusted proxy). Recommended: a registrable domain apart from the Hub's
  (previews at `*.example-preview.net` for a Hub at `hub.example.com`), so the browser treats them
  as cross-site and the Hub's `SameSite=Lax` cookie never travels with their requests. A zone under
  the Hub's own domain works, guarded by the rules below.
- **One origin per address.** An address (`HubPreviews.address`: User, session, Thread, Active
  environment, port) gets `originId`, 256 random bits in lower-case base32 (a 52-letter DNS label),
  never reused and never shared between Users, Spaces or sessions. Its path on the Hub,
  `/preview/<token>/`, stays the stable link the clients open (contract unchanged).
- **The handoff.** On the Hub's origin the path relays nothing any more. A top-level navigation
  carrying its User's Hub session (`resolve`, the ticket 07 rule) answers `303` to
  `https://<id>.<zone>/__t3_preview/handoff?code=…&path=…` with `Referrer-Policy: no-referrer`;
  anything else is `404` (signed out: `401`). The code is 256 random bits, lasts 60 seconds, is
  spent on its first presentation and counts only on its own origin. Spending it sets
  `__Host-t3_preview=<the address's pass>; Path=/; HttpOnly; Secure; SameSite=Lax` (host-only, so
  no other preview or the Hub receives it, and no sibling can shadow it) and answers `303` to the
  path, which must be local (`/…`, never `//…`).
- **Every request on the origin** (`resolveOrigin`) needs that cookie, then runs the same check
  as ticket 07 with the same 2-second cache and Space revision; WebSockets and SSE go through the
  same check, and a live socket closes on `whileAllowed` as before. The Hub's own session never
  counts there (it is host-only and never sent; if a client sends it anyway it is ignored): no
  cookie or a wrong one is `401` «Open this preview from T3 Code», a refusal `404`. Revocation is
  the address's: its session ending (sign-out, revoking, removing or disabling the User), the
  Thread moving, losing the Thread or the Space, or the address expiring (an hour unused) ends the
  origin at once; a dev server that stops answers `502`.
- **What crosses.** The dev server still sees `Host: localhost:<port>` and `Origin:
  http://localhost:<port>`, never the Hub's credentials or client addresses. On its own origin the
  page's own cookies (`t3_session…` ones included: the Hub's are host-only and never reach a
  preview host, so these are a previewed app's, T3 Code's own among them) and its own
  `Authorization` pass both ways, minus `__Host-t3_preview` alone and an `Authorization` whose scheme
  a browser attaches by itself (`Basic`, `Digest`, `Negotiate`, `NTLM`: HTTP auth, proxy or SSO
  credentials for other services, which the dev server, running repo code, must not see). The dev server's `Set-Cookie`
  loses any `Domain` (host-only, so no cookie reaches the Hub's domain or a sibling preview), and
  one naming the preview's cookie is dropped. Its own `Content-Security-Policy`, `Referrer-Policy`
  and service workers stand. `Clear-Site-Data` is dropped on every origin (browsers apply
  `"cookies"` to the whole registrable domain: it would sign the User out of the Hub and of other
  previews), as are `Strict-Transport-Security`, `Public-Key-Pins` and `Alt-Svc`. A redirect to the
  dev server itself lands on the preview's origin.
- **Handoffs pending** are capped per User (16; past that their own oldest go, never another
  User's) and indexed by address, so ending one drops its codes at once.
- **Nothing in the zone reaches the Hub.** `previewOriginLayer`, a global middleware inside client
  admission (so a trusted proxy's forwarded host counts) and outside every other middleware and
  route, takes every request whose host is under the zone: exactly `<id>.<zone>` on the pattern's
  scheme and port is that preview; any other host there (a made-up id, a deeper name, another
  port) answers `404`. So the Hub's API, sign-in, `/ws`, MCP, static files, CORS preflights and
  the server browser's `/api/preview-stream` are never served on a preview's host (Host header
  confusion), and a wildcard cannot match the Hub's own host.
- **The Hub's cookie doors.** A subdomain of the Hub's own domain is same-site, so `SameSite`
  does not keep the Hub's cookie from its requests. `crossesFromPreviewOrigin` is the one rule: a
  request whose `Origin` or `Referer` is in the zone came from a preview page, and so does one that
  hides both (`Origin: null` with `Sec-Fetch-Site: same-site` or `cross-site`, as a `no-cors` fetch
  with `referrerPolicy: "no-referrer"` sends). Every Hub cookie
  (session, legacy, dev token, guest) is read in one place, `readHubCookie`: none for such a
  request, `__Host-<name>` first, and a bare name only where no preview could have planted it
  (previews off, or plain HTTP). So EnvironmentAuth (the HTTP API, `/ws`, OTLP, the device hub, the
  preview stream, passkey ceremonies), the guest routes and the preview route never see a cookie a
  preview page sent, and nothing reads the browser's existing session to replace or revoke it for
  one. A preview page signs nobody in: every sign-in (`startUserBrowserSession`: password, TOTP,
  recovery code, passkey, reset, Owner registration, Invitations) and pairing redemption refuse it
  before issuing anything, and no door sets or clears a Hub or guest cookie for it (login CSRF,
  forced sign-out). A guest's POSTs (redeem, messages) also need the Hub's own Origin, judged as
  EnvironmentAuth judges a cookie's (the browser's `Sec-Fetch-Site: same-origin`, or the exact
  request origin, `T3CODE_PUBLIC_URL` or the dev web origin; never `null` or none), and a redemption a JSON body, which no
  `no-cors` request can carry. Not caught: a same-site embed naming neither header (an `<img>` with
  `referrerpolicy="no-referrer"`): such a GET changes nothing on the Hub and its answer is unreadable
  there, while the dev web app's legitimate same-site images keep working. With the setting on, the
  Hub's HTML is served with `frame-ancestors 'self'`, so a preview cannot frame it. `DoorRules`
  (`AMBIENT_COOKIE_RULES`) names, for every raw route, middleware and the HTTP API, whether it takes
  a cookie and how a preview origin is refused; its test fails on an undeclared door, on any cookie
  read outside `readHubCookie` (bar the preview route's own preview cookies), and on a module that
  sets a Hub cookie without asking `fromPreviewOrigin`. The Environment socket, git routes and MCP
  take no cookie.
- **Cookie tossing.** A preview page can set a cookie with `Domain=<the Hub's domain>` for the
  Hub. Over HTTPS the Hub's session and dev-token cookies are `__Host-<name>`, and guest cookies
  always are (on `/`, so they can be; a guest's bare cookie from before still counts off a preview
  page and moves to `__Host-` on the next session check, since a planted one could only carry a
  token the Hub gave some guest): browsers accept those only from the Hub's own host,
  `Secure`, on `/`, without `Domain`; see
  [environment-auth](environment-auth.md#the-session-cookie). Each sets alongside an expiry of its
  bare name, so sessions and guests from before move over. With the setting on, an HTTPS request's
  bare-named cookie counts for nothing, so a tossed one signs nobody in.
- **Plain HTTP under `localhost`** (`http://*.localhost:<port>`) is for development: browsers
  treat it as secure, so `__Host-` cookies work, but the Hub's own cookie over plain HTTP keeps its
  bare name.

## The server browser's profiles

The Hub's own Chromium (`ServerBrowser`: tabs a client streams over `/api/preview-stream`, and the
MCP `preview_*` tools) keeps persistent profiles: cookies, site storage, sign-ins. They are per
User and per Space, so one User's sign-in in a preview never reaches another User's preview of the
same app, nor the same User's preview in another Space.

- **One rule, every door.** A tab's profile is decided once, when the tab is set up
  (`PreviewProfiles.ownerFor`), and kept on the tab: in the Thread's Space (`spaceOf`), the profile
  of the person who opened it (WS `preview.open`, which `PreviewManager.openerOf` remembers), so
  the Owner or anyone else working another User's Thread browses as themselves and their sign-ins
  stay in their own profile; an agent's tab (MCP `preview_open`) uses the Thread's effective owner's
  (its own, else its root's, else the Owner's: the User `claimWork` lets work it), looked up once
  per open; a popup its opener tab's. `/api/preview-stream` attaches to tabs already set up. A
  Thread with no row (a draft) gets a throwaway context of its own, as incognito tabs and an agent's
  tabs without a named profile always do; `ServerBrowserContexts.contextFor` refuses to open a
  persistent profile without an owner. The tab's profile User also gives its catalog and recording
  frame rate.
- **Folders.** `<state>/server-browser/user-profiles/<user>/<space>/<profile>/`, each name the first
  128 bits of HMAC-SHA256 under a key in the Installation's secret store (`preview-profile-names`),
  with the level in the hashed text. Names neither collide (also on case-insensitive disks) nor
  tell whose they are; each Space folder holds an `owner.json` saying whose it is, for the sweeps.
- **Clearing.** `preview.clearProfile` clears the caller's own profile of that id in every Space
  they have it, never another User's. Clearing every User's profiles is a separate RPC,
  `preview.clearAllProfiles`, the Owner's alone (an Installation RPC). `preview.reportProfiles`
  records the catalog (names, default, recording frame rate) of the reporting client's own User;
  a tab uses its profile User's catalog; an agent's `preview_open`/`preview_status` the Thread
  owner's, or on a draft the User the agent acts as (`actingUserId`, from its credential).
- **Leaving.** On a Membership or status change (`SpaceDirectory.subscribeMembershipChanges`,
  `subscribeUserStatusChanges`), and at startup and hourly, a User's Space folders go when they no
  longer see that Space, or are removed (a disabled User keeps theirs), and so does any folder named
  under another key or not saying whose it is. Open contexts close first, and on such a change
  every open tab whose profile its User may no longer use closes, throwaway ones too. Once there
  is an Owner, the profiles of no User (from before) go at startup. Folder work runs in one queue
  (`ServerBrowserContexts`): a profile's Space folder gets its `owner.json` (written whole) before
  the profile folder exists, and the reconcile reads and removes in one step, so it never takes a
  profile that is opening.
- **Bounds.** Chromium's HTTP cache is capped at 64 MB per profile (`--disk-cache-size`). Hourly
  (first an hour after startup), a closed profile nobody opened for 30 days goes, and one over
  512 MB loses its caches, then everything if that is not enough. Sizes are read outside the folder
  queue, so opening a profile never waits on them; each deletion takes the queue briefly, only for
  a profile still closed then.
- **Before.** Every User shared `server-browser/profiles/<profile id>/`; whose its sign-ins were
  cannot be told, so it is deleted at startup. Users sign in again in their own profiles.

## Dedicated machines

A machine the Owner gave to one Organization (spec 3 ticket 09). On the Hub it is an External
environment like any joined machine, `kind = 'external'` with `mode = 'dedicated'`, the
Organization's `space_id` and **no owner** (migration 106): it is the Installation's, so turning a
User off never takes it. Who dedicated it is in `credential_issued_by` and the audit log only. On
the machine its server runs no work itself but one Sandbox for the Space it serves.

**On the Hub.**

- **Registering.** `t3 join --dedicated <Space>` sends the Space (name or id) as a suggestion only
  (`dedicatedSpace`). «Register this machine» offers the Owner alone every Organization not
  archived (`dedicatedSpaces`, the one asked for first) under **Used by**, preselected when it
  matched. Approving with `dedicatedSpaceId` asks `environment.dedicate` (the Owner, on the
  Installation) before the strong factor, and again with the Space (an Organization neither
  archived nor frozen) in the transaction that writes the row. The awaiting-confirmation and
  approved answers carry `dedicatedSpace`, so `t3 join` asks `Approved by Ada (ada) as a machine
  dedicated to Acme. Register it for Acme? [y/N]`. A machine takes only the mode it asked for
  (`joinModeRefusal`): a `--dedicated` join approved as personal, or a plain join approved as
  dedicated, registers nothing. The audit entry is `environment.register` with `mode`, `spaceId`
  and `via: "join"` (or `"ssh"`, see [Installing over SSH](#installing-over-ssh)).
- **Who.** The policy decides on its Space, as for a Sandbox (`decideSpaceBound` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)): seen by whoever sees the Space (the
  Owner sees every one), used by its Admins and Members (not Guests) for that Space's Threads only
  (`workSpaceId`), renamed and removed by the Owner only. With its Space deleted it stays the
  Installation's: the Owner still sees, renames and removes it, nothing runs there, and its
  credential is refused at connect (`space-missing`). Clients offer it only for that Space's
  Threads (`placeableEnvironments`) and as a preferred Environment only of its Space's Projects.
  Placement never picks it by default.
- **Its credential reaches its Space only.** `checkCredential` answers it with its `spaceId`, so
  the git route serves it its Space's repositories alone. The executor refuses work there for a
  Thread no longer in its Space, and **fails closed**: a Space it cannot read refuses the turn with
  `SpaceCheckUnavailableError` (retryable), never skips the check (`boundSpaceOf`). Its `t3 leave`
  is audited as the machine (`source: "cli"`, no User).
- **Only its Sandbox connects, with a credential of its own.** The machine's own credential (from
  `t3 join`) stays with its host and only asks the Hub (`/self`) or leaves: presented at connect
  or to the git route it is refused (`not-sandboxed`). Each answer to `/self` issues a new
  credential for the Sandbox, for the Space it serves then
  (`dedicated_sandbox_credentials`, migration 107, only its hashes); the one a reissue replaces
  stays valid until the new one is first used, for at most 10 minutes, so an answer lost on its way
  to the host breaks nothing; that is the one the container
  holds and the only one that connects as the machine or reaches its Space's repositories. A
  change of mode or Space (and removing the machine) drops it in the same transaction, so a copy an
  agent took from the container reaches nothing afterwards, and the old Space's server is refused
  before it could be welcomed for the new one. The socket also needs the hello to carry
  `sandbox: { runtime }` (checked again on the second credential check, after the socket is
  tracked). The host keeps its own credential under another secret
  (`dedicated-environment-credential`), so its own server run as a personal one (an older one, or
  `joined-hub.json` edited) finds none to present.
- **Changing mode or Space** (`POST /api/environments/mode`, **Change use** in Settings) is the
  Owner's, for joined machines only, to `personal` (the Owner's own) or `dedicated` (owned by
  nobody) to an Organization neither archived nor frozen. Active Threads on it refuse it with 409
  `EnvironmentModeChangeRefusedError`, naming them; archived ones do not block it and need an
  environment from then on (`released`), so unarchiving one never lands on a machine no longer
  its own. The dialog says the Space's work files on the machine will be deleted. It is audited as
  `environment.mode.change`, and after the commit the socket closes (`environment-mode-changed`).
- **The machine asks.** `POST /api/environments/self`, with its own credential, answers its mode
  and Space as the Hub has them now, and a dedicated one its Sandbox's new credential; a dedicated
  host follows that, never what it remembers. Its Space deleted, it answers `dedicated` with no
  Space (and no credential) until the Owner dedicates it elsewhere or makes it personal.

**On the machine.** `t3 join` writes `mode: "dedicated"` and `spaceId` into `joined-hub.json`,
after checking rootless Podman (only `T3CODE_SANDBOX_RUNTIME=process` skips that, for
development, with a warning that it isolates nothing). A dedicated machine's `t3 serve`
([DedicatedHost](../../apps/server/src/environments/DedicatedHost.ts)) serves `/health` as any
joined server, but connects nothing of its own:

- **One Sandbox per Space.** The Sandbox for Space S is `dedicated-<S>`, home
  `<base dir>-sandboxes/dedicated-<S>`, run through the runtime a Hub runs a Space's Sandbox with
  (`dedicatedRuntimeFromConfig`): Podman by default (rootless, with the Sandbox image), or the
  process runtime when asked for. The container rules are the ones above: keep-id, no
  capabilities, no new privileges, its own slirp4netns network without the host's loopback, only
  its home mounted read-write, its Sandbox credential and `joined-hub.json` written outside the home and
  mounted read-only, and the Hub reached only through the UNIX socket proxy
  (`/api/environment/connect`, `/api/git/…`, `/mcp`, `/api/ai/…`, 404 otherwise), which forwards to the Hub's
  own address (`https://`, with SNI for a host name; plain `http://` only for a Hub on that
  machine).
- **A home is never reused.** At start, and whenever its Sandbox's server ends, the host asks the
  Hub, and starts the Sandbox again with the credential that answer issued (the runtime's `create`
  replaces it in place). Another Space: it deletes the old Space's home (and container) and makes a
  new one. No Space (its Space deleted): it deletes the home and waits, asking every 10 seconds.
  Personal: it deletes the home, moves the credential back to the personal secret, writes its
  state as the Hub answered and serves as a personal machine from then on, without a restart.
  Every other `dedicated-*` home on disk (directories only, never the runtime's logs beside them)
  is deleted at start, so a change cut short leaves nothing.
- **The Sandbox's server serves only its Space.** Its state names the Space; welcomed as
  someone's personal machine or for another Space (`sandboxedServerRefuses`), it refuses and exits
  with code 78, which is how its host learns to ask; so does a Sandbox's server whose credential
  the Hub refuses (`credential-unknown`, `credential-revoked`, `space-missing`). A personal server whose credential the Hub
  refuses as `not-sandboxed` (dedicated on the Hub since) moves the credential to the dedicated
  secret, writes `mode: "dedicated"` and stops; restarted, it runs as above.
- **Its network.** A container reaches every address of its host but the loopback, and rootless
  Podman cannot firewall that. So, as a Hub runs Podman Sandboxes only when bound to loopback, a
  dedicated machine runs its Sandbox only when nothing of the host listens beyond loopback
  (`/proc/net/tcp*`, [hostExposure](../../apps/server/src/sandboxes/hostExposure.ts)), except its
  own `/health` port and the ports the Owner names in `T3CODE_DEDICATED_HOST_PORTS` (for example
  `22`). Otherwise `t3 status` names each `address:port` to bind to 127.0.0.1, and it runs
  nothing. Other machines of its network stay reachable, as from a Hub's Sandbox.
- **Lifecycle.** It starts and stops with the machine's server. When its server ends for any
  other reason it starts again after 1, 2, 4… seconds (at most 30); more than three ends in ten
  minutes leave it `failed` until `t3 serve` restarts. `t3 status` shows the Sandbox's state. There
  is no idle stop: the machine is the Space's anyway.
- **Limits.** The Hub sends the Space's effective Sandbox limits (its own values over the
  Installation's defaults, as for a Hub's Sandbox, so Settings shows the same for both; set on the
  Space's Sandbox or on the machine, see [Limits](#limits)) in the
  `/api/environments/self` answer (`limits`), which the host asks for at start and after each end
  of its Sandbox's server; it starts the Sandbox with them as `SandboxStartOptions`, capped at
  the CPUs and memory the machine has (`fitLimitsToHost`), so its Podman runtime passes what that
  machine enforces (`podmanLimitArgs`) and labels the rest, and a change applies on the next
  start. The disk limit is not enforced there: that is the Hub's own check, for its own
  Sandboxes.
- **Versions.** Upgrade the Hub and its dedicated machines together: neither side keeps
  compatibility with an older other (a host that gets no Sandbox credential from `/self` waits).

## Installing over SSH

The Owner adds a dedicated machine from Settings → Environments, **Add over SSH** (spec 3 ticket
10), instead of running `t3 join` on it. [SshInstall](../../apps/server/src/environments/sshInstall/SshInstall.ts)
runs it from the Hub's own process with [ssh2](https://github.com/mscdex/ssh2) (pure JavaScript,
no `ssh` binary: the key is never written to a file or put in an argument), in
[SshClient](../../apps/server/src/environments/sshInstall/SshClient.ts).

- **Who.** Every door is the Owner's alone: `SshInstall` asks `authorizeDedicate`
  (`environment.dedicate`, as dedicating a machine on «Register this machine») on start, confirm,
  cancel and the progress (`POST /api/environments/ssh/{start,confirm,cancel,status}`). There is
  no WS or MCP door. The machine's own call, `POST /api/environments/join/grant`, takes no session:
  only the run's grant, over HTTPS or loopback.
- **Input.** Host (a DNS name or an IP), port, user (a plain login name, never `root`: the work
  runs in rootless Podman), a private key with its passphrase (`RedactedFromValue` in the
  contract) or the SSH agent of the Hub's process (`SSH_AUTH_SOCK`, read once into
  `SshInstallPolicy`), the Organization, the machine's name (by default its IP address or its host
  name's first label, at most 64 characters) and the Hub's address as the machine reaches it (`https://`, or `http://` on
  loopback, as `t3 join`). The key is parsed before anything connects, with fixed messages.
- **Where it connects.** The host is resolved once (within 10 seconds) and the address pinned for
  the whole run (no DNS rebinding between steps). Every address is judged by its bytes, however it
  is written (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, `::ffff:127.0.0.1`, an IPv6 zone…). Refused: link-local addresses (169.254.0.0/16, fe80::/10, where
  cloud metadata lives), unspecified, multicast and broadcast ones, also as IPv4-mapped IPv6, and
  **the Hub's own machine**: loopback (127.0.0.0/8, `::1`) and every address of its own interfaces.
  A Space on the Hub's machine has its Sandbox already, and the Hub's own user would `t3 join` from
  the Hub's own home. `T3CODE_SSH_INSTALL_ALLOW_HUB_HOST=1` allows it, for development and the
  tests only (their SSH servers and containers are on the Hub's machine). Private networks and
  public addresses are allowed: an Owner's machines are there; the Owner is trusted, the checks
  stop a request from aiming the Hub at metadata services or at itself
  (`forbiddenSshAddress`, one rule).
- **Host key, trust on first use.** `start` connects, reads the host key and turns it down before
  any sign-in (no credential is offered), and the run waits in `awaiting-host-key` with
  `SHA256:…` as `ssh-keygen -lf` prints it, for 10 minutes; then it ends as cancelled, every step
  not run. Whatever stops `start` before the key is shown (an error, an interrupt) ends the run
  too, so nothing holds that address or the key. Closing the dialog cancels a run that has not
  finished, also one whose start answers after the close. `confirm` must send that same
  fingerprint; every later connection of the run accepts only it (a machine that changes its key
  between the two is refused before sign-in). On success the key is stored with the machine
  (`environment_ssh_hosts`, migration 110: host, port, user, algorithm, fingerprint, whether the
  key was kept); a later run to that address that shows another key fails at once, naming both,
  and one that shows the same key fails as **already installed**: both before any sign-in, until
  that machine is removed.
- **One run per machine.** A second run to the same host or resolved address and port while one
  waits or runs is refused with 409; one installed already is refused as above. Each run has its
  own grant, and `t3 join` on the machine refuses a machine already joined (by another name or
  address, or to another Hub), so two runs never register one machine twice.
- **The steps**, each a POSIX script run with `sh -c` (whatever the login shell), every value from
  the Owner single-quoted ([sshInstallScripts](../../apps/server/src/environments/sshInstall/sshInstallScripts.ts));
  host and user never reach a shell. Each runs in a **process group of its own** there
  (`stepCommand`: `setsid`, needing `setsid` and `flock` from util-linux), whose leader holds
  `~/.t3/ssh-install/step.lock` (`flock`, released by the kernel when it ends, so never stale) for
  the step's life and writes its group id and the step's random token in it; the step itself
  runs without the lock's descriptor, so a `t3 serve` it leaves behind does not hold it. While it
  is held, a new step (of any run, «Try again» too) refuses with the wrapper's own message ("its
  T3 Code step lock is held") and exit code 75: only both together mean busy, and a busy step did
  nothing there. A step that times out or is cancelled is stopped over a new channel of the same
  connection (`stopStepScript` with its token): it kills the group only when the lock is held and
  names that token, so never another step's or a group a stale file names; and it leaves a cancel
  marker for its token, so a step it reaches before the step took the lock does not begin (exit
  130), waiting up to 3 seconds for one taking it meanwhile. The check step makes
  `~/.t3/ssh-install` only for the lock and removes it again if it made it.
  1. _Check the system and Podman_: Linux, not root; with a systemd user manager, lingering (its
     service is a user unit, which would stop at logout): turned on with `loginctl enable-linger`
     (or with passwordless sudo) when allowed, otherwise it stops at once with the command to run as
     root. Then rootless Podman (`podman info`). Missing, it installs it with passwordless sudo
     (`apt-get`, `dnf`, `yum`, `zypper`); without one it stops with what to install (exit codes
     10-15 name the check). Nothing is installed before these checks pass.
  2. _Install T3 Code_: the runner of `@t3tools/ssh` (`buildRemoteT3RunnerScript`) for the Hub's
     own version, sent on standard input to `~/.t3/ssh-install/t3`: the release archive from
     `T3CODE_RELEASE_BASE_URL`, checked against `SHA256SUMS`, or in development a checkout's entry
     on the machine (`T3CODE_SSH_INSTALL_NODE_SCRIPT`). Then the Sandbox image
     (`t3 sandbox image build`) unless it is there, or the machine runs its work as a process
     (`T3CODE_SANDBOX_RUNTIME=process`, development only).
  3. _Register the machine_: `t3 join --dedicated <Space id> --name <name> --grant-on-stdin <Hub>`.
     The machine makes its credential as for any join; the grant comes on standard input.
  4. _Start its service_: `t3 service install` with a systemd user manager; without one (a
     container, a minimal VM) `t3 serve` under `nohup`, which says it will not survive a reboot.
     The step ends once the machine reached the Hub with its credential (`hasReachedHub`: asked
     `/self` or connected), within 2 minutes.
- **The grant.** 32 random bytes, made as step 3 starts and kept only as its SHA-256, for 5
  minutes, spent on first use whatever happens next, valid only while that run is registering and
  has registered nothing. Redeeming it registers the machine for the run's Space and name (never
  what the machine asks), approved by the Owner who started the run, through
  `EnvironmentRegistry.register` (which asks `environment.register` and `environment.dedicate`
  again in its transaction). The audit entry is `environment.register` with `mode: "dedicated"`,
  `spaceId`, `via: "ssh"` and `host`.
- **Failures and cancel.** A step that exits non-zero, times out or loses the connection stops the
  run there; the later steps never run. **Cancel** interrupts the run the same way, at any moment:
  it is recorded first, so a run whose steps have not begun stops before the first, and a run ends
  once (a later cancel or answer does not change how it ended). Either way the
  grant is dropped, a machine it registered is removed (`environment.remove` with `via: "ssh"`,
  its credential revoked), and, if the run registered it and the connection is up, the machine
  runs an undo (`t3 service uninstall` or killing the background `t3 serve`, then `t3 leave`); if the
  connection is gone the step's output says to run `t3 leave` there. A grant redeemed while the
  run is ending removes what it registered at once. The Hub does **not** remove T3 Code from the
  machine: from the install step on, the failed step's output ends with what is left there
  (`~/.t3/ssh-install`, and the Sandbox image if its build began) and the commands that remove it.
  «Try again» uses them, and a machine joined some other way may too.
- **The key and its secrets.** The key and passphrase live in the run's memory until it ends (or
  its host key is not confirmed in 10 minutes) and are dropped then. They never reach the machine,
  and every line of its output, and the run's error, pass a scrubber that removes, in one pass
  over the text as it came (the ranges first, then each run of them as one `[redacted]`), any
  piece of 12 characters or more of the key's body, the passphrase or the grant (wherever it
  shows, so a piece cut by a chunk or a column goes too), a passphrase of 4 to 11 characters
  whole, and a line with a PEM private-key marker. A passphrase under 4 characters is not
  scrubbed (it would redact common text; it is weak anyway). A line is scrubbed whole and only then
  cut to its length; a line longer than 8,000 characters without its end is shown without its
  last 11, which wait for what follows with what was found secret of them, so no piece of a secret
  escapes at that cut either. Errors from ssh2 become fixed
  messages (socket codes kept). Its spans and logs carry neither: a test reads them, and every
  file under the Hub's home, for the key and passphrase. The key goes from memory when the run
  ends, and so does the host key timer that held it. With «Keep the key for updates» the key (and passphrase) go to the
  Hub's secret store as `ssh-install-key-<environment id>`; removing the machine deletes that
  secret and its host record (`SshInstall.forget`, and `SshInstall.forgotten` once done). Removing
  it from Settings waits for that: if it fails the machine is removed all the same, and the answer
  (409) says its kept key or host record could not be deleted; every Hub start tries again for
  removed machines. A leftover host record never blocks a later install: only a machine not
  removed counts as installed. Nothing uses a kept key yet: a later «update over SSH» would.
- **Progress.** Each step keeps its last 300 lines (2,000 characters each); the dialog asks for
  the run every second while it runs. The Hub keeps the 20 newest finished runs in memory only.
