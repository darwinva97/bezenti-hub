// @effect-diagnostics globalJsonInEffect:off - the audit rows and pending pushes as stored.
/**
 * Makita ticket 11: a push for someone who is not an approver waits for `/makita ok`; only a new,
 * unedited comment by an approver's numeric id, newer than Makita's request, releases exactly the
 * waiting commit. The Owner may approve from the Hub; a stop cancels what waits.
 */
import { assert, it } from "@effect/vitest";
import { type MakitaConfigInput, ThreadId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as MakitaActivity from "./MakitaActivity.ts";
import { isApproverNow } from "./makitaApprovers.ts";
import {
  GRACE_GH,
  MAKITA_BOT,
  type MakitaReady,
  makitaReady,
  OCTOCAT,
  STRANGER,
} from "./MakitaFixtures.testkit.ts";
import { type FakeGitHubUser, gitHubTime } from "./MakitaGitHub.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const BRANCH = "makita/12-login-fails";
const PUSHING: Partial<MakitaConfigInput> = {
  capability: "push",
  approval: "others",
  triggers: { label: "makita", assigned: false, mention: true },
};

/** The time on GitHub moves on, in minutes after the fixture's start. */
const later = (ctx: MakitaReady, minutes: number) => {
  const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T10:00:00Z"));
  ctx.setup.github.clock.now = gitHubTime(start + minutes * 60_000);
};

/** One poll and one pass of the tasks, as the Scheduler runs them. */
const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
    yield* ctx.setup.makitaTasks.awaitStarting;
  });

/** `userId` links `user` the way a person does: a code, posted from that account. */
const link = (ctx: MakitaReady, userId: UserId, user: FakeGitHubUser) =>
  Effect.gen(function* () {
    const asked = yield* ctx.setup.githubIdentities
      .linkCodeForSession({ login: user.login })
      .pipe(CommandActor.actAs(userId));
    ctx.setup.github.commentOn(REPO, 40, user, asked.comment);
    yield* tick(ctx);
  });

/** Makita's activity, over the same Hub. */
const activityOf = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      MakitaActivity.layer.pipe(
        Layer.provide(
          Layer.succeedContext(Context.merge(ctx.setup.server.services, ctx.setup.context)),
        ),
      ),
    );
    return Context.get(services, MakitaActivity.MakitaActivity);
  });

const auditOf = (ctx: MakitaReady, action: string) =>
  ctx.setup.server.sql<{
    readonly source: string;
    readonly actor: string | null;
    readonly detail: string;
  }>`
    SELECT actor_source AS source, actor_user_id AS actor, detail_json AS detail
    FROM audit_log WHERE action = ${action} ORDER BY audit_id
  `;

/** Makita ready, Grace (the creator) linked as Grace-GH, a pushing task for `caller`'s label. */
const started = (over: Partial<MakitaConfigInput> = {}, caller: FakeGitHubUser = OCTOCAT) =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup } = ctx;
    const world = setup.gitWorld;
    world.seed(REPO, ["main"]);
    const config = yield* ctx.configure({ ...PUSHING, ...over });
    yield* setup.makitaIntake.pollDue;
    yield* link(ctx, setup.people.member, GRACE_GH);
    setup.github.label(REPO, 12, "makita", caller, { title: "Login fails!" });
    yield* tick(ctx);
    const [task] = yield* setup.server.sql<{ readonly taskId: string; readonly threadId: string }>`
      SELECT task_id AS "taskId", thread_id AS "threadId" FROM makita_tasks WHERE number = 12
    `;
    const threadId = ThreadId.make(task!.threadId);
    const cwd = world.made[0]?.cwd ?? "";
    const row = setup.server.sql<{
      readonly headSha: string | null;
      readonly pending: string | null;
      readonly approved: string | null;
      readonly state: string;
    }>`
      SELECT head_sha AS "headSha", pending_push_json AS pending,
        approved_through AS approved, state
      FROM makita_tasks WHERE task_id = ${task!.taskId}
    `.pipe(Effect.map((rows) => rows[0]!));
    return {
      ...ctx,
      config,
      task: task!,
      threadId,
      world,
      cwd,
      push: setup.makitaPushes.pushForThread(threadId),
      row,
      /** What Makita wrote on issue 12. */
      said: () => setup.github.commentsBy(REPO, 12, MAKITA_BOT.login),
    };
  });

live(
  "a push for a non-approver waits; an approver's /makita ok releases exactly that commit, answered with a 👍 and one line; a later instruction by a non-approver waits again",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, world, cwd } = ctx;
      const first = world.commit(cwd, { "src/login.ts": "export const fixed = true;\n" });
      const waiting = yield* ctx.push;
      assert.isFalse(waiting.pushed);
      assert.include(waiting.message, "/makita ok");
      assert.isNull(world.tipOf(REPO, BRANCH));
      // Makita asks once, without naming anyone who has not written on the issue.
      assert.deepEqual(ctx.said().slice(1), [
        `Ready to push \`${BRANCH}\` (+1 −0 in 1 file). An approver can reply \`/makita ok\` to send it.`,
      ]);
      // The same commit again: still waiting, no second request.
      assert.isFalse((yield* ctx.push).pushed);
      assert.lengthOf(ctx.said(), 2);

      // The agent keeps committing while it waits: the approval is for exactly what was asked.
      later(ctx, 5);
      const ok = setup.github.commentOn(REPO, 12, GRACE_GH, "/makita OK\nship it");
      yield* tick(ctx);
      assert.equal(world.tipOf(REPO, BRANCH), first);
      assert.deepEqual(setup.github.reactions.at(-1), {
        repo: REPO,
        feed: "issues",
        commentId: ok.id,
        content: "+1",
      });
      assert.equal(
        ctx.said().at(-1),
        `Pushed \`${BRANCH}\` (${first.slice(0, 12)}, 1 commit), approved by @Grace-GH.`,
      );
      const row = yield* ctx.row;
      assert.equal(row.headSha, first);
      assert.isNull(row.pending);
      assert.deepInclude(JSON.parse(row.approved ?? "{}"), {
        via: "github",
        login: "Grace-GH",
        commentId: ok.id,
      });
      const approve = (yield* auditOf(ctx, "makita.task.approve")).map((entry) =>
        JSON.parse(entry.detail),
      );
      assert.deepEqual(approve, [
        {
          space: setup.acmeId,
          repo: REPO,
          number: 12,
          makita: ctx.config.configId,
          via: "github",
          login: "Grace-GH",
          sha: first,
        },
      ]);
      const event = (yield* ctx.events).find((entry) => entry.key === `gh:issue-comment:${ok.id}`);
      assert.deepInclude(event, {
        outcome: "approval",
        detail: "approved",
        taskId: ctx.task.taskId,
      });
      // Its Thread hears it, once, as the creator.
      const told = setup.sends.find((send) => send.input.commandId.startsWith("makita-approved:"));
      assert.equal(told?.input.commandId, `makita-approved:${ctx.task.taskId}:${first}`);
      assert.deepInclude(told?.actor, { _tag: "User", userId: setup.people.member });
      assert.include(told?.input.text ?? "", first.slice(0, 12));

      // A replayed approval approves nothing more.
      yield* setup.server.sql`
        UPDATE makita_events SET outcome = 'queued', detail = 'ok'
        WHERE event_key = ${`gh:issue-comment:${ok.id}`}
      `;
      yield* tick(ctx);
      assert.lengthOf(yield* auditOf(ctx, "makita.task.approve"), 1);

      // With no new instruction (a CI fix), the next push inherits the approval.
      const second = world.commit(cwd, { "src/login.ts": "export const fixed = 2;\n" });
      assert.isTrue((yield* ctx.push).pushed);
      assert.equal(world.tipOf(REPO, BRANCH), second);

      // octocat (not an approver) asks for more: the push that follows waits again.
      later(ctx, 10);
      setup.github.commentOn(REPO, 12, OCTOCAT, "@makita-bot also fix the signup");
      yield* tick(ctx);
      world.commit(cwd, { "src/signup.ts": "export const fixed = true;\n" });
      const again = yield* ctx.push;
      assert.isFalse(again.pushed);
      assert.equal(world.tipOf(REPO, BRANCH), second);
      // Grace-GH has written on the issue now: the request names her.
      assert.equal(
        ctx.said().at(-1),
        `Ready to push \`${BRANCH}\` (+1 −0 in 1 file). @Grace-GH can reply \`/makita ok\` to send it.`,
      );
    }),
);

live(
  "an edited /makita ok, one by a non-approver, by Makita itself, written before the request or on another issue releases nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, world, cwd } = ctx;
      // Written before Makita asked: nothing waits yet, and it never counts later.
      later(ctx, 1);
      const early = setup.github.commentOn(REPO, 12, GRACE_GH, "/makita ok");
      yield* tick(ctx);
      world.commit(cwd, { "a.txt": "a\n" });
      assert.isFalse((yield* ctx.push).pushed);
      yield* tick(ctx);

      later(ctx, 5);
      // A non-approver on the list, a stranger, and an approver's comment edited into the command.
      const octocat = setup.github.commentOn(REPO, 12, OCTOCAT, "/makita ok");
      const stranger = setup.github.commentOn(REPO, 12, STRANGER, "/makita ok");
      const edited = setup.github.commentOn(REPO, 12, GRACE_GH, "looks good");
      setup.github.editComment(REPO, edited.id, "/makita ok");
      // Makita's own account, an approval on another issue, and the command not on the first line.
      const self = setup.github.commentOn(REPO, 12, MAKITA_BOT, "/makita ok");
      const elsewhere = setup.github.commentOn(REPO, 13, GRACE_GH, "/makita ok");
      const quoted = setup.github.commentOn(REPO, 12, GRACE_GH, "> /makita ok\nnot yet");
      yield* tick(ctx);

      assert.isNull(world.tipOf(REPO, BRANCH));
      assert.isNotNull((yield* ctx.row).pending);
      assert.lengthOf(yield* auditOf(ctx, "makita.task.approve"), 0);
      const refusedIds = new Set(
        [early, octocat, stranger, edited, self, elsewhere, quoted].map((made) => made.id),
      );
      assert.lengthOf(
        setup.github.reactions.filter((reaction) => refusedIds.has(reaction.commentId)),
        0,
      );
      const outcome = new Map(
        (yield* ctx.events).map((entry) => [entry.key, [entry.outcome, entry.detail]]),
      );
      const key = (id: number) => `gh:issue-comment:${id}`;
      assert.deepEqual(outcome.get(key(early.id)), ["command", "nothing-to-approve"]);
      assert.deepEqual(outcome.get(key(octocat.id)), ["ignored-not-approver", null]);
      assert.deepEqual(outcome.get(key(stranger.id)), ["ignored-not-approver", null]);
      assert.deepEqual(outcome.get(key(edited.id)), ["ignored-edited", null]);
      assert.deepEqual(outcome.get(key(self.id)), ["ignored-self", null]);
      assert.deepEqual(outcome.get(key(elsewhere.id)), ["command", "nothing-to-approve"]);
      assert.isUndefined(outcome.get(key(quoted.id)));

      // An approval edited after the intake saw it is refused when read again by id.
      later(ctx, 7);
      const late = setup.github.commentOn(REPO, 12, GRACE_GH, "/makita ok");
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      setup.github.editComment(REPO, late.id, "/makita ok");
      yield* setup.makitaTasks.startQueued;
      assert.isNull(world.tipOf(REPO, BRANCH));
      assert.deepEqual(
        (yield* ctx.events).find((entry) => entry.key === key(late.id))?.outcome,
        "ignored-edited",
      );
    }),
);

live(
  "approvers are the creator and listed accounts linked by active Members of the Space, read at the order; approval «always» asks the creator too",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started({ approvers: ["octocat"] });
      const { setup, world, cwd } = ctx;
      assert.deepEqual(
        ctx.config.approvers.map((user) => [user.id, user.login]),
        [[OCTOCAT.id, "octocat"]],
      );
      const configId = ctx.config.configId;
      // Listed, but linked by nobody in the Space: not an approver.
      assert.isFalse(yield* isApproverNow(setup.server.sql, configId, OCTOCAT.id));
      assert.isTrue(yield* isApproverNow(setup.server.sql, configId, GRACE_GH.id));
      world.commit(cwd, { "a.txt": "a\n" });
      assert.isFalse((yield* ctx.push).pushed);
      later(ctx, 5);
      setup.github.commentOn(REPO, 12, OCTOCAT, "/makita ok");
      yield* tick(ctx);
      assert.isNull(world.tipOf(REPO, BRANCH));

      // Ada (Admin) links octocat: now it approves, and its next /makita ok is honoured.
      yield* link(ctx, setup.people.admin, OCTOCAT);
      assert.isTrue(yield* isApproverNow(setup.server.sql, configId, OCTOCAT.id));
      later(ctx, 6);
      setup.github.commentOn(REPO, 12, OCTOCAT, "/makita ok");
      yield* tick(ctx);
      assert.isNotNull(world.tipOf(REPO, BRANCH));

      // Ada leaves Acme: octocat stops counting at once.
      const removed = yield* setup.server.request(`/api/spaces/${setup.acmeId}/members/remove`, {
        body: { userId: setup.people.admin },
        cookie: setup.ownerCookie,
      });
      assert.equal(removed.status, 200);
      assert.isFalse(yield* isApproverNow(setup.server.sql, configId, OCTOCAT.id));
      // A Guest who linked an account never approves.
      yield* link(ctx, setup.people.guest, STRANGER);
      yield* setup.makitaConfigs
        .updateForSession({ ...ctx.input({ ...PUSHING, approvers: ["mallory"] }), configId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.isFalse(yield* isApproverNow(setup.server.sql, configId, STRANGER.id));
    }),
);

live("with approval «others» a push the creator asked for goes out at once", () =>
  Effect.gen(function* () {
    const ctx = yield* started({}, GRACE_GH);
    ctx.world.commit(ctx.cwd, { "a.txt": "a\n" });
    assert.isTrue((yield* ctx.push).pushed);
    assert.lengthOf(ctx.said(), 1);
  }),
);

live("with approval «always» even the creator's own request waits for a /makita ok", () =>
  Effect.gen(function* () {
    const ctx = yield* started({ approval: "always" }, GRACE_GH);
    assert.equal(ctx.config.approval, "always");
    const head = ctx.world.commit(ctx.cwd, { "a.txt": "a\n" });
    assert.isFalse((yield* ctx.push).pushed);
    later(ctx, 5);
    ctx.setup.github.commentOn(REPO, 12, GRACE_GH, "/makita ok");
    yield* tick(ctx);
    assert.equal(ctx.world.tipOf(REPO, BRANCH), head);
  }),
);

live(
  "the Owner approves from the Hub and the next pass sends it; nobody else may, and a stop cancels what waits",
  () =>
    Effect.gen(function* () {
      const ctx = yield* started();
      const { setup, world, cwd } = ctx;
      const head = world.commit(cwd, { "a.txt": "a\n" });
      const taskId = ctx.task.taskId;
      // Nothing waits yet.
      const nothing = yield* setup.makitaConfigs
        .approveTaskForSession({ taskId })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(nothing.reason, "invalid");
      assert.isFalse((yield* ctx.push).pushed);

      // Grace (the creator), an Admin and an agent may not; a made-up task says nothing more.
      for (const who of [setup.people.member, setup.people.admin]) {
        const refused = yield* setup.makitaConfigs
          .approveTaskForSession({ taskId })
          .pipe(CommandActor.actAs(who), Effect.flip);
        assert.equal(refused.reason, "forbidden");
      }
      const agent = yield* setup.makitaConfigs
        .approveTaskForSession({ taskId })
        .pipe(
          CommandActor.actAsResolved({ _tag: "User", userId: setup.ownerId, via: "agent" }),
          Effect.flip,
        );
      assert.equal(agent.reason, "forbidden");
      const unknown = yield* setup.makitaConfigs
        .approveTaskForSession({ taskId: "mkt_000000000000000000000000" })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(unknown.reason, "not-found");
      const reader = yield* activityOf(ctx);
      const activity = yield* reader.activity({
        configId: ctx.config.configId,
        actorUserId: setup.ownerId,
      });
      assert.isTrue(activity.configs[0]!.canApprove);
      assert.deepInclude(activity.now[0]!.waitingPush, {
        branch: BRANCH,
        sha: head,
        approved: false,
      });

      const approved = yield* setup.makitaConfigs
        .approveTaskForSession({ taskId })
        .pipe(setup.asOwner);
      assert.isTrue(approved.approved);
      yield* setup.makitaTasks.startQueued;
      assert.equal(world.tipOf(REPO, BRANCH), head);
      assert.equal(
        ctx.said().at(-1),
        `Pushed \`${BRANCH}\` (${head.slice(0, 12)}, 1 commit), approved by a maintainer.`,
      );
      const [entry] = yield* auditOf(ctx, "makita.task.approve");
      assert.deepEqual([entry?.source, entry?.actor], ["user", setup.ownerId]);
      assert.deepInclude(JSON.parse(entry!.detail), { via: "hub", login: null, sha: head });
      const after = yield* reader.activity({
        configId: ctx.config.configId,
        actorUserId: setup.ownerId,
      });
      assert.deepInclude(after.tasks[0]!.lastApproval, { via: "hub", login: null });
      const grace = yield* reader.activity({
        configId: ctx.config.configId,
        actorUserId: setup.people.member,
      });
      assert.isFalse(grace.configs[0]!.canApprove);

      // A new instruction by octocat (after the Hub's approval), a waiting push, then a pause:
      // nothing waits any more.
      setup.github.clock.now = gitHubTime(DateTime.toEpochMillis(yield* DateTime.now) + 60_000);
      setup.github.commentOn(REPO, 12, OCTOCAT, "@makita-bot one more thing");
      yield* tick(ctx);
      world.commit(cwd, { "b.txt": "b\n" });
      assert.isFalse((yield* ctx.push).pushed);
      assert.isNotNull((yield* ctx.row).pending);
      yield* setup.makitaConfigs
        .pauseForSession({ configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      const stopped = yield* ctx.row;
      assert.deepEqual([stopped.state, stopped.pending], ["stopped", null]);
      setup.github.clock.now = gitHubTime(DateTime.toEpochMillis(yield* DateTime.now) + 120_000);
      setup.github.commentOn(REPO, 12, GRACE_GH, "/makita ok");
      yield* tick(ctx);
      assert.equal(world.tipOf(REPO, BRANCH), head);
    }),
);
