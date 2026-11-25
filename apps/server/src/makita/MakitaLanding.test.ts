// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 13: Makita's pull request lands only on an approver's order, `/makita merge` or
 * their own words through `makita_request_merge`, and only with CI green on the exact head Makita
 * pushed, GitHub saying it merges cleanly and no workflow touched. Everything else is refused,
 * and anything stopped wins. Each attempt of the design note's table is a case here.
 */
import { assert, it } from "@effect/vitest";
import {
  MAKITA_GITHUB_HOST,
  type MakitaConfigInput,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as MakitaActivity from "./MakitaActivity.ts";
import {
  DEPENDABOT,
  GRACE_GH,
  MAKITA_BOT,
  type MakitaReady,
  makitaReady,
  OCTOCAT,
  STRANGER,
} from "./MakitaFixtures.testkit.ts";
import { type FakeCi, type FakeGitHubUser, gitHubTime } from "./MakitaGitHub.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const BRANCH = "makita/12-login-fails";
const LANDING: Partial<MakitaConfigInput> = {
  capability: "push",
  mayLand: true,
  approval: "never",
  triggers: { label: "makita", assigned: false, mention: true },
};
const BODY = [
  "## Problem",
  "Login fails.",
  "## Fix",
  "Check it.",
  "## Verified",
  "CI.",
  "## Downsides",
  "None.",
].join("\n");
const GREEN: FakeCi = {
  checkRuns: [{ id: 801, name: "typecheck", status: "completed", conclusion: "success" }],
  statuses: [],
};

/** GitHub's clock a little after the Hub's now: a comment written after Makita's last push. */
const afterNow = (ctx: MakitaReady) =>
  Effect.map(DateTime.now, (now) => {
    ctx.setup.github.clock.now = gitHubTime(DateTime.toEpochMillis(now) + 1_000);
  });
/** GitHub's clock at the Hub's now, to the second: a comment before the next push. */
const atNow = (ctx: MakitaReady) =>
  Effect.map(DateTime.now, (now) => {
    ctx.setup.github.clock.now = gitHubTime(DateTime.toEpochMillis(now) - 1_000);
  });

/** One Scheduler tick: the poll, the tasks pass, then the merge orders. */
const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
    yield* ctx.setup.makitaTasks.awaitStarting;
    yield* ctx.setup.makitaLanding.landQueued;
  });

const link = (ctx: MakitaReady, userId: UserId, user: FakeGitHubUser) =>
  Effect.gen(function* () {
    const asked = yield* ctx.setup.githubIdentities
      .linkCodeForSession({ login: user.login })
      .pipe(CommandActor.actAs(userId));
    ctx.setup.github.commentOn(REPO, 40, user, asked.comment);
    yield* tick(ctx);
  });

const auditOf = (ctx: MakitaReady, action: string) =>
  ctx.setup.server.sql<{ readonly source: string; readonly detail: string }>`
    SELECT actor_source AS source, detail_json AS detail
    FROM audit_log WHERE action = ${action} ORDER BY audit_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ source: row.source, detail: JSON.parse(row.detail) as object })),
    ),
  );

/**
 * Grace (the creator, linked as Grace-GH, the approver) set a configuration that may land;
 * octocat (allowed, not an approver) asked on issue 12; Makita pushed one commit, opened its PR
 * and CI passed on it.
 */
const ready = (over: Partial<MakitaConfigInput> = {}) =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup } = ctx;
    const world = setup.gitWorld;
    world.seed(REPO, ["main"]);
    const config = yield* ctx.configure({ ...LANDING, ...over });
    yield* setup.makitaIntake.pollDue;
    yield* link(ctx, setup.people.member, GRACE_GH);
    setup.github.label(REPO, 12, "makita", OCTOCAT, { title: "Login fails!" });
    yield* tick(ctx);
    setup.github.hooks.branchTip = (repo, branch) => world.tipOf(repo, branch);
    const [task] = yield* setup.server.sql<{ readonly taskId: string; readonly threadId: string }>`
      SELECT task_id AS "taskId", thread_id AS "threadId" FROM makita_tasks WHERE number = 12
    `;
    const threadId = ThreadId.make(task!.threadId);
    const cwd = world.made[0]?.cwd ?? "";
    let commits = 0;
    /** The agent commits and Makita pushes; CI passes on it unless told otherwise. */
    const push = (ci: FakeCi | null = GREEN) =>
      Effect.gen(function* () {
        commits += 1;
        const head = world.commit(cwd, { "src/login.ts": `export const fixed = ${commits};\n` });
        const pushed = yield* setup.makitaPushes.pushForThread(threadId);
        assert.isTrue(pushed.pushed, pushed.message);
        if (ci !== null) setup.github.ci.set(head, ci);
        return head;
      });
    const head = yield* push();
    const opened = yield* setup.makitaPullRequests.openForThread(threadId, {
      title: "Fix the login",
      body: BODY,
    });
    assert.isTrue(opened.opened, opened.message);
    const pr = opened.number!;
    const row = setup.server.sql<{
      readonly state: string;
      readonly landedSha: string | null;
      readonly headSha: string | null;
    }>`
      SELECT state, landed_sha AS "landedSha", head_sha AS "headSha"
      FROM makita_tasks WHERE task_id = ${task!.taskId}
    `.pipe(Effect.map((rows) => rows[0]!));
    /** `user` writes `body` on the PR (or `on`), after Makita's last push unless `before`. */
    const say = (user: FakeGitHubUser, body: string, on = pr, before = false) =>
      Effect.gen(function* () {
        yield* before ? atNow(ctx) : afterNow(ctx);
        return setup.github.commentOn(REPO, on, user, body);
      });
    /** What Makita wrote on the PR, and on issue 12. */
    const onPr = () => setup.github.commentsBy(REPO, pr, MAKITA_BOT.login);
    const merges = () => setup.github.merges;
    const request = (commentId: number, kind: "issue-comment" | "review-comment" | "review") =>
      setup.makitaLanding.requestForThread(threadId, { commentId, kind });
    return {
      ...ctx,
      config,
      task: task!,
      threadId,
      world,
      head,
      pr,
      push,
      row,
      say,
      onPr,
      merges,
      request,
    };
  });

live(
  "an approver's /makita merge lands the PR with the checked head, says so with the order's link, deletes the branch and audits who ordered it",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready();
      const { setup, pr, head } = ctx;

      const order = yield* ctx.say(GRACE_GH, "/makita MERGE");
      yield* tick(ctx);

      // One merge, through GitHub's merge API, of exactly the head Makita pushed.
      assert.deepEqual(
        ctx.merges().map((merge) => [merge.number, merge.sha, merge.method]),
        [[pr, head, "merge"]],
      );
      const puts = setup.github.requests.filter((request) => request.method === "PUT");
      assert.deepEqual(
        puts.map((request) => [request.path, request.body]),
        [[`repos/${REPO}/pulls/${pr}/merge`, { sha: head, merge_method: "merge" }]],
      );
      // Never a push to the base: the only git pushes went to Makita's branch.
      for (const run of setup.gitWorld.gitRuns.filter((entry) => entry.args.includes("push"))) {
        assert.isTrue(
          run.args.some((arg) => arg.endsWith(`refs/heads/${BRANCH}`)),
          run.args.join(" "),
        );
      }
      assert.deepEqual(setup.github.deletedBranches, [{ repo: REPO, branch: BRANCH }]);
      const landed = ctx.merges()[0]!.mergeSha;
      assert.deepEqual(yield* ctx.row, { state: "done", landedSha: landed, headSha: head });
      assert.deepEqual(ctx.onPr(), [
        `Merged into \`main\`, ordered by @Grace-GH.\n\nOrder: https://github.com/${REPO}/issues/${pr}#issuecomment-${order.id}\nMerged: \`${landed.slice(0, 12)}\``,
      ]);
      const events = (yield* ctx.events).filter(
        (event) => event.key === `gh:issue-comment:${order.id}`,
      );
      assert.deepEqual(
        events.map((event) => [event.outcome, event.detail, event.taskId]),
        [["land", "merged", ctx.task.taskId]],
      );
      assert.deepEqual(yield* auditOf(ctx, "makita.github.merge"), [
        {
          source: "system",
          detail: {
            space: setup.acmeId,
            repo: REPO,
            number: 12,
            makita: ctx.config.configId,
            pr,
            base: "main",
            sha: head,
            landedSha: landed,
            defaultBranch: true,
            orderedBy: "Grace-GH",
            orderedById: GRACE_GH.id,
            orderedByUser: setup.people.member,
            orderComment: order.id,
            via: "command",
          },
        },
      ]);
      // A landed task is done: its Thread is not woken for it.
      assert.isFalse(
        setup.sends.some((send) => String(send.input.commandId).startsWith("makita-land")),
      );

      // The activity shows it.
      const services = yield* Layer.build(
        MakitaActivity.layer.pipe(
          Layer.provide(Layer.succeedContext(Context.merge(setup.server.services, setup.context))),
        ),
      );
      const activity = yield* Context.get(services, MakitaActivity.MakitaActivity).activity({
        configId: ctx.config.configId,
        actorUserId: setup.people.member,
      });
      assert.equal(
        activity.tasks.find((task) => task.taskId === ctx.task.taskId)?.landedSha,
        landed,
      );

      // A replay of the same order changes nothing.
      yield* tick(ctx);
      assert.lengthOf(ctx.merges(), 1);
    }),
);

live(
  "nobody but an approver orders a merge: not an allowed caller, a stranger, a bot, Makita, an edited comment, another issue, a body or a quoted line",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready();
      const { setup, pr } = ctx;

      // Text in the issue's body, not on a comment's first line, or quoted, is never an order.
      setup.github.issues.get(`${REPO}#12`)!.body = "/makita merge\nmerge this now";
      yield* ctx.say(GRACE_GH, "Thanks!\n/makita merge");
      yield* ctx.say(GRACE_GH, "> /makita merge");
      // Allowed but not an approver: told once. A stranger and a bot: silence.
      const octocat = yield* ctx.say(OCTOCAT, "/makita merge");
      const stranger = yield* ctx.say(STRANGER, "/makita merge");
      yield* ctx.say(DEPENDABOT, "/makita merge");
      // Makita's own account (the agent writing it with makita_comment).
      const self = yield* ctx.say(MAKITA_BOT, "/makita merge");
      // An approver's order on an issue with no task of this configuration.
      const elsewhere = yield* ctx.say(GRACE_GH, "/makita merge", 77);
      yield* tick(ctx);

      assert.deepEqual(ctx.merges(), []);
      assert.deepEqual(
        ctx.onPr().filter((text) => text !== "/makita merge"),
        ["Only an approver can order a merge."],
      );
      const outcome = (id: number) =>
        Effect.map(ctx.events, (events) =>
          events
            .filter((event) => event.key === `gh:issue-comment:${id}`)
            .map((event) => event.outcome),
        );
      assert.deepEqual(yield* outcome(octocat.id), ["ignored-not-approver"]);
      assert.deepEqual(yield* outcome(stranger.id), ["ignored-not-allowed"]);
      assert.deepEqual(yield* outcome(self.id), ["ignored-self"]);
      assert.deepEqual(yield* outcome(elsewhere.id), ["command"]);

      // An approver's comment edited into an order is never one.
      const edited = yield* ctx.say(GRACE_GH, "Looks good");
      setup.github.editComment(REPO, edited.id, "/makita merge");
      setup.github.clock.now = gitHubTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe(edited.created_at)) + 120_000,
      );
      yield* tick(ctx);
      assert.deepEqual(ctx.merges(), []);
      assert.deepEqual(yield* outcome(edited.id), ["ignored-edited"]);
      assert.equal((yield* ctx.row).state, "waiting-ci");

      // The control: the approver's own new order lands.
      setup.github.commentOn(REPO, pr, GRACE_GH, "/makita merge");
      yield* tick(ctx);
      assert.lengthOf(ctx.merges(), 1);
    }),
);

live(
  "an order older than Makita's last push, a push after the order, or someone else's push does not land",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready();
      const { setup, world } = ctx;

      // Written before the last push: refused, and said.
      yield* ctx.say(GRACE_GH, "/makita merge", ctx.pr, true);
      const second = yield* ctx.push();
      yield* tick(ctx);
      assert.deepEqual(ctx.merges(), []);
      assert.equal(
        ctx.onPr().at(-1),
        `I pushed \`${second.slice(0, 12)}\` after this order; order again once CI passes on it.`,
      );
      // The Thread hears it once.
      assert.include(String(setup.sends.at(-1)?.input.text), "did not merge");

      // Ordered, then Makita pushes before the order is handled: the order no longer holds.
      yield* ctx.say(GRACE_GH, "/makita merge", ctx.pr, true);
      yield* setup.makitaIntake.pollDue.pipe(Effect.andThen(ctx.due));
      const third = yield* ctx.push();
      yield* tick(ctx);
      assert.deepEqual(ctx.merges(), []);
      assert.include(ctx.onPr().at(-1)!, `I pushed \`${third.slice(0, 12)}\` after this order`);

      // Someone else pushes to Makita's branch: never landed.
      world.pushAsSomeoneElse(REPO, BRANCH);
      setup.github.ci.set(world.tipOf(REPO, BRANCH)!, GREEN);
      yield* ctx.say(GRACE_GH, "/makita merge");
      yield* tick(ctx);
      assert.deepEqual(ctx.merges(), []);
      assert.equal(
        ctx.onPr().at(-1),
        "Someone else pushed to this pull request; I only land commits I pushed.",
      );
    }),
);

live(
  "CI red, pending or absent on the head, a PR GitHub blocks, a workflow file, rebase-only, or landing turned off: no merge, and the reason once",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready();
      const { setup, head, pr } = ctx;
      const sha = `\`${head.slice(0, 12)}\``;
      const pull = setup.github.pulls.get(`${REPO}#${pr}`)!;
      const cases: ReadonlyArray<readonly [string, () => void, string]> = [
        [
          "red",
          () =>
            setup.github.ci.set(head, {
              checkRuns: [{ id: 9, name: "lint", status: "completed", conclusion: "failure" }],
              statuses: [],
            }),
          `CI failed on ${sha}; I only land commits CI passed.`,
        ],
        [
          "pending",
          () =>
            setup.github.ci.set(head, {
              checkRuns: [{ id: 9, name: "lint", status: "in_progress", conclusion: null }],
              statuses: [],
            }),
          `CI is still running on ${sha}; order again when it passes.`,
        ],
        [
          "none",
          () => setup.github.ci.delete(head),
          `No CI ran on ${sha}; I only land commits CI passed.`,
        ],
        [
          "blocked",
          () => {
            setup.github.ci.set(head, GREEN);
            pull.mergeable = true;
            pull.mergeableState = "blocked";
          },
          "GitHub says this pull request cannot be merged now (blocked).",
        ],
        [
          "conflict",
          () => {
            pull.mergeable = false;
            pull.mergeableState = "dirty";
          },
          "GitHub says this pull request cannot be merged now (dirty).",
        ],
        [
          "workflow",
          () => {
            pull.mergeable = true;
            pull.mergeableState = "clean";
            setup.github.pullFiles.set(`${REPO}#${pr}`, [
              { filename: "src/login.ts" },
              { filename: "ci.yml", previous_filename: ".github/workflows/ci.yml" },
            ]);
          },
          "This pull request changes `.github/workflows`; I never land that.",
        ],
        [
          "rebase only",
          () => {
            setup.github.pullFiles.delete(`${REPO}#${pr}`);
            setup.github.mergeSettings.set(REPO, { merge: false, squash: false });
          },
          "This repository allows only rebase merges; I never rebase.",
        ],
      ];
      for (const [why, arrange, said] of cases) {
        arrange();
        yield* ctx.say(GRACE_GH, "/makita merge");
        yield* tick(ctx);
        assert.deepEqual(ctx.merges(), [], why);
        assert.equal(ctx.onPr().at(-1), said, why);
      }
      assert.deepEqual(
        setup.github.requests.filter((request) => request.method === "PUT"),
        [],
      );

      // Landing off: refused with that reason, and the agent is not woken for it.
      setup.github.mergeSettings.set(REPO, { merge: false, squash: true });
      yield* setup.makitaConfigs
        .updateForSession({
          ...ctx.input({ ...LANDING, mayLand: false }),
          configId: ctx.config.configId,
        })
        .pipe(CommandActor.actAs(setup.people.member));
      const before = setup.sends.length;
      yield* ctx.say(GRACE_GH, "/makita merge");
      yield* tick(ctx);
      assert.deepEqual(ctx.merges(), []);
      assert.equal(ctx.onPr().at(-1), "Landing is off for this configuration.");
      assert.equal(setup.sends.length, before);
      const updates = yield* auditOf(ctx, "makita.config.update");
      assert.deepInclude(updates.at(-1)!.detail, { changed: "may_land", mayLand: false });

      // On again: a repository that refuses merge commits gets a squash.
      yield* setup.makitaConfigs
        .updateForSession({ ...ctx.input(LANDING), configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      yield* ctx.say(GRACE_GH, "/makita merge");
      yield* tick(ctx);
      assert.deepEqual(
        ctx.merges().map((merge) => merge.method),
        ["squash"],
      );
    }),
);

live("a pause, «Stop all» or /makita stop wins over a valid order, and nothing is said", () =>
  Effect.gen(function* () {
    const ctx = yield* ready();
    const { setup } = ctx;
    const quiet = ctx.onPr().length;

    // Queued, then Makita is stopped before the order is handled.
    yield* ctx.say(GRACE_GH, "/makita merge");
    yield* setup.makitaIntake.pollDue;
    yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner);
    yield* setup.makitaTasks.startQueued;
    yield* setup.makitaLanding.landQueued;
    assert.deepEqual(ctx.merges(), []);
    assert.equal(ctx.onPr().length, quiet);
    // A request is refused as well.
    const order = yield* ctx.say(GRACE_GH, "@makita-bot merge it", 12);
    const refused = yield* ctx.request(order.id, "issue-comment").pipe(Effect.flip);
    assert.equal(refused.reason, "forbidden");
  }),
);

live("/makita stop right after a valid order, in the same poll, wins", () =>
  Effect.gen(function* () {
    const ctx = yield* ready();
    const quiet = ctx.onPr().length;
    yield* ctx.say(GRACE_GH, "/makita merge");
    yield* ctx.say(OCTOCAT, "/makita stop", 12);
    yield* tick(ctx);
    yield* tick(ctx);
    assert.deepEqual(ctx.merges(), []);
    assert.equal((yield* ctx.row).state, "stopped");
    assert.equal(ctx.onPr().length, quiet);
  }),
);

live("a paused configuration does not land a valid order", () =>
  Effect.gen(function* () {
    const ctx = yield* ready();
    const { setup } = ctx;
    yield* ctx.say(GRACE_GH, "/makita merge");
    yield* setup.makitaIntake.pollDue;
    yield* setup.makitaConfigs
      .pauseForSession({ configId: ctx.config.configId })
      .pipe(CommandActor.actAs(setup.people.member));
    yield* setup.makitaTasks.startQueued;
    yield* setup.makitaLanding.landQueued;
    assert.deepEqual(ctx.merges(), []);
    assert.deepEqual(ctx.onPr(), []);
  }),
);

live(
  "makita_request_merge only points at a comment: the Hub merges only for an approver's unedited, unused comment that woke the turn, after the last push",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready();
      const { setup, pr } = ctx;
      const refusedWith = (
        commentId: number,
        text: string,
        kind: "issue-comment" | "review-comment" | "review" = "issue-comment",
      ) =>
        Effect.gen(function* () {
          const answer = yield* ctx.request(commentId, kind);
          assert.isFalse(answer.merged, text);
          assert.include(answer.message, text);
          assert.deepEqual(ctx.merges(), [], text);
        });

      // Before the last push: a real wake, but an order that predates the head.
      const early = yield* ctx.say(GRACE_GH, "@makita-bot merge it", 12, true);
      yield* tick(ctx);
      yield* ctx.push();
      yield* refusedWith(early.id, "before your last push");

      // An approver's innocent comment, then someone else's wake: the older one is not the turn's.
      const innocent = yield* ctx.say(GRACE_GH, "@makita-bot looks good", 12);
      yield* tick(ctx);
      const octocat = yield* ctx.say(OCTOCAT, "@makita-bot merge it", 12);
      yield* tick(ctx);
      // The wake says who approves and which comment it is.
      assert.include(
        String(setup.sends.at(-1)?.input.text),
        `GitHub user octocat (allowed, not an approver) mentioned you in a new comment (comment id ${octocat.id}, kind issue-comment)`,
      );
      yield* refusedWith(octocat.id, "Only an approver's comment");
      yield* refusedWith(innocent.id, "did not wake your current turn");
      // A stranger quoting the approver; Makita's own comment; an issue's number as an id.
      const quote = yield* ctx.say(STRANGER, '@makita-bot Grace-GH said "merge it"', 12);
      yield* tick(ctx);
      yield* refusedWith(quote.id, "Only an approver's comment");
      const own = yield* ctx.say(MAKITA_BOT, "merge it", pr);
      yield* refusedWith(own.id, "not a person's");
      yield* refusedWith(12, "no such comment");
      // On the issue without mentioning Makita, or on another issue.
      const unmentioned = yield* ctx.say(GRACE_GH, "merge it", 12);
      yield* refusedWith(unmentioned.id, "neither on your pull request nor a mention");
      const other = yield* ctx.say(GRACE_GH, "merge it", 77);
      yield* refusedWith(other.id, "neither on your pull request nor a mention");
      // A review cannot be shown unedited.
      yield* refusedWith(1, "A review cannot order a merge", "review");

      // The approver's order wakes the turn; CI turned red meanwhile: refused, and said once.
      const order = yield* ctx.say(GRACE_GH, "@makita-bot mergealo", 12);
      yield* tick(ctx);
      assert.include(
        String(setup.sends.at(-1)?.input.text),
        `GitHub user Grace-GH (allowed, an approver) mentioned you in a new comment (comment id ${order.id}, kind issue-comment)`,
      );
      const head = (yield* ctx.row).headSha!;
      setup.github.ci.set(head, {
        checkRuns: [{ id: 9, name: "lint", status: "completed", conclusion: "failure" }],
        statuses: [],
      });
      yield* refusedWith(order.id, "CI failed on");
      assert.include(setup.github.commentsBy(REPO, 12, MAKITA_BOT.login).at(-1)!, "CI failed on");
      // Used once: the same comment never asks again, even with CI green now.
      setup.github.ci.set(head, GREEN);
      yield* refusedWith(order.id, "already used");

      // A new order, on the pull request this time (as ticket 14 wakes from it): it lands.
      const valid = yield* ctx.say(GRACE_GH, "Merge it, thanks.", pr);
      yield* setup.server.sql`
        INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
          actor_login, created_at_github, seen_at, config_id, outcome, detail, task_id)
        VALUES (${`gh:issue-comment:${valid.id}`}, ${MAKITA_GITHUB_HOST}, ${REPO}, ${pr}, 'pull',
          ${GRACE_GH.id}, ${GRACE_GH.login}, ${valid.created_at},
          ${DateTime.formatIso(yield* DateTime.now)}, ${ctx.config.configId}, 'started',
          'continued', ${ctx.task.taskId})
      `;
      // Edited after it woke the turn: refused.
      const editedOrder = yield* ctx.say(GRACE_GH, "@makita-bot merge it", 12);
      yield* tick(ctx);
      setup.github.editComment(REPO, editedOrder.id, "@makita-bot merge it now");
      yield* refusedWith(editedOrder.id, "edited");
      // `valid` is no longer the newest wake either: one more, then the request.
      const last = yield* ctx.say(GRACE_GH, "Merge it.", pr);
      yield* setup.server.sql`
        INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
          actor_login, created_at_github, seen_at, config_id, outcome, detail, task_id)
        VALUES (${`gh:issue-comment:${last.id}`}, ${MAKITA_GITHUB_HOST}, ${REPO}, ${pr}, 'pull',
          ${GRACE_GH.id}, ${GRACE_GH.login}, ${last.created_at},
          ${DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + 5_000))},
          ${ctx.config.configId}, 'started', 'continued', ${ctx.task.taskId})
      `;
      yield* refusedWith(valid.id, "did not wake your current turn");
      const answer = yield* ctx.request(last.id, "issue-comment");
      assert.isTrue(answer.merged, answer.message);
      assert.deepEqual(
        ctx.merges().map((merge) => [merge.number, merge.sha]),
        [[pr, head]],
      );
      assert.include(ctx.onPr().at(-1)!, "Merged into `main`, ordered by @Grace-GH.");
      const audited = yield* auditOf(ctx, "makita.github.merge");
      assert.deepInclude(audited[0]!.detail, {
        via: "request",
        orderedBy: "Grace-GH",
        orderComment: last.id,
      });
      assert.equal((yield* ctx.row).state, "done");
    }),
);

live("landing needs push; the agent is told how to ask only where its configuration may land", () =>
  Effect.gen(function* () {
    const ctx = yield* ready();
    const { setup } = ctx;
    const first = setup.launches[0]!.input.initialMessage!.text;
    assert.include(first, "makita_request_merge");
    assert.include(first, "ask instead");
    assert.notInclude(first, "You may never merge");
    const created = yield* auditOf(ctx, "makita.config.create");
    assert.deepInclude(created[0]!.detail, { capability: "push", mayLand: true });

    const without = yield* ready({ mayLand: false });
    const text = without.setup.launches[0]!.input.initialMessage!.text;
    assert.notInclude(text, "makita_request_merge");
    assert.include(text, "You may never merge or approve a pull request.");
    const refused = yield* without.setup.makitaLanding
      .requestForThread(without.threadId, { commentId: 1, kind: "issue-comment" })
      .pipe(Effect.flip);
    assert.equal(refused.reason, "forbidden");
  }),
);
