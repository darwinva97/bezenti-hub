# MCP servers and Skills

A Space can keep its own MCP servers and Skills. Every Thread of the Space gets them, on whichever
machine it runs, so nobody installs them by hand.

## Add an MCP server

In Space settings → **MCP servers & Skills**, Owners and Admins of an organization add MCP servers
(in a Personal space, its owner does). Give it
a name and either a command to run (stdio) or a URL (http), with its arguments, environment
variables or headers.

Never paste a token. Put it in the Space's Vault and write `${NAME}` where it goes, for example a
header `Authorization: Bearer ${GITHUB_TOKEN}`. Each Thread fills it in when its agent starts, from
the Vault entries that Thread receives. A value that looks like a credential is refused when it is
typed in directly.

Members and Guests see each server's name and whether it is on, never its settings.

## Find one in the MCP Registry

Instead of typing it in, search the official [MCP Registry](https://registry.modelcontextprotocol.io)
from **Add MCP server** (on a phone, from **Add from the MCP Registry**). Choosing a result fills in
its command or URL, arguments, variables and headers; nothing is saved or run until you check them
and save. A server reached by URL is offered before one that runs a command, and a command is shown
in full. Secret values arrive as `${NAME}` references, so add each named entry to a Vault group the
Space receives before saving. The server's row says which registry entry it came from; turn it off
or delete it like any other.

The Hub asks the registry for you. An Owner who does not want the Hub to reach it starts the
server with `T3CODE_MCP_REGISTRY_URL=off`.

## When a server is unavailable

If a Thread does not receive an entry a server uses (the group is not chosen, a loan ended, a
dynamic secret could not be issued), the server is left out of that Thread instead of starting
without it. The Thread says which server and which names are missing. A server is also left out on
an agent that cannot take it: Claude, Codex, Grok, Kiro and OpenCode take Space MCP servers;
Cursor, Antigravity and OpenCode v2 do not yet.

Turning a server off, changing it or rotating a Secret it uses reaches each Thread at its next turn.

An agent can ask with `list_space_tools` what its Thread got. Each server is either available or
unavailable with a reason:

- **not-delivered**: the Thread does not receive the names listed.
- **not-supported**: the Thread's agent does not take Space MCP servers.
- **no-secrets**: the agent cannot receive Vault entries, and the server uses one.
- **outdated-machine**: the Thread runs on a joined machine whose T3 Code is too old. Update it.
- **not-in-session**: the Thread has not started a session yet, or the server changed after it
  started. Its next turn decides.

On Claude, an available server also shows how it connected: `connected`, `pending`, `needs-auth`
(the server wants a sign-in the Hub cannot give it; use a token in a header instead) or `failed`.
The error itself is not shown, because it can contain the server's address and credentials.

## Add a Skill

A Skill is a `SKILL.md` (its frontmatter needs a `name` and a `description`) and any files it uses.
It can list the Vault names it expects, so a Thread that lacks one says so. Skills never hold
Secrets. Claude receives a Space's Skills, shown as `space:<name>`; other agents keep using the
Skills found on their machine.

## Lend one

Choose **Lend…** on its row to lend it to another Space with a Grant, like a Vault group. See
[Lending resources](lending.md).
