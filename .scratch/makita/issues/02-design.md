# 02 design: «may use Makita» per User and Space

Ticket: `02-el-permiso-por-space.md`. Spec: `../spec.md` («El permiso "may use Makita"», open question 2 decided on 2026-11-24: per User and Space). `installation_permissions` is not touched.

## What changes

- **Migration `164_MakitaPermissions`**: `makita_permissions (user_id, space_id, granted_by, granted_at, PRIMARY KEY (user_id, space_id))`, index on `space_id`. Test: runs to 163, then 164; a second row for the same pair is refused.
- **`AccessPolicy`**: a pure resource `MakitaSpaceResource { kind: "makita-space", space, permitted }`, where `permitted` says whether the acting User has a row there (the service reads it in the same transaction). Two actions:
  - `makita.use`: the Owner anywhere but another User's Personal space (`personal-space-read-only`), with no row; anyone else must first still be there — an Organization's Admin or Member (`not-a-member`; a Guest `role-not-allowed`), or the User of their own Personal space (`not-your-personal-space`) — then hold a row (`makita-not-permitted`, a new reason); and the Space must be open (`space-archived`, `space-frozen`). A disabled User: `user-inactive`.
  - `makita.view`: the Owner everywhere; an Organization's Admins (archived too); anyone who would have `makita.use` there leaving the open-Space condition aside (they still see their configurations of an archived Space).
  - One table of rows in `AccessPolicy.test.ts`.
- **`makita/MakitaPermissions.ts`** (the table's only writer), the Owner's:
  - `list`: every row with the User's and the Space's names, the Role there now, whether it takes effect and, if not, why (`not-a-member`, `guest`, `space-archived`, `space-frozen`, `user-inactive`, `space-gone`); and the candidates for «Grant»: every active User who is not the Owner, with the Spaces where they may receive it (Organizations where they are Admin or Member, and their own Personal space), open ones only.
  - `grant({ userId, spaceId })`: refused for the Owner («The Owner may use Makita everywhere.»), a disabled or removed User, a Space that is not open, a Guest («Guests cannot use Makita.»), someone not in the Organization, another User's Personal space. Idempotent; one write transaction (the checks read inside it); audited `makita.permission.grant` (`space`, `role`).
  - `revoke({ userId, spaceId })`: deletes the row; idempotent; audited `makita.permission.revoke` (`space`, `reason: revoked`). Ticket 03 pauses that User's configurations of that Space in this same transaction.
  - `*ForSession` twins: a person's own session only, and the Owner (`makita.manageAccount`).
  - Exported, for the next tickets and for removals: `permittedIn(sql, userId, spaceId)` and `forgetUserWithin(sql, actor, userId)`.
- **Removal from the Hub** (`InstallationUserService`, `user.remove`): `forgetUserWithin` deletes the User's rows in that transaction, each audited `makita.permission.revoke` (`reason: user-removed`). Leaving or losing a Membership keeps the row with no effect (`makita.use` needs the Membership); coming back does not need a new grant, which the list shows.

## Who may do it

Granting, revoking and listing: only the Owner's own WS session (`makita.manageAccount`). An agent, the shell, a one-Space session, an Admin: `forbidden`. Nobody grants it to themselves.

## How it is undone

Revoke (the Owner, audited). A User removed from the Hub loses every row with an audit entry. Every grant shows in the list with who gave it and when.

## Doors added

| Door                                     | Rule                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `makita.permissions.list`             | `RPC_SPACE_ACCESS` unscoped `MAKITA_PERMISSIONS` («the Owner's own session; names every User and Space, the Owner's to see»), `access:read`. |
| WS `makita.permissions.grant` / `revoke` | same rule, `access:write`.                                                                                                                   |

`DoorRules`: `makita_permissions` is named only under `makita/` and by its migration; the Makita RPC sweep grows by three.

## Web

Platform → Makita → **Who may use Makita**: one row per grant (User · Space, its Role, «Granted by … on …», and why it has no effect when so), «Grant…» (a dialog: User, then one of their eligible Spaces) and «Revoke» with a confirmation.

## Tests (red-first)

`makita/MakitaPermissions.test.ts`: the Owner grants Grace (Member) in Acme and Ada (Admin) in Acme; Gus in his own Personal space; refused: Linus (Guest), the Owner, Gus in Acme, Grace in Gus's Personal space, an archived Acme; an Admin, a Member, an agent and a one-Space session neither list, grant nor revoke; Grace with a row in Acme has no `makita.use` in Globex; Grace removed from Acme → `not-a-member` and the list says so; Grace removed from the Hub → her rows gone, audited; revoke is audited and idempotent.
