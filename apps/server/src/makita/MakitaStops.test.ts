// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 06: stopping is stopping. Pausing a configuration, the Owner's «Stop all», a
 * closed issue or a person's Stop end the task, interrupt its turn as the system, and the gateway
 * refuses its Thread's next request at once; nothing is written on GitHub about it, and resuming
 * replays nothing.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { MAKITA_STOPPED } from "../ai/AiGatewayKeys.ts";
import { call, messages, platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { makitaReady, OCTOCAT } from "./MakitaFixtures.testkit.ts";
import { stopCommandIdOf } from "./MakitaStops.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const MESSAGES = "/api/ai/anthropic/v1/messages";

/**
 * Makita ready, Grace's configuration, octocat's label on issue 12 made a task; its Thread stands
 * in the Hub (the launcher is a recorder) with a gateway key, as a provider session gets one.
 */
const running = Effect.gen(function* () {
  const ctx = yield* makitaReady;
  const { setup, due } = ctx;
  const config = yield* ctx.configure();
  yield* setup.makitaIntake.pollDue;
  setup.github.label(REPO, 12, "makita", OCTOCAT, { title: "Login fails", body: "It fails." });
  yield* due;
  yield* setup.makitaIntake.pollDue;
  yield* setup.makitaTasks.startQueued;
  const [task] = yield* setup.server.sql<{ readonly taskId: string; readonly threadId: string }>`
    SELECT task_id AS "taskId", thread_id AS "threadId" FROM makita_tasks
  `;
  assert.isDefined(task);
  const threadId = ThreadId.make(task!.threadId);
  const at = "2026-11-24T00:00:00.000Z";
  yield* setup.server.sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json, owner_user_id
    ) VALUES (
      ${threadId}, ${ctx.widgets}, 'Makita: acme/widgets#12 Login fails', 'claudeAgent',
      'full-access', 'default', ${at}, ${at},
      ${JSON.stringify({ lineage: { rootThreadId: threadId }, modelSelection: config.modelSelection })},
      ${setup.people.member}
    )
  `;
  const key = Redacted.value((yield* setup.keys.issueForThread(threadId)).key);
  const ask = (withKey = key) => call(setup, MESSAGES, { key: withKey, body: messages() });
  /** GitHub writes so far (comments, labels): a stop must add none. */
  const writes = () => setup.github.requests.filter((request) => request.method !== "GET").length;
  const stateOf = setup.server.sql<{ readonly state: string; readonly failure: string | null }>`
    SELECT state, failure FROM makita_tasks WHERE task_id = ${task!.taskId}
  `.pipe(Effect.map((rows) => rows[0]));
  const stopAudits = setup.server.sql<{
    readonly source: string;
    readonly actor: string | null;
    readonly detail: string;
  }>`
    SELECT actor_source AS source, actor_user_id AS actor, detail_json AS detail
    FROM audit_log WHERE action = 'makita.task.stop' ORDER BY audit_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ source: row.source, actor: row.actor, ...JSON.parse(row.detail) })),
    ),
  );
  return {
    ...ctx,
    config,
    taskId: task!.taskId,
    threadId,
    key,
    ask,
    writes,
    stateOf,
    stopAudits,
  };
});

live(
  "pausing a configuration stops its task, interrupts the turn as the system once, and the gateway refuses its next request; GitHub hears nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* running;
      const { setup } = ctx;
      // Running: the gateway serves it, and nothing is interrupted.
      assert.equal((yield* ctx.ask()).status, 200);
      yield* setup.makitaStops.interruptStopped;
      assert.lengthOf(setup.commands, 0);
      const before = ctx.writes();

      // An Admin of Acme (Ada) pauses Grace's configuration.
      yield* setup.makitaConfigs
        .pauseForSession({ configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.deepEqual(yield* ctx.stateOf, { state: "stopped", failure: "config-paused" });
      assert.deepEqual(yield* ctx.stopAudits, [
        {
          source: "user",
          actor: setup.people.admin,
          space: setup.acmeId,
          repo: REPO,
          number: 12,
          makita: ctx.config.configId,
          reason: "config-paused",
        },
      ]);

      // The next request is refused before any interrupt lands.
      const refused = yield* ctx.ask();
      assert.equal(refused.status, 403);
      assert.include(refused.text, MAKITA_STOPPED);

      // The sweep interrupts the Thread's turn, as the system, with a reason; once.
      yield* setup.makitaStops.interruptStopped;
      assert.lengthOf(setup.commands, 1);
      const { command, actor } = setup.commands[0]!;
      assert.deepEqual(actor, { _tag: "Server" });
      assert.deepInclude(command, {
        type: "thread.stop",
        commandId: stopCommandIdOf(ctx.taskId),
        threadId: ctx.threadId,
        reason: "Makita stopped this work: its configuration was paused.",
      });
      yield* setup.makitaStops.interruptStopped;
      assert.lengthOf(setup.commands, 1);

      // makita_comment writes nothing now, and the stop wrote nothing on GitHub.
      const comment = yield* setup.makitaTasks
        .commentForThread(ctx.threadId, "after the pause")
        .pipe(Effect.flip);
      assert.equal(comment.reason, "forbidden");
      assert.equal(ctx.writes(), before);

      // Grace resumes it: the task stays stopped and its Thread stays refused.
      yield* setup.makitaConfigs
        .resumeForSession({ configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.equal((yield* ctx.stateOf)!.state, "stopped");
      assert.equal((yield* ctx.ask()).status, 403);
    }),
);

live(
  "the Owner's pause is resumed only by the Owner, and a Thread that is not Makita's keeps working",
  () =>
    Effect.gen(function* () {
      const ctx = yield* running;
      const { setup } = ctx;
      const other = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.makitaConfigs
        .pauseForSession({ configId: ctx.config.configId })
        .pipe(setup.asOwner);
      const refused = yield* setup.makitaConfigs
        .resumeForSession({ configId: ctx.config.configId })
        .pipe(CommandActor.actAs(setup.people.member), Effect.flip);
      assert.equal(refused.reason, "forbidden");
      assert.equal((yield* ctx.ask()).status, 403);
      assert.equal((yield* ctx.ask(other.key)).status, 200);
    }),
);

live(
  "«Stop all Makita work» stops every task and refuses its Thread at once; resuming replays nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* running;
      const { setup } = ctx;
      const before = ctx.writes();
      yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner);
      assert.deepEqual(yield* ctx.stateOf, { state: "stopped", failure: "makita-paused" });
      const refused = yield* ctx.ask();
      assert.equal(refused.status, 403);
      assert.include(refused.text, MAKITA_STOPPED);
      yield* setup.makitaStops.interruptStopped;
      assert.deepInclude(setup.commands[0]!.command, {
        type: "thread.stop",
        threadId: ctx.threadId,
        reason: "Makita stopped this work: all Makita work was stopped.",
      });

      // A label while stopped is not read; after resuming it is not replayed.
      setup.github.label(REPO, 13, "makita", OCTOCAT);
      yield* setup.makitaIntake.pollDue;
      yield* setup.makitaAccount.resumeAllForSession.pipe(setup.asOwner);
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      yield* setup.makitaTasks.startQueued;
      const tasks = yield* setup.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM makita_tasks
      `;
      assert.equal(tasks[0]!.n, 1);
      assert.lengthOf(setup.launches, 1);
      assert.equal(ctx.writes(), before);
      // Still refused: a stopped task is asked for again, never resumed.
      assert.equal((yield* ctx.ask()).status, 403);
    }),
);

live(
  "a person stops one task: its configuration's pausers may, others see nothing, an agent is refused; a closed issue interrupts too",
  () =>
    Effect.gen(function* () {
      const ctx = yield* running;
      const { setup } = ctx;
      // Linus is a Guest of Acme: he cannot see Grace's configuration, so no such task.
      const hidden = yield* setup.makitaConfigs
        .stopTaskForSession({ taskId: ctx.taskId })
        .pipe(CommandActor.actAs(setup.people.guest), Effect.flip);
      assert.deepEqual([hidden.reason, hidden.message], ["not-found", "No such Makita task."]);
      const missing = yield* setup.makitaConfigs
        .stopTaskForSession({ taskId: "mkt_000000000000000000000000" })
        .pipe(CommandActor.actAs(setup.people.member), Effect.flip);
      assert.deepEqual([missing.reason, missing.message], ["not-found", "No such Makita task."]);
      // Grace's agent (an MCP call as her) may not.
      const agent = yield* setup.makitaConfigs.stopTaskForSession({ taskId: ctx.taskId }).pipe(
        CommandActor.actAsResolved({
          _tag: "User",
          userId: setup.people.member,
          via: "agent",
        }),
        Effect.flip,
      );
      assert.equal(agent.reason, "forbidden");
      assert.equal((yield* ctx.stateOf)!.state, "running");

      // Grace, its creator, stops it.
      const stopped = yield* setup.makitaConfigs
        .stopTaskForSession({ taskId: ctx.taskId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.deepEqual(stopped, { stopped: true });
      assert.deepEqual(yield* ctx.stateOf, { state: "stopped", failure: "manual" });
      assert.equal((yield* ctx.ask()).status, 403);
      const again = yield* setup.makitaConfigs
        .stopTaskForSession({ taskId: ctx.taskId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.deepEqual(again, { stopped: false });
      yield* setup.makitaStops.interruptStopped;
      assert.equal(
        setup.commands[0]!.command.type === "thread.stop" && setup.commands[0]!.command.reason,
        "Makita stopped this work: the task was stopped.",
      );

      // A new task on issue 14, then the issue closed: stopped, and its turn interrupted.
      setup.github.label(REPO, 14, "makita", OCTOCAT);
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      yield* setup.makitaTasks.startQueued;
      setup.github.addEvent(REPO, {
        event: "closed",
        actor: { login: OCTOCAT.login, id: OCTOCAT.id, type: "User" },
        issue: { number: 14, title: "Another" },
      });
      yield* ctx.due;
      yield* setup.makitaIntake.pollDue;
      const [closed] = yield* setup.server.sql<{
        readonly threadId: string;
        readonly state: string;
        readonly failure: string | null;
      }>`
        SELECT thread_id AS "threadId", state, failure FROM makita_tasks WHERE number = 14
      `;
      assert.deepInclude(closed, { state: "stopped", failure: "issue-closed" });
      yield* setup.makitaStops.interruptStopped;
      assert.lengthOf(setup.commands, 2);
      assert.deepInclude(setup.commands[1]!.command, {
        type: "thread.stop",
        threadId: ThreadId.make(closed!.threadId),
        reason: "Makita stopped this work: the issue was closed.",
      });
      assert.deepEqual(
        (yield* ctx.stopAudits).map((row) => [row.source, row.reason]),
        [
          ["user", "manual"],
          ["system", "issue-closed"],
        ],
      );
    }),
);

live("taking back the creator's permission stops their running task with that reason", () =>
  Effect.gen(function* () {
    const ctx = yield* running;
    const { setup } = ctx;
    yield* setup.makitaPermissions
      .revokeForSession({ userId: setup.people.member, spaceId: setup.acmeId })
      .pipe(setup.asOwner);
    assert.deepEqual(yield* ctx.stateOf, { state: "stopped", failure: "permission-revoked" });
    assert.equal((yield* ctx.ask()).status, 403);
    yield* setup.makitaStops.interruptStopped;
    assert.deepInclude(setup.commands[0]!.command, {
      type: "thread.stop",
      reason:
        "Makita stopped this work: its configuration's creator may no longer use Makita here.",
    });
  }),
);
