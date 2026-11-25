// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 26: the agent asks, the Hub decides. A task's own open issue is closed with a
 * verdict only with the capability on, nothing paused, at or above the threshold, once per issue
 * ever, within the daily limit, and never a stranger's issue that nobody allowed handed over.
 * Reopening, on GitHub or with `/makita reopen`, wins forever.
 */
import { assert, it } from "@effect/vitest";
import { MAKITA_AUTONOMY_OFF, type MakitaConfigInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { type MakitaReady, makitaReady, OCTOCAT, STRANGER } from "./MakitaFixtures.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const CLOSING: Partial<MakitaConfigInput> = {
  autonomy: { ...MAKITA_AUTONOMY_OFF, closeIssues: true },
};

const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
    yield* ctx.setup.makitaIssueCloses.reopenQueued;
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

/** octocat labels issue `number` (opened by `author`): its task, and its Thread. */
const taskFor = (ctx: MakitaReady, number: number, author = OCTOCAT) =>
  Effect.gen(function* () {
    ctx.setup.github.openIssue(REPO, number, author);
    ctx.setup.github.label(REPO, number, "makita", OCTOCAT);
    yield* tick(ctx);
    const [task] = yield* ctx.setup.server.sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM makita_tasks
      WHERE number = ${number} AND state NOT IN ('done', 'stopped', 'failed')
    `;
    return ThreadId.make(task!.threadId);
  });

const stateOf = (ctx: MakitaReady, number: number) =>
  Effect.map(
    ctx.setup.server.sql<{ readonly state: string }>`
      SELECT state FROM makita_tasks WHERE number = ${number} ORDER BY created_at DESC LIMIT 1
    `,
    (rows) => rows[0]?.state,
  );

const NOT_WANTED = {
  verdict: "not-wanted",
  confidence: 0.9,
  reason: "Logging in with an expired session is meant to fail.",
} as const;

live(
  "a valid verdict is posted and the issue closed as not planned; the task ends; every refusal writes nothing on GitHub",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure();
      yield* setup.makitaIntake.pollDue;
      const thread = yield* taskFor(ctx, 12);
      const close = (input: Parameters<typeof setup.makitaIssueCloses.closeForThread>[1]) =>
        setup.makitaIssueCloses.closeForThread(thread, input);
      const update = (over: Partial<MakitaConfigInput>) =>
        setup.makitaConfigs
          .updateForSession({ ...ctx.input(over), configId: config.configId })
          .pipe(CommandActor.actAs(setup.people.member));

      // Off by default: refused, nothing on GitHub.
      assert.include((yield* close(NOT_WANTED)).message, "Closing issues is off");
      yield* update(CLOSING);
      for (const [input, said] of [
        [{ ...NOT_WANTED, confidence: 0.5 }, "below this configuration's 0.80"],
        [{ ...NOT_WANTED, verdict: "duplicate" }, "names the issue or pull request"],
        [{ ...NOT_WANTED, verdict: "duplicate", ref: 99 }, "There is no #99"],
        [{ ...NOT_WANTED, verdict: "already-fixed", ref: 12 }, "ref is this issue itself"],
        [{ ...NOT_WANTED, ref: 3 }, "takes no ref"],
        [{ ...NOT_WANTED, reason: "" }, "one short reason"],
      ] as const) {
        const answer = yield* close(input);
        assert.isFalse(answer.closed, said);
        assert.include(answer.message, said);
      }
      assert.deepEqual(setup.github.commentsBy(REPO, 12, "makita-bot"), [
        "On it. I'll report back here.",
      ]);
      assert.equal(setup.github.issues.get(`${REPO}#12`)!.state, "open");

      // A duplicate of an issue that exists: posted, then closed as not planned.
      setup.github.openIssue(REPO, 7, OCTOCAT);
      const done = yield* close({
        verdict: "duplicate",
        ref: 7,
        confidence: 0.86,
        reason: "Same\n  failure as #7.",
      });
      assert.isTrue(done.closed);
      const issue = setup.github.issues.get(`${REPO}#12`)!;
      assert.deepInclude(issue, { state: "closed", stateReason: "not_planned" });
      const said = setup.github.commentsBy(REPO, 12, "makita-bot").at(-1)!;
      assert.include(
        said,
        "Triage verdict: duplicate of #7 (confidence 0.86). Same failure as #7.",
      );
      assert.include(said, "Closing as not planned.");
      assert.include(said, "`/makita reopen`");
      assert.equal(yield* stateOf(ctx, 12), "done");
      const audited = yield* auditOf(ctx, "makita.github.close_issue");
      assert.deepEqual(audited, [
        {
          source: "agent",
          detail: {
            space: setup.acmeId,
            repo: REPO,
            number: 12,
            makita: config.configId,
            verdict: "duplicate",
            ref: 7,
            confidence: 0.86,
            stateReason: "not_planned",
          },
        },
      ]);
      // The task has ended: a second close is refused.
      assert.include((yield* close(NOT_WANTED)).message, "has ended");
      // GitHub's `closed` event finds no live task to stop.
      yield* tick(ctx);
      assert.equal(yield* stateOf(ctx, 12), "done");
    }),
);

live(
  "a stranger's issue is closed only when someone allowed handed it over, never on their word alone; the daily limit and a pause refuse",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure({
        autonomy: { ...MAKITA_AUTONOMY_OFF, closeIssues: true, closePerDay: 1 },
      });
      yield* setup.makitaIntake.pollDue;
      // mallory opened it, octocat (allowed) asked Makita to look: a close is possible.
      const strangers = yield* taskFor(ctx, 20, STRANGER);
      const mine = yield* taskFor(ctx, 21);
      const update = (over: Partial<MakitaConfigInput>) =>
        setup.makitaConfigs
          .updateForSession({ ...ctx.input(over), configId: config.configId })
          .pipe(CommandActor.actAs(setup.people.member));
      // Nobody the configuration answers now asked: octocat is no longer on the list.
      yield* update({
        callers: ["Grace-GH"],
        autonomy: { ...MAKITA_AUTONOMY_OFF, closeIssues: true, closePerDay: 1 },
      });
      const refused = yield* setup.makitaIssueCloses.closeForThread(strangers, NOT_WANTED);
      assert.include(refused.message, "nobody it answers handed it to you");
      assert.equal(setup.github.issues.get(`${REPO}#20`)!.state, "open");
      yield* update({ autonomy: { ...MAKITA_AUTONOMY_OFF, closeIssues: true, closePerDay: 1 } });
      assert.isTrue((yield* setup.makitaIssueCloses.closeForThread(strangers, NOT_WANTED)).closed);

      // One a day for this configuration.
      const limit = yield* setup.makitaIssueCloses.closeForThread(mine, NOT_WANTED);
      assert.include(limit.message, "closed 1 issues in the last 24 hours");
      // Paused: refused before anything else.
      yield* setup.makitaConfigs
        .pauseForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.include(
        (yield* setup.makitaIssueCloses.closeForThread(mine, NOT_WANTED)).message,
        "paused",
      );
      assert.equal(setup.github.issues.get(`${REPO}#21`)!.state, "open");
    }),
);

live(
  "reopening wins forever: a stranger's /makita reopen does nothing, an allowed one reopens and reacts, and Makita never closes that issue again",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      yield* ctx.configure(CLOSING);
      yield* setup.makitaIntake.pollDue;
      const first = yield* taskFor(ctx, 12);
      setup.github.openIssue(REPO, 13, OCTOCAT, { pull: true });
      const fixed = yield* setup.makitaIssueCloses.closeForThread(first, {
        verdict: "already-fixed",
        ref: 13,
        confidence: 0.95,
        reason: "Fixed by the session refresh.",
      });
      assert.isTrue(fixed.closed);
      assert.equal(setup.github.issues.get(`${REPO}#12`)!.stateReason, "completed");
      assert.include(
        setup.github.commentsBy(REPO, 12, "makita-bot").at(-1)!,
        "Triage verdict: already fixed in #13 (confidence 0.95). Fixed by the session refresh.\n\nClosing as completed.",
      );

      const strangerSays = setup.github.commentOn(REPO, 12, STRANGER, "/makita reopen");
      yield* tick(ctx);
      assert.equal(setup.github.issues.get(`${REPO}#12`)!.state, "closed");
      const octocatSays = setup.github.commentOn(REPO, 12, OCTOCAT, "/Makita Reopen");
      yield* tick(ctx);
      assert.equal(setup.github.issues.get(`${REPO}#12`)!.state, "open");
      assert.deepEqual(
        (yield* ctx.events)
          .filter((row) => row.key.startsWith("gh:issue-comment:"))
          .map((row) => [row.key, row.outcome, row.detail]),
        [
          [`gh:issue-comment:${strangerSays.id}`, "ignored-not-allowed", "reopen"],
          [`gh:issue-comment:${octocatSays.id}`, "command", "reopen:done"],
        ],
      );
      assert.deepEqual(
        setup.github.reactions.map((reaction) => [reaction.commentId, reaction.content]),
        [[octocatSays.id, "+1"]],
      );
      const [row] = yield* setup.server.sql<{ readonly via: string; readonly login: string }>`
        SELECT reopened_via AS via, reopened_by_login AS login FROM makita_issue_closes
      `;
      assert.deepEqual(row, { via: "command", login: "octocat" });
      assert.deepInclude((yield* auditOf(ctx, "makita.github.reopen_issue"))[0]!.detail, {
        by: "octocat",
        number: 12,
      });

      // A new task on the same issue: Makita closes an issue once at most.
      setup.github.label(REPO, 12, "makita", OCTOCAT);
      yield* tick(ctx);
      const [again] = yield* setup.server.sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM makita_tasks WHERE number = 12 AND state = 'running'
      `;
      const refused = yield* setup.makitaIssueCloses.closeForThread(
        ThreadId.make(again!.threadId),
        NOT_WANTED,
      );
      assert.include(refused.message, "closed before");
      assert.equal(setup.github.issues.get(`${REPO}#12`)!.state, "open");
    }),
);

live("an allowed person reopening on GitHub is recorded; a stranger's reopening is not", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup } = ctx;
    yield* ctx.configure(CLOSING);
    yield* setup.makitaIntake.pollDue;
    for (const number of [12, 14]) {
      const thread = yield* taskFor(ctx, number);
      assert.isTrue((yield* setup.makitaIssueCloses.closeForThread(thread, NOT_WANTED)).closed);
    }
    yield* tick(ctx);
    setup.github.setIssueState(REPO, 12, "open", OCTOCAT);
    setup.github.setIssueState(REPO, 14, "open", STRANGER);
    yield* tick(ctx);
    const rows = yield* setup.server.sql<{
      readonly number: number;
      readonly via: string | null;
      readonly login: string | null;
    }>`
      SELECT number, reopened_via AS via, reopened_by_login AS login FROM makita_issue_closes
      ORDER BY number
    `;
    assert.deepEqual(rows, [
      { number: 12, via: "github", login: "octocat" },
      { number: 14, via: null, login: null },
    ]);
    assert.deepEqual(
      (yield* ctx.events)
        .filter((row) => row.detail === "reopened")
        .map((row) => [row.number, row.outcome]),
      [[12, "command"]],
    );
  }),
);
