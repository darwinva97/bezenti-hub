# 03 design: a Makita configuration

Ticket: `03-una-configuracion.md`. Spec: `../spec.md` («Configuraciones», «Quién lo pide y si puede», «Parar», «Puertas», «Auditoría»). Batch 1 limits what the service accepts; the table holds every column of the spec from now on.

## What changes

- **Migration `165_MakitaConfigs`**: `makita_configs` with every column of the spec: `config_id` (`mk_<24 hex>`), `space_id`, `name`, `created_by`, `created_at`, `updated_at`, `deleted_at`, `repos_json`, `triggers_json`, `callers_mode` (`creator|list|members|anyone`), `callers_json`, `strangers` (`ignore|reply`), `ignore_json`, `model_selection_json`, `capability` (`comment|push`), `may_land` (`INTEGER NOT NULL DEFAULT 0`), `approval` (`others|always|never`), `approvers_json`, `base_branch`, `environment_id`, `paused_at`, `paused_by`, `paused_reason` (`manual|owner|permission-revoked|creator-disabled|creator-left`), with `CHECK`s on every enum. Index `(space_id, created_at)` for live rows. Test: runs to 164, then 165; the checks refuse a bad value.
- **`AccessPolicy`**: a resource `MakitaConfigResource { kind: "makita-config", space, createdBy, permitted, pausedByOwner }` (`permitted`: the actor's row in that Space) and four actions:
  - `makita.pause`: the Owner; the creator while still in the Space; the Organization's Admins. Also in an archived Space (a way out).
  - `makita.resume`: the Owner (open Space); the creator only with `makita.use` there, and never one the Owner paused (`owner-only`).
  - `makita.edit`: the creator only, with `makita.use` (not the Owner, not an Admin).
  - `makita.delete`: the creator while still in the Space, or the Owner.
- **`makita/MakitaConfigs.ts`** (the table's only writer): `list`, `create`, `update`, `delete`, `pause`, `resume` and their `*ForSession` twins (a person's own session only). Checks read in the write transaction (`makita.use`, the 20 live configurations per Space, the Projects). Batch-1 values only:
  - `name` 1–80; `triggers`: a label (default `makita`), `assigned` and `mention` off (ticket 09);
  - `callersMode = list`, 1–50 GitHub logins, each resolved with Makita's token (`GET /users/{login}`) to its numeric id at save (a `Bot` is refused; logins unchanged keep their id); `strangers = ignore`;
  - `capability = comment`, `mayLand = false`, `approval = others`, no approvers;
  - `baseBranch`: null or a valid branch name; `environmentId`: null only («Space Sandbox (recommended)»; ticket 15 adds a dedicated machine, never a personal or lent one);
  - `modelSelection`: a gateway driver's instance (`claudeAgent`, `codex`, `opencode`, `pi`, or one configured with one of those drivers), an `aiAccountId` in `AllowedAiAccounts.for(creator, Space)` that is not `direct`, accepted by `chooseAiAccount` (`atTheDoor`, the model served);
  - `repos`: `{ all: true }` or `{ projects }` of live Projects of the Space whose GitHub repository resolves: `git remote -v` and `gh-resolved` in the Project's checkout on the Hub, read with `selectGitHubBaseRepository` over the `github.com` remotes only (`gh`'s rule). No GitHub remote: refused; two candidates and no `gh repo set-default`: «Pick the GitHub remote» (shown, not selectable).
  - After the commit, for each repository it listens to: `GET /repos/{o}/{r}/labels/{label}`, and on a 404 `POST …/labels` (audited `makita.github.label`, `outcome: created`); a refusal or no account becomes a note in the answer («Could not create the label … »).
- **Pause** sets `paused_at`, `paused_by`, `paused_reason` (`owner` when the Owner pauses someone else's, `manual` otherwise); **resume** clears them; **delete** sets `deleted_at`. All idempotent and audited (`makita.config.pause` with `reason`, `.resume`, `.delete`; `.create`; `.update` with `changed`, the fields by name). Tickets 05–06 stop the running tasks.
- **Revoking «may use Makita»** (ticket 02) pauses that User's live configurations of that Space in the same transaction (`permission-revoked`, audited as the Owner's pause). **Removing a User from the Hub** pauses all of theirs (`creator-left`, audited as the remover's) — the conservative part of ticket 17's table, so nothing of theirs can run.
- The view (`MakitaConfig`): its fields, the creator's and pauser's names, the Projects with their repository or why none, the AI account's name and a warning when it is no longer available to the creator there («This AI account is no longer available to you here»), and what the viewer may do (`canEdit`, `canPause`, `canResume`, `canDelete`). `list({ spaceId })` needs `makita.view` there and adds the form's options for whoever has `makita.use` (the Space's Projects with their state, the viewer's own gateway accounts with their models, the gateway agents); without a Space, the Owner gets every configuration of the Hub, anyone else those of the Spaces they view.

## Who may do it

Above. A Member without the row, an agent, the shell and a one-Space session create nothing; another Space sees nothing (`forbidden` on the list, `not-found` on a config of a Space one may not view).

## How it is undone

Pause / Resume / Delete as above; a revoked permission or a removed creator pauses (resuming needs the permission back, and only the creator or the Owner). Every change audited.

## Doors added

| Door                                                                  | Rule                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `makita.configs.list`                                              | `RPC_SPACE_ACCESS` unscoped `MAKITA_CONFIGS` («`makita.view` on the named Space; without one, the Owner every Space, anyone else the Spaces they view; another Space's configuration answers like a missing one»), `orchestration:read`. |
| WS `makita.configs.create` / `update` / `delete` / `pause` / `resume` | same rule with `makita.use` / `.edit` / `.delete` / `.pause` / `.resume`, `orchestration:operate` (as scheduled tasks: they will launch Threads as their creator).                                                                       |

No HTTP, raw route or MCP door. `DoorRules`: `makita_configs` named only under `makita/` and by its migration; the Makita RPC sweep grows by six.

## Web

Space settings → **Makita** (`SpaceSettingsSections`/`settingsModals`, an Organization's and one's own Personal space's; the panel says when the viewer may not use Makita there): the list (name, repositories, whom it answers, AI account and model, capability, state, «Paused by … on …», warnings) with Pause/Resume, Edit (the creator) and Delete (the creator or the Owner) in a «⋯» menu; «New configuration» opens a dialog with name, repositories (Projects with a GitHub remote, or «All Projects with a GitHub remote»), the label, «A list of GitHub users», agent + AI account + model, «Comment and analyse» (the CI-with-secrets note of the spec), base branch, «Where it works: Space Sandbox (recommended)».

## Tests (red-first)

`makita/MakitaConfigs.test.ts` (Hub testkit, fake GitHub, real git checkouts in a temp folder): Grace with the row creates one for an Acme Project and an AI account she may use; the logins are resolved to ids and the missing label created (audited); a Member without the row, an agent and a one-Space session create nothing; an account she may not use, a `direct` one, another Space's Project, a Project without a GitHub remote, an ambiguous one, `environmentId` ≠ null, `push`, `anyone`, `mayLand` are refused; 20 per Space; Ada (Admin) pauses Grace's but neither edits nor resumes it; the Owner pauses it and then Grace cannot resume it; the Owner sees every configuration; Globex sees nothing of Acme's; revoking Grace's permission pauses hers; delete is audited.
