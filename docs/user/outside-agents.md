# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once as you: it sees and does only what your account can, in the Spaces you
belong to, and you choose what it may do on top of that.

## Get the MCP URL

In **User settings → Machines**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host or any
  `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet, so it needs a public `https` address,
  such as your own reverse proxy. A Tailscale address only works from your own
  tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. If the browser is not signed in to the
Hub, the page asks you to **Sign in** first, then shows the request again. The
page says which account approves (“acting as …”): the agent acts as that User.
To approve from a browser that is not yours, choose **Use a pairing code
instead** and enter a code from **User settings → Machines → This computer → Network**; the agent then
acts as whoever created the code. A browser signed in as you only accepts a
code you created, so it never approves as someone else. On the Hub, `t3 auth pairing create --user
<sign-in name>` creates one for that User, and without `--user` for the Owner.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in the projects you can reach. A thread it starts or steers cannot run
  with more permissions than the mode you chose. What it creates belongs to you
  and to the Space you could create it in; where you could not, it is refused.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using a public
   `https` address for the environment.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in. It acts as the Owner, or as another User with
`--user <sign-in name>`:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

Tokens from `t3 auth session issue` and devices paired with `t3 pair` act as
the Owner too, or as `--user <sign-in name>`, so a script for a teammate sees
only their Spaces. A User who is disabled or removed cannot be chosen.

## Remove an agent

Approved agents appear in your sessions under **User settings → Machines → This computer → Network**,
like your other clients. Revoke one there to cut off its access immediately; the
Owner can revoke anyone's. A sign-in lasts 30 days; after that the agent asks
you to approve it again.
