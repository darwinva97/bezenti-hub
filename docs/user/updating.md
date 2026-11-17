# Updating T3 Code

This build of T3 Code never checks for or installs releases on its own. The
desktop app, the web app, the mobile app, and the server do not contact
upstream's release feeds, and there is no update button for T3 Code itself.
Provider CLIs still update as before; see **Update providers** below.

**User settings → About** shows the version you are running. **User settings → Machines** shows the version of each connected server.

## Install a new version

Install the new build yourself on each machine, the same way you installed it:

- **Desktop app:** quit the app, install the new build over the old one, and
  open it again. A desktop app also restarts its own server.
- **Command-line server:** stop the server, replace the `t3` executable, and
  start it again with your usual options such as `--host` or
  `--tailscale-serve`.
- **Background service:** replace `t3`, then run `t3 service install` with the
  new `t3`. It needs a release source (below) to unpack the new version.
- **Mobile app:** install the new build. The app does not download updates in
  the background.

`t3 service install`, the install scripts, the `t3` npm package, and connecting
the desktop app to a machine over SSH all need the `t3` release archive for
their version. They download it only from the
release source set in `T3CODE_RELEASE_BASE_URL`, laid out like a GitHub release
download: `<url>/v<version>/SHA256SUMS` and the `t3-<version>-<platform>`
archives beside it. A query on the URL, such as a signed token, is kept on
every file. Without that setting they work only for a version already unpacked
in T3 home (the install script unpacks it there), fail with a message
otherwise, and download nothing.

Update the machines that run your servers along with the apps you use. Saved
threads, settings, and project files are kept.

## Before you update

Restarting a server interrupts active agents and terminal commands.

**User settings → Machines → ‹machine› → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice naming the machine to
  update.
- A server newer than your app refuses the connection with an update message.

Install the matching version on the side the notice names, then reconnect.

## If a server does not start

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

If the desktop app's server keeps failing at startup, T3 Code shows a "T3 Code
could not start" window instead of the app. Use **Copy details** to keep the
error, then reinstall the version that last worked.

## Update providers

**User settings → Machines → ‹machine› → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

Providers installed with npm check for updates through the server's own npm, so
the checks use npm's configured registry, authentication, and proxy settings.
Providers installed with Homebrew or pnpm check through those tools.

After a successful provider CLI update, T3 Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest T3 Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

On a phone, open **User settings → Machines** and select an environment to
refresh provider status and update supported providers. Provider update checks
and restart continuation preferences are in **User settings → Machines → ‹machine› → Maintenance**.
