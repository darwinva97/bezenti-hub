# 24 design: reproduce, report, label, prove

Ticket: `24-reproducir-y-etiquetar.md`. Spec: `../spec.md` («Amenazas de prompt injection», «Configuraciones», «Puertas», «Auditoría»). Builds on 05 (`makita_comment`, its mask and token-shape refusal), 12 (`makita_open_pull_request`), 23 (`MakitaTriage`, the first message's new paragraph). Model: `robobun` reports «Reproduced on main `0966e99d8f3` (linux x64): `bun out.js` throws …», then «Fix in progress: #49561» / «Fix: #49575», labels `bug`, an area and `confirmed bug`, and proves the fix with tests that fail on main.

## What changes

- **Migration `173_MakitaTriage`**: `makita_configs.labels_json TEXT NOT NULL DEFAULT '[]'` (the labels Makita may add or remove); `makita_tasks.reproduced TEXT` (null, `yes`, `no`: the task's last reproduction report) and `makita_tasks.labels_json TEXT NOT NULL DEFAULT '[]'` (the labels Makita set and has not removed). Nothing else changes; existing rows read as «never labels», «not reported».
- **First message** (`makitaTriageText.ts`, after ticket 23's paragraph):
  - Reproduce before changing code. Report on the issue, with `makita_comment` and `report`, in this form: «Reproduced on `<base>` `<commit>` (`<platform>`): `<command>` `<observed result>`.» or «Could not reproduce on `<base>` `<commit>` (`<platform>`). Tried: …». The commit is `git rev-parse --short=11 HEAD` of the worktree before any change; the platform is `uname -sm` of the Sandbox.
  - Pushing tasks: write a test that fails before the change; run it before and after; give both outcomes as `evidence` when opening the pull request («17 of 20 new tests fail on main.»). Once the pull request is open, post one line on the issue: «Fix in progress: #<n>».
  - With labels configured: which ones it may set, and that `makita_label` is the only way.
- **A cheap Hub check, no free-text parser**: `makita_comment` gains `report?: "reproduced" | "not-reproduced"`. With it, the comment's first line must start with «Reproduced on » (or «Could not reproduce») and hold a commit in backticks (7–40 hex digits); otherwise the comment is refused, naming the form, and nothing is posted. Posted, the task's `reproduced` becomes `yes` or `no` (the last report wins) and the comment's audit says `report`. The Hub does not judge whether the claim is true: it records what Makita said publicly, so the activity can show it.
- **Labels in the configuration**: optional `labels` in the input (absent on update: unchanged; on create: none), up to 30 names of 1–50 characters, unique ignoring case, never the trigger label («`makita` hands issues to Makita; Makita can't set it.»). The view gains `labels`. An update that changes them is audited `makita.config.update` with `changed: labels`. Small, local edits in `MakitaConfigs.ts` (one column read, one `UPDATE` after the insert and in the update); the checks live in `makita/makitaLabels.ts`.
- **The form** (`MakitaLabelsField.tsx`, a new component the configuration dialog renders under the capability): names separated by commas, and «Labels in these repositories», chips of the labels that already exist in the chosen repositories (one click adds one). They come from a new RPC.
- **New RPC `makita.configs.labels { spaceId, repos }`** → `{ labels }` (names, sorted, at most 300): `makita.use` on the Space (the same rule as creating a configuration), a person's own session only; reads `GET /repos/{repo}/labels?per_page=100` with Makita's token for each repository the chosen Projects resolve to (at most 20). It writes nothing. Door sweeps, `MaskedPaths`, `RpcSpaceAccess`, `clientRpcPermissions`, instrumentation.
- **`makita_label { add?, remove?, on? }`** (`MakitaTriage`), listed only when the configuration's list is not empty (the MCP door reads it with the task, as it reads `push` and `land`):
  - Only on the task's issue (default) or its own pull request (`on: "pull_request"`, once it exists); repository and number from the task row.
  - Each name must be on the configuration's list (ignoring case; the list's spelling is used) and is never the trigger label; 1 to 10 names per call; anything else refuses the whole call and nothing reaches GitHub.
  - Makita and the configuration not paused, the task live. At most 10 calls per task (counted in the audit log).
  - GitHub: `POST /repos/{repo}/issues/{n}/labels` with the names to add; `DELETE …/labels/{name}` for each to remove (a 404, already gone, is fine). The task's `labels_json` keeps what Makita set.
  - Audit `makita.github.labels` (`agent` as the creator; `repo`, `number`, `makita`, `added`, `removed`), with its label in `AUDIT_ACTION_LABELS`.
- **Evidence in the pull request**: `makita_open_pull_request` accepts `evidence?: { before, after }`, each 1–4 000 characters, masked with the creator's secrets and refused on a token's shape or a Hub link like the body. The Hub writes it under an «Evidence» heading between `<!-- makita:evidence:start -->` and `<!-- makita:evidence:end -->`, each part in a code fence longer than any run of backticks inside it, before the footer. A body or evidence that already holds `makita:evidence` is refused, so the markers are only ever the Hub's. Without evidence nothing changes.
- **Activity**: each task gains `reproduced` (`yes`, `no` or null) and `labels`; the web activity shows «Reproduced» / «Not reproduced» and the labels.
- **Doors**: `MCP_TOOL_RULES.makita_label`, `MAKITA_ALLOWED_TOOLS` and a label-only set in `McpInvocationContext`, the `makita_` list in the sweep, `MaskedPaths`, `agentContextBudget.json` measured; `makita_comment` and `makita_open_pull_request` door texts mention the new inputs.

## Who may do it

Labels: the configuration's creator decides the list (the form, the same `makita.edit` rule); the agent only picks from it, on its own issue or PR, checked on the Hub. The RPC answers only someone who may use Makita in that Space. Reports and evidence are text the agent publishes, masked and checked like every comment.

## How it is undone

Empty the list: `makita_label` disappears at the next tool call and is refused before. A label Makita set is removed on GitHub by anyone, or by Makita when asked. Pausing or stopping refuses the tool. The migration only adds columns with defaults.

## Downsides (accepted)

- Whether the agent really reproduced is its word, not the Hub's: the Hub only checks the report's form and records it; a person reads the report on GitHub.
- GitHub creates a label that does not exist when one is added to an issue. The form offers existing ones, but a configured name that is not in a repository yet will be created there, with GitHub's default colour.

## Tests (red-first)

`MakitaTriage.test.ts`: with no labels the tool is refused; a name off the list, or the trigger label, is refused and no request reaches GitHub; a valid call adds and removes on the issue, and on the PR with `on`, audited, and the task keeps the labels; the eleventh call is refused. `MakitaConfigs.test.ts`: 31 labels, a duplicate and the trigger label are refused; labels round-trip and an update without `labels` keeps them; the RPC lists a repository's labels for someone who may use Makita and refuses someone who may not. `MakitaTasks`: a `report` comment without the form is refused and not posted; a valid one sets `reproduced`. `MakitaPullRequests.test.ts`: evidence lands between the markers before the footer, masked; a body with the marker is refused. Migration test for 173; MCP gate; door sweeps.
