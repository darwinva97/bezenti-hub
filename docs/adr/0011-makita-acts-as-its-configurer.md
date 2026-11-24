# Makita acts as whoever configures it, with a token that never leaves the Hub

Makita is the Hub's GitHub teammate: a normal GitHub account (not a GitHub App) that the Owner registers once, behind which a Hub agent answers issues in the repositories a configuration listens to. Its work runs as the configuration's creator — their Thread, their AI account, their Space's rules — and Makita is a mark on that Thread, not a new kind of principal. Its GitHub token is sealed in the Hub's store and read only by the Hub's own GitHub client; no agent, machine, Vault or answer ever receives it. Everything Makita writes on GitHub is written by the Hub, after checking the configuration on the server.

## Considered Options

- **A GitHub App**: per-repository installation tokens and fine permissions, but it needs a public webhook route, an administrator of every repository to install it, and a second identity model; a normal account works wherever it is a collaborator.
- **A Makita principal in the Hub**: its own actor in AccessPolicy, CommandActor, the AI gateway keys and the audit, and someone to own its AI accounts — much more surface for the same result.
- **The token in a Vault, delivered to the agent**: the agent reads text anyone can write (issues, comments, CI logs); a token in its environment is a token waiting for its prompt injection.
- **Act as the creator, the token in the Hub** (chosen): every existing rule about a User (AI accounts per Space, Thread visibility, usage) applies unchanged, and the worst a hijacked agent can do with GitHub is ask the Hub for what its configuration already allows.

## Consequences

- Makita's Threads appear among their creator's, marked and filterable; their use counts on the creator and on the configuration.
- The Owner gives «may use Makita» per User and Space; a creator who loses it, leaves or is removed stops their configurations.
- The token's scopes are checked when it is saved: workflow, repository deletion and administration scopes are refused, so even a leaked token cannot change CI or repository settings.
- Every write on GitHub and every change to a configuration is in the audit log, with the configuration and, for actions on behalf of someone on GitHub, their login.
