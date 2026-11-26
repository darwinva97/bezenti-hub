// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off - audit rows; folders on disk.
/**
 * Makita ticket 28: a finished task's worktree removed from its machine once its pull request is
 * merged or closed (a person's merge also deletes its branch), or 7 days after it ended without
 * one; kept while the pull request is open; retried while the machine is away; never another path.
 */
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import { MAKITA_AUTONOMY_OFF, type MakitaConfigInput, type ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import { MAKITA_BOT, type MakitaReady, makitaReady, OCTOCAT } from "./MakitaFixtures.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const DAY_MS = 24 * 60 * 60 * 1_000;
const PUSHING: Partial<MakitaConfigInput> = {
  capability: "push",
  approval: "never",
  autonomy: MAKITA_AUTONOMY_OFF,
};

const daysAgo = (days: number) =>
  Effect.map(DateTime.now, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) - days * DAY_MS)),
  );

/**
 * A pushing task on issue `number` whose worktree the Hub made on the Sandbox (its folder on disk),
 * last touched `days` ago; `pr`: its pull request, open on GitHub unless `prOpen` is false.
 */
const seed = (
  ctx: MakitaReady,
  input: {
    readonly configId: string;
    readonly projectId: ProjectId;
    readonly number: number;
    readonly state: string;
    readonly days?: number;
    readonly pr?: number;
    readonly prOpen?: boolean;
    readonly landed?: boolean;
    readonly prClosed?: boolean;
    /** Where the Hub recorded its worktree; by default where `move.prepare` puts it. */
    readonly cwd?: string;
  },
) =>
  Effect.gen(function* () {
    const { setup } = ctx;
    const taskId = `mkt_wt_${input.number}`;
    const threadId = `thread-wt-${input.number}`;
    const branch = `makita/${input.number}-fix`;
    const cwd = input.cwd ?? setup.gitWorld.worktreeOf(input.projectId, threadId);
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.writeFileSync(`${cwd}/uncommitted.txt`, "never pushed\n");
    const workspace = JSON.stringify({
      environmentId: "env-sandbox",
      cwd,
      startSha: "b".repeat(40),
    });
    const at = yield* daysAgo(input.days ?? 30);
    yield* setup.server.sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, branch, base_branch, pr_number,
        workspace_json, landed_sha, pr_closed_at, created_at, updated_at)
      VALUES (${taskId}, ${input.configId}, ${setup.acmeId}, ${input.projectId}, 'github.com',
        ${REPO}, ${input.number}, 'issue', ${threadId}, 1, 'octocat', ${input.state}, ${branch},
        NULL, ${input.pr ?? null}, ${workspace}, ${input.landed === true ? "c".repeat(40) : null},
        ${input.prClosed === true ? at : null}, ${at}, ${at})
    `;
    if (input.pr !== undefined) {
      const open = input.prOpen !== false;
      setup.github.pulls.set(`${REPO}#${input.pr}`, {
        number: input.pr,
        title: "Fix it",
        body: "",
        head: branch,
        base: "main",
        state: open ? "open" : "closed",
        user: MAKITA_BOT,
        headSha: "a".repeat(40),
      });
      setup.github.issues.set(`${REPO}#${input.pr}`, {
        number: input.pr,
        title: "Fix it",
        body: "",
        user: MAKITA_BOT,
        state: open ? "open" : "closed",
        locked: false,
        pull: true,
      });
    }
    return { taskId, threadId, branch, cwd };
  });

const rowOf = (ctx: MakitaReady, taskId: string) =>
  ctx.setup.server.sql<{
    readonly state: string;
    readonly failure: string | null;
    readonly prClosed: string | null;
    readonly removed: string | null;
    readonly failingSince: string | null;
    readonly nextTry: string | null;
    readonly worktreeFailure: string | null;
    readonly gaveUp: string | null;
    readonly branchCleanup: string | null;
  }>`
    SELECT state, failure, pr_closed_at AS "prClosed", worktree_removed_at AS removed,
      worktree_failing_since AS "failingSince", worktree_next_try_at AS "nextTry",
      worktree_failure AS "worktreeFailure", worktree_gave_up_at AS "gaveUp",
      branch_cleanup AS "branchCleanup"
    FROM makita_tasks WHERE task_id = ${taskId}
  `.pipe(Effect.map((rows) => rows[0]!));

const auditOf = (ctx: MakitaReady, action: string) =>
  ctx.setup.server.sql<{ readonly detail: string }>`
    SELECT detail_json AS detail FROM audit_log WHERE action = ${action} ORDER BY audit_id
  `.pipe(
    Effect.map((rows) => rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>)),
  );

/** Its retry is due now, as if its time had come. */
const dueAgain = (ctx: MakitaReady, taskId: string) =>
  ctx.setup.server.sql`
    UPDATE makita_tasks SET worktree_next_try_at = NULL WHERE task_id = ${taskId}
  `;

const pullIssue = (number: number) => ({
  number,
  title: "Fix it",
  pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
});

live(
  "a person merges Makita's pull request: the task ends, its branch is deleted once and its worktree removed; a second pass does nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(PUSHING);
      yield* setup.makitaIntake.pollDue;
      const task = yield* seed(ctx, {
        configId: config.configId,
        projectId: ctx.widgets,
        number: 11,
        state: "waiting-reply",
        pr: 41,
      });
      // Live with its pull request open: nothing is removed.
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(setup.gitWorld.removals, 0);
      assert.isTrue(NodeFS.existsSync(task.cwd));

      const actor = { login: OCTOCAT.login, id: OCTOCAT.id, type: "User" };
      setup.github.pulls.get(`${REPO}#41`)!.state = "closed";
      setup.github.addEvent(REPO, { event: "merged", actor, issue: pullIssue(41) });
      setup.github.addEvent(REPO, { event: "closed", actor, issue: pullIssue(41) });
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      assert.deepInclude(yield* rowOf(ctx, task.taskId), {
        state: "done",
        branchCleanup: "pending",
      });

      yield* setup.makitaWorktrees.sweep;
      assert.deepEqual(setup.github.deletedBranches, [{ repo: REPO, branch: task.branch }]);
      assert.deepEqual(
        setup.gitWorld.removals.map((removal) => [removal.environmentId, removal.cwd]),
        [["env-sandbox", task.cwd]],
      );
      assert.equal(setup.gitWorld.removals[0]!.threadId, task.threadId);
      assert.isFalse(NodeFS.existsSync(task.cwd));
      const row = yield* rowOf(ctx, task.taskId);
      assert.isNotNull(row.removed);
      assert.isNotNull(row.prClosed);
      assert.equal(row.branchCleanup, "deleted");
      assert.deepEqual(yield* auditOf(ctx, "makita.task.remove_worktree"), [
        {
          space: setup.acmeId,
          repo: REPO,
          number: 11,
          makita: config.configId,
          environment: "env-sandbox",
          why: "pr-closed",
          outcome: "removed",
        },
      ]);
      assert.deepEqual(yield* auditOf(ctx, "makita.github.delete_branch"), [
        {
          space: setup.acmeId,
          repo: REPO,
          number: 11,
          makita: config.configId,
          pr: 41,
          branch: task.branch,
        },
      ]);

      // Again: nothing more is asked of the machine or of GitHub, nothing more is audited.
      const requests = setup.github.requests.length;
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(setup.gitWorld.removals, 1);
      assert.lengthOf(setup.github.deletedBranches, 1);
      assert.lengthOf(setup.github.requests, requests);
      assert.lengthOf(yield* auditOf(ctx, "makita.task.remove_worktree"), 1);
    }),
);

live(
  "Makita's own merge or close never deletes a branch again; an ended task keeps its worktree while its pull request is open and loses it once GitHub says it closed",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(PUSHING);
      yield* setup.makitaIntake.pollDue;
      const base = { configId: config.configId, projectId: ctx.widgets };
      const stopped = yield* seed(ctx, { ...base, number: 12, state: "stopped", pr: 42 });
      const landed = yield* seed(ctx, { ...base, number: 13, state: "done", pr: 43, landed: true });
      // Makita's account merged 43 (a landing): its events are not a person's.
      const bot = { login: MAKITA_BOT.login, id: MAKITA_BOT.id, type: "User" };
      setup.github.addEvent(REPO, { event: "merged", actor: bot, issue: pullIssue(43) });
      setup.github.addEvent(REPO, { event: "closed", actor: bot, issue: pullIssue(43) });
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;

      yield* setup.makitaWorktrees.sweep;
      assert.isTrue(NodeFS.existsSync(stopped.cwd));
      assert.isFalse(NodeFS.existsSync(landed.cwd));
      assert.deepEqual(setup.github.deletedBranches, []);
      assert.isNull((yield* rowOf(ctx, landed.taskId)).branchCleanup);
      assert.isNull((yield* rowOf(ctx, stopped.taskId)).removed);
      // GitHub was asked about 42, and is not asked again before its next look.
      const asked = () =>
        setup.github.requests.filter((request) => request.path === `repos/${REPO}/pulls/42`);
      assert.lengthOf(asked(), 1);
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(asked(), 1);

      setup.github.pulls.get(`${REPO}#42`)!.state = "closed";
      yield* dueAgain(ctx, stopped.taskId);
      yield* setup.makitaWorktrees.sweep;
      assert.isFalse(NodeFS.existsSync(stopped.cwd));
      const row = yield* rowOf(ctx, stopped.taskId);
      assert.isNotNull(row.prClosed);
      assert.isNotNull(row.removed);
      // Only an event a person made deletes a branch.
      assert.deepEqual(setup.github.deletedBranches, []);
    }),
);

live(
  "a failed task without a pull request keeps its worktree for 7 days, then it is removed; a live one keeps it",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(PUSHING);
      const base = { configId: config.configId, projectId: ctx.widgets };
      const recent = yield* seed(ctx, { ...base, number: 14, state: "failed", days: 6 });
      const old = yield* seed(ctx, { ...base, number: 15, state: "failed", days: 8 });
      const running = yield* seed(ctx, { ...base, number: 16, state: "running", days: 40 });

      yield* setup.makitaWorktrees.sweep;
      assert.isTrue(NodeFS.existsSync(recent.cwd));
      assert.isFalse(NodeFS.existsSync(old.cwd));
      assert.isTrue(NodeFS.existsSync(running.cwd));
      assert.deepInclude((yield* auditOf(ctx, "makita.task.remove_worktree"))[0]!, {
        number: 15,
        why: "ended",
        outcome: "removed",
      });

      // A day later for the recent one: its 7 days are over.
      yield* setup.server.sql`
        UPDATE makita_tasks SET updated_at = ${yield* daysAgo(7.1)} WHERE task_id = ${recent.taskId}
      `;
      yield* setup.makitaWorktrees.sweep;
      assert.isFalse(NodeFS.existsSync(recent.cwd));
      assert.isTrue(NodeFS.existsSync(running.cwd));
    }),
);

live(
  "an offline machine is asked again later and given up on after 14 days, audited; an outdated one is waited for; a folder already gone counts as removed",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(PUSHING);
      const base = { configId: config.configId, projectId: ctx.widgets };
      const task = yield* seed(ctx, { ...base, number: 17, state: "done", pr: 47, landed: true });

      setup.gitWorld.state.removal = "offline";
      yield* setup.makitaWorktrees.sweep;
      const away = yield* rowOf(ctx, task.taskId);
      assert.equal(away.worktreeFailure, "offline");
      assert.isNotNull(away.failingSince);
      assert.isNotNull(away.nextTry);
      assert.isNull(away.removed);
      // Not due yet: the machine is not asked again.
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(setup.gitWorld.removals, 1);

      // An outdated machine: waited for, never a failure that counts toward giving up.
      setup.gitWorld.state.removal = "outdated";
      yield* dueAgain(ctx, task.taskId);
      yield* setup.makitaWorktrees.sweep;
      assert.deepInclude(yield* rowOf(ctx, task.taskId), {
        worktreeFailure: "outdated-machine",
        gaveUp: null,
        removed: null,
      });

      // Back, with the folder already gone: removed, all the same.
      NodeFS.rmSync(task.cwd, { recursive: true, force: true });
      setup.gitWorld.state.removal = "removed";
      yield* dueAgain(ctx, task.taskId);
      yield* setup.makitaWorktrees.sweep;
      const back = yield* rowOf(ctx, task.taskId);
      assert.isNotNull(back.removed);
      assert.isNull(back.worktreeFailure);
      assert.deepInclude((yield* auditOf(ctx, "makita.task.remove_worktree"))[0]!, {
        number: 17,
        outcome: "gone",
      });

      // Away for 14 days: given up, visibly, and never asked again.
      const gone = yield* seed(ctx, { ...base, number: 18, state: "done", pr: 48, landed: true });
      yield* setup.server.sql`
        UPDATE makita_tasks SET worktree_failing_since = ${yield* daysAgo(15)},
          worktree_failure = 'offline'
        WHERE task_id = ${gone.taskId}
      `;
      setup.gitWorld.state.removal = "offline";
      yield* setup.makitaWorktrees.sweep;
      const given = yield* rowOf(ctx, gone.taskId);
      assert.isNotNull(given.gaveUp);
      assert.isNull(given.removed);
      assert.deepInclude((yield* auditOf(ctx, "makita.task.remove_worktree"))[1]!, {
        number: 18,
        outcome: "gave-up",
        failure: "offline",
      });
      const calls = setup.gitWorld.removals.length;
      yield* dueAgain(ctx, gone.taskId);
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(setup.gitWorld.removals, calls);
    }),
);

live(
  "never removes a path that is not the task's recorded worktree: the Project's checkout or another Thread's folder is refused without asking the machine",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(PUSHING);
      const base = { configId: config.configId, projectId: ctx.widgets };
      const checkout = NodeFS.mkdtempSync(`${setup.gitWorld.machine}/checkout-`);
      const other = setup.gitWorld.worktreeOf(ctx.widgets, "thread-someone-else");
      const onCheckout = yield* seed(ctx, {
        ...base,
        number: 19,
        state: "done",
        pr: 49,
        landed: true,
        cwd: checkout,
      });
      const onOther = yield* seed(ctx, {
        ...base,
        number: 20,
        state: "failed",
        days: 30,
        cwd: other,
      });

      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(setup.gitWorld.removals, 0);
      assert.isTrue(NodeFS.existsSync(checkout));
      assert.isTrue(NodeFS.existsSync(other));
      for (const task of [onCheckout, onOther]) {
        const row = yield* rowOf(ctx, task.taskId);
        assert.isNotNull(row.gaveUp);
        assert.isNull(row.removed);
        assert.match(row.worktreeFailure ?? "", /^refused/u);
      }
      assert.deepEqual(
        (yield* auditOf(ctx, "makita.task.remove_worktree")).map((entry) => entry.outcome),
        ["refused", "refused"],
      );
      // Refused for good: nothing on the next pass either.
      yield* setup.makitaWorktrees.sweep;
      assert.lengthOf(yield* auditOf(ctx, "makita.task.remove_worktree"), 2);
    }),
);
