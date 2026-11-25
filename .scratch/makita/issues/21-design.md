# 21 design: add a repository by name

Ticket: `21-repos-por-nombre.md`. Spec: `../spec.md` («Configuraciones», «Puertas»). Builds on 03 (the form, `MakitaRepos`) and 08 (linked GitHub accounts).

## What changes

- **WS `makita.repos.add { spaceId, repo }`** → `{ project: MakitaProjectRepo, created, notes }`. The form calls it from «Repositories» («owner/name or a github.com URL» + «Add»); the answer's Project shows up checked. Saving the configuration stays the existing `create`/`update`: nothing about a configuration changes here.
- **`makita/MakitaRepoAdd.ts`** (new service), for a person's own session only (never an agent, the shell or a one-Space session), one add at a time per Hub process:
  1. **`makita.use` in the Space** (AccessPolicy, as `configs.create`), else `forbidden` before anything else: nobody else learns anything or spends a GitHub request.
  2. **Parse**: `owner/name`, `https://github.com/owner/name[.git][/…]`, `github.com/owner/name`, `git@github.com:owner/name.git`. Anything else: `invalid`, no request.
  3. **Reuse**: a live Project of that Space whose checkout resolves (gh's rule, `spaceProjectRepos`) to the same repository, case-insensitive → answered with `created: false`. It needs no `project.create` (nothing is made); the person already sees that Project.
  4. **`project.create` in the Space** (AccessPolicy, the rule a Project made by hand meets: Admins and Members of an Organization, a Personal space's own User, the Owner but not in another User's Personal space, never in an archived or frozen Space). Refused: `forbidden` «You cannot add Projects to this Space.», before GitHub is asked.
  5. **GitHub, with Makita's token** (`MakitaGitHub.rest`): `GET repos/{o}/{r}`. A 404/403, or a private repository the person may not see, answer the same `not-found`: «Makita can't reach owner/name. Check the name and that Makita's GitHub account can read it; for a private repository, your linked GitHub account must be a collaborator too.» For a private repository the person must be the Owner (who holds the token anyway) or have a linked GitHub account (ticket 08, `linkedIdsOf`) that GitHub says is a collaborator (`GET user/{id}` for the current login, then `GET repos/{o}/{r}/collaborators/{login}` → 204). Nothing of the repository (description, branches, private or not) is answered; only its canonical `owner/name` once it passed. No push permission for Makita there → a note («Makita can read owner/name but not push to it: comments and labels need it as a collaborator with Write.»).
  6. **Create** through `MakitaProjectClone.clone` (new, `makita/MakitaProjectClone.ts`): the Hub's own «clone a repository as a new Project» path — `ProjectCloneTracker.start` with the hooks `ws.ts` uses for `projectClone.start`, moved to `project/projectCloneHooks.ts` so both share them — run as the person (`CommandActor.actAsResolved`), with the configuration's `spaceId`: `ProjectService.create` then claims it through `SpaceDirectory.claimCreation` (`project.create` checked again, the owner stamped as the Space's rules say). Destination: a new folder `<Hub Projects folder>/<repo name>[-n]`, checked with `requireCloneDestination(…, { asProject: true })` as the WS door does. Clone URL `https://github.com/owner/name.git` with the Hub's own git access, as a clone by hand (Makita's token never reaches the checkout or its config). It waits up to 20 s for the checkout's GitHub remote to resolve (the save needs it) or the clone to end; a clone that fails leaves the Project with its «Retry» like any clone, and a note says so.
  7. **Audit** `makita.repo.add` (the person; `space`, `repo`, `project`, `created`), label «Added a repository to Makita».
- **Removing** a repository from a configuration is unchecking it and saving: the Project is never touched.

## Who may do it

Whoever may use Makita in the Space; making a new Project also needs exactly what making one by hand needs (`project.create`, a folder the person may root a Project in). A Guest, someone of another Space, an agent, the shell or a one-Space session add nothing. Private repositories: only someone GitHub says may see them.

## How it is undone

The Project is an ordinary Project of the Space: deleted like any other (by who may). Unchecking it in the configuration stops Makita listening there. Audited.

## Doors added

| Door                  | Rule                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `makita.repos.add` | `RPC_SPACE_ACCESS` `MAKITA_CONFIGS` (`makita.use` on the named Space, then `project.create` to make one), `source-control:write` like `projectClone.start`. |

No HTTP, raw route or MCP door; the Makita RPC sweep grows by one.

## Deviations (conservative)

- The clone uses the Hub's own git access, not Makita's token: a private repository the Hub cannot clone gets a Project with a failed clone and a note. Giving a checkout Makita's token would make it every Space Member's.
- The save-time check stays: a Project whose remote has not appeared yet is refused at save, as today.

## Tests (red-first)

`makita/MakitaRepoAdd.test.ts` over the Makita testkit and the fake GitHub, with a recording `MakitaProjectClone`: Grace adds `acme/new-thing` → one Project created in Acme as her, audited; adding its URL again reuses it; an existing Acme Project's repository is reused without `project.create`; Linus (Guest), Ada (Admin without the permission) and Globex's Gus add nothing and GitHub is not asked (today `makita.use` implies `project.create`; the second check guards the rules drifting apart); a private repository answers like a missing one unless Grace's linked account is a collaborator; a bad name is refused with no GitHub request; unchecking it and saving leaves the Project. `project/projectCloneHooks.test.ts`: the hooks create in the given Space as the given User. Door sweeps.
