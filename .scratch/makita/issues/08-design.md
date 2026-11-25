# 08 design: link a Hub User to their GitHub account

Ticket: `08-vincular-la-cuenta-de-github.md`. Spec: `../spec.md` («Vincular una cuenta de GitHub», «Quién lo pide y si puede», «Puertas», «Auditoría»). Builds on 09: the intake already reads issue and review comments, decides each once by its key, and ignores edited ones.

## What changes

- **Migration `169_GitHubIdentities`** (the number may move at integration):
  - `github_identities (user_id PRIMARY KEY, host, github_user_id, login, linked_at, UNIQUE (host, github_user_id))`: one GitHub account per User, one User per GitHub account.
  - `github_link_codes (code_hash PRIMARY KEY, user_id, host, github_user_id, login, created_at, expires_at, used_at, outcome)`: `code_hash` is the SHA-256 of the code; `outcome` is `linked` or `taken` once used. Index on `user_id`.
  - Both named only by `makita/GitHubIdentities.ts` and the migration (`DoorRules`).
- **Asking for a code** (User settings → Account → «GitHub account»): the User types **their GitHub login**. The Hub resolves it with Makita's token (`GET /users/{login}`, a person's account only) and makes a code: 8 characters from a 32-letter alphabet without look-alikes (40 bits), 15 minutes, one use, stored as SHA-256 only, **bound to that numeric GitHub id**. A new code drops the User's unused ones. The answer is the code and the line to post, `@<makita> link <code>`, shown once; later reads say only «waiting for @login until …».
- **The proof** (intake, `issue-comments` and `review-comments`): a new comment whose first line is exactly `@<makita login> link <code>` (case-insensitive) on any issue or pull request of a repository a live configuration listens to. It is handled before mentions, so it never starts or wakes a task. Makita itself, `Bot` users, ghosts and edited comments are ignored, as in 09. In the batch's transaction: the code's hash must match a row that is unused, unexpired and **bound to the comment author's numeric id**; otherwise nothing happens and nothing is written to GitHub. A match uses the code; then:
  - the GitHub id is already linked to another User: the code ends `taken`, nothing is linked, and the User's Account page says «That GitHub account is linked to someone else on this Hub.» (never who);
  - otherwise the User's link becomes that id and login (replacing an earlier one of theirs), audited `github_identity.link` (and `github_identity.unlink` for the replaced one).
  - After the commit Makita reacts on the comment: 👍 linked, 😕 taken. Only a valid code bound to the author can cause that write, so strangers cannot make Makita write.
  - The event row is `command` / `link` with **no configuration**, so no Space's activity shows it.
- **Whom a configuration answers** (`makita/makitaCallers.ts`, one read per intake pass for every configuration, and at each task's framing of «allowed»):
  - `creator` («Only me»): the creator's linked id;
  - `list`: the list's ids plus the creator's linked id (spec order);
  - `members` («Members of this Space with a linked GitHub account»): the linked ids of the Space's current Admins and Members (Guests do not count: they may not use Makita either), or the Personal space's User;
  - only active Users count (a disabled User's link stays but answers nothing). `anyone` stays refused (ticket 16).
  - Read on every pass from the tables, never stored in the configuration: unlinking, leaving the Space or being removed takes effect at the next event, with no edit.
- **Unlink**: the User, or the Owner for anyone (`userId`), audited. A User removed from the Hub loses their link in the same transaction (`MakitaPermissions.forgetUserWithin`), audited `github_identity.unlink` (`reason: user-removed`).
- **`MakitaConfigs`** accepts `creator`, `list` and `members` (`creator` and `members` keep no list), audits `callersMode` and `changed: callersMode`.
- **Web**: Account → «GitHub account» (login field, «Link GitHub account», the line to post with a copy button, the linked login, «Unlink»); the configuration form's «It answers»: «Only me», «A list of GitHub users», «Members of this Space with a linked GitHub account», with a note when the viewer has no link yet.

## How someone could try to claim another person's GitHub account, and why it fails

1. **Type someone else's login** when asking for a code. The code is bound to their numeric id; only a comment written by their GitHub account uses it. Without their GitHub session nothing happens.
2. **Copy someone's code** from their public comment and post it from one's own account, in the same or another listened repository, before Makita reads theirs (the race a plain code would allow). The author's id is not the bound id: ignored, the code stays usable by its owner.
3. **Edit a comment** to add or change a code after posting: only creation counts; edited comments are `ignored-edited`.
4. **Guess a code**: 2^40 values for 15 minutes, and a guessed code only links the poster's own account to whoever asked for it, which needs that person to have asked for the poster's login.
5. **Take over an account someone already linked**: `UNIQUE (host, github_user_id)` and the check in the transaction refuse it, saying only «linked to someone else».
6. **Rename tricks**: everything compares the numeric id. A renamed login keeps answering; a new account that takes an old login does not.
7. **What remains**: tricking the account's owner into posting the line for you. The line names the bot and «link»; the link is audited and shown on the owner's own page only if they have a Hub User. Said plainly in the UI copy: post it only for your own Hub account.

## Who may do it

- `githubIdentity.get`, `.linkCode`: the session's own User (AccessPolicy `githubIdentity.manage`, a `github-identity` resource: only its own User). `.unlink`: its own User or the Owner (`githubIdentity.unlink`). A person's own WS session only: never an agent, the Hub's shell or a one-Space session.
- Nobody reads another User's link: no door returns one. The only hint is that a member's comments are marked «allowed» in the creator's own Makita Thread, which is the point of «members».

## How it is undone

«Unlink» (the User or the Owner) takes effect at the next event. Codes expire in 15 minutes. Leaving a Space or being disabled stops counting at once; removal deletes the link. Every link and unlink is audited (no Space: the Owner's audit view).

## Doors added

| Door                                 | Rule                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| WS `githubIdentity.get`              | `RPC_SPACE_ACCESS` unscoped: the session's own User's link and pending code state, never the code |
| WS `githubIdentity.linkCode {login}` | same; answers the code once                                                                       |
| WS `githubIdentity.unlink {userId?}` | same; another User's only for the Owner                                                           |

No HTTP, raw route or MCP door.

## Tests (red-first)

`makita/GitHubIdentities.test.ts` over the fake GitHub: a code posted by its account links it (👍, audited) and a renamed login is still recognised; an expired code, a used code and a code posted by another account do not link; an account linked to Ada cannot be linked by Grace (😕, «linked to someone else», no name); «Only me» answers the creator's linked account and stops at the next event after unlinking; «members» answers Ada and stops at the next event after she leaves Acme; a Guest's link does not count; unlink by the Owner; an agent session is refused. Migration test for 169; door sweeps.
