# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

Other devices reach the host over your local network, Tailscale, another VPN or
proxy you run, or SSH. This fork has no hosted tunnel.

## Sign in to a Hub from the desktop or mobile app

Once a Hub has accounts, the desktop and mobile apps join it by its address and
you sign in in your browser, with your passkey or your password (and code).
No pairing code is needed.

- **Desktop:** the desktop app connects to one Hub. Unless this computer is
  your Hub, first turn off **User settings → Machines → This computer → Local
  environment** (the app restarts). Then select **Add Hub** under **Hub**, enter
  its address (for example `hub.example.com`) and select **Sign in in browser**.
  Your default browser opens the Hub's sign-in page; after you sign in, select
  **Continue** and return to T3 Code. To run this computer's agents for that
  Hub, join it as a machine instead (`t3 join`, see
  [Join a machine to your Hub](./install.md#join-a-machine-to-your-hub)).
- **Mobile:** open **User settings → Machines → Add**, enter the Hub's address
  and tap the checkmark. The Hub's sign-in page opens inside the app; sign in,
  tap **Continue**, and the app takes over.

The app acts as you, with your access, and appears in **User settings → Sessions** on the Hub, where you can revoke it. Removing the Hub from the
app also signs that device out of it. On mobile, the thread list's filter menu
has a **Space** section for each Hub: new projects and threads you start there
go to that Space. A thread someone else started is read-only: you can read it,
but only its creator can send messages or answer its questions.

The browser hands the app a one-time code, never a session: on desktop it goes
to a port on this computer that the app opens for that sign-in only, and on
mobile to the T3 Code app's own link (`t3code://auth/callback`). The code works
once, for one minute, and only together with a secret that never left the app.
Only continue on a sign-in page you just opened from the app.

Pasting a pairing link into the address field, or scanning a pairing QR code on
mobile, still pairs as described below.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **User settings → Machines → This computer → Network**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, run:

```bash
t3 up --lan
```

On Linux and macOS, `t3 up` runs T3 Code as a [background service](./background-service.md).
The background service is not available on Windows, so there `t3 up` prints the
`t3 serve` command to keep running in a terminal. Run `t3 up` again to change
your choice, and `t3 status` to see it. `t3 status --json` prints the settings,
and `t3 up --help` lists every flag.

For a server in a terminal, run `t3 serve --lan`. Either way, T3 Code then
accepts connections from your local network and tailnet, so a pairing code is
all that keeps other devices on them out. Once the Installation has an Owner it
accepts any address, since every request then needs someone signed in.
Devices on your local network and tailnet can sign in and pair over plain HTTP;
from anywhere else it takes HTTPS, such as a
[domain behind a reverse proxy](./public-hub.md).

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **User settings → Machines**
on web and desktop and **User settings → Machines** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

On a computer with the desktop app, you can open the printed `t3code://pair`
app link instead. The desktop app asks you to confirm the server address, then
adds it.

If your HTTPS endpoint uses a certificate from your own certificate authority,
install that CA on Android as a **CA certificate** in its security settings; the
Android app then trusts it.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Sharing & access page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, or SSH. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list.
A pairing link for a saved machine is refused when it comes from an address
that machine does not have yet; add that address with **Add route** instead.
Pairing again over an address the machine already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once over Tailscale is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or the
[local network](./background-service.md#local-network-access) choice in `t3 up`.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**User settings → Machines** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **User settings → Machines** and
choose **Edit**.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Each paired route has its own session and may grant different
permissions.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **User settings → Machines → This computer → Network**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 --set-path=/ off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Web app

The Hub serves its own web app, so a pairing link opens on the endpoint's own
address. It does not make an unreachable backend reachable or convert HTTP to
HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **User settings → Machines → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **User settings → Machines → This computer → Network** on the host, or on a headless host with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the T3 home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Local servers

The browser lists ports held by processes your terminals and agents started.
T3 Code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; T3 Code checks that address and opens it as written.

To stop listing ports, set `T3CODE_PORT_DISCOVERY=0` in the environment that
starts the T3 Code server, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo t3 browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx t3 browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your T3 server runs as root, run it as a nonroot user to keep
sandboxing enabled. `t3 browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`T3CODE_SERVER_BROWSER_SANDBOX=0` in the **T3 server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve
```

For a systemd service, add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under
`[Service]` in its configuration, run `sudo systemctl daemon-reload`, then restart
your T3 service. Setting the variable in an agent's terminal does not change the
environment of an already running T3 server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents T3 Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **User settings → Sessions** lists your own sessions and
pairing links; the Owner sees every User's. Revoking an unused link prevents new
pairings; revoking a session removes that device's access and closes its open
connections. A device paired with a link signs in as the User who created the
link, and a link from `t3 pair` belongs to the Owner. Command-line management is
available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx t3 pair --scope orchestration:read --scope filesystem:read
```

The selected scopes replace the default permissions. The same option works with
`npx t3 auth pairing create` and `npx t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, and access
management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **User settings → Machines** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
