# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

From a checkout of this repository:

```bash
T3CODE_VERSION=<version> T3CODE_RELEASE_BASE_URL=<release source> sh scripts/install.sh
```

On Windows, in PowerShell:

```powershell
$env:T3CODE_VERSION = "<version>"; $env:T3CODE_RELEASE_BASE_URL = "<release source>"
.\scripts\install.ps1
```

This installs the `t3` binary to `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_VERSION` to the exact version to install and
`T3CODE_RELEASE_BASE_URL` to your release source; see
[Updating T3 Code](./updating.md#install-a-new-version).

| Task                                             | Command                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                                    |
| Start the server without a browser               | `t3 serve`                                                              |
| Use it from your other devices                   | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md))               |
| Reclaim database space                           | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`).

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

The background service does not apply to a server run this way; update it
with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                                                      |
| ------------------ | ------------------------------------------------------------ |
| Windows            | `winget install T3Tools.T3Code`                              |
| macOS              | `brew install --cask t3-code`                                |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb`                           |
| Arch Linux         | `yay -S t3code-bin`                                          |
| Arch Linux nightly | `yay -S t3code-nightly-bin`                                  |
| Nix                | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code` |

The desktop app does not update itself. To update, install the new build the
same way; see [Updating T3 Code](./updating.md).

### Nix (nixpkgs)

T3 Code is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code).
The command above installs from `nixos-unstable` and requires Nix 2.30 or later with
`nix-command` and `flakes` enabled. Launch the desktop app with `t3code-desktop`;
the package also includes the `t3` command.

On NixOS, you can instead add the package to your system configuration, using
a nixpkgs revision that includes `t3code`:

```nix
environment.systemPackages = [ pkgs.t3code ];
```

Apply the change with `sudo nixos-rebuild switch`. For Home Manager, add
`pkgs.t3code` to `home.packages` and run `home-manager switch`.

Update a profile installation with `nix profile upgrade t3code`. For NixOS or
Home Manager, update your configuration's nixpkgs input or channel and rebuild.
Nix manages both the desktop app and the bundled
`t3` command; use Nix to update them.

### The `t3` command

The desktop app includes the `t3` command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
**t3 command**. On macOS and Linux it adds a `t3` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. If you already have `t3`
from npm, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it with a pairing URL.

Store links and QR codes are also available in **Settings → About → Mobile app**
on web and desktop. The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta releases](https://github.com/pingdotgg/t3code/releases?q=android-beta-).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew and
Chocolatey installs compare against the version their package manager offers,
which can trail the npm release; update Claude installed with Chocolatey
through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

### Create the Owner account

The first time a new server starts, the pairing URL it prints or opens asks you
to create the Owner account: enter your name, register a passkey, and save the
recovery codes. They are shown only once, and each one signs you in once if you
lose your passkey. After that the URL no longer creates accounts, and opening it
again says it was already used.

Once the Owner exists, opening the server's address in any signed-out browser
goes straight to sign-in; no pairing link or code is needed. A passkey works
only on the address you registered it on, so create the account from the address
you plan to keep using. Sign out from **Settings → Access**.

For devices without passkeys, add a password under **Settings → Access → Your
account**. You choose a sign-in name there too. The Owner must first set up an
authenticator app (1Password, Google Authenticator and similar) in the same
section, and then signs in with the password plus the app's six-digit code.
Adding, changing or removing a password or authenticator app asks you to
confirm it's you with your passkey or current password, and signs out your
other devices. After repeated wrong passwords or codes, sign-in pauses for a
while before you can try again.

### Your sessions

A browser sign-in lasts 30 days and renews each time you use it, so a device
you use regularly stays signed in. Tokens for apps, outside agents and scripts
last 30 days from when they were issued. **Settings → Access → Your sessions** lists your
browsers, devices and outside agents; revoke any of them there and its open
connections close at once. The Owner sees and can revoke every User's sessions.

The desktop and mobile apps sign in to a Hub through your browser; see
[Sign in to a Hub](./remote-access.md#sign-in-to-a-hub-from-the-desktop-or-mobile-app).
**Create link** in the same section is an optional shortcut: it makes a
one-time link or QR code that signs another device in as you. A link or
session created from the server's shell (`t3 pair`, `t3 auth session issue`)
belongs to the Owner.

If you lose every passkey and recovery code, run this in the server's shell:

```bash
t3 auth owner-reset --base-url https://hub.example.com
```

It prints a link that lets you register a new passkey. The link works once and
expires after an hour, and running the command again cancels the previous link.
Your old passkeys stop working and every signed-in device is signed out. Open
the link on the address you sign in on, since a passkey works only there. Anyone holding the link can take over the Owner account, so
don't share it.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Spaces and organizations

Every project and thread belongs to a Space: your Personal space or an
organization. Pick the current Space from the selector at the bottom of the
sidebar; new projects and threads go there, and a thread started in a project
joins that project's Space. Each person's choice is remembered in their browser. The Owner creates organizations from the same
selector with **Create organization**.

The sidebar lists only the projects and threads of the current Space. The thread
you have open stays listed even if it belongs to another Space, and the current
Space does not change by itself. Turn on **All Spaces** next to the sidebar
search to list every Space at once; the choice is remembered per person in the
browser. Without Spaces, such as on a local install, the sidebar lists everything.

You see the projects and threads of your Personal space and of every
organization you belong to, whoever created them, and nothing else. Work in an
archived organization disappears for its members. The Owner sees everything.

### Personal spaces and Installation permissions

A Personal space is yours alone, but it stays hidden until the Owner allows it.
The Owner opens **Users and permissions** from the Space selector and turns on
**Use their Personal space** for a person; it shows up in that person's selector
at once, and turning it off hides it again, along with what is in it. **Register
their own Environments** is stored for a later release and changes nothing yet.

The Owner can see every Personal space: the selector lists them under **Personal
spaces (read only)**, and the Owner reads them but changes nothing in them. The
selector reminds you of this while your Personal space is the current Space.
Nothing in a Personal space is shared with anyone else: no invitations, no guest
links; to share work, it has to move to an organization.

### Disabling and removing people

In **Users and permissions** the Owner can **Disable** a person: they are signed
out everywhere at once (browsers, the desktop and mobile apps, outside agents and
`t3` tokens), their pending reset links, pairing codes and invitations stop
working, their running agent turns stop, their scheduled tasks pause (the Owner
can delete them), and signing in tells them the Owner disabled the account.
They stay in their organizations; **Turn back on** lets them sign in again and
resumes the tasks that were paused.

**Remove** is for good and asks you to type their sign-in name. On top of
disabling, it takes them out of every organization (what they made there stays),
takes back every vault you allowed them, and freezes their Personal space: it is listed for the Owner as "name (removed)"
under **Personal spaces (read only)**, nobody can add to or change it, and the
Owner can only read it, move its projects to an organization, or delete what is
in it. Their name stays on what they did. The Owner
cannot be disabled or removed.

### Audit log

The Owner can see who did what in the sensitive actions: open **Audit log**
from the Space selector, or from **Settings → Access**. It lists invitations
created, accepted and revoked, Role changes, people removed or leaving an
organization, reset links, Installation permissions, people disabled, turned
back on or removed, organizations archived, restored and deleted, projects
moved and deleted, threads deleted for good, guest links, and the app and
outside-agent sign-ins you approved, plus tokens and Owner reset links issued
from the Hub's shell with `t3`. Each entry names the person, the space, what
they acted on and when; filter by action, person or space. Entries are kept
for good, and none contains a token, password or code.

What you can change depends on your Role in the organization:

| Action                               | Admin | Member |    Guest     |
| ------------------------------------ | :---: | :----: | :----------: |
| Start threads and continue your own  |  yes  |  yes   |     yes      |
| Continue someone else's thread       |  no   |   no   |      no      |
| Create projects                      |  yes  |  yes   |      no      |
| Archive your own                     |  yes  |  yes   | threads only |
| Archive or stop someone else's       |  yes  |   no   |      no      |
| Pin, settle or snooze someone else's |  yes  |   no   |      no      |
| Permanently delete what is archived  |  yes  |   no   |      no      |
| Create guest links                   |  yes  |   no   |      no      |
| Invite as Member or Guest            |  yes  |   no   |      no      |
| Change Roles or remove (not Admins)  |  yes  |   no   |      no      |

On a teammate's thread the composer explains that only its creator can continue
it, and that holds for the Owner too; start a new thread in the same project to
build on their work. A thread's terminals, previews and app tools are its
creator's too, and a Guest opens terminals only in their own threads' folders.
Agents act with the permissions of the person whose thread they run in. Guest
links are never made from a Personal space. Everything else here, the Owner can do
everywhere.

### Back up the master key

Every secret the Hub stores (sign-in keys, provider and source-control
credentials, the SSH key kept for updates) is encrypted with a master key kept
in its own file, `master.key` in the Hub's state folder. A copy of the disk or
of a backup without that file reveals none of them, and without it they are
lost and everyone signs in again. Until you back it up, **Settings → Access**
warns «Back up the master key»: **Download master key backup** asks for your
passkey (or password and code) and saves it, then asks you to type the first 8
characters of the key from the saved file; the warning clears only then. From
the Hub's shell:

- `t3 secrets key export --output <file>` writes it to a new owner-only file;
- `t3 secrets key import <file>` (Hub stopped) restores it, for example on a new
  server after copying the state folder; a key that does not open the secrets
  there is refused;
- `t3 secrets key rotate` (Hub stopped) re-encrypts everything with a new key and
  keeps the old one as `master.key.previous` until you delete it.

To keep the key off the disk you back up, set `T3CODE_MASTER_KEY_FILE` to its
absolute path. The key must be readable by you alone (`chmod 600`); a read-only
secret mount owned by root that others cannot read (`0440`) is accepted too, and on a file system without
permissions (WSL's `/mnt/c`, some NFS) set
`T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1`, which warns at every start. A Hub
started with a missing or different key refuses to start and says why; it never
makes a new key over encrypted secrets.

### Invite people

To add someone to an organization, switch to it in the Space selector, choose
**Invite people**, pick a Role and press **Create invite link**. Admins invite
Members and Guests; only the Owner invites Admins. Copy the link and send it over
any chat app: it is shown only once, works once and expires after 7 days. The same
dialog lists every invitation with its status (pending, accepted, expired or
revoked) and has **Revoke** for pending ones.

Opening the link shows the organization, the Role and who invited you, and tells
you that the Owner can see your Personal space. Enter your name and create your
account with a passkey, or with a sign-in name and password. An Admin who picks a
password also sets up an authenticator app on the same page. You land signed in,
in that organization. If you are already signed in, **Accept invitation** adds
the organization to your account instead. The mobile app cannot accept
invitations yet; open the link in a browser. Someone you invite starts in your
organization, not in the Owner's setup.

### Manage members

Switch to the organization and choose **Organization settings** in the Space
selector. Everyone in it sees who belongs and with which Role. Admins change
Members' and Guests' Roles and remove them; only the Owner names Admins, changes
them or removes them. Whoever is removed or leaves loses access at once, on every
open device, and what they created stays in the organization. To come back they
need a new invitation. **Leave organization** at the bottom of the dialog lets
anyone but the Owner leave.

An Admin needs a passkey, or a password together with an authenticator app.
Someone made Admin who signs in with only a password stays a Member until they
add an app: the sidebar shows **Set up an authenticator app to become Admin**,
which opens **Settings → Access**. Someone with a passkey is an Admin at once,
signs in with the passkey, and their password works only once they add an app.
Invitations an Admin made end when they are removed or are no longer an Admin,
and so do the guest links they created.

Someone who can't sign in anymore can ask the Owner for a reset link: **Reset
link** next to their name in **Organization settings** creates one. It works once
and expires after an hour. Opening it lets them register a new passkey, or choose
**Set a new password instead**; either way their old passkeys, password and
authenticator app stop working and every device is signed out. Anyone holding the
link can take over the account, so send it only to them.

### Archive, restore or delete an organization

The Owner can pause an organization: in **Organization settings**, **Archive
organization** hides it from its Members at once, on every open device, stops its
running threads and keeps its scheduled tasks from running. Nothing new starts in
it, not even from the Owner. The Owner still sees it in the Space selector under
**Archived**, where **Restore organization** brings it back as it was. Only an
archived organization can be deleted: **Delete organization** asks you to type its
name, then deletes its projects, threads, members and invitations for good, and
its own vaults with their secrets. Vaults of the Owner's that it was allowed keep
their secrets and only lose that organization.

### Move a project to another Space

In **Settings → Projects**, a project you may move shows **Move to another Space**
with a **Move to…** list of the Spaces it can go to. You need to be an Admin where
the project is (or its owner, for your Personal space) and an Admin where it goes.
The Owner can move any project, except into or out of someone else's Personal
space, which the Owner only reads; a removed user's frozen Personal space is the
exception, and the Owner can move projects out of it. All its threads move with it,
and who can see it changes at once. Stop its running threads first: the move is
refused while any of them runs, and says which. In the new Space the project uses
that Space's vaults and AI accounts. Before you confirm, the dialog lists the
vaults its threads stop receiving; the project's own vault choices that the new
Space is not allowed are dropped, so allowing such a vault there later does not
bring it back by itself.

### Join a machine to your Hub

Your PC, laptop or another server can become one of the Hub's Environments, so
work can later run there. On that machine, run:

```bash
t3 join https://hub.example.com
```

It prints a link to the Hub's **Register this machine** page and opens it in a
browser on that machine; add `--no-browser` to only print it, and open the link
on any device, your phone included. Sign in with your own account, check the
operating system, hostname and request time, change the name if you like, and
confirm with your passkey, or your password and authenticator code. Back on the
machine, `t3 join` says who approved it (`Approved by Grace (grace) as their
personal machine. Register it as theirs? [y/N]`); answer `y` only if that is
you, since anyone who saw the link could have approved it. Without a terminal,
add `--owner <your sign-in name>` (or your user id if you sign in only with a
passkey): the machine is registered only if that user approved it. The Owner can add machines, and so can any
user the Owner gave **Register their own Environments** in **Users**; without
it the page says so. The machine becomes the personal machine of whoever
approved it: only they run work on it, in any of their Spaces. Other users never
see it; the Owner sees every machine but runs nothing on someone else's. Each
user sees their machines in **Settings → Environments**, where they rename and
remove them. Taking the permission away stops new machines but keeps the ones
already joined; turning a user off or removing them also removes their
machines. The Hub's address must be `https://`; plain `http://` is accepted
only for a Hub on the same machine.

Joining a server that already has its own users or threads cuts them off, since
a joined machine serves no sign-in; `t3 join` refuses unless you add `--force`.

Then start the joined machine's server with `t3 serve` (or restart it). A
joined machine serves no web app and no sign-in of its own: it keeps one
connection out to the Hub, so you open no ports, and it reconnects by itself
after a reboot or network drop. `t3 status` shows its Hub and whether it is
connected; `t3 leave` removes it from the Hub.

In the desktop app you can do the same without a terminal: in **Settings →
Environments**, under **This app**, turn on **Use this computer as an
Environment**, enter the Hub's address and choose **Join**. The approval page
opens in your browser; once you approve, the app shows who approved it: choose
**Register as theirs** if that is you (or **Not me**), and it starts this computer's
Environment server by itself and shows whether it is connected. It runs apart
from the app's own local environment, in the `joined-environment` folder of
the T3 home, and the app stays connected to your Hub as before. Turning the
setting off stops that server and turning it on starts it again; it also starts
with the app. With **Keep running when the window is closed** on, closing the
window keeps the app, and this computer's Environment, running; quit the app to
stop it. **Leave** removes this computer from the Hub.

In **Settings → Environments**, **Machines on this Hub** lists every machine
with its status (online, reconnecting or offline; a Sandbox is running, stopped,
starting or failed to start), how it is used (Sandbox of a Space, dedicated to a
Space, or someone's personal machine), when it was last seen, its
providers and their versions, and its free CPU, memory and disk. **Rename**
changes its name; **Remove** disconnects it at once and its credential stops
working, so a lost machine loses access immediately. The Hub machine itself is
always listed and cannot be removed. Joining, renaming and removing are recorded
in the audit log. On mobile, the Owner sees the same list, read-only, under
**Settings → Environments**, with each machine's use, Space and status.

### Run Threads on a joined machine

When your Hub has another machine, the composer of a new Thread shows an
**Environment** picker. Pick the machine and send: the agent, its checkpoints and
the Project's files are on that machine, while the conversation, approvals and
diffs stream to every client through the Hub. The Thread's header shows where it
runs and whether that machine is online, reconnecting or offline, and so does the
sidebar for Threads off the Hub machine; both change on their own when the machine
drops or returns (a machine shows **Reconnecting** at once and **Offline** about a
minute later). A machine that is offline, or that lacks the selected provider, is
listed but can't be picked, with the reason. Only the machine's owner can run
Threads on it; everyone else runs on the Hub machine.

Your apps connect only to the Hub, never to the machines themselves: one sign-in
shows every Thread, whichever machine runs it, and a Thread's link (`/<thread>`)
stays the same wherever it runs. Older links that also named an environment still
open the Thread.

To skip the picker, open the Project's settings and set **Preferred environment**
to a machine you can use. New Threads in that Project start there unless someone
picks another machine in the composer; a person who can't use that machine starts
on the Hub machine instead.

The machine works in its own copy of the Project, under its `projects` folder in
the T3 home. The first Thread there clones it from the Project's `origin` remote
on the Hub; a Project without one must already be checked out on the machine.
New worktrees can't be made on a joined machine yet, so start such Threads in
the Project's checkout (moving a Thread that has one, below, makes it there). Each machine uses the provider sign-ins it already has.
**Settings → Environments** counts the Threads running on each machine.

After each turn the machine uploads the turn's checkpoint, with your uncommitted
changes, to the Hub, which keeps its own git repository per Project. Turn and
Thread diffs then open even while that machine is off, and undoing a turn works
there from the Hub's copy. Until the upload finishes the turn's changed files
say **Checkpoint not uploaded yet**; a failed upload retries by itself, and right
away when the machine reconnects. The Hub's repository is separate from your
own remotes: checkpoints are never pushed to `origin`. A machine can only reach
the repositories of Projects its owner works in, and loses access as soon as it
is removed.

A Thread's terminals, its Files panel, file search and previews open on the
machine it runs on, in that machine's copy of the Project. When the machine is
off they say **Environment offline** instead; nothing you type or save is kept
for later, so start the machine and try again.

### Run Threads in your Space's Sandbox

Every Space has a **Sandbox**: a server of its own that the Hub runs for that
Space, with its own files, Project checkouts and provider sign-ins. The Hub
itself runs no agents: a Thread you start without choosing a machine runs in its
Space's Sandbox (or on the Project's **Preferred environment**, while that one
can take it). The composer's **Environment** picker lists it as **<Space> Sandbox** (for example
**Acme Sandbox**) beside your machines. The first time, the
Hub creates the Sandbox, and later Threads reuse it. Threads that ran on the Hub
machine before Sandboxes say **Needs an environment**; move them to the Sandbox
or one of your machines to go on.

Sandboxes need Podman on the Hub's machine (see below). Until the Hub can run
them they are not listed, and a new Thread can only run on a machine of your
own: the composer says **No Environment can run this Thread** with the reason
(for example that the Hub has no Podman, or does not listen on loopback only)
until you pick one. A Sandbox stops by itself
after 30 minutes with no turns, open terminals or previews
(`T3CODE_SANDBOX_IDLE_SECONDS` on the Hub changes it), and starts again when you
send a message, open a terminal or browse its files; meanwhile the Thread says
**Starting the Sandbox…**. If it cannot start, the Thread says why with **Try
again**.
Only Admins and Members of the Space can run Threads there (not Guests), and
only that Space's Threads run in it; another Space's Sandbox never shows in the
picker. A Sandbox reaches only its own Space's repositories on the Hub. Turns,
checkpoints, terminals and moves work as on a joined machine.

To run Sandboxes, the Hub's machine needs:

- **Rootless Podman** 3.4 or newer with `slirp4netns`, and subuid/subgid ranges
  for the user the Hub runs as (`/etc/subuid`, `/etc/subgid`).
- **The Sandbox image**, `localhost/t3code-sandbox:<version>` (or another one
  named in `T3CODE_SANDBOX_IMAGE`), built as below.
- **A Hub that listens on loopback only.** A Sandbox's container can reach every
  other address of the machine, so start the Hub with `T3CODE_HOST=127.0.0.1`
  and publish it through a reverse proxy (or `t3 up`). A Hub listening on
  `0.0.0.0` or a LAN address runs no Sandboxes, and `t3 serve` warns at startup
  when Podman is there but Sandboxes are off for that reason.

Each Sandbox has CPU, memory, process and disk limits: the Owner sets the
defaults (2 CPUs, 4 GiB of memory, 4096 processes, 20 GiB of disk to begin with)
and a Space's own in **Settings → Environments → Sandboxes**, which also shows
each Sandbox's status, uptime, use and image, and lets the Owner start, stop
and restart it; a Space's Admins see their Sandbox there too. A Space whose
Sandbox runs only on a dedicated machine has a row there too, where the Owner
changes its limits. CPU, memory and
process limits apply on the Sandbox's next start, and Podman enforces them only
when the Hub runs in a systemd user session (with `dbus-user-session`
installed): otherwise Settings shows **Limits not enforced on this host** and
why. The disk limit is the Hub's own: a Sandbox whose files go over it stops,
its running turns end saying so, and its Threads say its disk is full until the
Owner raises the limit and starts it again. The Hub checks every minute, so a
Sandbox can briefly go past its limit: keep the Sandboxes' folder
(`<Hub home>-sandboxes`) on a disk of its own (or a size-capped mount) so it can
never fill the disk the Hub keeps its data on. Whatever the limits, no Sandbox
runs while that disk has less than 5% (at most 10 GiB) free. A Sandbox the Owner
stops from Settings stays stopped until someone starts it.

Each Sandbox runs in a container of its own, with no access to the Hub's
files, other Sandboxes, or anything on the machine's loopback. It reaches the
internet, and the Hub only through a private socket. A Sandbox clones a
Project from the Project's own remote, so use a remote it can reach over the
internet.

#### The Sandbox image

Every Sandbox runs the same image: Debian with Node, git, ripgrep and common
build tools, the CLIs of Claude Code, Codex, OpenCode, Pi and Grok, and the T3
server of the Hub's own version. Build it on the Hub's machine with:

```bash
t3 sandbox image build
```

or, as the Owner, with **Build image** in **Settings → Environments → Sandbox
image**, which shows the build's output as it runs and why it failed if it
did. The first build downloads a few gigabytes and takes several minutes;
later ones reuse most of it. A Hub that started before the image existed runs
Sandboxes once you restart it.

The same section shows the version each Sandbox runs. After a new build, a
stopped Sandbox uses it from its next start. A running one keeps its image
until you choose **Update** beside it; the Hub refuses while a turn is running
there and says so, so updating never interrupts work. Provider sign-ins live
in the Sandbox's own files, not in the image, so they survive every update.
Each build and update is recorded in the audit log.

### The AI gateway

The Hub runs its own copy of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
which later lets agents use the AI accounts you share. It runs only the releases this version
of T3 Code pins, each checked against a checksum kept in T3 Code itself, on the Hub's loopback
address, where only the Hub reaches it. Nothing to install or configure. A machine joined to a
Hub never runs one.

**Settings → AI gateway** shows whether it is running, its version and uptime as they change.
When a T3 Code update pins a newer release, **Update to …** starts it beside the current one
and switches once it answers; **Roll back to …** returns to the one before, and stays there
until you update again. Both are recorded in the audit log. In the desktop app, and on a Hub
run from source (`vp run dev`), the gateway is off until you choose **Turn on** there;
`T3CODE_AI_GATEWAY=managed` or `off` decides instead, on any Hub.

### Dedicate a machine to an organization

A server of your own, such as a VPS, can serve a whole organization instead of
one person: every Admin and Member of that organization can run its Threads
there, and nobody else sees it. On that machine, with rootless Podman and the
Sandbox image built there (`t3 sandbox image build` on that machine, as for
Sandboxes, above), run:

```bash
t3 join --dedicated Acme https://hub.example.com
```

`t3 join` checks Podman and the image first, and says how to build the image
if it is missing. Open the link as the Owner: under **Used by**,
**Everyone in Acme (dedicated)** is already chosen (only the Owner is offered
organizations; anyone else registers machines only as their own). Confirm, and
back on the machine answer `y` to `Approved by … as a machine dedicated to
Acme. Register it for Acme? [y/N]`. Then start it with `t3 serve`: it runs the
organization's work inside a Sandbox container, with the same isolation as the
Hub's Sandboxes, so the agents see none of the machine's own files or users.
`t3 status` shows whether that container is running. The container can reach
any service the machine listens to on an address other than `127.0.0.1`, so
it starts only when there is none: bind such services to `127.0.0.1`, or list
the ports the organization may reach in `T3CODE_DEDICATED_HOST_PORTS` (for
example `T3CODE_DEDICATED_HOST_PORTS=22`). `t3 status` names any it found.

The organization's Admins and Members see it in the composer's **Environment**
picker for that organization's Threads, and can make it a Project's
**Preferred environment**; Guests see it but run nothing there, and other
organizations never see it. New Threads never land on it unless someone picks
it or the Project prefers it.

In **Settings → Environments** the Owner's **Change use** makes a machine
personal again, or dedicates it to another organization. It works only once no
Thread is on the machine: otherwise it names the Threads to move (or delete)
first; archived Threads there don't block it, and need another Environment
when unarchived. The organization's work files on the machine are deleted
with the change, so no other organization or owner ever sees them. Each change
is recorded in the audit log. A dedicated machine follows the change by itself;
a personal machine dedicated this way stops taking work until you restart its
server with `t3 serve`, which then runs that work in a Sandbox container. If
the organization is deleted, the Owner can still rename or remove the machine,
and it runs nothing.

### Add a machine over SSH

Instead of running `t3 join` on a server yourself, the Owner can let the Hub do it. In
**Settings → Environments**, **Add over SSH** asks for the machine's host, port and user (not
`root`), a private key (with its passphrase, if it has one) or the Hub's own SSH agent, the
organization to dedicate it to, its name, and the Hub's address as that machine reaches it.

**Connect** shows the machine's host key: compare it with what
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the machine, then **Trust this key
and install**. Each step shows its output as it runs:

1. **Check the system and Podman.** The machine must run Linux. With systemd, the user needs
   lingering (so the service runs while nobody is logged in): the Hub turns it on if it may,
   otherwise it stops and says what to run as root (`loginctl enable-linger <user>`). If Podman is
   missing and the user can use `sudo` without a password, the Hub installs it; otherwise it stops
   and says what to install. Nothing is installed before these checks pass.
2. **Install T3 Code**, this Hub's version (from your release source, `T3CODE_RELEASE_BASE_URL`),
   and build the Sandbox image there.
3. **Register the machine**, dedicated to the organization, with a one-time grant: nothing to
   approve.
4. **Start its service** (`t3 service install`), and wait until it reaches the Hub.

If a step fails, or you press **Cancel installation** (closing the dialog cancels too), the run
stops there, stops what that step was still doing on the machine, shows that step's output, and
leaves no machine registered; fix the cause and **Try again**. What was already installed there
stays (the output says what, and how to remove it). The key is used for that
run only and forgotten, unless you tick **Keep the key for updates**: then the Hub keeps it in its
secret store until you remove the machine. A machine already installed is not installed again
(remove it first), and a later run to that address that shows another host key is refused. The
registration is in the audit log as `environment.register`, via `ssh`, with the host and never the
key. The Hub never connects to link-local addresses (such as a cloud's metadata service at
169.254.169.254), nor to its own machine (`localhost` or any of its addresses): an organization
there has its Sandbox already.

### Move a Thread to another machine

To go on with a Thread elsewhere, open its menu (its title in the header, or
right-click it in the sidebar) and choose **Move to another Environment**. The
dialog lists the machines you can use with their status, and explains what will
happen; pick one and choose **Move Thread**. If a turn is running you choose
between **Wait for the turn to finish** (the default) and **Stop the turn**.

The Thread's header and the dialog show each step: finishing the turn (or waiting
for your answer, when the turn asked you something), uploading a final checkpoint,
fetching it, preparing the workspace, and ready. **Cancel move**, in the header or
the dialog, stops it before it switches; the Thread stays where it was. While a
Thread moves it takes no new messages, and messages already queued start on the
new machine. When the machine it leaves is online it first uploads everything in
the workspace, including changes you made by hand. On the new machine the Thread
gets a worktree of its own (your shared copy of the Project there is never
changed), with its branch, the files from the checkpoint, and the Project's setup
script run in it, which also rebuilds ignored files such as dependencies; the
script's output shows in the Thread. If the old machine is off, the move continues
from the last checkpoint it uploaded and says which turn that was. A branch the
new machine had with commits of its own is kept under a `refs/t3/recovered/...`
ref there and named in the dialog, never thrown away.

The Thread's link stays the same, and its timeline shows **Moved from Laptop to
Hub machine** (with who moved it and what it continues from). The next turn runs
on the new machine in a fresh session, which starts with a handoff: short notes on
what was done and what is next, written by the Thread's provider on the old machine,
followed by the Thread's most recent messages (long ones cut). When the old machine
is off, the Hub machine writes the notes for the Owner's own Threads; for anyone
else's Thread the notes are assembled from the history instead, so your
conversation is never sent with another person's provider account. Keys, tokens
and passwords that look like ones are blanked out first. The agent is told the
notes may be wrong and to check them, and it can search and read the whole
conversation with its `thread_history` tool, which reads only this Thread. The
timeline shows **Handoff to Desktop** with who wrote the notes; open it to read
exactly what the new agent was told. Writing the notes is one model call; if it
fails or takes over three minutes, the move still goes on with notes assembled
from the Thread's history (its last requests and reply and the files it changed),
and the timeline says why. A Thread that stays on its machine resumes its own
session as always, with no handoff. If a
step fails, the Thread stays on the machine it was on and
the dialog says which step failed and why. Only one move of a Thread runs at a
time, only the Thread's creator can move it, and the audit log records each move.

A Thread without a project works the same way. It can start on a joined machine,
in its own folder there (under the machine's `projects/scratch`), and its
checkpoints go to a repository on the Hub of that Thread alone, which only the
machine running it can reach. Moving it takes its folder to the new machine,
with its branches and commits, and with no worktree and no setup script. Git
repositories nested inside the folder don't move, and the timeline says which.
Whatever the new machine's old copy of the folder had is kept under a
`refs/t3/recovered/...` ref, in that folder and on the Hub.

### When a machine goes away

If a Thread's machine drops while a turn runs, the Thread's header, its sidebar row
and the composer say **Paused, environment offline**. The machine keeps what the
agent does meanwhile and sends it when it reconnects, so nothing is lost or shown
twice: if the agent was still running, the turn simply goes on. If the machine's
T3 server stopped too, the turn ends as interrupted ("The agent on Laptop stopped
while Laptop was offline"); send a message to go on there, or move the Thread.
Messages you send to a paused Thread wait in its queue and start when the turn
ends there or once you move it. To move a paused Thread right away, choose **Stop
the turn** in the move dialog: **Wait for the turn to finish** waits for the
machine to come back.

When a machine that was off comes back with changes for a Thread that moved away
in the meantime (files you edited by hand in the Thread's own worktree there,
never uploaded), it puts them on a separate branch in the Hub's repository,
`refs/t3/recovered/<thread>/return/<time>`, and the Thread's timeline says
**Recovered changes from Laptop** with that branch. Nothing is merged and the
machine's own files are left as they are, so you can still bring the changes back
yourself from either place. A Thread that worked in the machine's shared copy of
the Project is not collected from there, since other Threads use it too: its
timeline says which folder on which machine may still hold changes.

**Remove** a machine and its Threads keep all their history but run nowhere: they
say **Needs an environment** and take no new messages until you move them (the
composer offers **Move to another Environment**). A turn that was running there
ends as interrupted.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T3 Code for everyone on a machine.
