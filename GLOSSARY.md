# Bezenti Hub

A self-hosted, multi-user extension of T3 Code: one Owner runs one installation for themselves and the people who work with them, giving each scoped access to projects, threads, AI accounts, vaults and environments. Base T3 Code vocabulary lives in `docs/internals/glossary.md`; a term defined here overrides it.

## Language

**Installation**:
One self-hosted deployment of this product, with exactly one Owner.
_Avoid_: Tenant, instance, workspace

**Owner**:
The single person who runs the Installation and holds every permission in it.
_Avoid_: Superadmin, root

**Makita**:
The Hub's GitHub bot teammate: a normal GitHub account, registered once by the Owner, behind which a Hub agent answers issues in the repositories a Makita configuration listens to. Its work runs as the configuration's creator; its token never leaves the Hub. Only the bot is called Makita, never the product.
_Avoid_: the bot account, GitHub App, Makita principal

**Makita configuration**:
What one person who may use Makita in a Space set up for it: which repositories it listens to, whom it answers (by numeric GitHub id), with which of their AI accounts and model, and what it may do.
_Avoid_: Makita setup, bot config, webhook

**User**:
A person with a sign-in on the Installation's Hub.
_Avoid_: Account, cuenta (reserved for AI accounts), usuario

**Hub**:
The central server of an Installation and the source of truth for Users, permissions, AI accounts, vaults, Projects and registered Environments. It never runs agents itself.
_Avoid_: Control plane, main server, master

**Space**:
The place a Project or Thread belongs to: exactly one Organization or one Personal space, never both.
_Avoid_: Scope, area, folder

**Organization**:
A Space shared by its Members. It owns the Projects and Threads created in it and is granted vaults, AI accounts and Environments. Only the Owner creates Organizations.
_Avoid_: Organización, team, workspace, tenant

**Personal space**:
The private Space every user has. Creating in it is a permission; nothing in it is shared directly with others, though the Owner can see it.
_Avoid_: Libre, sin organización, my space, home

**Member**:
A user who belongs to an Organization. A user can be a Member of several Organizations.
_Avoid_: Participant, collaborator

**Role**:
The fixed set of permissions a Member has in one Organization. Each Member has exactly one Role per Organization; Roles are a closed set, not configurable.
_Avoid_: Rol, group, permission set

**Invitation**:
A single-use link the invitee must accept. An Organization's Invitation carries a Role and adds them to that Organization; accepting it creates their User if they had none. The Owner's Invitation to the Hub itself is a Platform invitation.
_Avoid_: Sign-up, registration

**Registration mode**:
The Owner's setting for who may get a new User when someone signs in with Keycloak: `open` (anyone, with no Organization), `invitation-only` (the default: an Invitation or a Keycloak group the Owner mapped) or `closed` (only a Platform invitation). It never touches existing Users.
_Avoid_: Sign-up policy, enrollment mode

**Platform invitation**:
The Owner's Invitation to the Hub itself, without an Organization or a Role: accepting it creates a User and nothing more, whatever the Registration mode. Single use, 7 days, revocable.
_Avoid_: Hub invitation, manual sign-up

**Environment**:
One running T3 server and the machine, filesystem, credentials and state it owns: a VPS, a desktop, a laptop.
_Avoid_: Entorno, machine, host, runner

**AI account**:
One subscription login (Claude, ChatGPT…) or one API key that only the Owner registers in the Hub and allows Spaces or Users to use.
_Avoid_: Cuenta, provider account, personal AI account, credential

**AI gateway**:
The Hub's single endpoint through which agents reach their AI accounts, so real credentials never leave the Hub.
_Avoid_: Proxy, CLIProxy, router, hub (for this meaning)

**Access key**:
A key to the AI gateway that a Space gives to someone, with or without a Hub account, with its own validity (and models and token caps). It is the Space's: it is not a User and never acts as one, and its use counts on the key.
_Avoid_: API key (for this meaning), User key, clave de acceso, guest key

**Vault**:
Each owner's (a User's or an Organization's) one set of entries, Secrets and Variables, each under an environment-variable name, whose values the Hub stores itself or reads from a Secret provider. It is made of Vault groups.
_Avoid_: Secret store, env file, bóveda

**Secret**:
A Vault entry whose value is a credential (token, password, key): it is written and replaced but never read back from the Hub, not even by the Owner, and every place the Hub shows history masks it.
_Avoid_: Credential (reserved for AI accounts), password

**Sealed secret**:
A Secret no one can reveal through the Hub, not even the Owner: it can only be replaced or deleted. Making it revealable again takes a new value.
_Avoid_: Hidden secret, locked secret, write-only secret

**Variable**:
A Vault entry whose value is configuration, not a credential (a URL, a region, a cluster name): anyone who sees the entry's name sees its value, and it is never masked.
_Avoid_: Plain secret, config var, env var (for the entry itself)

**Vault group**:
A named part of a Vault and the unit chosen per Space or Project and lent with a Grant. Every Vault has a `default` group, received by every Thread of its owner's Space and never deleted or renamed; the Owner's `default` was the Main vault.
_Avoid_: Folder, sub-vault, Main vault (now the Owner's `default`), Secret link (gone: a Grant shares a group)

**Secret provider**:
An outside system the Owner connects to the Hub that holds secret values the Hub reads on demand: OpenBao, HashiCorp Vault, 1Password, a cloud secret manager, a Kubernetes cluster's Secrets… Agents never hold its credentials; the Hub reads for them.
_Avoid_: Provider (alone: reserved for agent runtimes), backend, secret store, bóveda externa

**Provider scope**:
The part of a Secret provider the Owner lets one or more Vaults read: the role the Hub signs in with and the paths and dynamic roles it may name. A Provider entry stays within a Provider scope allowed to its Vault.
_Avoid_: Mount, policy, permission (those are the provider's own)

**Provider entry**:
A Vault entry whose value lives in a Secret provider: the Vault keeps only where to read it, and the Hub reads it when a process starts. It is never revealed through the Hub.
_Avoid_: Reference (alone), remote secret, link

**Dynamic secret**:
A Provider entry the Secret provider issues on demand with a lease and an expiry (a Kubernetes token, a database user, cloud keys), so each Thread gets its own and it stops working by itself.
_Avoid_: Ephemeral secret, temp credentials, rotating secret

**Lease**:
The Secret provider's record of one Dynamic secret issued for a Thread, which the Hub renews while the Thread uses it and revokes when the Thread no longer may.
_Avoid_: Session, grant, token (alone)

**Provider-backed vault**:
A Vault whose entries are the keys of one path in a Secret provider, listed and read from there instead of being added one by one in the Hub.
_Avoid_: Synced vault, mirror, external vault

**Template entry**:
A Vault entry whose value the Hub builds when a process starts from other entries of the same Vault, such as a kubeconfig or a `DATABASE_URL`.
_Avoid_: Computed secret, interpolation, derived variable

**Secret file**:
A Vault entry delivered as a file in memory on the Thread's machine, its environment variable holding the file's path instead of the value.
_Avoid_: Mounted secret, volume

**Workload identity token**:
A short-lived token the Hub signs for one Thread, naming its User, Space, Project and Thread, which outside systems (Kubernetes, OpenBao, cloud accounts) trust instead of a stored secret. It reaches the Thread as a Vault entry.
_Avoid_: OIDC token, ID token, JWT (as a name), service account token

**Space MCP**:
A third-party MCP server that belongs to a Space: a command (stdio) or a URL (http), with arguments, environment variables and headers. The Hub hands it to the provider of every Thread of its Space, and of Spaces it is lent to. Not the Hub's own MCP tools (`t3-code`).
_Avoid_: MCP (alone), configured MCP, plugin

**Space Skill**:
A `SKILL.md` with its frontmatter and supporting files, kept in a Space and handed to its Threads. It holds no Secrets; it may name the Vault entries it expects.
_Avoid_: Skill (alone, for one found in a machine's folders), prompt, plugin

**Vault reference**:
`${NAME}` in a Space MCP's value: the Vault entry of that environment-variable name, filled in on the Thread's machine when its process starts. The value is never stored with the MCP.
_Avoid_: Placeholder, secret ref

**Sandbox**:
An Environment the Hub runs on its own machine for exactly one Space, isolated from every other Space. It is where a Space's work runs when no other Environment is chosen.
_Avoid_: Container, VM, workspace, default environment

**External environment**:
Any Environment other than a Sandbox: a machine (PC, laptop, extra VPS) running a T3 server registered with the Hub. It is either personal, used only by the User who registered it in any of their Spaces, or dedicated to one Space and usable by all its Members.
_Avoid_: Remote, host, node, runner

**Thread**:
The durable conversation and work history a user drives with an agent. Every Thread belongs to a Space and its history is stored in the Hub; a Thread without a Project runs in its Space's Sandbox.
_Avoid_: Chat, conversation, session

**Active environment**:
The one Environment a Thread is running in at a given moment. Moving a Thread changes its Active environment.
_Avoid_: Current machine, host

**Project**:
A body of work, with its files and Threads, that belongs to one Space, is not bound to a single Environment and can be continued from different Environments.
_Avoid_: Proyecto, repo, workspace
