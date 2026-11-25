# 07 design: usage and activity

Ticket: `07-uso-y-actividad.md`. Spec: `../spec.md` («Uso», «Clientes», «Puertas»). Builds on 05: `makitaRows.makitaTaskOfThread(sql, threadId)` is the seam. Includes 05's web follow-up (`makita.threads`, the Thread's Makita header, the «Makita» list filter). Makita has no token limits (Owner decision 4): this is visibility only, never a cap.

## What changes

- **Migration `168_AiUsageMakita`** (ticket 06 needed none):
  - `ai_usage.makita_config_id TEXT` (NULL unless a Makita Thread made the request), with a partial index `(makita_config_id, at) WHERE makita_config_id IS NOT NULL`.
  - `ai_usage_daily` rebuilt as 146 and 160 did, with `makita_config_id TEXT NOT NULL DEFAULT ''` in the primary key and a partial index `(makita_config_id, day) WHERE makita_config_id <> ''`. Every existing row is copied as is with `''`.
  - No backfill: Makita 05 has only run on `public-hub-1`, so no production request was a Makita Thread's. Golden test like 160's.
- **Gateway**: `AiGatewayKeys.authorize`, for a Thread key, reads the Thread's Makita task (one indexed read) and puts `makitaConfigId` on `GatewayCaller` (null for every other key; a failed read is a 503 like the others there). The request record carries it; `AiUsage` writes it to both tables. `user_id` stays the creator's: the Thread is theirs, so the tokens count on the creator **and** on the configuration. `AiGatewayActivity` also holds a Makita request as unwritten under `makita-config:<id>` and `makita-thread:<threadId>` until the log writes it, so «Now» shows tokens not yet written.
- **`AiUsage.summary`**: each row gains `makitaConfigId` and the labels `makitaConfigs` (`{ id, name }`). Which rows a session sees does not change (a Makita row is the creator's, so: the creator, whoever reads that Space's usage, the Owner). A configuration is **named** only to the Owner, to whoever reads its Space's usage (`aiUsage.viewSpace`) and to the creator; on any other row the session sees (a lender reading a borrower's row through a Grant) `makitaConfigId` is null and nothing is named, so no other Space's configuration name leaks. Names are read through `makitaRows.configNames` (the Makita tables stay `makita/`'s). Usage shows such rows as «Makita: <name>» beside Users and access keys.
- **`AiUsage.makitaUsage`** (no door; only `MakitaActivity` calls it, after its own checks): for some configurations, today / this week / this month from `ai_usage_daily` (UTC periods of `GrantCaps.periodOf`), and per Thread over the per-request rows (90 days), each with its estimated cost (`aiPrices.ts`, null when not priced). `MakitaActivity` maps Threads to tasks for «per repository / task / caller».
- **`makita/MakitaActivity.ts`** and two WS reads, a person's own session only (never an agent, the Hub's shell or a one-Space session), like `makita.configs.list`:
  - `makita.activity { configId? , spaceId? }`. `configId`: `makita.view` on its Space, else not-found (another Space's configuration answers like a missing one). `spaceId`: `makita.view` there, else forbidden (as the list). Neither: the Owner's view of every configuration (Platform → Makita); anyone else forbidden. It answers the configurations (name, Space, paused, usage today / week / month), «Now» (tasks `running` / `waiting-ci` / `awaiting-approval`: repository#n, state, caller, since, tokens so far with the unwritten part), the 30 most recent tasks (state, failure, issue link, tokens), the 50 most recent events with their outcome and detail (`ignored-not-allowed`, `ignored-paused`…), and usage per repository and per caller (today / week / month).
  - **Usage visibility inside it**: a configuration's usage (its totals, its tasks' tokens, its share of the per repository / caller rows) only to its creator, to whoever reads its Space's usage and to the Owner; a Member who holds `makita.use` sees other creators' configurations and their activity (as the list already shows them) but `usage: null`. The ticket's red-first rule wins over the spec's «makita.view sees their usage».
  - A task's `threadId` only when the viewer may see that Thread (its Space among those they view, or the Owner); else null and no link.
  - `makita.threads {}`: the Makita tasks of the Threads the viewer may see (task's Space among those they view; the Owner all), newest 500: Thread id, repository, number, kind, caller login, state. Nothing about configurations.
- **Contracts** in a new `packages/contracts/src/makitaActivity.ts` (not `makita.ts`, which ticket 06 edits in parallel).
- **Web**: Space settings → Makita: each configuration row shows today's tokens, and «Activity» opens the activity of that configuration (or «Activity» for the whole Space). Platform → Makita: «Activity» next to «Stop all Makita work», for every configuration. Settings → AI accounts → Usage, grouped by User: «Makita: <name>». A Makita Thread's header: «Makita · <repo>#<n> · asked by @<caller>» linking to the issue. The Thread list filter gains «Makita» (only Makita Threads). New UI in new files; the two settings files only gain a few lines.

## Who may do it

Nobody writes anything new by RPC: two reads, decided in `makita/` by `AccessPolicy` (`makita.view`, `aiUsage.viewSpace`, `space.view`) for the session's own person. Usage rows are written by the gateway from the key alone. No new MCP tool, HTTP endpoint or raw route; both RPCs go into the door sweeps.

## How it is undone

Reads only, nothing to undo. The migration adds a nullable column and rebuilds a summary table with every row kept (the golden test says so); taking the feature out leaves `makita_config_id` unused. Per-request rows still age out at 90 days.

## Tests (red-first)

- Migration 168: every daily row kept with `''`; two configurations on the same day, account and model are rows of their own; the indexes exist.
- `AiGatewayRoute` over its testkit: a Makita Thread's request writes `makita_config_id` to `ai_usage` and `ai_usage_daily`; a normal Thread's writes none.
- `AiUsage`: the tokens count on the creator (filter by User) and show as their configuration's row; a Member who does not read the Space's usage sees neither another creator's rows nor the configuration's name; another Space's Admin sees nothing; a lender's view of a borrower's Makita row names no configuration.
- `MakitaActivity`: the creator sees today / week / month and per task / repository / caller; an Admin of the Space too; a Member with `makita.use` sees the activity of another's configuration with `usage: null`; another Space's Admin gets not-found for a `configId` and forbidden for a `spaceId`; only the Owner gets the view of every configuration; an agent's or a one-Space session is refused; events show their outcome and detail; «Now» includes unwritten tokens; `makita.threads` lists only Threads of Spaces the viewer sees.
