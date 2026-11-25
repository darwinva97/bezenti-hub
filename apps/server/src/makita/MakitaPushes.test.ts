// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 10: a configuration that may push gives each task its own worktree on a
 * `makita/<n>-<slug>` branch; `makita_push` sends the agent's commits there and nowhere else, never
 * forced, refusing workflows, strangers' commits and secrets; the token never leaves the Hub.
 */
import { assert, it } from "@effect/vitest";
import { type MakitaConfigInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import { classicToken } from "./MakitaGitHub.testkit.ts";
import { makitaReady, OCTOCAT } from "./MakitaFixtures.testkit.ts";
import { SOMEONE_ELSE_PUSHED } from "./MakitaPushes.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const BRANCH = "makita/12-login-fails";
const BOT_EMAIL = "4242+makita-bot@users.noreply.github.com";

/** Makita ready, a configuration that may push, octocat's label on issue 12 turned into a task. */
const started = (over: Partial<MakitaConfigInput> = { capability: "push", approval: "never" }) =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup, due } = ctx;
    const world = setup.gitWorld;
    world.seed(REPO, ["main"]);
    const config = yield* ctx.configure(over);
    yield* setup.makitaIntake.pollDue;
    setup.github.label(REPO, 12, "makita", OCTOCAT, { title: "Login fails!" });
    yield* due;
    yield* setup.makitaIntake.pollDue;
    yield* setup.makitaTasks.startQueued;
    const [task] = yield* setup.server.sql<{
      readonly taskId: string;
      readonly threadId: string;
      readonly state: string;
      readonly branch: string | null;
      readonly headSha: string | null;
      readonly failure: string | null;
    }>`
      SELECT task_id AS "taskId", thread_id AS "threadId", state, branch, head_sha AS "headSha",
        failure
      FROM makita_tasks
    `;
    const threadId = ThreadId.make(task!.threadId);
    const cwd = world.made[0]?.cwd ?? "";
    const push = setup.makitaPushes.pushForThread(threadId);
    const taskRow = setup.server.sql<{
      readonly headSha: string | null;
      readonly lastPushAt: string | null;
      readonly pending: string | null;
    }>`
      SELECT head_sha AS "headSha", last_push_at AS "lastPushAt", pending_push_json AS pending
      FROM makita_tasks WHERE task_id = ${task!.taskId}
    `.pipe(Effect.map((rows) => rows[0]!));
    return { ...ctx, config, task: task!, threadId, world, cwd, push, taskRow };
  });

live(
  "a push configuration's task works in its own worktree; the agent's commit lands on makita/12-… only, audited",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, config, task, world, cwd } = ctx;
      assert.deepEqual([config.capability, config.approval], ["push", "never"]);
      assert.deepEqual([task.state, task.branch], ["running", BRANCH]);

      // Its worktree, made before the Thread, from GitHub's main, with the bot as author.
      assert.lengthOf(world.made, 1);
      const start = world.tipOf(REPO, "main");
      assert.equal(world.git(cwd, ["rev-parse", "HEAD"]), start);
      assert.equal(world.git(cwd, ["symbolic-ref", "--short", "HEAD"]), BRANCH);
      assert.equal(world.git(cwd, ["config", "user.email"]), BOT_EMAIL);
      const { input } = setup.launches[0]!;
      assert.deepEqual(input.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: cwd,
        branch: BRANCH,
      });
      assert.equal(input.placement, "space-work");
      assert.include(input.initialMessage!.text, "makita_push");
      assert.include(input.initialMessage!.text, BRANCH);

      // The agent commits; the Hub pushes it to the task's branch.
      const head = world.commit(cwd, { "src/login.ts": "export const fixed = true;\n" });
      const pushed = yield* ctx.push;
      assert.deepEqual(
        [pushed.pushed, pushed.branch, pushed.sha, pushed.commits],
        [true, BRANCH, head, 1],
      );
      assert.equal(world.tipOf(REPO, BRANCH), head);
      assert.equal(world.tipOf(REPO, "main"), start);
      assert.deepEqual(world.branchesOf(REPO), ["main", BRANCH]);
      const row = yield* ctx.taskRow;
      assert.equal(row.headSha, head);
      assert.isNotNull(row.lastPushAt);
      const audited = yield* setup.server.sql<{
        readonly source: string;
        readonly actor: string | null;
        readonly detail: string;
      }>`
        SELECT actor_source AS source, actor_user_id AS actor, detail_json AS detail
        FROM audit_log WHERE action = 'makita.github.push'
      `;
      assert.deepEqual(
        audited.map((entry) => [entry.source, entry.actor, JSON.parse(entry.detail)]),
        [
          [
            "agent",
            setup.people.member,
            {
              space: setup.acmeId,
              repo: REPO,
              number: 12,
              makita: config.configId,
              branch: BRANCH,
              sha: head,
              commits: 1,
            },
          ],
        ],
      );

      // Nothing new: nothing pushed. Uncommitted changes never go out.
      world.write(cwd, { "scratch.txt": "not committed\n" });
      assert.isFalse((yield* ctx.push).pushed);
      // The next commit builds on the last push: a fast-forward.
      const next = world.commit(cwd, { "src/login.ts": "export const fixed = 2;\n" });
      const again = yield* ctx.push;
      assert.isTrue(again.pushed);
      assert.equal(world.tipOf(REPO, BRANCH), next);
    }),
);

live(
  "the agent cannot reach main, the base or any other branch: whatever its worktree holds, the Hub pushes to the task's branch",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { world, cwd } = ctx;
      const start = world.tipOf(REPO, "main");
      // A hostile agent renames its branch to main and commits there.
      world.git(cwd, ["checkout", "--quiet", "-B", "main"]);
      const head = world.commit(cwd, { "evil.txt": "push me to main\n" });
      const pushed = yield* ctx.push;
      assert.isTrue(pushed.pushed);
      assert.equal(pushed.branch, BRANCH);
      assert.equal(world.tipOf(REPO, "main"), start);
      assert.equal(world.tipOf(REPO, BRANCH), head);
    }),
);

live(
  "a commit that changes a workflow, one not by the bot, or one holding a secret is refused and nothing reaches GitHub",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, world, cwd } = ctx;
      const start = world.git(cwd, ["rev-parse", "HEAD"]);
      const reset = () => world.git(cwd, ["reset", "--quiet", "--hard", start]);

      world.commit(cwd, { ".github/workflows/ci.yml": "on: push\njobs: {}\n" });
      const workflow = yield* ctx.push;
      assert.isFalse(workflow.pushed);
      assert.include(workflow.message, ".github/workflows/ci.yml");

      reset();
      world.commit(cwd, { "a.txt": "a\n" }, { as: "person" });
      const stranger = yield* ctx.push;
      assert.isFalse(stranger.pushed);
      assert.include(stranger.message, BOT_EMAIL);

      reset();
      world.commit(cwd, { "config.ts": `export const key = "${classicToken("leaked")}";\n` });
      const token = yield* ctx.push;
      assert.isFalse(token.pushed);
      assert.include(token.message, "shaped like a token");

      reset();
      setup.creatorSecrets.push("hunter2-creator-vault-value");
      world.commit(cwd, { "b.txt": "password=hunter2-creator-vault-value\n" });
      const vault = yield* ctx.push;
      assert.isFalse(vault.pushed);
      assert.notInclude(vault.message, "hunter2");

      assert.isNull(world.tipOf(REPO, BRANCH));
      assert.isNull((yield* ctx.taskRow).headSha);
    }),
);

live("Makita never force-pushes, and a branch someone else moved is not overwritten", () =>
  Effect.gen(function* () {
    const ctx = yield* started();
    const { world, cwd } = ctx;
    const start = world.git(cwd, ["rev-parse", "HEAD"]);
    const first = world.commit(cwd, { "a.txt": "a\n" });
    assert.isTrue((yield* ctx.push).pushed);

    // History rewritten under what Makita pushed: refused.
    world.git(cwd, ["reset", "--quiet", "--hard", start]);
    world.commit(cwd, { "a.txt": "rewritten\n" });
    const rewritten = yield* ctx.push;
    assert.isFalse(rewritten.pushed);
    assert.include(rewritten.message, "never force-pushes");
    assert.equal(world.tipOf(REPO, BRANCH), first);

    // Someone else pushed to the branch: the agent's next commit does not go over it.
    world.git(cwd, ["reset", "--quiet", "--hard", first]);
    world.pushAsSomeoneElse(REPO, BRANCH);
    const theirs = world.tipOf(REPO, BRANCH);
    world.commit(cwd, { "b.txt": "b\n" });
    const moved = yield* ctx.push;
    assert.isFalse(moved.pushed);
    assert.equal(moved.message, SOMEONE_ELSE_PUSHED);
    assert.equal(world.tipOf(REPO, BRANCH), theirs);
  }),
);

live("a paused configuration and the task it stopped push nothing", () =>
  Effect.gen(function* () {
    const ctx = yield* started();
    const { setup, config, task, world, cwd } = ctx;
    world.commit(cwd, { "a.txt": "a\n" });

    yield* setup.makitaConfigs.pauseForSession({ configId: config.configId }).pipe(setup.asOwner);
    const paused = yield* ctx.push.pipe(Effect.flip);
    assert.equal(paused.reason, "forbidden");
    // The pause stopped the task too (ticket 06), and a resume does not bring it back.
    yield* setup.makitaConfigs.resumeForSession({ configId: config.configId }).pipe(setup.asOwner);
    const stopped = yield* ctx.push.pipe(Effect.flip);
    assert.equal(stopped.reason, "forbidden");
    assert.isNull(world.tipOf(REPO, BRANCH));
    const [row] = yield* setup.server.sql<{ readonly state: string }>`
        SELECT state FROM makita_tasks WHERE task_id = ${task.taskId}
      `;
    assert.equal(row?.state, "stopped");
  }),
);

live("a configuration that only comments gets no worktree, and its agent cannot push", () =>
  Effect.gen(function* () {
    const ctx = yield* started({});
    const { setup, task, world } = ctx;
    assert.equal(ctx.config.capability, "comment");
    assert.isNull(task.branch);
    assert.lengthOf(world.made, 0);
    assert.deepEqual(setup.launches[0]!.input.workspaceStrategy, { type: "root" });
    assert.include(setup.launches[0]!.input.initialMessage!.text, "You may only comment");
    const refused = yield* ctx.push.pipe(Effect.flip);
    assert.equal(refused.reason, "forbidden");
    assert.deepEqual(world.branchesOf(REPO), ["main"]);
  }),
);

live(
  "with approval for others, the first push for someone who is not an approver waits, and nothing reaches GitHub",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started({ capability: "push", approval: "others" });
      const { world, cwd } = ctx;
      const head = world.commit(cwd, { "a.txt": "a\n" });
      const waiting = yield* ctx.push;
      assert.isFalse(waiting.pushed);
      assert.include(waiting.message, "/makita ok");
      assert.isNull(world.tipOf(REPO, BRANCH));
      const row = yield* ctx.taskRow;
      assert.isNull(row.headSha);
      const pending = JSON.parse(row.pending ?? "{}") as Record<string, unknown>;
      assert.deepInclude(pending, {
        sha: head,
        branch: BRANCH,
        commits: 1,
        files: 1,
        additions: 1,
        deletions: 0,
      });
    }),
);

live("a worktree that cannot be made fails the task before any Thread starts", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup, due } = ctx;
    setup.gitWorld.seed(REPO, ["main"]);
    setup.gitWorld.state.failWorktree = true;
    yield* ctx.configure({ capability: "push", approval: "never" });
    yield* setup.makitaIntake.pollDue;
    setup.github.label(REPO, 12, "makita", OCTOCAT);
    yield* due;
    yield* setup.makitaIntake.pollDue;
    yield* setup.makitaTasks.startQueued;
    assert.lengthOf(setup.launches, 0);
    const [task] = yield* setup.server.sql<{ readonly state: string }>`
      SELECT state FROM makita_tasks
    `;
    assert.equal(task?.state, "failed");
    const [event] = yield* setup.server.sql<{ readonly detail: string | null }>`
      SELECT detail FROM makita_events WHERE outcome = 'started'
    `;
    assert.equal(event?.detail, "workspace-failed");
  }),
);

live(
  "Makita's token stays in the Hub: in no git argument, nowhere on the machine, in no row; only the push's own environment",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, world, cwd } = ctx;
      const token = classicToken("intake");
      world.commit(cwd, { "a.txt": "a\n" });
      assert.isTrue((yield* ctx.push).pushed);

      const pushes = world.gitRuns.filter((run) => run.args.includes("push"));
      assert.isAbove(pushes.length, 0);
      for (const run of world.gitRuns) {
        assert.notInclude(run.args.join(" "), token, run.operation);
      }
      // The credential helper's variable carries it to the one git process that needs it.
      const githubPush = world.gitRuns.find((run) => run.operation === "MakitaGitHub.push-branch");
      assert.equal(githubPush?.env.T3CODE_HUB_GIT_CREDENTIAL, token);
      for (const run of world.gitRuns.filter((entry) =>
        entry.operation.startsWith("MakitaPushes"),
      )) {
        assert.notInclude(JSON.stringify(run.env), token);
      }
      // Nowhere on the machine (its checkout, worktree and home), nor in the Hub repository.
      assert.notInclude(world.everything(world.machine), token);
      assert.notInclude(world.everything(world.hub), token);
      assert.notInclude(JSON.stringify(process.env), token);
      const rows = JSON.stringify([
        yield* setup.server.sql`SELECT * FROM makita_tasks`,
        yield* setup.server.sql`SELECT * FROM audit_log`,
      ]);
      assert.notInclude(rows, token);
    }),
);
