// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 22: a configuration has at most N tasks at work; more triggers wait in line, in
 * arrival order, and start as tasks end. Waking a live task never waits. The Owner's Hub-wide
 * ceiling wins. Pausing, `/makita stop` and a closed issue take what waits out of the line.
 */
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { makitaReady, OCTOCAT } from "./MakitaFixtures.testkit.ts";
import { APPROVAL_DETAIL } from "./makitaApprovers.ts";
import { CONVERSATION } from "./makitaConversation.ts";
import { MERGE_DETAIL } from "./makitaLandingRules.ts";
import { NEVER_STARTS, waitingOf } from "./makitaQueue.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";

/** Makita ready, Grace's configuration with these caps; labels on issues read and handled. */
const lined = (maxTasks: number) =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const config = yield* ctx.configure({
      maxTasks,
      triggers: { label: "makita", assigned: false, mention: true },
    });
    yield* ctx.setup.makitaIntake.pollDue;
    const pass = Effect.gen(function* () {
      yield* ctx.due;
      yield* ctx.setup.makitaIntake.pollDue;
      yield* ctx.setup.makitaTasks.startQueued;
    });
    const label = (...numbers: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        for (const number of numbers) {
          ctx.setup.github.label(REPO, number, "makita", OCTOCAT, { title: `Issue ${number}` });
        }
        yield* pass;
      });
    const started = () =>
      ctx.setup.launches.map((launch) => /#(\d+) /u.exec(launch.input.title ?? "")?.[1]);
    const line = () =>
      waitingOf(ctx.setup.server.sql, [config.configId]).pipe(
        Effect.map((rows) => rows.map((row) => [row.number, row.position])),
      );
    const finish = (number: number) =>
      ctx.setup.server.sql`UPDATE makita_tasks SET state = 'done' WHERE number = ${number}`;
    return { ...ctx, config, pass, label, started, line, finish };
  });

it("knows every queued detail that never starts a task", () => {
  assert.deepEqual(
    [...NEVER_STARTS].toSorted(),
    [APPROVAL_DETAIL, CONVERSATION, MERGE_DETAIL, "stop"].toSorted(),
  );
});

live(
  "beyond its cap a trigger waits in line, in arrival order, and starts as a task ends; a mention on a live task is never held",
  () =>
    Effect.gen(function* () {
      const ctx = yield* lined(1);
      yield* ctx.label(12, 13, 14);
      assert.deepEqual(ctx.started(), ["12"]);
      assert.deepEqual(yield* ctx.line(), [
        [13, 1],
        [14, 2],
      ]);
      const [waiting] = yield* ctx.setup.server.sql<{ readonly outcome: string }>`
        SELECT outcome FROM makita_events WHERE number = 13
      `;
      assert.equal(waiting?.outcome, "queued");

      // A mention on issue 12 wakes its task at once, with the configuration full.
      ctx.setup.github.commentOn(REPO, 12, OCTOCAT, "@makita-bot and the logout?");
      yield* ctx.pass;
      assert.lengthOf(ctx.setup.sends, 1);
      assert.deepEqual(ctx.started(), ["12"]);

      // Another pass changes nothing; issue 12's task ends and 13 starts, then 14.
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual(ctx.started(), ["12"]);
      yield* ctx.finish(12);
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual(ctx.started(), ["12", "13"]);
      assert.deepEqual(yield* ctx.line(), [[14, 1]]);
      // A task waiting for a person holds no slot.
      yield* ctx.setup.server
        .sql`UPDATE makita_tasks SET state = 'waiting-reply' WHERE number = 13`;
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual(ctx.started(), ["12", "13", "14"]);
      assert.deepEqual(yield* ctx.line(), []);
    }),
);

live(
  "a task whose turn ended without a comment gives its slot back once its grace passed; one whose turn goes on keeps it",
  () =>
    Effect.gen(function* () {
      const ctx = yield* lined(1);
      const { sql } = ctx.setup.server;
      yield* ctx.label(12, 13);
      assert.deepEqual(ctx.started(), ["12"]);
      const [task] = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM makita_tasks WHERE number = 12
      `;
      const stateOf12 = sql<{ readonly state: string }>`
        SELECT state FROM makita_tasks WHERE number = 12
      `.pipe(Effect.map((rows) => rows[0]?.state));
      const aged = sql`
        UPDATE makita_tasks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE number = 12
      `;
      // Its Thread's turn is going: the slot stays taken, however old the task.
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('makita-run-12', ${task!.threadId}, 1, 'claudeAgent', 'running',
          '2026-11-25T00:00:00.000Z', '{}')
      `;
      yield* aged;
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual([ctx.started(), yield* stateOf12], [["12"], "running"]);

      // The turn ended, but the task just changed: within the grace it keeps its slot.
      yield* sql`
        UPDATE orchestration_v2_projection_runs SET status = 'completed'
        WHERE run_id = 'makita-run-12'
      `;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE makita_tasks SET updated_at = ${now} WHERE number = 12`;
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual([ctx.started(), yield* stateOf12], [["12"], "running"]);

      // Past the grace with no turn going: it waits for a person and issue 13 starts.
      yield* aged;
      yield* ctx.setup.makitaTasks.startQueued;
      assert.deepEqual([ctx.started(), yield* stateOf12], [["12", "13"], "waiting-reply"]);
    }),
);

live(
  "the Owner's ceiling across the Hub wins over a configuration's cap; only the Owner sets it",
  () =>
    Effect.gen(function* () {
      const ctx = yield* lined(3);
      const { setup } = ctx;
      const refused = yield* setup.makitaAccount
        .setTaskLimitForSession({ maxTasks: 1 })
        .pipe(CommandActor.actAs(setup.people.member), Effect.flip);
      assert.equal(refused.reason, "forbidden");
      const zero = yield* setup.makitaAccount
        .setTaskLimitForSession({ maxTasks: 0 })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(zero.reason, "invalid");
      const set = yield* setup.makitaAccount
        .setTaskLimitForSession({ maxTasks: 1 })
        .pipe(setup.asOwner);
      assert.equal(set.account?.maxTasks, 1);
      const audits = yield* setup.server.sql<{ readonly detail: string }>`
      SELECT detail_json AS detail FROM audit_log WHERE action = 'makita.account.limit'
    `;
      assert.deepEqual(
        audits.map((row) => JSON.parse(row.detail)),
        [{ from: 10, to: 1 }],
      );

      yield* ctx.label(12, 13);
      assert.deepEqual(ctx.started(), ["12"]);
      assert.deepEqual(yield* ctx.line(), [[13, 1]]);
      yield* setup.makitaAccount.setTaskLimitForSession({ maxTasks: 2 }).pipe(setup.asOwner);
      yield* setup.makitaTasks.startQueued;
      assert.deepEqual(ctx.started(), ["12", "13"]);
    }),
);

live(
  "a closed issue, `/makita stop` and a pause take what waits out of the line; resuming replays nothing",
  () =>
    Effect.gen(function* () {
      const ctx = yield* lined(1);
      const { setup, config } = ctx;
      yield* ctx.label(12, 13, 14, 15);
      assert.deepEqual(yield* ctx.line(), [
        [13, 1],
        [14, 2],
        [15, 3],
      ]);

      setup.github.addEvent(REPO, {
        event: "closed",
        actor: { login: OCTOCAT.login, id: OCTOCAT.id, type: "User" },
        issue: { number: 13, title: "Issue 13" },
      });
      setup.github.commentOn(REPO, 14, OCTOCAT, "/makita stop");
      yield* ctx.pass;
      assert.deepEqual(yield* ctx.line(), [[15, 1]]);
      const dropped = yield* setup.server.sql<{
        readonly number: number;
        readonly outcome: string;
        readonly detail: string | null;
      }>`
        SELECT number, outcome, detail FROM makita_events
        WHERE number IN (13, 14) AND outcome <> 'command' ORDER BY number
      `;
      assert.deepEqual(
        dropped.map((row) => [row.number, row.outcome, row.detail]),
        [
          [13, "ignored-no-config", "issue-closed"],
          [14, "ignored-no-config", "github-stop"],
        ],
      );

      yield* setup.makitaConfigs
        .pauseForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      assert.deepEqual(yield* ctx.line(), []);
      const [paused] = yield* setup.server.sql<{ readonly outcome: string }>`
        SELECT outcome FROM makita_events WHERE number = 15
      `;
      assert.equal(paused?.outcome, "ignored-paused");
      yield* setup.makitaConfigs
        .resumeForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      yield* setup.makitaTasks.startQueued;
      assert.deepEqual(ctx.started(), ["12"]);
    }),
);

live(
  "a configuration's cap is 3 unless its creator says, from 1 to 20, and audited when changed",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const made = yield* ctx.configure();
      assert.equal(made.maxTasks, 3);
      const tooMany = yield* ctx.setup.makitaConfigs
        .updateForSession({ configId: made.configId, ...ctx.input({ maxTasks: 21 }) })
        .pipe(CommandActor.actAs(ctx.setup.people.member), Effect.flip);
      assert.equal(tooMany.reason, "invalid");
      const changed = yield* ctx.setup.makitaConfigs
        .updateForSession({ configId: made.configId, ...ctx.input({ maxTasks: 5 }) })
        .pipe(CommandActor.actAs(ctx.setup.people.member));
      assert.equal(changed.config.maxTasks, 5);
      // Left out of the input, it stays.
      const kept = yield* ctx.setup.makitaConfigs
        .updateForSession({ configId: made.configId, ...ctx.input({ name: "Renamed" }) })
        .pipe(CommandActor.actAs(ctx.setup.people.member));
      assert.equal(kept.config.maxTasks, 5);
      const updates = yield* ctx.setup.server.sql<{ readonly detail: string }>`
      SELECT detail_json AS detail FROM audit_log WHERE action = 'makita.config.update'
      ORDER BY audit_id
    `;
      assert.deepEqual(
        updates.map((row) => JSON.parse(row.detail).changed),
        ["max_tasks", "name"],
      );
    }),
);
