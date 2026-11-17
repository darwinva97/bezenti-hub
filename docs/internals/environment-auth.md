# Environment authentication

The environment issues its own sessions and enforces their capabilities. A
session comes from a pairing grant or from a User signing in to a local account.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. The default grant includes access
management: `terminal:operate` is a shell as the server's user and
`orchestration:operate` can start a full-access agent, and either can mint a
session with every scope through `t3 auth session issue`, so withholding
management from the default would not be a boundary. A narrower client gets
explicit scopes. Creating another pairing link requires both `access:write` and
every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning.

### User accounts

A session's `subject` names how it was obtained and security checks match its
literals, so the User travels separately: the `auth_sessions` row's `user_id`,
mirrored in the signed `uid` claim. Verification reads the row, so detaching a
User never needs a reissued token.

Once an Owner exists every session belongs to a User. A pairing link carries
the User who created it, and a device that redeems it signs in as that User. An
outside MCP client acts as the User who approved it (see
[MCP clients](#mcp-clients-are-a-separate-audience)). The Hub's shell picks the
User: `t3 pair`, `t3 auth pairing create`, `t3 auth session issue` and
`t3 thread` take `--user <sign-in name or id>`, resolved by
`UserDirectory.findActiveUserByName`, and issuance refuses a disabled or removed
User. Only paths that are the Installation's own bind to the Owner in
[EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts): those shell
commands without `--user` (only someone with the Hub's shell runs them), the
startup link, the desktop bootstrap, the reusable dev token and `t3 project`.
The binding is explicit at each caller rather than a default in
[SessionStore](../../apps/server/src/auth/SessionStore.ts): a future path that
forgot its User would otherwise silently act as the Owner. Instead an
`auth_sessions` trigger refuses a row without a User once an Owner exists, so
such a path fails closed. Creating the Owner hands it every earlier session,
since before then only the machine's operator could pair.

Browser sessions slide: the row's `expires_at`, not the signed `exp`, is the
deadline, and each use moves it to 30 days ahead, written at most once an hour.
An open socket renews it an hour before the deadline, since the renewal only
moves a deadline that has not passed. Bearer, DPoP, MCP and CLI tokens keep the
fixed lifetime in their `exp`: they are held unattended, so use must not keep a
leaked one alive. The browser cookie's expiry is re-sent on every
`/api/auth/session` check, so it follows the row.

Each User sees and revokes their own sessions and links; the Owner (or anyone
before an Owner exists) sees everyone's. The access stream subscribes before
reading its snapshot and passes a removal only for an id it already showed that
viewer, since a removal carries nothing else to scope it by. A link is checked
against its User when redeemed, so a disabled User's links stop working, and a
credential change or reset revokes the User's unspent links along with their
other sessions: a link minted with a stolen session must not outlive the change
that ends that session.

The administrative bootstrap link creates the Owner exactly once
([UserDirectory](../../apps/server/src/auth/UserDirectory.ts)); the passkey is
verified before the link is spent, so a cancelled registration does not burn
it. Once an Owner exists that link refuses Owner creation and the web app sends
its visitor to sign in, though other clients can still exchange it to pair as
the Owner. Once used, revoked or expired, that link reports `spent` from the
owner-status endpoint, so the web app says it was used rather than calling it
invalid. Every other credential reports `not-applicable`, so the unauthenticated
endpoint never confirms that one existed. Signed-out visits go to `/sign-in` once an Owner exists
(the session state reports `ownerExists`); the pairing-code form only appears
on a fresh Installation.
A passkey is bound to the host name the browser used when it was registered
(the WebAuthn relying party ID, taken from the request's `Origin`), so moving
the Installation to another domain strands existing passkeys. With
`T3CODE_PUBLIC_URL` set, that origin is the only one a passkey ceremony
accepts, and it passes the origin check even when a proxy rewrites `Host`, so a
passkey cannot be registered on another name for the same server. Recovery codes
and Owner reset links are the way back in. Both are random enough that a plain
SHA-256 is stored, and each is spent atomically on use. A reset link comes from
`t3 auth owner-reset`, which writes to the database directly, so it works with
the server stopped. It lasts one hour, and issuing one ends the earlier ones. A
registration started from a link can only be finished with that link. A reset
assumes the old passkeys are lost or stolen, so in one transaction it spends the
link, replaces every passkey with the new one, revokes the Owner's sessions and
issues a new one.

### The session cookie

A browser session is an `HttpOnly`, `SameSite=Lax` cookie on `/`, host-only (no `Domain`), named
per server (`t3_session_<hash>`, see [utils](../../apps/server/src/auth/utils.ts)). Over HTTPS it
is `__Host-t3_session_<hash>` and `Secure`: a browser takes a `__Host-` cookie only from the host
itself, so no other host, a preview's own origin under the Hub's domain included, can set or
shadow it (cookie tossing). Every response that sets it over HTTPS also expires the bare-named
one, so a session from before moves to the prefix on its next check (`/api/auth/session`, which
re-sends the cookie anyway) rather than signing out; sign-out expires both names. Plain HTTP (the
desktop app's loopback server, a LAN or dev Hub) cannot hold a `__Host-` cookie and keeps the bare
name. The reusable dev token's cookie (`t3_dev_session_<id>`) follows the same rule, and setting
it expires the session cookie under both names. Every Hub cookie, guest ones included, is read by
`readHubCookie`: the `__Host-` name first; with previews on their own origin
(`T3CODE_PREVIEW_ORIGIN`) an HTTPS request's bare-named (and legacy `t3_session`) cookie no longer
counts at all, since a preview could have set it for the Hub's domain, so a browser that never
checked in since the upgrade signs in once more; and no cookie counts on a request from a preview
page (`crossesFromPreviewOrigin`), which also signs nobody in (see
[Sandboxes: previews on their own origin](sandboxes.md#previews-on-their-own-origin)).

### App sign-in

The desktop and mobile apps sign in to a Hub through the system browser
(RFC 8252), so passkeys and password managers work and the app never sees a
credential. [AppSignIn](../../apps/server/src/auth/AppSignIn.ts) is the whole
server side:

- The app makes a PKCE verifier and `state`, and opens `/app-sign-in` with the
  S256 challenge, its redirect and a label. The page signs in as any browser
  does, then the User approves: `POST /api/auth/app-sign-in/approve` takes only
  the browser's own cookie (its origin checked with it), never a bearer token,
  so every app session traces back to a sign-in in a browser. The page and
  `/connect-agent` are served with `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`, so another site cannot frame the consent. Cancel
  returns `error=access_denied` with the `state` to the same redirect.
- The redirect is a loopback `http://127.0.0.1:<port>/callback` or `[::1]`, never
  `localhost`, which can resolve elsewhere (RFC 8252 §8.3) (the desktop
  app listens on a port of its own for that one sign-in) or exactly
  `t3code[-dev|-preview]://auth/callback`
  ([`appSignInRedirectKind`](../../packages/shared/src/appSignIn.ts)). Anything
  else is refused, so the page is not an open redirect and the code never
  leaves the device that asked for it.
- The Hub keeps the code's SHA-256 in memory with the User, challenge and
  redirect, for one minute. `POST /api/auth/app-sign-in/token` spends a code on
  its first presentation, even when the verifier or redirect then fails, and
  issues a bearer (or, with a DPoP proof, DPoP) session for that User, subject
  `app-sign-in`, with the standard scopes the approving browser session held,
  never more. A restart drops pending codes;
  the app just signs in again. Like other app tokens it lasts 30 days from
  issue and does not slide.
- Signing out (`POST /api/auth/sign-out`) ends the request's own session,
  cookie or token, so removing a Hub from an app revokes its session there. The
  client also signs out a new session it could not save, and the previous one
  when it signs in to a saved Hub again. Apps refuse a plain-HTTP Hub address
  outside this machine, the LAN and the tailnet, as the Hub's transport rule
  would.

A custom URL scheme is not owned: another app on the phone can register
`t3code://`. It cannot use a code it intercepts, because the exchange needs the
verifier that stayed in the T3 Code app, and a callback whose `state` is not
the app's own is dropped. iOS hands an `ASWebAuthenticationSession` result
only to the app that opened it; on Android the redirect is an ordinary intent
that another app could catch, which is why the verifier matters. What a scheme
cannot stop is
a malicious app starting its own sign-in, with its own verifier, and asking the
User to approve it; the approval page names the client label (chosen by the
app) and where the code goes, and says to continue only with a sign-in the
User just started. Claimed HTTPS redirects (universal and app links) would
close that gap and are the next step if it matters.

### Joined environments

`t3 join <hub>` makes a machine one of the Hub's External environments
([EnvironmentJoin](../../apps/server/src/environments/EnvironmentJoin.ts)). The
machine makes its credential itself, `t3env.<issuing Hub's id>.<secret>`, and
starts a join request carrying only its SHA-256 and a PKCE challenge; the
credential never travels. The Owner, or a User with the `environments.registerOwn`
Installation permission, approves on «Register this machine», from any device,
and the machine becomes the approver's personal one. The policy asks
`environment.register` first (`missing-installation-permission` otherwise, whose
message names the permission and is the one `REGISTER_OWN_REQUIRED_MESSAGE` the
page also gets as the request's `denialMessage`; the page learns it beforehand
from `viewerMayApprove`, and only a viewer who may approve sees the machine's
name, hostname, OS and time), so the proof of a User without the right is never
checked; then `UserDirectory.confirmStrongFactor` needs a
fresh passkey assertion or a password _with_ a TOTP code in the same request, so
a stolen browser session cannot add a machine. Only such a User denies a request,
and only while it is pending.

Anyone allowed to add machines who gets hold of the link could approve someone
else's machine as their own, so approving registers nothing: the request becomes
`awaiting-confirmation` and the machine's status answer names the approver
(display name, sign-in name, id). `t3 join` asks `Approved by Grace (grace) as
their personal machine. Register it as theirs? [y/N]` on a terminal; without
one it registers only with `--owner <sign-in name or id>` naming that approver,
and refuses otherwise. The desktop app passes `--confirm-on-stdin` and shows the
question with «Register as theirs» and «Not me». `POST /api/environments/join/confirm`
(with the verifier) accepts, which writes the row and its `environment.register`
entry, whose actor is the approver, or refuses, which ends the request. The
registry asks the policy again in the transaction that writes the row, so a
permission revoked between the approval and the confirmation adds nothing. The
machine asks the outcome with its verifier until then, and asking again after a
lost answer gets the same machine, never a second one. A browser on the machine itself is also sent to `t3 join`'s loopback
port (as app sign-in does), only as a nudge to ask now. The PKCE store is shared
with app sign-in ([pkceGrants](../../apps/server/src/auth/pkceGrants.ts)).

The Owner can also add a dedicated machine over SSH from the Hub
([Installing over SSH](./sandboxes.md#installing-over-ssh)): there is no approval page, and the
Hub runs `t3 join --grant-on-stdin` on the machine with a one-use grant of that run. The machine
still makes its credential itself and sends only its hash; `POST /api/environments/join/grant`
(HTTPS or loopback, no session) registers it for the run's Space and name, approved by the Owner
who started the run, once.

The credential is not a session: `SessionStore` never sees it, so only
`/api/environment/connect` and `/api/environments/leave` accept it, as with
guest tokens. The Hub keeps its hash and who approved it when. The Hub's id in
it is the server's persisted EnvironmentId, not the Hub machine's row id (the
constant `environment:hub-machine`, the same on every Hub), so a Hub can tell a
credential another Hub issued from an unknown one; a Hub whose `welcome` names
another id gets the socket closed by the machine. `leave` refuses plain HTTP
from off the Hub's machine, as the socket does (`isSecureEnvironmentTransport`).
A machine belongs to its owner: turning off or removing that User revokes their
machines in the same transaction and closes their sockets after it commits, and
the credential check refuses a machine whose owner is off in any case. Revoking
`environments.registerOwn` only stops new approvals: the permission gates
joining, not having, so machines already joined keep working, and their owner
still sees, renames and removes them in Settings (the Owner sees and manages
every one, but uses only their own). The Hub machine's load, providers and
running Threads are the whole Installation's, so only the Owner's list carries
them; everyone else gets the row without them.

The socket ([connectRoute](../../apps/server/src/environments/connectRoute.ts))
upgrades before it checks the credential, so every refusal reaches the machine
as a close code it can explain (`ENVIRONMENT_CLOSE_REASONS` in the
[protocol contract](../../packages/contracts/src/environmentConnection.ts));
the `final` ones stop the machine's reconnect loop, the rest back off with
jitter. The server's reader must be acquired before a close is written, or the
handshake never completes and the client times out waiting for `open`.
Removing an Environment revokes its row (kept, so the next use answers
`credential-revoked`, not unknown) and after the commit closes its live socket.
The socket is tracked before the credential is checked a second time, so a
removal that lands between the upgrade and the hello is never missed. Two
processes with one credential would take turns forever, so the newer connection
wins and the older stops on a final `replaced`. Status is computed when
read from `last_seen_at` and whether a socket is attached, not kept by timers.

A joined server ([JoinedHub](../../apps/server/src/environments/JoinedHub.ts))
serves only `/health` on loopback: no web app, sign-in or user WebSocket. Its
mode comes from `joined-hub.json` in the state dir, which `t3 join` writes and
`t3 leave` removes. Over its socket it runs the calls the Hub makes for the
Threads placed on it, and authorizes nothing itself: the Hub checks
`environment.use` when a Thread is placed (a personal machine runs only its
owner's Threads; the Owner sees every machine but uses only their own), and
accepts a provider event only from the Thread's Active environment. The agent
there calls the Hub's MCP with the per-Thread credential the Hub issued, so it
acts with exactly its User's permissions.

A machine the Owner dedicated to an Organization (`t3 join --dedicated`, chosen under **Used by**
on «Register this machine», or later with **Change use**) is that Space's, not its registrar's:
`environment.dedicate` (the Owner, on the Installation) is asked before the strong factor and again
when the row is written, its policy is a Sandbox's (seen with its Space, used by its Admins and
Members for its Threads only), and its credential reaches only its Space's repositories. Its mode or
Space changes only while no Thread is on it. See
[Sandboxes: dedicated machines](sandboxes.md#dedicated-machines).

A Project's preferred Environment (`project.update` with
`preferredEnvironmentId`) may be set only to a machine its setter may use
([`mayUseEnvironment`](../../apps/server/src/environments/EnvironmentRegistry.ts));
an unknown or removed machine is refused alike. Placement takes the User's own
choice first, then the preference, then the Hub machine; a preference the User
may not use (the Owner's laptop, for a Member), or one offline or without the
provider, falls back to the Hub machine instead of refusing, since that User
never chose it; clients preview the same rule (`previewThreadPlacement`).

The desktop app's «Use this computer as an Environment»
([DesktopJoinedEnvironment](../../apps/desktop/src/joinedEnvironment/DesktopJoinedEnvironment.ts))
is the same flow, not a second one. It runs the bundled server's `t3 join --no-browser` in a T3
home of its own, `<the app's T3 home>/joined-environment`, opens the approval link the CLI prints
with the system browser, and so leaves the credential in that server's secret store exactly as
the CLI does. It then runs that server through the desktop's backend manager (restarts with
backoff, SIGTERM then kill on stop), in desktop bootstrap mode so it ends with the app, with
`--base-dir` so a `T3CODE_HOME` the app runs under cannot point it at the app's own state, and
with `/health` as its readiness probe. It is kept out of the backend pool: the renderer lists the
pool as local environments to connect to, and a joined server serves no clients. «Leave» stops
it and runs `t3 leave`. The app stays a client of its Hubs throughout; closing its last window
leaves it running (on Windows and Linux too) while the setting is on and «Keep running when the
window is closed» is.

### Spaces

Every Project and Thread belongs to a Space: an Organization or a User's Personal
space. Who may do what is decided only by the pure
[AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts), whose table-driven test
is the Role table; a new rule is a new row there, not a check at a call site.
[SpaceDirectory](../../apps/server/src/spaces/SpaceDirectory.ts) loads the
principal (Owner or not, Roles, Installation permissions) for it.

A new Project or Thread is claimed for its Space inside the service every caller
goes through, `ProjectService.create` and `ThreadManagementService.dispatch`, so
the web client, launches, MCP tools, scheduled tasks and the CLI are all checked
and stamped with `spaceId` and `ownerUserId`. Transports only pass the session's
User (a client's `ownerUserId` is replaced). MCP tools pass the invocation
scope's `userId`, so an agent creates as the Thread's owner and an outside client
as the User who approved it; a refusal reaches the agent as the app's message.
Only callers with no User at all act as the Owner: work before an Owner exists,
`t3 project`, and server-made effects. A scheduled task records its creator
(`owner_user_id`), only they change or run it, and its runs act as them; tasks from
before Users keep running as the server. A Thread joins its Project's Space, and a
Project from before Spaces counts as the Owner's Personal space. A client's
requested Space places new Projects and Threads in unknown Projects; for a
Thread in a known Project it must be that Project's Space, or the claim is
refused (`space-mismatch`, checked after visibility so it reveals nothing).
Callers that name no Space (agents, forks, the CLI) get the Project's. Clients
send their current Space only to the environment it came from, and list, search
and offer Projects of that Space alone (`client-runtime` `spaceFilter`), so
that refusal only meets a stale client. Archived
Organizations and frozen Personal spaces take nothing new, even from the Owner.

Rows from before Spaces keep `NULL` in both columns and count as the Owner's
Personal space; the migration cannot backfill them because the Owner may not
exist yet. A trigger on `users` creates each User's Personal space
(`personal:<userId>`) with the row, so no account path has to remember it, and
its User always uses it: no permission gates it (migration 137 dropped the old
`personalSpace.create` grants). The Owner grants and revokes the remaining
Installation permissions (`installation_permissions` rows) over HTTP
(`/api/installation/users`, which also needs the `access:read`/`access:write`
scope) through `SpaceDirectory.setInstallationPermission`. `environments.registerOwn`
lets a User approve their own machine joining (see
[Joined environments](#joined-environments)). The Owner reads every
Personal space and lists them in the selector, but changes nothing in another
User's (`personal-space-read-only`). Naming a Space one cannot see, a
`personal:<id>` included, answers exactly like naming a missing one.

#### Who sees what

A User sees the Projects and Threads of the Spaces the policy lets them view
(`space.view`): their own Personal space and every live
Organization they belong to. The Owner sees everything, every Personal space included; an archived
Organization disappears for its Members only. A Thread's Space is its own
`spaceId`, else its Project's, so an unstamped child Thread follows its Project;
with neither it is the Owner's.

[SpaceVisibility](../../apps/server/src/spaces/SpaceVisibility.ts) is the only
place this is answered, and every read of Projects or Threads asks it:

- The stores take a `spaceIds` filter (`SpaceVisibility.spaceFilter`) and put
  `threadInSpaces` in their SQL, so hidden Threads are never read or decoded:
  the shell snapshot and its index, archived and older settled pages, families,
  worktrees, search and Pull Request links. Projects are filtered by `spaceId`.
- The shell stream drops a live delta for a Project or Thread the subscriber
  cannot see before reading it, so deltas never show what the snapshot hid.
- RPCs that name one Thread or Project are checked by the RPC authorization
  middleware from [RpcSpaceAccess](../../apps/server/src/auth/RpcSpaceAccess.ts).
  It lists every `orchestration.*` RPC and every RPC whose payload names a
  `threadId`, `projectId` or `projectIds` (in fact every RPC), as `thread`, `project`,
  `filtered`, `installation` or `unscoped` with the reason; `RpcAuthorization.test.ts` fails when one is
  missing. A hidden Thread and a missing one both fail with
  `SpaceResourceNotFoundError`, so a refusal is not an existence oracle. HTTP
  Thread routes answer `thread_not_found` the same way.
- MCP read tools use the scope's `userId` (`mcpVisibility`). Every caller has
  one once an Owner exists: an agent in a Thread reads as the Thread's owner, an
  outside client as the User who approved it. A caller with none reads as
  everything, which only happens before an Owner exists.
  The scope's `userId` is the same field WS and HTTP principals carry, so
  `SpaceDirectory.principalOf` gives services the same principal (Owner or not,
  Roles, Installation permissions). MCP project updates and deletes treat a
  Project the User cannot see as missing; Role write rules come with ticket 08.

Each WebSocket connection resolves its viewer once (`CurrentViewer`) and again
only when `SpaceDirectory.revision` moves, which every Space or Membership write
bumps, so a new Membership shows on the next read without reconnecting. A
Membership that ends or changes instead closes the User's sockets
(`connectionEnds` in `ws.ts`, fed by `SpaceDirectory.membershipsChanged`),
because rows already sent cannot be filtered back out. The client reconnects and
resumes its shell from its last sequence, and a resume would send only new
events, so removing a Membership also stamps `users.access_narrowed_through`
with the current event sequence; a resume from at or before it gets a full
snapshot instead (`CurrentViewer.lostAccessSince`). Every other stream re-checks
visibility when the client resubscribes. The socket subscribes to Membership
changes before it resolves its viewer, so a change in between is not missed, and
a write that changes nothing publishes nothing.

Granting or revoking an Installation permission keeps the socket: it wakes that
User's open streams instead (`SpaceDirectory.subscribeAccessChanges`, one hub
per User, only when a row changed). The shell stream restarts, the old round
ending before a fresh authoritative snapshot and its live tail take over (web
reloads its Spaces on it). Streams on one Thread (Thread, command output,
worktree setup, terminals) go through `untilAccessLost` in
[RpcSpaceAccess](../../apps/server/src/auth/RpcSpaceAccess.ts): it subscribes,
reruns the middleware's guard once and on each change, and ends the stream when
the guard refuses. A Membership change wakes the same hub before its socket
closes.

#### Who changes what

Every write meets the Role rules where all transports meet: thread commands in the
orchestrator's dispatch, under the Thread's lock
([commandAccess](../../apps/server/src/orchestration-v2/commandAccess.ts) maps each
command to an action), Project changes in `ProjectService`, and Force stop in
`ThreadManagementService` before it kills the agent. Who acts is the fiber's
[CommandActor](../../apps/server/src/auth/CommandActor.ts): the RPC middleware sets
it to the session's User, the HTTP mutate route likewise, an MCP call acts as its
credential's User (an agent as its Thread's owner), and
`ServerRuntimeStartup.enqueueCommand` carries it into its worker. Only the server's
own work (effect worker, reactors, tasks from before Users) has no actor and goes
unchecked; once an Owner exists, a request whose session names no User is refused
(`SpaceDirectory.actingUser`), and an agent in a Thread from before owners acts as
the Owner. The receipt store stamps the actor on every
command receipt (`actor_user_id`); nothing a client sends sets it.

Only a Thread's creator speaks in it or changes it, not even an Admin or the Owner
(MCP app calls and model context included); archiving, restoring and stopping are
the creator's or an Admin's; permanent deletion is an Admin's and only from the
archive. Pins, settling, snoozes and tags are stored once per Thread, so they are
the creator's or an Admin's too; visits and unread marks are open to every viewer,
and since that marker is per Thread a viewer's visit also marks it read for its
creator until markers are kept per User. A command not named in `commandAccess`
counts as continuing, so a new command is owner-only until someone decides
otherwise. A refusal on something the User can see is a `SpaceAccessDeniedError`
that says why; a hidden target and a missing one fail alike as not found on every
path. Refusals record no receipt, since a Role can change and the retry should
pass, and a command id replays only for the User who sent it.

Terminals, previews, devices, chat attachments and worktree setup are `work` RPCs
in `RpcSpaceAccess`: only the Thread's owner works them, and a terminal opens only in
the folder of a Thread the User created or in a Project of a Space where their Role
creates Projects (so not a Guest's). A draft has no row to
carry an owner, so the first User to work it holds it in memory
(`SpaceVisibility.claimWork`); it is hidden from everyone else, and the terminal
and preview streams show each User only what they may work. A launch whose
client-chosen id names an existing Thread fails before anything is provisioned,
alike for hidden and visible Threads, and Pull Request
calls routed by repository see only visible Projects (`RequestVisibility`, which MCP tools
carry too) and reach only such a Project's own repository with the Hub's credentials; changing
a Pull Request (merge, review, labels, guides) takes a Role that works the Project
(`workProject`), not a Guest's.

An Organization's lifecycle is the Owner's
([OrganizationLifecycle](../../apps/server/src/spaces/OrganizationLifecycle.ts)).
Archiving sets `archived_at` and, like a removal, marks its Members'
`access_narrowed_through` and closes their sockets, so their shells resume without
it; it then stops, as the Owner, every Thread with live work: unfinished runs, open
requests, background commands and delegated tasks (`threadHasLiveWork`; the Sandbox
stop of spec 3 goes there too). Nothing starts there afterwards: the policy refuses
Users' creates and continues, and the orchestrator refuses any `message.dispatch`,
fork or delegated task in an archived or frozen Space whoever sends it, the server's
own resumes and continuations included (`SpaceDirectory.workBlocked`). Scheduled
tasks run only in an open Space: archived, frozen or deleted ones skip their runs,
and a failed read skips the tick. Restoring clears `archived_at` and
publishes on the Members' access-change hubs, so open shells reload with it. Delete
is refused unless archived and first sets `deleting_at` (migration 091) in the same
transaction as the check, so the Organization is never restored half-deleted: it deletes the Organization's Projects (with their
Threads) and leftover Threads through `ProjectService`'s event-sourced delete paths,
with command ids fixed per Organization so a retry replays, then removes its
scheduled tasks, Memberships, Invitations and row in one transaction.

Moving a Project (`project.move` in the project mutation) is decided on both
Spaces: the mover runs the origin and the destination (Admin of an Organization, or
the User of a Personal space). The Owner moves anything except into or out of
another User's Personal space, other than out of a removed User's frozen one.
Nothing moves into an archived or frozen Space. `ProjectService.move` marks the Project
moving (`whileProjectMoves`: no Thread is created or started in it meanwhile), checks
each Thread idle under its lock and refuses with `ProjectMoveBlockedError` (HTTP 409)
naming the busy ones, records the Project's new `spaceId` on a `project.meta-updated`
event, then lists its Threads again and gives each the new Space with a
`thread.metadata-updated` event under its lock, each checked as a move out of the
Thread's own Space (so a stray Thread stamped elsewhere needs that Space's rights too). Afterwards `SpaceDirectory.projectMoved` bumps
`revision`, marks who lost it as narrowed and publishes on every viewer's
access-change hub, so the origin's open shells drop it and the destination's gain
it, also after a move that failed part way. A rerun of an interrupted move finishes
its Threads.

Spaces are read and Organizations created over HTTP (`/api/spaces`), beside the
account endpoints, rather than as guarded WS commands: creating an Organization
depends on who the User is, not on a session scope, so clients show controls from
the server's `canCreateOrganization`, `canCreateThreads`, `canInvite`,
`canMoveProjectsOut` and `canMoveProjectsIn` answers; archived Organizations are
listed (marked `archived`) only to the Owner.
Per-Thread controls come from `threadRolePermissions` in the client runtime, which
mirrors the policy from the directory's Roles and `isOwner`; the server stays the
judge.

#### The Installation as a whole is the Owner's

Scopes say what a credential may do, not whose Installation it is: every browser session
got the standard scopes, so they kept no Member out of the Hub's settings, processes or
providers. Two layers now do:

- RPCs on the Installation as a whole are `installation` in `RpcSpaceAccess`
  (`INSTALLATION_RPC_METHODS` in contracts): settings and keybindings (one file for the
  whole Hub), storage cleanup, process, trace, telemetry and usage diagnostics, signalling a
  process, triage, every provider, provider sign-in, ACP registry install and an ACP agent's
  model provider (secrets included; the Project only says where the agent runs), device hosts,
  device actions and shutdown, the Hub's source-control sign-in and starring, and the Hub's
  AI gateway (`aiGateway.*`, [ai-gateway.md](ai-gateway.md)). The
  middleware refuses them with `SpaceActionDeniedError` ("Only the Owner of this Hub can do
  that.") unless the session sees everything (the Owner, or no Owner yet), whatever its
  scopes, and says that rather than naming a missing scope; an Admin is refused like a Member.
  Device state (`device.list`, its stream) carries only sessions of Threads the User sees and
  `device.detail` answers another Space's device like a missing one (`DeviceAccess`); host
  retry and tool update are the Owner's. The `/api/device-hub` proxy needs the `threadId` a
  device is open in from anyone but the Owner: visible to watch it, worked to drive it. What stays `unscoped` is one session's or connection's own
  (probe, server config, lifecycle, client activity, preview profiles, uploads) or reads the
  Hub's shared state its Members need (host load, devices, source-control tools); handlers
  filter the rest: discovered local servers (only those of Threads the User works; stopping
  one needs it listed so), agent sessions to import (folders the User may read, Projects they
  see), clones (into a folder of the User's team's Projects, or a new folder right in the
  Hub's Projects folder that no Project holds, its parent resolving where it is named:
  `SpaceVisibility.mayCreateDirectory` through `requireCloneDestination`, asked again right
  before git writes and before a retry clears the old checkout; listed, cancelled and retried by their starter, or
  seen with their Project; their URLs carry no credentials), pending attachments (deleted
  only by the User who asked for the upload, remembered in memory) and the access stream.
- A session of any User but the Owner is read without the Installation's own scopes
  (`AuthInstallationScopes`: `settings:write`, `providers:manage`, `environment:maintain`,
  `diagnostics:read`), however and whenever it was issued (`heldByUser` in EnvironmentAuth,
  for cookies, bearer and DPoP tokens and WebSocket tickets); sign-in issues a Member's
  session without them, and a Member's pairing link and MCP approval ask none of them. So the
  scopes a client is told about are what it can use, and clients that hide controls by scope
  hide these for a Member. The RPC check is what refuses; this keeps the clients honest.
- One check per operation, whatever the transport: `authorizeRpcCall` (the RPC's scopes, then
  `RpcSpaceAccess`) runs in the WS middleware, and an MCP tool doing what an RPC does runs it
  with that RPC's method as its caller's User (`mcp/rpcAccess.ts`, with `scopesOfUser`):
  `t3_environment_preferences_update` as `server.updateSettings`, `t3_project_create`/`update`
  as `projects.mutate` (scripts need `settings:write`), `t3_project_clone` as cloning from the
  app.

Clients hide what a Member cannot do rather than fail: command permissions refuse
`INSTALLATION_RPC_METHODS` for a session that is not the Owner's
(`sessionActsForInstallation`), the web Settings drop Providers, AI gateway, Devices,
Maintenance, Diagnostics, Source control and Secrets for a Member (opening one says only the Owner changes
them) and mark Threads, Browser, Worktrees, Keybindings, Projects and Labs as the Hub's, whose
rows a Member cannot change are inert and say only the Owner changes them, and
mobile Settings drop Providers, Source control and Maintenance. Settings stored once for the
whole Hub (model favorites, project actions and the like) are therefore the Owner's until
they are kept per User.

### Invitations

People join an Organization only through an Invitation
([InvitationService](../../apps/server/src/spaces/InvitationService.ts)), which
carries the Role and is created, listed and revoked over HTTP
(`/api/spaces/:spaceId/invitations`, `/api/invitations/revoke`). The policy's
`invitation.create` and `invitation.manage` actions allow the Owner and the
Organization's Admins, only in an Organization (nothing is shared from a Personal
space), and creating needs a live one. An Admin Invitation, to create or to
revoke, also needs `admin.manage`, which is the Owner's alone. The link is `<origin>/invite#token=…`; the token is 32 random
bytes shown once, and only its SHA-256 is stored, so looking it up leaks nothing
through timing. The web app's startup pairing leaves `#token=` alone on `/invite`,
as on `/reset`.

The invitee's endpoints (`/api/invitations/preview`, `registration`,
`totp-enrollment`, `accept`) need no session. An unknown, expired (7 days),
revoked, used or archived-Organization link answers the same `invalid` preview
and the same refusal, and each such miss counts toward the per-client back-off
of password sign-in. Accepting verifies the passkey, or hashes the password and
checks the TOTP code, first; then one transaction creates the User, spends the
Invitation with a conditional `UPDATE` (so of two racing accepts one wins),
adds the membership and issues the browser session. A refusal inside it, such as
a taken sign-in name, leaves the link unspent. A signed-in User accepts through
`/api/invitations/join`, which adds the Organization to their User instead; it
refuses the Owner, an existing Member, and an Admin Invitation for an account
that signs in with a password alone.

### Memberships

[MembershipService](../../apps/server/src/spaces/MembershipService.ts) lists,
changes, removes and leaves over `/api/spaces/:spaceId/members…` and `/leave`.
The policy decides each on a `MembershipResource` (the target's current Role and
the one asked for): an Admin acts on Members and Guests only, and anything that
starts or ends at Admin is the Owner's. The check and the write share one
transaction, and the target's connections close after it commits. Removing and
leaving delete only the Membership row; Projects and Threads keep their Space and
creator. Members of an Organization see its member list; anyone else gets the
same answer as for a missing Organization.

An Admin Membership counts only for a User with a passkey or TOTP: until then
`SpaceDirectory` gives them a Member's Role (`pendingAdmin` in the directory and
member list), and the credentials row's `isAdmin`, which feeds
`passwordRequiresTotp`, is false. A phished password therefore never yields Admin
rights, and nothing enrolls TOTP from the sign-in form: a pending Admin adds it
under Settings → Access with a step-up. Promoting a User who has a passkey and a
password but no TOTP revokes their sessions in the same transaction, since any of
them may have come from the password; their password then answers
`SecondFactorMissingError`. Credential changes that start or end Admin rights call
`AccessChanges` (provided by SpaceDirectory, so account code need not depend on
Spaces) after they commit.

Removing someone, or changing an Admin to another Role, revokes the pending
Invitations they created in that Organization in the same transaction. A guest
link records its creator and stops working once that User may no longer create
guest links on its Thread (checked on every guest request), which covers removal
and demotion without a write to the Thread.

### Disabled and removed Users

[InstallationUserService](../../apps/server/src/spaces/InstallationUserService.ts)
sets `users.disabled_at` / `removed_at` and, in the same transaction, expires
their reset links, revokes the Invitations they created, and revokes every
`auth_sessions` row (browser, app, MCP client and CLI bearer are all sessions)
and pairing link of theirs in one write each; removal also deletes their
Memberships and sets their Personal space's `frozen_at`. Sockets and the
per-User hub hear it after the commit. Asking again for the same status reruns
the revocation, so a retry finishes a half-done one, and a session read treats
a disabled or removed User's session as revoked regardless. Their principal
carries `inactive`, which the policy denies everywhere, so anything that acts
_as_ them without a session (guest links they made, agent tool calls) stops
too, and their Memberships can stay for a re-enable. After the commit
`SpaceDirectory.userStatusChanged` tells the work that runs as them:
`InactiveUserTurns` interrupts their running turns, and `ScheduledTaskService`
pauses their enabled tasks (`paused_for_owner`), resumes exactly those on
re-enable, and skips and pauses any run whose creator turned out inactive; the
Owner may pause or delete such a task. A trigger (migration 092) refuses a new
session or pairing link for an inactive User, closing the race with a sign-in
already under way, which then answers as the disabled account. App sign-in
codes need no revocation since their exchange checks the User. Sign-in
(passkey, password, the TOTP step, recovery code) says the account is disabled
or removed only after the credential verified, so it is no oracle, and spends
nothing. The User row stays as a tombstone for names. A frozen Personal space
is read-only for everyone; the Owner may only stop its running Threads, move its
Projects out (`ProjectService.move`) and
delete from it, archived or not.

Reset links are the Owner's alone (`UserDirectory.issueResetLink`; `created_by`
names the issuer), since a link takes the account over. Redeeming one registers a
passkey or, for anyone but the Owner, sets a new password; either way it removes
every other passkey, the password and TOTP and ends every session, in one
transaction.

### Audit log

[AuditLog](../../apps/server/src/audit/AuditLog.ts) appends to `audit_log`
(migration 093), which triggers keep append-only; nothing prunes it. An entry
is written by the service that performs the action, inside that action's
transaction, so a rolled-back action leaves none and an entry that cannot be
written fails the action. Event-sourced actions (permanent Thread and Project
deletes, each Thread a Project or Organization delete destroys, Project moves,
guest links) pass their entry to `EventSink`
(`commitCommand`/`commitProjectCommand` `audit`), which writes it with the
receipt as the fiber's `CommandActor`, so a replayed command records nothing.
App sign-in and MCP OAuth approvals live in memory and record before their
code is minted; an MCP pairing code is spent in the same transaction as its
entry. The actor comes from `CommandActor`: an MCP call or a Thread's agent is
`agent` (the pre-owner `ThreadOwner` resolves to the Owner), the shell is `cli`
(`t3 auth ...`, offline `t3 project`, and live `t3 project` through a session
with `SHELL_SESSION_SUBJECT`), and a session naming no User records as `system`
before an Owner exists and fails the action after. Entries snapshot the Space and target names, since
Organizations and Projects are deleted while Users are only tombstoned. Detail
keys are an allow-list per action (`AUDIT_DETAIL_KEYS` in contracts); any
other key is dropped on write, whatever the caller passes.
`secret.*` are in the closed `AuditAction` list for the spec that owns secrets
to record. The read (`/api/installation/audit`) is
Owner-only and needs `access:read`; anyone else gets the same 403 whatever
they filter by.

### Sign-in rules

Which accounts may use a password without a second factor is one function,
`passwordRequiresTotp` in UserDirectory: true for the Owner and for an Admin of
any Organization. Extend that function rather than checking roles at call sites.
It applies three times: setting a password needs TOTP enrolled first, removing
TOTP needs the password gone first, and password sign-in refuses an account the
rule covers when it has no TOTP. The last check catches an account whose rule
changed after it set a password. An Admin Invitation therefore takes a passkey,
or a password together with a TOTP enrollment confirmed in the same accept.

Any account with TOTP gets the code step: the password step answers
`secondFactor: "totp"` with a short-lived challenge id, and the code goes to
`/api/auth/password/totp`. That answer comes whether or not the password was
right (a wrong one gets a challenge no code passes), so it never confirms a
guessed password on its own. Failed passwords, codes and step-up proofs count
per account and per client address, which behind a trusted proxy is the
forwarded one. After five failures each further one locks
the key for twice as long, from 30 seconds up to 15 minutes. The counters live in
memory, so a restart clears them.

A stolen session must not be able to install a lasting way in. Setting,
changing or removing a password and confirming or removing TOTP therefore need
a step-up proof in the same request: a fresh passkey assertion, or the current
password plus a code when TOTP is enrolled. Only an account with no credential
yet is exempt. Each such change revokes the User's other sessions, and a removal
that would leave no way to sign in is refused.

Passwords are argon2id (19 MiB, two passes) via `hash-wasm`, which is
WebAssembly. A native addon would need a build per platform staged into the
desktop and CLI artifacts, and `node:crypto.argon2` needs Node 24.7, newer than
the server's supported floor. Hashing holds the event loop for tens of
milliseconds, so at most two run at once. TOTP secrets are sealed with
AES-256-GCM under the `user-credential-key` server secret, with the User id as
associated data. Each sign-in code's 30-second step is recorded, so a code works
once. An enrollment code is not recorded, since it only proves the app works.

### Guest links are not sessions

A [guest link](../user/guest-links.md) gives one browser read access to one
thread and a way to propose messages. Its tokens are HMACs of the thread and
share id under a server key ([GuestShareService](../../apps/server/src/guest/GuestShareService.ts)),
so nothing secret is stored. The share in the thread projection is the only
state: replacing, closing, or archiving it revokes every token, and the
orchestrator's serial commands make redeeming and sending happen once. Guest
tokens never enter `SessionStore`, so no RPC, WebSocket, or MCP path can accept
one. Guest routes also require the environment's public address to still be the
link's hostname; the request's Host header is not checked, because a LAN client
can forge it. No public address exists until the Hub provides one, so guest
links cannot be created yet.

### MCP clients are a separate audience

Agents T3 Code did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)).
It accepts loopback redirect URIs for agents on the user's machine and any
HTTPS redirect for hosted agents (ChatGPT, bots). An HTTPS redirect means a
link someone else sends the owner can deliver access to that someone, so the
approval page names the host access goes to and approving stays the owner's
call. Every client is public and proves itself with PKCE; a client that asks
for a secret is registered without one. Client registration is stateless, so an unauthenticated caller cannot grow server
state. Approval spends a one-time pairing code, or uses a browser session with
`access:write`; proof-bound codes are refused without being spent.

The issued session belongs to whoever approved: the signed-in User of that
browser session, or the User a pairing code was issued to (its creator, or the
`--user` it was created for). The authorization code carries that User to the
token exchange, and `/mcp` puts the session's `user_id` on the invocation
scope, so reads, creations and the client's place in "Your sessions" (listing
and revoking) all follow that User, and revoking or disabling the User cuts the
client off with the rest of their sessions. A signed-out consent page shows the
sign-in form in place and reloads the same request once signed in, so there is
no return URL to redirect through; the approval details name the User
(`signedInAs`). The CSRF token is bound to the approving session, client,
redirect and PKCE challenge, so it cannot approve for another sign-in. A
pairing code is checked before it is spent: its User must still sign in and, in a
signed-in browser, be that browser's User, so the page's "acting as" is always
true. Once an Owner exists an approval that names no User is refused rather than
given to the Owner; sessions from before the Owner are adopted by it when it is
created, so no MCP session stays userless. The token
stays a plain bearer: DPoP binding of MCP clients is unchanged.

The user grants either read-only access or a runtime-mode ceiling, not a
scope list: MCP tools are all orchestration, and `orchestration:operate`
alone would let an agent start a thread in full access and act through it.
The result is an ordinary session with subject `mcp-client`. A read-only
grant holds `orchestration:read` alone. On `/mcp` it passes only tools
declared as reads in [McpToolAccess](../../apps/server/src/mcp/McpToolAccess.ts),
where every tool must declare who may call it to compile. Any other grant adds
`orchestration:operate` and a signed ceiling. Only `/mcp` accepts these sessions. Every other HTTP and WebSocket
path rejects that subject, because the RPC surface would let the agent act
above its ceiling. Inside MCP the credential sets the limits and tool
parameters only pick targets; see
[threadAccess](../../apps/server/src/mcp/threadAccess.ts).

Issuer and resource URLs come from the request's Host and the scheme a trusted
proxy reported (see [the client behind a proxy](./remote.md#the-client-behind-a-proxy)),
so one server answers over loopback, Tailscale Serve and a reverse proxy. A
proxy that rewrites Host or drops the protocol header breaks sign-in.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. A ticket names the route it
opens: the RPC socket, or the media routes (device hub, preview stream), which
share one ticket across `<img>`, `EventSource` and several sockets. A DPoP
client's RPC ticket is bound to its proof key and the upgrade carries a fresh
proof in the `dpop` query parameter, since a WebSocket cannot set headers; a
ticket captured on a plain HTTP LAN route is useless without the key, and the
proof's `jti` is consumed like any other. Media tickets stay bearer because each
media request would need its own proof. Clients that predate this mint unbound
tickets that open either route. Browser sessions can authenticate the upgrade
with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts), and the WebSocket RPC
group's `RpcScopeAuthorization` middleware checks it before any handler runs.

Scope changes must not prevent older clients from connecting. Token exchange
intersects recognized requests with the pairing grant; retired and unknown names
are dropped. A request with no granted scopes fails before consuming the link.
Stored credentials are never expanded when scopes split.

Auth responses keep `scopes` within the original wire vocabulary and include
`permissions` for the exact grant. New clients use `permissions` when present,
even if empty. Older servers omit it, so clients use legacy parent checks for
features those servers already support. These client checks never change server
authorization. Permission errors likewise retain a legacy `requiredScope` and
add the exact `requiredPermission`, so a denied RPC stays decodable by old clients.
Unknown response permissions are ignored; grant inputs stay strict.

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

### Secrets at rest

Everything `ServerSecretStore` keeps (session signing keys among them) is encrypted with the
master key; only the Owner sees its status or downloads its backup (`masterKey.backup` in
`AccessPolicy`, with a strong factor in the request; HTTP only). `request_secret` answers of type
`file` are sealed at rest and in clear only in a folder in memory (on the disk, emptied at every
start, where there is none); that delivery applies only when
the Hub machine runs agents, since a Sandbox or a joined machine cannot read a path on the Hub. See
[secrets.md](secrets.md).

## Folders on the Hub's disk

Projects are not filesystem sandboxes, but on a Hub with Members the Hub's disk is not one
User's: what a call opens on it is checked against the folders the User may read or work in
(`SpaceVisibility.mayReadDirectory` / `mayUseDirectory`, used by `RpcSpaceAccess` for
`readDirectory`, `workDirectory`, `readIfThread`, `workIfThread`, asset URLs and MCP image
inlining). The Owner reads everything; `filesystem:read` alone no longer opens a path outside
those folders for anyone else.

Those checks trust two kinds of root, and only under today's rule
([directoryRoots](../../apps/server/src/spaces/directoryRoots.ts)), applied when the rule is
written and again every time a folder is checked, so a row recorded before the rule, by
another machine, or by a move that kept an old path, counts only if it passes:

- A Project's workspace root: one the Owner chose (or from before Users), or a folder right in
  the Hub's Projects or Scratch folder. Anyone but the Owner creates a Project only in a new
  folder right in the Projects folder that no Project holds (claimed under a lock, so two
  Spaces never take the same one), or in one the Hub made for it (a named Project, a promoted
  Scratch Thread), and never moves it or points its icon outside it. `ProjectService` enforces
  this for every transport; cloning that makes a Project asks the same rule up front.
- A Thread's worktree while it runs on the Hub machine (or names none): only inside its
  Project, or the Project's own part of a linked worktree of the repository it is in (the
  worktree plus the Project's path in the repository, so monorepo Projects of different Spaces
  claim none of each other's). A repository that holds the Hub's own folders never qualifies.
  The orchestrator refuses others on `thread.create` and `thread.metadata.update`.

Nothing is rewritten: a root that fails today's rule stays recorded and works as before for
the Owner, who sees everything. For everyone else it is simply no folder of theirs: terminals,
files and assets there are refused as missing until the Owner moves the Project into the
Projects folder or the Thread back into its Project.

An agent's MCP credential on a machine bound to one Space (its Sandbox, a dedicated machine)
reads and acts only in that Space (`spaceLimit`), with its User's rights there:
`SpaceVisibility` filters what it reads, and `SpaceDirectory.authorizeItem` and
`claimCreation`, which every write passes, refuse the rest.

Every other door decides with the rule of the RPC it mirrors: HTTP routes call
`authorizeSessionAsRpc`, MCP tools `authorizeAsRpc`, and both run with the caller's
`RequestVisibility`. [DoorRules](../../apps/server/src/auth/DoorRules.ts) lists each HTTP
endpoint, raw route and MCP tool with its rule, and its test fails on a new door that has none.

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential. Access is checked when the URL is minted, not when it
is served: a URL issued before access was revoked keeps working until it expires,
and it is not bound to the session that minted it.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
