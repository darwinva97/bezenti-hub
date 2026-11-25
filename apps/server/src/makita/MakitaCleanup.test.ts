// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 27: the Hub closes Makita's own pull requests idle for the configuration's days
 * (once, with a comment, its branch deleted, its task ended) and, at once, one an approver labels
 * as bad work. Anyone else's label, another account's pull request, a pending approval, a running
 * turn and a pause are left alone.
 */
import { assert, it } from "@effect/vitest";
import {
  MAKITA_AUTONOMY_OFF,
  type MakitaConfigInput,
  type ProjectId,
  type UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { idleCloseText } from "./MakitaCleanup.ts";
import {
  GRACE_GH,
  MAKITA_BOT,
  type MakitaReady,
  makitaReady,
  OCTOCAT,
} from "./MakitaFixtures.testkit.ts";
import { type FakeGitHubUser, gitHubTime } from "./MakitaGitHub.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const GITHUB_NOW = "2026-11-24T10:00:00Z";
const CLEANING: Partial<MakitaConfigInput> = {
  capability: "push",
  approval: "never",
  autonomy: { ...MAKITA_AUTONOMY_OFF, closeIdlePrsDays: 30, badWorkLabel: "slop" },
};

const daysBefore = (iso: string, days: number) =>
  gitHubTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)) - days * 24 * 60 * 60 * 1_000);

const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
    yield* ctx.setup.makitaCleanup.badWorkQueued;
  });

/**
 * A task of `configId` on issue `pr - 30` whose pull request `pr` is on GitHub, opened by `by`,
 * last active `idleDays` ago; the Hub last touched the task long ago.
 */
const seed = (
  ctx: MakitaReady,
  input: {
    readonly configId: string;
    readonly projectId: ProjectId;
    readonly pr: number;
    readonly idleDays: number;
    readonly state?: string;
    readonly pending?: boolean;
    readonly by?: FakeGitHubUser;
    readonly open?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { setup } = ctx;
    const branch = `makita/${input.pr - 30}-fix`;
    yield* setup.server.sql`
      INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
        kind, thread_id, caller_github_id, caller_login, state, branch, base_branch, pr_number,
        pending_push_json, created_at, updated_at)
      VALUES (${`mkt_seed_${input.pr}`}, ${input.configId}, ${setup.acmeId}, ${input.projectId},
        'github.com', ${REPO}, ${input.pr - 30}, 'issue', ${`thread-seed-${input.pr}`}, 1,
        'octocat', ${input.state ?? "waiting-reply"}, ${branch}, NULL, ${input.pr},
        ${input.pending === true ? "{}" : null}, '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')
    `;
    const by = input.by ?? MAKITA_BOT;
    setup.github.pulls.set(`${REPO}#${input.pr}`, {
      number: input.pr,
      title: "Fix it",
      body: "",
      head: branch,
      base: "main",
      state: input.open === false ? "closed" : "open",
      user: by,
      headSha: "a".repeat(40),
      updatedAt: daysBefore(GITHUB_NOW, input.idleDays),
    });
    setup.github.issues.set(`${REPO}#${input.pr}`, {
      number: input.pr,
      title: "Fix it",
      body: "",
      user: by,
      state: input.open === false ? "closed" : "open",
      locked: false,
      pull: true,
    });
    return { branch, taskId: `mkt_seed_${input.pr}` };
  });

const tasks = (ctx: MakitaReady) =>
  ctx.setup.server.sql<{
    readonly pr: number;
    readonly state: string;
    readonly failure: string | null;
    readonly closed: string | null;
  }>`
    SELECT pr_number AS pr, state, failure, pr_closed_at AS closed FROM makita_tasks
    WHERE pr_number IS NOT NULL ORDER BY pr_number
  `;

const auditOf = (ctx: MakitaReady, action: string) =>
  ctx.setup.server.sql<{ readonly detail: string }>`
    SELECT detail_json AS detail FROM audit_log WHERE action = ${action} ORDER BY audit_id
  `.pipe(Effect.map((rows) => rows.map((row) => JSON.parse(row.detail) as object)));

const link = (ctx: MakitaReady, userId: UserId, user: FakeGitHubUser) =>
  Effect.gen(function* () {
    const asked = yield* ctx.setup.githubIdentities
      .linkCodeForSession({ login: user.login })
      .pipe(CommandActor.actAs(userId));
    ctx.setup.github.commentOn(REPO, 40, user, asked.comment);
    yield* tick(ctx);
  });

live(
  "an idle pull request of Makita's is closed once, said and its branch deleted; an active one, another account's, one waiting for approval and a running task's are left alone",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      setup.github.clock.now = GITHUB_NOW;
      const config = yield* ctx.configure(CLEANING);
      const base = { configId: config.configId, projectId: ctx.widgets };
      const idle = yield* seed(ctx, { ...base, pr: 41, idleDays: 40 });
      yield* seed(ctx, { ...base, pr: 42, idleDays: 1 });
      yield* seed(ctx, { ...base, pr: 43, idleDays: 40, pending: true });
      yield* seed(ctx, { ...base, pr: 44, idleDays: 40, state: "running" });
      yield* seed(ctx, { ...base, pr: 45, idleDays: 40, by: OCTOCAT });
      yield* seed(ctx, { ...base, pr: 46, idleDays: 40, open: false });

      yield* setup.makitaCleanup.sweepIdle;

      assert.deepEqual(setup.github.commentsBy(REPO, 41, "makita-bot"), [idleCloseText(30)]);
      assert.include(idleCloseText(30), "nothing happened here for 30 days");
      assert.include(idleCloseText(30), "Reopening it is fine");
      assert.equal(setup.github.pulls.get(`${REPO}#41`)!.state, "closed");
      assert.deepEqual(setup.github.deletedBranches, [{ repo: REPO, branch: idle.branch }]);
      for (const pr of [42, 43, 44, 45]) {
        assert.equal(setup.github.pulls.get(`${REPO}#${pr}`)!.state, "open", String(pr));
        assert.deepEqual(setup.github.commentsBy(REPO, pr, "makita-bot"), [], String(pr));
      }
      const rows = yield* tasks(ctx);
      assert.deepEqual(
        rows.map((row) => [row.pr, row.state, row.failure, row.closed !== null]),
        [
          [41, "stopped", "pr-idle", true],
          [42, "waiting-reply", null, false],
          [43, "waiting-reply", null, false],
          [44, "running", null, false],
          [45, "waiting-reply", null, false],
          [46, "waiting-reply", null, true],
        ],
      );
      assert.deepEqual(yield* auditOf(ctx, "makita.github.close_pull_request"), [
        {
          space: setup.acmeId,
          repo: REPO,
          number: 11,
          makita: config.configId,
          pr: 41,
          branch: idle.branch,
          reason: "idle",
          days: 30,
        },
      ]);
      // At most every 10 minutes, and never twice: nothing more happens now.
      yield* setup.makitaCleanup.sweepIdle;
      assert.lengthOf(setup.github.commentsBy(REPO, 41, "makita-bot"), 1);
    }),
);

live("with the option off or the configuration paused, nothing idle is closed", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup } = ctx;
    setup.github.clock.now = GITHUB_NOW;
    const off = yield* ctx.configure({ capability: "push", approval: "never" });
    const paused = yield* ctx.configure({ ...CLEANING, name: "Paused" });
    yield* setup.makitaConfigs
      .pauseForSession({ configId: paused.configId })
      .pipe(CommandActor.actAs(setup.people.member));
    yield* seed(ctx, { configId: off.configId, projectId: ctx.widgets, pr: 41, idleDays: 200 });
    yield* seed(ctx, { configId: paused.configId, projectId: ctx.widgets, pr: 42, idleDays: 200 });
    yield* setup.makitaCleanup.sweepIdle;
    assert.equal(setup.github.pulls.get(`${REPO}#41`)!.state, "open");
    assert.equal(setup.github.pulls.get(`${REPO}#42`)!.state, "open");
    assert.lengthOf(yield* auditOf(ctx, "makita.github.close_pull_request"), 0);
  }),
);

live(
  "an approver's bad-work label closes Makita's pull request at once and stops its task; anyone else's does nothing; paused, nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure(CLEANING);
      yield* setup.makitaIntake.pollDue;
      // Grace, the creator, approves with her linked account.
      yield* link(ctx, setup.people.member, GRACE_GH);
      const base = { configId: config.configId, projectId: ctx.widgets, idleDays: 0 };
      const work = yield* seed(ctx, { ...base, pr: 47, state: "running" });

      // octocat may ask Makita for things, but does not approve: the label is only a label.
      setup.github.label(REPO, 47, "slop", OCTOCAT, { pull: true });
      yield* tick(ctx);
      assert.equal(setup.github.pulls.get(`${REPO}#47`)!.state, "open");
      // Another label by an approver means nothing either.
      setup.github.label(REPO, 47, "needs-work", GRACE_GH, { pull: true });
      yield* tick(ctx);
      assert.equal(setup.github.pulls.get(`${REPO}#47`)!.state, "open");

      setup.github.label(REPO, 47, "SLOP", GRACE_GH, { pull: true });
      yield* tick(ctx);
      assert.equal(setup.github.pulls.get(`${REPO}#47`)!.state, "closed");
      assert.deepEqual(setup.github.deletedBranches, [{ repo: REPO, branch: work.branch }]);
      assert.deepEqual(setup.github.commentsBy(REPO, 47, "makita-bot"), []);
      assert.deepEqual(
        (yield* tasks(ctx)).map((row) => [row.pr, row.state, row.failure]),
        [[47, "stopped", "bad-work"]],
      );
      assert.deepEqual(
        (yield* ctx.events)
          .filter((row) => row.number === 47)
          .map((row) => [row.login, row.outcome, row.detail]),
        [
          ["octocat", "ignored-not-approver", "bad-work"],
          ["Grace-GH", "command", "bad-work:closed"],
        ],
      );
      assert.deepInclude((yield* auditOf(ctx, "makita.github.close_pull_request"))[0]!, {
        reason: "bad-work",
        by: "Grace-GH",
        byId: GRACE_GH.id,
        pr: 47,
      });
      // The `closed` event that follows finds the task already stopped.
      yield* tick(ctx);
      assert.equal((yield* tasks(ctx))[0]!.failure, "bad-work");

      // Paused: an approver's label is ignored and nothing is closed.
      yield* seed(ctx, { ...base, pr: 48 });
      yield* setup.makitaConfigs
        .pauseForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      setup.github.label(REPO, 48, "slop", GRACE_GH, { pull: true });
      yield* tick(ctx);
      assert.equal(setup.github.pulls.get(`${REPO}#48`)!.state, "open");
      assert.deepEqual(
        (yield* ctx.events)
          .filter((row) => row.number === 48)
          .map((row) => [row.outcome, row.detail]),
        [["ignored-paused", "bad-work"]],
      );
    }),
);
