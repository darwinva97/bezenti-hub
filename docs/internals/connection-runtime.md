# Connection runtime

Web, the desktop renderer, and mobile share one connection owner per environment
in `packages/client-runtime`.

## Web and desktop hold one connection, the Hub's

A Thread runs on whichever Environment the Hub places it on, and its Active
environment arrives as a field of the Thread on the shell and detail streams
(`activeEnvironmentId`). The client never connects to the machine itself; a
joined machine serves only `/health` anyway. So web and desktop hold exactly one
connection: in a browser, the page's own server; on desktop, either its local
environment (this computer is the Hub) or, with that turned off, the one Hub it
signed in to ([singleHub](../../apps/web/src/connection/singleHub.ts) refuses a
second saved connection and never connects one past the first). The desktop's
other local backends (WSL) are not connected.

`ScopedThreadRef.environmentId` is that connection's id. It is never the Active
environment and does not change when a Thread moves. Thread routes are
`/$threadId`, resolved on the Hub connection; the older
`/$environmentId/$threadId` and `/threads/$environmentId/$threadId` links redirect
there. The Active environment's name and live status (online, reconnecting,
offline, and for a Sandbox stopped, starting or failed) come from the Hub's Environments list, polled every five seconds while a
view shows it. A machine whose socket dropped but was heard from in the last 20 s still shows
online (`ENVIRONMENT_RECONNECT_GRACE_MS`): behind a proxy such as Cloudflare's, long-lived sockets
drop routinely and the machine is back within seconds; it shows reconnecting until 90 s of
silence, then offline. A lent Sandbox connects on its own socket, so its status follows the same
rule and not its host's connection ([hub environments](../../packages/client-runtime/src/environment/hubEnvironments.ts),
shared by web and mobile with the move dialog's wording and steps). The same module holds what
every client shows for a machine: `environmentStatusLabel` («Running» for a Sandbox online, else
Online, Reconnecting, Offline, Stopped, Starting, Failed to start), `ENVIRONMENT_STATUS_TONES`
(green online; amber reconnecting or starting, which pulses; red failed; grey offline or stopped)
and `environmentUseDescription` (Runs the Hub, Sandbox of <Space>, Dedicated to <Space>, Your /
<User>'s personal machine), so web, desktop and mobile say and colour them alike.

## Mobile holds one connection too

Mobile connects only to its Hub, decided once and stored
([mobile single Hub](../../apps/mobile/src/connection/singleHub.ts)): later starts
connect the stored Hub without probing anything. A phone that saved several
connections before asks each once, in parallel and within a bounded time, and
stores the first that answers as a Hub; when none does, none connects and Settings
→ Environments asks the User to choose. Kept connections are never deleted
silently and never connect on their own: each can be removed, or, while there is
no Hub, chosen with «Use as my Hub». Only the Hub may register again, and after it
is removed the next Hub the User adds becomes the stored one. «Add a Hub» signs
in in the system browser; scanning or pasting pairing codes is gone, and only a
development build's dev link (mobile e2e runs) and the showcase capture still
pair. Thread rows and the Thread screen show the Active environment from the same
poll, and «Move to another Environment» opens a screen with the web dialog's
rules. Mobile file, search and write calls of a Thread pass its `threadId`, so
they act on the Thread's machine. Mobile routes and `ScopedThreadRef` still carry
the Hub connection's `environmentId`.

The rest of this page describes each connection, which the registry still keys by
environment. Platform code supplies storage, credentials, network
signals, and application lifecycle events. React views consume the runtime.
Keeping retries and session lifetime here prevents competing reconnect loops when
several views need the same environment.

## One transport retry owner

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with jittered exponential backoff, capped at
five minutes, that resets only after a connection stays up. Without jitter, every
client of a restarted server reconnects in the same second; with a short cap, a
client that can never connect retries all day. Offline states and authentication
failures wait for a wakeup instead of spending attempts on unchanged conditions.

Foregrounding, a network change, an explicit retry, and an offline report probe
the established session, and only a failed probe reconnects. Offline reports are
often wrong, for example for a loopback server. The OS can kill a suspended
socket without a close event, so a probe still unanswered after 500 ms asks the
host for its public descriptor over a fresh request, again each second until it
answers. If the host answers while the socket delivers no frame, the socket is
dead and is replaced, even while the network reports offline: at once on
loopback and LAN, and 2.5 seconds after the check starts elsewhere, where one
lost packet can stall a live socket. Without that evidence the probe deadline
decides: 3 seconds on loopback and LAN routes and after a long mobile
suspension, when the data on screen is stale; 15 seconds elsewhere, because a
tailnet over DERP or a VPN can be slower than that on a live socket. A long
suspension's probe that times out also replaces the socket regardless of the
network report. The web and desktop foreground probe skips the fresh request,
because a busy host can answer it before a queued probe. Foregrounding also
wakes a pending retry immediately. A long suspension restarts an in-flight
attempt; a short one leaves it alone.

The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes
connections by environment. An involuntary disconnect retains the registration
and cached data. Explicit removal closes the scope and clears credentials,
projections, and platform-owned state such as drafts.

## HTTP authorization

RPC sessions authenticate at socket upgrade, while HTTP requests need current
credentials from the
[authorization service](../../packages/client-runtime/src/authorization/service.ts).
Replacing a healthy socket for HTTP renewal would interrupt conversations and
change the transport generation without a transport failure. Refresh failure
belongs to the HTTP operation.

The server closes a socket when its session is revoked or expires. A socket on a
DPoP-bound session moves to a newer session for the same DPoP key, subject, and
scopes when one exists
([`SessionStore.awaitInvalidation`](../../apps/server/src/auth/SessionStore.ts));
otherwise it closes at expiry and the supervisor reconnects.

Session listings must retain unrevoked connected sessions after credential expiry
so an open connection does not disappear from connection management. This does
not extend the credential's lifetime. New HTTP requests and socket upgrades still
require valid credentials.

## Transport health and data freshness are separate

A socket opening is insufficient evidence that the environment is usable. The
[RPC session](../../packages/client-runtime/src/rpc/session.ts) waits for the
initial server configuration before becoming ready. Shell and thread data then
have their own synchronization state. A failed shell subscription can coexist
with a healthy connection; labeling that state "reconnecting" promises a
transport retry that will never happen.

Cached projections remain readable offline. They must neither imply a live
connection nor overwrite newer live data during a reconnect. Loading and
resuming snapshots belongs to the shared state services, so every view agrees
on which data is current.

Shell snapshots can leave rows out when the client asks. Servers that advertise
`shellThreadFamilies` leave out idle subagent children: a child stays while it
has a live or queued run, a pending request or background work, or a subagent
child of its own, so badge and working walks never meet a gap. Servers that also
advertise `shellOlderSettled` keep only the 25 newest settled top-level threads
(and any tied with the 25th, pinned, snoozed, live, or above a kept child); the
snapshot's `olderSettled` names that cut and counts the rest per project. Left-out
rows load on demand and merge behind shell rows
([thread families](../../packages/client-runtime/src/state/threadFamilies.ts)):
the family a thread view or a queued message mounts holds every active thread
sharing the thread's root, so it also brings back an old settled thread opened by
link; the Settled shelf reads pages below the cut; searches return the rows of
older matches. A missing shell row therefore does not prove a thread is gone:
code that deletes data or a worktree on absence must check the family or the
server first.

The Settled count is local Settled rows, minus local rows below the cut, plus the
server's counts
([older settled threads](../../packages/client-runtime/src/state/olderSettledThreads.ts)).
The counts are re-read when a removal or an old row's arrival or change could
move them, so archiving any thread costs one small read. A shelf lists an older
row only above the highest page frontier of the environments that can still
load, so the merged list stays a correct prefix while a page loads. An
environment with no snapshot this session, or a failed page, holds no one back.
On-demand reads wait for the session's first authoritative snapshot
(`generation > 0`), and each is keyed by generation. A resume that skips that
snapshot must still bump `generation` once verified, and may reuse a cached
snapshot only when its omissions match what the session asks for.

[Thread detail](../../packages/client-runtime/src/state/threads.ts) separates
subscription lifetime from cache lifetime. Mounted consumers share one live
stream, which stops when the last consumer unmounts; hidden mounted routes still
count. A registry-local cache retains state and its replay cursor for five idle
minutes so back navigation can resume without another snapshot download.

The desktop app adds one consumer: a
[keep-alive](../../apps/web/src/state/threads.ts) mounts every thread whose
session is starting or running, in each enabled environment. Opening a running
thread then needs no replay. The shell and detail streams are independent, so
the shell can report a stop before the detail loads or catches up. A stopped
thread stays mounted until its own stream is live and shows the stop, and the
stream then closes and saves the settled state.
Web and mobile do not keep threads alive.

Retain state and cursor together only after an update finishes. Cancellation must
not advance the cached cursor beyond the applied data, and an old scope must not
overwrite its successor's cache. Preserve pagination data on reuse, but clear
canceled loading state.

The [RPC boundary](../../packages/client-runtime/src/rpc/client.ts) resolves
requests against the current session at execution time. Durable subscriptions
follow replacement sessions. After a transport failure they wait for the
supervisor; an expected domain failure may resubscribe on the same healthy
session. Reconnection does not automatically replay mutations, whose retry and
idempotency rules belong to the operation.
