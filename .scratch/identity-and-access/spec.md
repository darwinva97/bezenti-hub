# Spec: Identidad y acceso

Status: done
Map: ../multi-user-hub/map.md (spec 1 de 6)
Decisiones de origen: «Organizaciones y espacio personal», «Roles y permisos», «Inicio de sesión en el Hub», «Cierre del mapa» (`../multi-user-hub/issues/07`, `08`, `09`, `16`)
ADRs: 0001 (instalación autoalojada de un solo Owner), 0003 (Hub público con cuentas locales)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`

## Problem Statement

T3 Code no conoce a las personas. Cada servidor pertenece a un único usuario del sistema operativo, y quien se empareja recibe un token con permisos, no una identidad: por defecto, todos los permisos. El Owner quiere que su equipo trabaje en la misma Installation sin que nadie pueda ver o tocar lo que no le corresponde. Quiere repartir el trabajo en Organizations, dar a cada persona un Role, invitar con un enlace y que cada uno entre desde la web, el desktop o el móvil sin códigos de emparejamiento. Hoy nada de eso existe: no hay Users, ni Spaces, ni Roles, ni forma de saber quién hizo qué.

## Solution

El servidor del Owner pasa a ser el Hub de la Installation y tiene sus propias cuentas. En el primer arranque, la URL de administrative bootstrap crea la cuenta del Owner. A partir de ahí, el Owner crea Organizations e invita a personas con un enlace copiable que ya lleva su Role. Cada persona acepta la Invitation, crea su User y entra con passkey o contraseña. Owner y Admins necesitan passkey, o contraseña más TOTP.

Todo Project y todo Thread pertenece a un Space: una Organization o el Personal space de un User. Cada User ve y hace solo lo que su Role permite en cada Space, según una tabla fija. Su agente actúa con esos mismos permisos, nunca con más. Las sesiones pertenecen siempre a un User, duran 30 días renovables y cada uno puede ver y revocar las suyas. Las acciones sensibles quedan en una auditoría mínima.

## User Stories

### Arranque y Owner

1. As the Owner, I want the first-run bootstrap URL to open a "create the Owner account" screen, so that I own the Installation from the first minute.
2. As the Owner, I want the bootstrap URL to stop working once my account exists, so that nobody else can claim the Installation.
3. As the Owner, I want to register a passkey when I create my account, so that my account is protected from day one.
4. As the Owner, I want to receive recovery codes when I create my account, so that I can get back in if I lose my passkey.
5. As the Owner, I want a command I can run in the Hub's shell that issues a one-time reset link for my account, so that I never get locked out of my own Installation.
6. As the Owner, I want the Hub to be reachable on my own domain over HTTPS, so that my team can sign in from anywhere without installing Tailscale.

### Inicio de sesión y sesiones

7. As a User, I want to sign in with the Hub URL plus a passkey, so that signing in is one tap on a new device.
8. As a User, I want to sign in with a password as a fallback, so that I can still enter on a device that does not support passkeys.
9. As an Admin, I want to be required to use a passkey or a password plus a TOTP code, so that powerful accounts are never protected by a password alone.
10. As a Member promoted to Admin, I want to be asked to add a passkey or TOTP on my next sign-in, so that the stronger rule applies as soon as my Role changes.
11. As a User, I want to use the browser's "use a passkey from my phone" QR on a computer, so that I can sign in on a machine where my passkey is not stored.
12. As a User on desktop or mobile, I want to type the Hub URL and finish sign-in in the system browser, so that I never copy pairing codes.
13. As a User, I want my session to last 30 days and renew while I use it, so that I do not sign in every day.
14. As a User, I want to see my sessions (devices, browsers, outside agents) and revoke any of them, so that I can cut off a lost device.
15. As the Owner, I want to revoke any User's sessions, so that I can cut off access immediately.
16. As a User whose session is revoked, I want my open connections to close at once, so that revocation has immediate effect.
17. As a Member or Guest who forgot their password, I want the Owner or an Admin to give me a one-time reset link, so that I can recover access without email.

### Organizations, Personal spaces e Invitations

18. As the Owner, I want to create Organizations, so that I can split my team's work into separate Spaces.
19. As an Admin, I want to be unable to create Organizations, so that the Owner keeps control of the structure. _(Sustituida por el ticket 18: cualquier User crea Organizations y queda como su Admin.)_
20. As the Owner, I want to invite a person into an Organization with a copyable link that carries their Role, so that I can send it over any chat app.
21. As an Admin, I want to invite people as Member or Guest into my Organization, so that I can grow my team without bothering the Owner.
22. As an inviter, I want an Invitation to expire after 7 days, be single-use and be revocable before acceptance, so that a leaked link does little harm.
23. As an invitee without an account, I want accepting the Invitation to create my User, so that joining is one step.
24. As an invitee who already has a User, I want accepting to add the Organization to my existing User, so that I keep one sign-in for every Organization.
25. As an invitee, I want the acceptance screen to tell me the Owner can see my Personal space, so that I know what is private and what is not.
26. As a User, I want to belong to several Organizations and switch between them with a Space selector, so that I can work across teams.
27. As a User, I want to leave an Organization, so that I can stop working there.
28. As an Admin, I want to remove a Member or Guest from my Organization, so that people who left lose access.
29. As an Admin, I want to be unable to change or remove another Admin, so that only the Owner manages Admins.
30. As the Owner, I want to name and remove Admins of each Organization, so that I decide who runs each one.
31. As an Organization, I want everything a person created in it to stay in it when they leave, so that work is never lost with people.
32. As the Owner, I want to archive an Organization so it disappears for its Members and nothing runs, and restore it later, so that I can pause a team safely.
33. As the Owner, I want to permanently delete only an already archived Organization, so that deletion is never one accidental click.
34. As the Owner, I want to grant a User the Installation permission to create in their Personal space, so that only the people I choose work outside Organizations. _(Sustituida por el ticket 17: todo User tiene siempre su Personal space.)_
35. As a User without that permission, I want my Personal space to stay empty and hidden, so that I am not offered something I cannot use. _(Sustituida por el ticket 17.)_
36. As the Owner, I want removing a User from the Installation to freeze their Personal space and hand it to me, so that I decide whether to keep, move or delete it.
37. As the Owner, I want to see every User's Personal space, so that I keep oversight of my Installation.

### Projects y Threads dentro de un Space

38. As a User, I want every Project and Thread I create to belong to the Space I am working in, so that it is visible to exactly the right people.
39. As a User, I want a Thread without a Project to belong to my current Space too, so that loose chats follow the same rules.
40. As a Member, I want to see every Project and Thread of my Organization, so that I know what the team is doing.
41. As a Guest, I want to see the Organization's Projects and Threads and create my own Threads, but not create Projects, so that I can contribute without restructuring anything.
42. As any User, I want to continue only my own Threads, so that nobody speaks or spends in someone else's name.
43. As a User who wants to build on a teammate's Thread, I want to open a new Thread in the same Project, so that I can continue their work as myself.
44. As a Member, I want to archive my own Threads and Projects, and as a Guest my own Threads, so that I can tidy my work.
45. As an Admin, I want to archive other people's Threads and Projects and permanently delete archived ones, so that I can keep the Organization clean.
46. As an Admin, I want to stop a running Thread that belongs to someone else, so that I can halt runaway work.
47. As a User, I want to move a Project between Spaces when I am Admin in the destination and Admin or Personal-space owner in the origin, so that work can graduate from my Personal space into an Organization or back.
48. As a User moving a Project, I want to be required to stop its running Threads first, so that nothing is half-moved.
49. As a User, I want nothing in my Personal space to be shareable directly with others, so that sharing always goes through an Organization.
50. As an Admin, I want to create guest links (read one Thread for 24h) only inside Organizations, so that Personal spaces are never shared.

### Agentes

51. As a User, I want my agent to act with exactly my permissions in my Thread's Space, so that it cannot read or change what I cannot.
52. As a User, I want an outside agent (an MCP client such as Claude Code in my terminal) to sign in as me, so that it gets my permissions and nothing more.
53. As a User, I want `t3` CLI tokens to be issued to me and act as me, so that scripts follow the same rules.

### Auditoría

54. As the Owner, I want an audit log of Invitations, Role changes, secret reveals and edits, permanent deletions and Environment registrations, so that I can see who did what in sensitive actions.
55. As the Owner, I want every audit entry to name the User, the Space, the action and the time, so that entries are useful without digging.

## Implementation Decisions

### Modelo de datos (nuevas tablas, migraciones a partir de la 080)

- **Users**: id, display name, login name, created/disabled/removed timestamps, `isOwner` (exactly one).
- **User credentials**: password hash (argon2id), TOTP secret (encrypted at rest with the server's secret store), WebAuthn passkeys (credential id, public key, sign counter, transports, label), Owner recovery codes (hashed, single-use).
- **Spaces**: id, kind (`organization` | `personal`), name, `personalOwnerUserId` for personal spaces, `archivedAt`, `frozenAt` (for the Personal space of a removed User).
- **Memberships**: (spaceId, userId, role) for Organizations; role ∈ `admin` | `member` | `guest`. A Personal space has no membership rows: its owner and the Owner are implicit.
- **Installation permissions**: (userId, permission) with an initial closed set: `personalSpace.create`, `environments.registerOwn` (the second is consumed by the Sandboxes/Environments spec).
- **Invitations**: id, spaceId, role, token hash, createdBy, expiresAt (7 days), acceptedAt/By, revokedAt.
- **Password reset links**: id, userId, token hash, createdBy, expiresAt, usedAt.
- **Audit log**: id, at, actorUserId, spaceId (nullable), action, target kind/id, small JSON detail. Append-only.
- **Projects and Threads** gain `spaceId` and `ownerUserId` (the creator, for "own" checks). Command receipts gain `actorUserId`.
- Start from zero: no data migration from a single-user T3 Code; a fresh Installation has no Projects or Threads without a Space.

### Sessions

- `userId` becomes a required field of pairing grants, session claims (new claim, versioned like `rtc`/`plk`), the `auth_sessions` row and the verified/authenticated session and HTTP principal shapes. The user id is read from the row, not the claim, so it can be revoked without reissuing tokens.
- `subject` stays as the channel label it is today; security checks that depend on its literals are untouched.
- Session lifetime: 30 days, sliding on use. Revoking a session or removing/disabling a User closes its sockets (existing invalidation path).
- Scopes remain the capability ceiling of a session (for example a narrowed MCP client). Identity-based authorization (below) applies on top: a call needs both the scope and an Allow from the policy.

### Módulos

- **AccessPolicy** (pure, deep module, no I/O): `decide(principal, action, resource) → Allow | Deny(reason)`. The principal carries `userId`, `isOwner`, Installation permissions and the User's Role per Space. Actions are a closed enum mirroring the Role table of «Roles y permisos»: view space content, create thread, continue thread, create project, archive (own/others'), stop others' thread, permanently delete archived, invite (member/guest), change role/remove (non-admin), name/remove admin, create organization, archive/restore/delete organization, move project (origin and destination checks), create guest link, create in personal space, see personal space, reveal/edit secrets and register environments (the last two only as audit actions here; their rules live in their own specs). The Owner is always Allow.
- **UserDirectory**: create Owner (bootstrap only), create User from Invitation, disable/remove User (freezes Personal space and hands it to the Owner), credential enrollment and verification (passkey, password, TOTP, recovery codes), reset links.
- **SpaceDirectory**: create/archive/restore/delete Organization, memberships and Roles, Personal space lookup, Installation permissions, move Project between Spaces (requires its Threads stopped).
- **InvitationService**: create, list, revoke, accept (creates or links a User).
- **AuditLog**: append and list (Owner only).
- **CurrentPrincipal**: an Effect context service provided once per WebSocket connection in the WS RPC layer and per request in HTTP and MCP, replacing ad-hoc closure access to the session for authorization. The RPC authorization middleware receives the principal, not only scopes.

### Enforcement

- **Reads**: the shell stream (snapshot and live deltas) and every project/thread read RPC and HTTP endpoint filter by the Spaces the principal can view. There must be a single visibility helper used by all of them, so a new read path cannot forget it.
- **Writes**: project and thread commands (create, dispatch message, archive, stop, delete, move) ask AccessPolicy before dispatch. `message.dispatch` on a Thread is allowed only to its `ownerUserId`. The server stamps `actorUserId` on every command (extending creation provenance) and on its command receipt; clients cannot set it.
- **Agents**: tool calls an agent makes through T3 Code's MCP server run with the principal of the User who started the turn (always the Thread's owner). This follows the existing link-origin precedent.
- **Guest links**: creation requires an Organization Space and the Admin Role.
- **Network exposure**: when the Installation has an Owner, the server accepts connections from any peer, since every request needs a User session. HTTPS is terminated by a reverse proxy in front of the Hub; the server refuses to issue browser sessions over plain HTTP except on loopback.

### API contracts (packages/contracts)

- New schemas: User, Space, Membership, Role, InstallationPermission, Invitation, AuditEntry, Principal (as exposed to clients: own user, Spaces with Role, Installation permissions).
- New HTTP auth endpoints: Owner bootstrap (create account), passkey registration and assertion (WebAuthn challenge/response), password sign-in, TOTP enrollment and verification, recovery code sign-in, reset-link redemption, Invitation preview and acceptance.
- New WS RPCs: spaces (list mine, create, archive, restore, delete), memberships (list, change role, remove, leave), invitations (create, list, revoke), installation permissions (Owner), users (Owner: list, disable, remove, issue reset link), sessions (list mine, revoke; Owner: any), audit (Owner: list), project move between Spaces.
- Protected client mutations follow the existing guarded-command pattern: each new mutation declares its scope, and its UI availability comes from the command's permission atom, now also fed by the principal's Role in the current Space.
- New dependencies: a WebAuthn server library, an argon2id implementation, a TOTP implementation. Prefer small, maintained, pure-JS or well-supported native packages that build on every server platform T3 Code ships.

### Superficies de cliente

- **Web**: sign-in page (passkey, password, TOTP step), Owner bootstrap page, Invitation acceptance page (with the Personal space disclosure), reset-link page, Space selector, Organization settings (Members, Roles, Invitations), Owner admin (Users, Installation permissions, audit log), "Your sessions" in settings. Pairing-code screens leave the normal flow.
- **Desktop**: add a Hub by URL and finish sign-in in the system browser.
- **Mobile**: same as desktop through the system browser; the Space selector in navigation.
- Shared client logic (principal, current Space, permission atoms) lives in the shared client runtime.
- **CLI**: Owner reset-link command; session/token issuance bound to a User.

## Testing Decisions

- A good test drives external behavior only: a principal asks for an action and gets Allow or Deny; a client calls the real API and sees what that User may see. No tests for what types already guarantee, wiring, or copy text.
- **Seam 1, AccessPolicy**: one table-driven suite (`it.effect.each`-style rows) that walks the full Role table of «Roles y permisos» for Admin, Member and Guest, plus the Owner, Installation permissions, Personal-space rules (owner, Owner visibility, no direct sharing), project moves between Spaces and guest-link creation. A new rule is a new row.
- **Seam 2, server boundary**: the real HTTP API and WS RPC layers over in-memory SQLite, covering the end-to-end flows: Owner bootstrap (and its single use), Invitation create/accept/expire/revoke, password, password+TOTP, passkey sign-in with a test authenticator, recovery code, reset link, Space-filtered shell snapshot and live deltas, a Member denied continuing someone else's Thread, an agent tool call limited to the turn starter's Spaces, session revocation closing the socket, and the audit entries for each audited action.
- Do not repeat Seam 1's rule cases at Seam 2: Seam 2 proves the policy is consulted on each path, Seam 1 proves the rules.
- Prior art: the existing environment-auth admin tests, the RPC authorization tests (which already assert every RPC declares a scope; extend them so every Space-scoped RPC is covered by the visibility helper), the session store tests, and the HTTP auth tests built on a real `HttpApiBuilder` layer. Client permission atoms extend the existing command-permission tests in the client runtime.
- Follow the repo's test rules: no sleeps, polling or timeouts; `TestClock` for expiry (sessions, Invitations, reset links).

## Out of Scope

- Hub ↔ Environment trust (how other Environments accept the Hub's proof of identity), the Hub as Thread store and moving Threads between Environments: spec 2.
- Sandboxes and External environments (the rules for `environments.registerOwn` are consumed there): spec 3.
- AI accounts and the AI gateway: spec 4. Vaults and secret reveal/edit rules: spec 5 (this spec only provides the audit actions).
- Process view: spec 6.
- OAuth sign-in (GitHub, Google), email delivery, custom or configurable Roles, per-resource permissions, public sign-up, billing.
- Migrating data from an existing single-user T3 Code.

## Further Notes

- AGENTS.md "Hit every surface" applies: every new capability needs its entry points (chat, settings, command palette), all three clients, MCP reachability through services, contracts, reverse states (archive/restore, invite/revoke, grant/revoke permission, add/remove member) and docs.
- `docs/user/` needs new pages or sections for signing in, Invitations, Organizations and Roles; `docs/internals/environment-auth.md` must be rewritten where identity changes it, not appended to.
- The Owner can see every Personal space; this must be stated in the Invitation acceptance screen and in the Personal space UI.
- Upstream T3 Code's single-owner assumptions (for example the default grant of every scope) remain true only for sessions of the Owner.
