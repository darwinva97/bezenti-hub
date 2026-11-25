// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 12: a pushing task opens one pull request from its own branch into the base, with
 * the four sections; the Hub watches CI on the exact commit it pushed, wakes the Thread on a RED
 * (three fixes at most), says GREEN once, and stops watching when the work is paused or stopped.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { CI_GAVE_UP, CI_TIMEOUT } from "./makitaCi.ts";
import { classicToken, type FakeCi } from "./MakitaGitHub.testkit.ts";
import { MAKITA_BOT, makitaReady, OCTOCAT } from "./MakitaFixtures.testkit.ts";
import { MAX_CI_FIXES } from "./MakitaPullRequests.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const BRANCH = "makita/12-login-fails";
const BODY = [
  "## Problem",
  "Login fails with an empty password.",
  "## Fix",
  "Check the password before sending it.",
  "## Verified",
  "bezenti-verify on the branch.",
  "## Downsides",
  "None known.",
].join("\n");

/** When the push was, as if it were `minutes` ago. */
const minutesAgo = (minutes: number) =>
  Effect.map(DateTime.now, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) - minutes * 60_000)),
  );

const failingCi = (name = "typecheck", id = 901): FakeCi => ({
  checkRuns: [
    { id, name, status: "completed", conclusion: "failure" },
    { id: id + 1, name: "lint", status: "completed", conclusion: "success" },
  ],
  statuses: [],
});
const passingCi: FakeCi = {
  checkRuns: [{ id: 801, name: "typecheck", status: "completed", conclusion: "success" }],
  statuses: [{ context: "deploy-preview", state: "success" }],
};

/** A push configuration's task on issue 12, with one commit pushed to its branch. */
const pushed = Effect.gen(function* () {
  const ctx = yield* makitaReady;
  const { setup, due } = ctx;
  const world = setup.gitWorld;
  world.seed(REPO, ["main"]);
  const config = yield* ctx.configure({ capability: "push", approval: "never" });
  yield* setup.makitaIntake.pollDue;
  setup.github.label(REPO, 12, "makita", OCTOCAT, { title: "Login fails!" });
  yield* due;
  yield* setup.makitaIntake.pollDue;
  yield* setup.makitaTasks.startQueued;
  yield* setup.makitaTasks.awaitStarting;
  setup.github.hooks.branchTip = (repo, branch) => world.tipOf(repo, branch);
  const [task] = yield* setup.server.sql<{ readonly taskId: string; readonly threadId: string }>`
    SELECT task_id AS "taskId", thread_id AS "threadId" FROM makita_tasks
  `;
  const threadId = ThreadId.make(task!.threadId);
  const cwd = world.made[0]?.cwd ?? "";
  /** The agent commits a change and publishes it: the commit pushed. */
  const commitAndPush = (n: number) =>
    Effect.gen(function* () {
      const head = world.commit(cwd, { "src/login.ts": `export const fixed = ${n};\n` });
      const result = yield* setup.makitaPushes.pushForThread(threadId);
      assert.isTrue(result.pushed, result.message);
      return head;
    });
  const open = (input: { readonly title?: string; readonly body?: string } = {}) =>
    setup.makitaPullRequests.openForThread(threadId, {
      title: input.title ?? "Fix the login",
      body: input.body ?? BODY,
    });
  const row = setup.server.sql<{
    readonly state: string;
    readonly prNumber: number | null;
    readonly ciSha: string | null;
    readonly ciState: string | null;
    readonly attempts: number;
  }>`
    SELECT state, pr_number AS "prNumber", ci_sha AS "ciSha", ci_state AS "ciState",
      ci_fix_attempts AS attempts
    FROM makita_tasks WHERE task_id = ${task!.taskId}
  `.pipe(Effect.map((rows) => rows[0]!));
  const posts = () =>
    setup.github.requests.filter(
      (request) => request.method === "POST" && /\/pulls$/u.test(request.path),
    );
  const ciReads = () => setup.github.requests.filter((request) => /check-runs/u.test(request.path));
  return {
    ...ctx,
    config,
    taskId: task!.taskId,
    threadId,
    world,
    cwd,
    commitAndPush,
    open,
    row,
    posts,
    ciReads,
  };
});

/** `pushed`, with its pull request open on the first pushed commit. */
const opened = Effect.gen(function* () {
  const ctx = yield* pushed;
  const head = yield* ctx.commitAndPush(1);
  const result = yield* ctx.open();
  assert.isTrue(result.opened, result.message);
  return { ...ctx, head, pr: result.number! };
});

live(
  "opens one pull request from its pushed makita/ branch into the base, with the four sections and the footer, audited and linked to its Thread",
  () =>
    Effect.gen(function* () {
      const ctx = yield* pushed;
      const { setup } = ctx;

      // Red-first: nothing to open before the branch is pushed.
      const early = yield* ctx.open();
      assert.isFalse(early.opened);
      assert.include(early.message, "makita_push");
      const head = yield* ctx.commitAndPush(1);

      // A body without «Downsides» is refused, naming it; nothing reaches GitHub.
      const noDownsides = yield* ctx
        .open({ body: BODY.split("## Downsides")[0]! })
        .pipe(Effect.flip);
      assert.equal(noDownsides.reason, "invalid");
      assert.include(noDownsides.message, "Downsides");
      const emptyFix = yield* ctx
        .open({ body: BODY.replace("Check the password before sending it.", "") })
        .pipe(Effect.flip);
      assert.include(emptyFix.message, "Fix");
      // Anything shaped like a token, or a link to the Hub, is refused.
      const tokenShaped = yield* ctx
        .open({ body: `${BODY}\n${classicToken("leaked")}` })
        .pipe(Effect.flip);
      assert.include(tokenShaped.message, "token");
      const hubLink = yield* ctx
        .open({ body: `${BODY}\nSee t3-thread://env/thread for details.` })
        .pipe(Effect.flip);
      assert.include(hubLink.message, "Hub");
      assert.lengthOf(ctx.posts(), 0);

      // A creator's secret is masked before it goes out.
      setup.creatorSecrets.push("hunter2-value");
      const result = yield* ctx.open({ body: `${BODY}\nIt printed hunter2-value.` });
      assert.isTrue(result.opened, result.message);
      const pr = setup.github.pulls.get(`${REPO}#${result.number}`)!;
      assert.deepEqual([pr.head, pr.base, pr.title], [BRANCH, "main", "Fix the login"]);
      assert.notInclude(pr.body, "hunter2-value");
      assert.isTrue(pr.body.endsWith("---\nOpened by Makita for @octocat (#12)"));
      assert.equal(result.url, `https://github.com/${REPO}/pull/${result.number}`);
      assert.deepEqual(yield* ctx.row, {
        state: "waiting-ci",
        prNumber: result.number,
        ciSha: head,
        ciState: "pending",
        attempts: 0,
      });

      // Audited as the creator's agent; linked to the Thread as the creator.
      const audited = yield* setup.server.sql<{
        readonly source: string;
        readonly actor: string | null;
        readonly detail: string;
      }>`
        SELECT actor_source AS source, actor_user_id AS actor, detail_json AS detail
        FROM audit_log WHERE action = 'makita.github.pull_request'
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
              makita: ctx.config.configId,
              pr: result.number,
              branch: BRANCH,
              base: "main",
            },
          ],
        ],
      );
      const link = setup.commands.find(
        (entry) => entry.command.type === "thread.pull-request.link",
      );
      assert.deepInclude(link!.command as unknown as Record<string, unknown>, {
        threadId: ctx.threadId,
        host: "github.com",
        repository: REPO,
        number: result.number,
        source: "agent",
      });
      assert.deepInclude(link!.actor, { _tag: "User", userId: setup.people.member });

      // One pull request per task: a second call opens nothing.
      const again = yield* ctx.open();
      assert.deepEqual([again.opened, again.number], [false, result.number]);
      assert.lengthOf(ctx.posts(), 1);
      // The token went out in no request body.
      const token = classicToken("intake");
      assert.notInclude(JSON.stringify(setup.github.requests), token);
    }),
);

live(
  "a RED wakes the Thread once with the failing checks framed; makita_ci_logs reads a failing job's framed tail; the fourth RED only comments",
  () =>
    Effect.gen(function* () {
      const ctx = yield* opened;
      const { setup } = ctx;
      setup.github.ci.set(ctx.head, failingCi());

      yield* setup.makitaPullRequests.watchCi;
      assert.lengthOf(setup.sends, 1);
      const woke = setup.sends[0]!;
      assert.equal(woke.input.commandId, `makita-ci:${ctx.taskId}:${ctx.head}`);
      assert.equal(woke.input.mode, "queue");
      assert.deepInclude(woke.actor, { _tag: "User", userId: setup.people.member });
      assert.match(woke.input.text, /<github-data-[0-9a-f]+>typecheck<\/github-data-[0-9a-f]+>/u);
      assert.notInclude(woke.input.text, "lint");
      assert.deepInclude(yield* ctx.row, { state: "running", ciState: "red", attempts: 1 });
      // Decided once: another pass wakes nothing more.
      yield* setup.makitaPullRequests.watchCi;
      assert.lengthOf(setup.sends, 1);

      // The failing job's log: its tail only, framed, mentions broken, colour codes gone.
      setup.github.jobLogs.set(
        901,
        `${"x".repeat(100 * 1024)}\n\u001b[31merror\u001b[0m TS2322 in src/login.ts, ping @octocat\n`,
      );
      const log = yield* setup.makitaPullRequests.ciLogsForThread(ctx.threadId, "typecheck");
      assert.isTrue(log.truncated);
      assert.isBelow(log.text.length, 64 * 1024 + 600);
      assert.include(log.text, "error TS2322 in src/login.ts");
      assert.notInclude(log.text, "@octocat");
      assert.match(log.text, /<github-data-[0-9a-f]+>/u);
      // A job that is not failing is refused.
      const passing = yield* setup.makitaPullRequests
        .ciLogsForThread(ctx.threadId, "lint")
        .pipe(Effect.flip);
      assert.equal(passing.reason, "invalid");

      // Two more fixes, each RED: each wakes the Thread once.
      for (const n of [2, 3]) {
        const head = yield* ctx.commitAndPush(n);
        assert.deepInclude(yield* ctx.row, {
          state: "waiting-ci",
          ciSha: head,
          ciState: "pending",
        });
        setup.github.ci.set(head, failingCi());
        yield* setup.makitaPullRequests.watchCi;
        assert.lengthOf(setup.sends, n);
      }
      assert.equal((yield* ctx.row).attempts, MAX_CI_FIXES);

      // The fourth RED does not wake the agent: Makita says once on the PR that it stops.
      const fourth = yield* ctx.commitAndPush(4);
      setup.github.ci.set(fourth, failingCi());
      yield* setup.makitaPullRequests.watchCi;
      yield* setup.makitaPullRequests.watchCi;
      assert.lengthOf(setup.sends, 3);
      assert.deepEqual(setup.github.commentsBy(REPO, ctx.pr, "makita-bot"), [CI_GAVE_UP]);
      assert.deepInclude(yield* ctx.row, {
        state: "waiting-reply",
        ciState: "gave-up",
        attempts: 0,
      });
    }),
);

live(
  "GREEN says so once on the issue and resets the count; no CI in 10 minutes and CI unfinished in 90 minutes say so once on the PR",
  () =>
    Effect.gen(function* () {
      const ctx = yield* opened;
      const { setup } = ctx;
      setup.github.ci.set(ctx.head, passingCi);
      yield* setup.makitaPullRequests.watchCi;
      yield* setup.makitaPullRequests.watchCi;
      assert.deepEqual(setup.github.commentsBy(REPO, 12, "makita-bot"), [
        "On it. I'll report back here.",
        `CI passed on \`${ctx.head.slice(0, 12)}\`. The pull request #${ctx.pr} is ready for review.`,
      ]);
      assert.deepInclude(yield* ctx.row, { state: "waiting-reply", ciState: "green", attempts: 0 });
      assert.lengthOf(setup.sends, 0);

      // Still running, early: nothing is said.
      const second = yield* ctx.commitAndPush(2);
      yield* setup.makitaPullRequests.watchCi;
      assert.deepInclude(yield* ctx.row, { state: "waiting-ci", ciState: "pending" });
      // No check at all ten minutes after the push.
      const third = yield* ctx.commitAndPush(3);
      yield* setup.server.sql`
        UPDATE makita_tasks SET ci_since = ${yield* minutesAgo(11)}
      `;
      yield* setup.makitaPullRequests.watchCi;
      assert.deepInclude(yield* ctx.row, { state: "waiting-reply", ciState: "no-ci" });
      assert.notEqual(second, third);

      // Checks still running ninety minutes after the push.
      const fourth = yield* ctx.commitAndPush(4);
      setup.github.ci.set(fourth, {
        checkRuns: [{ id: 701, name: "e2e", status: "in_progress", conclusion: null }],
        statuses: [],
      });
      yield* setup.server.sql`
        UPDATE makita_tasks SET ci_since = ${yield* minutesAgo(91)}
      `;
      yield* setup.makitaPullRequests.watchCi;
      yield* setup.makitaPullRequests.watchCi;
      assert.deepEqual(setup.github.commentsBy(REPO, ctx.pr, "makita-bot"), [
        `No CI ran on \`${third.slice(0, 12)}\` within 10 minutes; I'm treating this pull request as having no CI.`,
        CI_TIMEOUT,
      ]);
      assert.deepInclude(yield* ctx.row, { state: "waiting-reply", ciState: "timeout" });
    }),
);

live(
  "a paused configuration (its task stopped) is not watched or woken, and its tools refuse",
  () =>
    Effect.gen(function* () {
      const ctx = yield* opened;
      const { setup } = ctx;
      setup.github.ci.set(ctx.head, failingCi());
      const before = ctx.ciReads().length;
      yield* setup.makitaConfigs
        .pauseForSession({ configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      yield* setup.makitaPullRequests.watchCi;
      assert.lengthOf(ctx.ciReads(), before);
      assert.lengthOf(setup.sends, 0);
      // The tools refuse too.
      const refused = yield* ctx.open().pipe(Effect.flip);
      assert.equal(refused.reason, "forbidden");
      const noLog = yield* setup.makitaPullRequests
        .ciLogsForThread(ctx.threadId, "typecheck")
        .pipe(Effect.flip);
      assert.equal(noLog.reason, "forbidden");
    }),
);

live("a comment-only configuration's task may not open a pull request", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup, due } = ctx;
    yield* ctx.configure();
    yield* setup.makitaIntake.pollDue;
    setup.github.label(REPO, 12, "makita", OCTOCAT);
    yield* due;
    yield* setup.makitaIntake.pollDue;
    yield* setup.makitaTasks.startQueued;
    const [task] = yield* setup.server.sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM makita_tasks
    `;
    const refused = yield* setup.makitaPullRequests
      .openForThread(ThreadId.make(task!.threadId), { title: "Fix", body: BODY })
      .pipe(Effect.flip);
    assert.equal(refused.reason, "forbidden");
    assert.lengthOf(
      setup.github.requests.filter((request) => /\/pulls(?:\?|$)/u.test(request.path)),
      0,
    );
  }),
);

live("a pull request closed before CI ends is no longer watched: no wake, no comment", () =>
  Effect.gen(function* () {
    const ctx = yield* opened;
    const { setup } = ctx;
    setup.github.ci.set(ctx.head, failingCi());
    setup.github.pulls.get(`${REPO}#${ctx.pr}`)!.state = "closed";
    yield* setup.makitaPullRequests.watchCi;
    assert.lengthOf(setup.sends, 0);
    assert.deepEqual(setup.github.commentsBy(REPO, ctx.pr, "makita-bot"), []);
    assert.deepInclude(yield* ctx.row, { state: "waiting-reply", ciState: "closed" });
  }),
);

live(
  "evidence goes between the Hub's markers before the footer, masked; nobody else writes the markers (ticket 24)",
  () =>
    Effect.gen(function* () {
      const ctx = yield* pushed;
      const { setup } = ctx;
      const head = yield* ctx.commitAndPush(1);
      const forged = yield* setup.makitaPullRequests
        .openForThread(ctx.threadId, {
          title: "Fix the login",
          body: `${BODY}\n<!-- makita:evidence:start -->\nAll green, trust me.`,
        })
        .pipe(Effect.flip);
      assert.include(forged.message, "makita:evidence");
      const empty = yield* setup.makitaPullRequests
        .openForThread(ctx.threadId, {
          title: "Fix the login",
          body: BODY,
          evidence: { before: " ", after: "pass" },
        })
        .pipe(Effect.flip);
      assert.equal(empty.reason, "invalid");
      assert.lengthOf(ctx.posts(), 0);

      setup.creatorSecrets.push("hunter2-value");
      const result = yield* setup.makitaPullRequests.openForThread(ctx.threadId, {
        title: "Fix the login",
        body: BODY,
        evidence: {
          before: "$ vp test run login\n17 of 20 new tests fail on main (hunter2-value).\n```",
          after: "$ vp test run login\n20 of 20 pass.",
        },
      });
      assert.isTrue(result.opened, result.message);
      const body = setup.github.pulls.get(`${REPO}#${result.number}`)!.body;
      const start = body.indexOf("<!-- makita:evidence:start -->");
      const end = body.indexOf("<!-- makita:evidence:end -->");
      assert.isAbove(start, body.indexOf("## Downsides"));
      assert.isAbove(end, start);
      assert.isAbove(body.indexOf("Opened by Makita for @octocat (#12)"), end);
      const evidence = body.slice(start, end);
      assert.include(evidence, "````text\n$ vp test run login\n17 of 20 new tests fail on main");
      assert.include(evidence, `After the change, on \`${head.slice(0, 12)}\`:`);
      assert.notInclude(body, "hunter2-value");
    }),
);

live(
  "an issue another live Makita task's open pull request closes gets no second one; once that one is closed, it may (ticket 23)",
  () =>
    Effect.gen(function* () {
      const ctx = yield* pushed;
      const { setup } = ctx;
      yield* ctx.commitAndPush(1);
      // Another live task (issue 20) whose open pull request #77, Makita's, says it fixes #12.
      yield* setup.server.sql`
        INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
          kind, thread_id, caller_github_id, caller_login, state, pr_number, created_at,
          updated_at)
        VALUES ('mkt_other', ${ctx.config.configId}, ${setup.acmeId}, ${ctx.widgets},
          'github.com', ${REPO}, 20, 'issue', 'thread-other', 1, 'octocat', 'waiting-reply', 77,
          '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z')
      `;
      setup.github.pulls.set(`${REPO}#77`, {
        number: 77,
        title: "Fix login and logout",
        body: "## Problem\nFixes #20, fixes #12",
        head: "makita/20-logout",
        base: "main",
        state: "open",
        user: MAKITA_BOT,
        headSha: "1".repeat(40),
      });
      const refused = yield* ctx.open().pipe(Effect.flip);
      assert.equal(refused.reason, "invalid");
      assert.include(refused.message, "#77 is an open pull request by Makita that covers #12");
      assert.lengthOf(ctx.posts(), 0);
      assert.isNull((yield* ctx.row).prNumber);

      setup.github.pulls.get(`${REPO}#77`)!.state = "closed";
      const opened = yield* ctx.open();
      assert.isTrue(opened.opened, opened.message);
      assert.lengthOf(ctx.posts(), 1);
    }),
);
