/**
 * Makita ticket 07: a Makita Thread's gateway requests count on its configuration and on its
 * creator; Usage names the configuration only to those who may see that usage; the activity shows
 * tasks, events and usage per repository and caller, its usage only to the creator, the Space's
 * usage readers and the Owner; another Space sees nothing.
 */
import { assert, it } from "@effect/vitest";
import { type ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { call, messages, platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { lendAiAccount } from "../grants/Grants.testkit.ts";
import * as MakitaActivity from "./MakitaActivity.ts";
import { makitaReady } from "./MakitaFixtures.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";

/**
 * Grace's configuration, a Makita task whose Thread asked the gateway once, and one request of
 * an ordinary Thread of hers; Hedy, a Member of Acme who may use Makita, made nothing.
 */
const used = Effect.gen(function* () {
  const ctx = yield* makitaReady;
  const { setup } = ctx;
  const config = yield* ctx.configure();
  const hedy = UserId.make("hedy");
  yield* addMember(setup.server, { id: hedy, displayName: "hedy" });
  yield* joinOrganization(setup.server, setup.acmeId, hedy, "member");
  yield* setup.directory.membershipsChanged([hedy]);
  yield* setup.makitaPermissions
    .grantForSession({ userId: hedy, spaceId: setup.acmeId })
    .pipe(setup.asOwner);

  const makitaThread = yield* setup.thread(setup.people.member, setup.acmeId, ctx.acmeClaude);
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* setup.server.sql`
    INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number, kind,
      thread_id, caller_github_id, caller_login, state, created_at, updated_at)
    VALUES ('mkt_000000000000000000000001', ${config.configId}, ${setup.acmeId},
      ${makitaThread.projectId}, 'github.com', ${REPO}, 12, 'issue', ${makitaThread.threadId}, 1,
      'octocat', 'running', ${at}, ${at})
  `;
  yield* setup.server.sql`
    INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id, actor_login,
      seen_at, config_id, outcome, detail)
    VALUES ('gh:issue-event:77', 'github.com', ${REPO}, 13, 'issue', 666, 'mallory', ${at},
      ${config.configId}, 'ignored-not-allowed', NULL),
      ('gh:issue-event:78', 'github.com', ${REPO}, 12, 'issue', 1, 'octocat', ${at},
      ${config.configId}, 'started', NULL)
  `;
  const ordinary = yield* setup.thread(setup.people.member, setup.acmeId, ctx.acmeClaude);
  for (const key of [makitaThread.key, ordinary.key]) {
    const answer = yield* call(setup, "/api/ai/anthropic/v1/messages", {
      key,
      body: messages(),
    });
    assert.equal(answer.status, 200);
  }
  yield* setup.settled(2);

  const services = yield* Layer.build(
    MakitaActivity.layer.pipe(
      Layer.provide(Layer.succeedContext(Context.merge(setup.server.services, setup.context))),
    ),
  );
  const activity = Context.get(services, MakitaActivity.MakitaActivity);
  return { ...ctx, config, hedy, makitaThread, ordinary, activity };
});

live(
  "a Makita Thread's requests carry its configuration in both usage tables; an ordinary Thread's none",
  () =>
    Effect.gen(function* () {
      const { setup, config, makitaThread, ordinary } = yield* used;
      const rows = yield* setup.server.sql<{
        readonly threadId: string;
        readonly configId: string | null;
      }>`
        SELECT thread_id AS "threadId", makita_config_id AS "configId" FROM ai_usage
        ORDER BY at
      `;
      assert.deepEqual(
        rows.map((row) => [row.threadId, row.configId]),
        [
          [makitaThread.threadId, config.configId],
          [ordinary.threadId, null],
        ],
      );
      const daily = yield* setup.server.sql<{
        readonly configId: string;
        readonly userId: string;
        readonly requests: number;
      }>`
        SELECT makita_config_id AS "configId", user_id AS "userId", requests FROM ai_usage_daily
        ORDER BY makita_config_id
      `;
      assert.deepEqual(
        daily.map((row) => [row.configId, row.userId, row.requests]),
        [
          ["", setup.people.member, 1],
          [config.configId, setup.people.member, 1],
        ],
      );
    }),
  60_000,
);

live(
  "Usage counts the tokens on Grace and names «Widget bugs» to her and the Admin; a Member who does not read Acme's usage and another Space see none of it",
  () =>
    Effect.gen(function* () {
      const { setup, config, hedy } = yield* used;
      const asGrace = CommandActor.actAs(setup.people.member);
      const hers = yield* setup.usage.summary({ userId: setup.people.member }).pipe(asGrace);
      // Both requests are hers: the Makita Thread's too.
      assert.equal(hers.totals.requests, 2);
      const makitaRows = hers.rows.filter((row) => row.makitaConfigId === config.configId);
      assert.lengthOf(makitaRows, 1);
      assert.isAbove(makitaRows[0]!.inputTokens + makitaRows[0]!.outputTokens, 0);
      assert.deepEqual(hers.labels.makitaConfigs, [{ id: config.configId, name: "Widget bugs" }]);

      const ada = yield* setup.usage.summary({}).pipe(CommandActor.actAs(setup.people.admin));
      assert.equal(ada.totals.requests, 2);
      assert.deepEqual(ada.labels.makitaConfigs, [{ id: config.configId, name: "Widget bugs" }]);

      for (const viewer of [hedy, setup.people.globexMember, setup.people.guest]) {
        const seen = yield* setup.usage.summary({}).pipe(CommandActor.actAs(viewer));
        assert.equal(seen.totals.requests, 0, viewer);
        assert.deepEqual(seen.labels.makitaConfigs ?? [], [], viewer);
        assert.notInclude(JSON.stringify(seen), "Widget bugs");
      }
    }),
  60_000,
);

live(
  "the activity shows Grace and the Admin today's usage, the task and its tokens, per repository and caller, and the events with their outcome",
  () =>
    Effect.gen(function* () {
      const { setup, config, makitaThread, activity } = yield* used;
      const asGrace = CommandActor.actAs(setup.people.member);
      const hers = yield* activity.activityForSession({ configId: config.configId }).pipe(asGrace);
      assert.isFalse(hers.everyone);
      assert.lengthOf(hers.configs, 1);
      // Her own configuration: she may stop its tasks (ticket 06's door).
      assert.isTrue(hers.configs[0]!.canStop);
      const usage = hers.configs[0]!.usage;
      assert.isNotNull(usage);
      assert.equal(usage!.today.requests, 1);
      assert.isAbove(usage!.today.tokens, 0);
      assert.deepEqual(usage!.week.requests, 1);
      assert.deepEqual(usage!.month.requests, 1);

      assert.lengthOf(hers.now, 1);
      const task = hers.now[0]!;
      assert.deepInclude(task, {
        repo: REPO,
        number: 12,
        callerLogin: "octocat",
        state: "running",
      });
      assert.equal(task.threadId, makitaThread.threadId as ThreadId);
      assert.equal(task.usage?.requests, 1);
      assert.equal(task.usage?.tokens, usage!.today.tokens);
      assert.lengthOf(hers.tasks, 1);
      assert.deepEqual(
        hers.byRepository.map((row) => [row.label, row.usage.today.requests]),
        [[REPO, 1]],
      );
      assert.deepEqual(
        hers.byCaller.map((row) => [row.label, row.usage.today.requests]),
        [["octocat", 1]],
      );
      assert.deepEqual(hers.events.map((event) => event.outcome).toSorted(), [
        "ignored-not-allowed",
        "started",
      ]);
      assert.include(
        hers.events.map((event) => event.actorLogin),
        "mallory",
      );

      const ada = yield* activity
        .activityForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.equal(ada.configs[0]?.usage?.today.requests, 1);
      assert.isTrue(ada.configs[0]?.canStop);
      assert.equal(ada.now[0]?.usage?.requests, 1);
    }),
  60_000,
);

live(
  "a Member who may use Makita sees another's configuration and its activity but not its usage; another Space gets not-found or forbidden; only the Owner sees every configuration; no agent or one-Space session",
  () =>
    Effect.gen(function* () {
      const { setup, config, hedy, activity } = yield* used;
      const asHedy = CommandActor.actAs(hedy);
      const hers = yield* activity.activityForSession({ configId: config.configId }).pipe(asHedy);
      assert.isNull(hers.configs[0]!.usage);
      // Another creator's configuration: she may not stop its tasks.
      assert.isFalse(hers.configs[0]!.canStop);
      assert.lengthOf(hers.now, 1);
      assert.isNull(hers.now[0]!.usage);
      assert.isNotNull(hers.now[0]!.threadId);
      assert.deepEqual(hers.byRepository, []);
      assert.deepEqual(hers.byCaller, []);
      const space = yield* activity.activityForSession({ spaceId: setup.acmeId }).pipe(asHedy);
      assert.isNull(space.configs[0]!.usage);

      const asGus = CommandActor.actAs(setup.people.globexMember);
      const missing = yield* activity
        .activityForSession({ configId: config.configId })
        .pipe(asGus, Effect.flip);
      assert.equal(missing.reason, "not-found");
      assert.notInclude(missing.message, "Widget");
      const acme = yield* activity
        .activityForSession({ spaceId: setup.acmeId })
        .pipe(asGus, Effect.flip);
      assert.equal(acme.reason, "forbidden");
      // The Globex view of Acme's configuration, by naming Globex: still not found.
      const crossed = yield* activity
        .activityForSession({ configId: config.configId, spaceId: setup.globexId })
        .pipe(CommandActor.actAs(setup.people.admin), Effect.flip);
      assert.equal(crossed.reason, "not-found");
      for (const viewer of [setup.people.admin, setup.people.member, hedy]) {
        const everything = yield* activity
          .activityForSession({})
          .pipe(CommandActor.actAs(viewer), Effect.flip);
        assert.equal(everything.reason, "forbidden");
      }
      const owner = yield* activity.activityForSession({}).pipe(setup.asOwner);
      assert.isTrue(owner.everyone);
      assert.deepEqual(
        owner.configs.map((entry) => [entry.name, entry.usage?.today.requests]),
        [["Widget bugs", 1]],
      );

      for (const as of [
        CommandActor.actAsResolved({ _tag: "User", userId: setup.people.member, via: "agent" }),
        CommandActor.actAsResolved({
          _tag: "User",
          userId: setup.people.member,
          spaceLimit: setup.acmeId,
        }),
      ]) {
        const refused = yield* activity
          .activityForSession({ configId: config.configId })
          .pipe(as, Effect.flip);
        assert.equal(refused.reason, "forbidden");
        const threads = yield* activity.threadsForSession.pipe(as, Effect.flip);
        assert.equal(threads.reason, "forbidden");
      }
    }),
  60_000,
);

live(
  "makita.threads lists the Makita Threads of the Spaces one sees: Grace's and the Owner's view have it, Globex's none",
  () =>
    Effect.gen(function* () {
      const { setup, makitaThread, activity } = yield* used;
      const expected = [
        {
          threadId: makitaThread.threadId as ThreadId,
          repo: REPO,
          number: 12,
          kind: "issue",
          callerLogin: "octocat",
          state: "running",
        } as const,
      ];
      for (const viewer of [setup.people.member, setup.people.admin]) {
        const seen = yield* activity.threadsForSession.pipe(CommandActor.actAs(viewer));
        assert.deepEqual(seen.threads, expected);
      }
      const owner = yield* activity.threadsForSession.pipe(setup.asOwner);
      assert.deepEqual(owner.threads, expected);
      const gus = yield* activity.threadsForSession.pipe(
        CommandActor.actAs(setup.people.globexMember),
      );
      assert.deepEqual(gus.threads, []);
    }),
  60_000,
);

live(
  "a lender reading a borrower's Makita requests through its loan sees the tokens but never the configuration's name",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      // Gus (Globex) lends an account of his to Acme; Grace's configuration uses it.
      const lent = yield* setup.account("Lent Claude", "claude", {});
      yield* setup.server.sql`
        UPDATE ai_accounts SET owner_kind = 'user', owner_id = ${setup.people.globexMember}
        WHERE account_id = ${lent}
      `;
      yield* lendAiAccount(setup.server.sql, {
        accountId: lent,
        lender: { kind: "user", id: setup.people.globexMember },
        spaceId: setup.acmeId,
      });
      const config = yield* ctx.configure({
        modelSelection: { ...ctx.input().modelSelection, aiAccountId: lent },
      });
      const thread = yield* setup.thread(setup.people.member, setup.acmeId, lent);
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* setup.server.sql`
        INSERT INTO makita_tasks (task_id, config_id, space_id, project_id, host, repo, number,
          kind, thread_id, caller_github_id, caller_login, state, created_at, updated_at)
        VALUES ('mkt_000000000000000000000002', ${config.configId}, ${setup.acmeId},
          ${thread.projectId}, 'github.com', ${REPO}, 14, 'issue', ${thread.threadId}, 1,
          'octocat', 'running', ${at}, ${at})
      `;
      const answer = yield* call(setup, "/api/ai/anthropic/v1/messages", {
        key: thread.key,
        body: messages(),
      });
      assert.equal(answer.status, 200);
      yield* setup.settled(1);

      const gus = yield* setup.usage
        .summary({})
        .pipe(CommandActor.actAs(setup.people.globexMember));
      assert.equal(gus.totals.requests, 1);
      assert.isTrue(gus.rows.every((row) => (row.makitaConfigId ?? null) === null));
      assert.deepEqual(gus.labels.makitaConfigs ?? [], []);
      assert.notInclude(JSON.stringify(gus), "Widget bugs");
      // Grace still sees it as her configuration's.
      const grace = yield* setup.usage.summary({}).pipe(CommandActor.actAs(setup.people.member));
      assert.deepEqual(grace.labels.makitaConfigs, [{ id: config.configId, name: "Widget bugs" }]);
    }),
  60_000,
);
