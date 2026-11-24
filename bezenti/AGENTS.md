# Working on the Bezenti Hub fork

This repository is a fork of T3 Code that turns it into a **multi-user Hub**: one server with an
Owner, Organizations and Personal spaces ("Spaces"), Users with roles (Admin, Member, Guest),
Keycloak sign-in, joined machines and Sandboxes, an AI gateway that pools AI accounts per Space with
usage caps and access keys, Vaults, and Grants (loans of AI accounts, Vault groups and machines
between Spaces). Upstream T3 Code is single-user. Here every feature must hold up when several
people share one Hub.

Where this file and the root `AGENTS.md` disagree, this file wins.

## The flow

1. **Branch.** Work in your own worktree, on a branch from `public-hub-1` (the integration branch;
   `main` is what production runs). Name it `ui/…`, `fix/…`, `feat/…` or `ci/…`. Run `vp i` in the
   worktree before your first commit: without `node_modules` the pre-commit hook silently does
   nothing.
2. **Size the work.**
   - Small (UI, copy, a bug): build it.
   - Sensitive (permissions, Spaces, Grants, credentials, AI usage and caps, migrations, anything a
     stranger could reach): first write a short design note at `.scratch/<area>/<slug>-design.md`,
     commit it, then build. Keep it to what changes, who may do it, and how it is undone.
   - Large: split it into branches that each stand on their own.
3. **Commit** in small commits with hooks on. Never `--no-verify`, never amend, never commit with
   hooks disabled.
4. **Verify in CI, not on the dev machine.** Push your branch to `darwinva97/bezenti-hub`. The
   `bezenti-verify` workflow plans from your diff (typecheck of touched packages and their
   dependents, lint, changed tests and the tests beside changed files, the door sweeps when
   `apps/server` changed) and takes about 2–3 minutes. Wait for the run of your exact commit
   (`gh run list --workflow bezenti-verify.yml --branch <branch> --json headSha,conclusion,url`);
   its summary and the `bezenti-verify-receipt` artifact hold the receipt. On RED, fix and push
   again. See «Verificación de ramas en CI» in [README.md](README.md).
   - Locally, run only what you iterate on: `vp test run <files>` and the typecheck of the package
     you touch, one heavy command at a time (the dev machine is short on memory).
   - Do not run `vp run check:changed`, `vp check` or any repo-wide check locally.
5. **Report** to the lead: commits, tip SHA, the GREEN run URL, what changed for users, and open
   questions. The lead reviews and merges into `public-hub-1`.
6. **Never** push to `main`, deploy, tag, or publish a release. Only `main` deploys (through
   `bezenti.yml`), and only when the Owner says so. No pull requests unless asked.

## Hub rules

- **Doors.** Every RPC, HTTP route and MCP tool decides access through `AccessPolicy`. A new door is
  added to the door sweeps (`apps/server/src/auth/DoorRules.test.ts`,
  `apps/server/src/auth/RpcAuthorization.test.ts`). Someone who may not see a resource gets
  not-found, never a hint about it.
- **Isolation.** A feature works per User and per Space. Never show another Space's data, names or
  counts. Settings that upstream treats as global need a per-User or per-Space scope, or an Owner
  gate.
- **Reversible and audited.** Every way in has a way out and a way to see it. Privileged actions
  write an audit entry.
- **Migrations.** Use the next free id on `public-hub-1` (see
  `apps/server/src/persistence/Migrations.ts`). The Migrator skips ids below the highest applied,
  so if another branch lands first with your id, renumber before merging. Never reserve ranges.
- **Public repository.** No emails, passwords, IP addresses, private hostnames, personal account
  names or tokens in code, tests, docs, commit messages or CI logs. Never print a secret.
- **Copy.** Product text stays in English and the product keeps its name. Operations notes in
  `bezenti/` are in Spanish.
- **Specs and tickets** for larger work live under `.scratch/` (see `docs/agents/issue-tracker.md`);
  this overrides the root file's «Plans and work artifacts».
- **Upstream.** We port selected upstream commits rather than merging. Before porting one, check
  `git log public-hub-1 --grep '#<PR>'` so it is not taken twice, and renumber upstream migrations
  above ours.
