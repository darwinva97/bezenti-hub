/**
 * Makita ticket 04: the intake reads each listened repository's issue events with Makita's token
 * and conditional requests, and decides each `makita` label once: who put it, whether they may,
 * which configuration takes it. Strangers, bots and Makita itself start nothing.
 */
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import {
  DEPENDABOT,
  GRACE_GH,
  MAKITA_BOT,
  makitaReady,
  OCTOCAT,
  STRANGER,
} from "./MakitaFixtures.testkit.ts";
import { FAST_POLL_MS, SLOW_POLL_MS } from "./MakitaIntake.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";

live(
  "starts from now, takes a label of someone on the list once (read twice, re-read after a crash, a 304), with the actor's numeric id",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup, events, cursor, due, feedReads } = ctx;
      const config = yield* ctx.configure();
      // Labelled before Makita listened: never replayed.
      const old = setup.github.label(REPO, 7, "makita", OCTOCAT);
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.deepEqual(yield* events, []);
      assert.equal((yield* cursor)[0]!.cursor, String(old.id));

      const fresh = setup.github.label(REPO, 12, "makita", OCTOCAT);
      yield* due;
      const queued = yield* setup.makitaIntake.pollDue;
      assert.deepEqual(queued, [
        {
          eventKey: `gh:issue-event:${fresh.id}`,
          repo: REPO,
          number: 12,
          configId: config.configId,
        },
      ]);
      assert.deepEqual(
        (yield* events).map((row) => [row.key, row.number, row.kind, row.actor, row.outcome]),
        [[`gh:issue-event:${fresh.id}`, 12, "issue", 1, "queued"]],
      );
      assert.equal((yield* cursor)[0]!.cursor, String(fresh.id));

      // Nothing new: GitHub answers 304 to the ETag, nothing is written.
      yield* due;
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      const last = feedReads().at(-1)!;
      assert.isDefined(last.ifNoneMatch);
      assert.lengthOf(yield* events, 1);

      // A crash after the batch was written but before the cursor moved: the batch is read again
      // and every key is taken.
      yield* setup.server.sql`
        UPDATE makita_repo_cursors SET cursor = ${String(old.id)}, etag = NULL, next_poll_at = NULL
      `;
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.lengthOf(yield* events, 1);
      assert.equal((yield* cursor)[0]!.cursor, String(fresh.id));
      // Every read carried Makita's token, never anything else.
      assert.isTrue(feedReads().every((request) => request.signed));
    }),
);

live(
  "a stranger, a bot, Makita itself and a pull request start nothing; another label is not even stored",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup, events, due } = ctx;
      const config = yield* ctx.configure();
      yield* setup.makitaIntake.pollDue;
      setup.github.label(REPO, 1, "makita", STRANGER);
      setup.github.label(REPO, 2, "makita", DEPENDABOT);
      setup.github.label(REPO, 3, "makita", MAKITA_BOT);
      setup.github.label(REPO, 4, "bug", OCTOCAT);
      setup.github.label(REPO, 5, "MAKITA", OCTOCAT, { pull: true });
      yield* due;
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.deepEqual(
        (yield* events).map((row) => [row.number, row.kind, row.outcome, row.detail, row.configId]),
        [
          [1, "issue", "ignored-not-allowed", null, config.configId],
          [2, "issue", "ignored-bot", null, config.configId],
          [3, "issue", "ignored-self", null, config.configId],
          [5, "pull", "ignored-no-config", "pull-request", config.configId],
        ],
      );
    }),
);

live("the oldest configuration that answers the caller takes the event", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup, events, due } = ctx;
    const first = yield* ctx.configure({ name: "Octocat's" });
    const second = yield* ctx.configure({ name: "Grace's", callers: [GRACE_GH.login] });
    yield* setup.makitaIntake.pollDue;
    setup.github.label(REPO, 20, "makita", GRACE_GH);
    setup.github.label(REPO, 21, "makita", OCTOCAT);
    yield* due;
    const queued = yield* setup.makitaIntake.pollDue;
    assert.deepEqual(
      queued.map((event) => [event.number, event.configId]),
      [
        [20, second.configId],
        [21, first.configId],
      ],
    );
    assert.deepEqual(
      (yield* events).map((row) => row.outcome),
      ["queued", "queued"],
    );
  }),
);

live(
  "a paused configuration ignores what comes and replays nothing on resume; «Stop all» reads nothing and starts from now",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup, events, due, cursor, feedReads } = ctx;
      const config = yield* ctx.configure();
      yield* setup.makitaIntake.pollDue;
      yield* setup.makitaConfigs
        .pauseForSession({ configId: config.configId })
        .pipe(ctx.setup.asOwner);
      setup.github.label(REPO, 30, "makita", OCTOCAT);
      yield* due;
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.deepEqual(
        (yield* events).map((row) => [row.number, row.outcome]),
        [[30, "ignored-paused"]],
      );
      yield* setup.makitaConfigs
        .resumeForSession({ configId: config.configId })
        .pipe(ctx.setup.asOwner);
      yield* due;
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.lengthOf(yield* events, 1);

      yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner);
      const before = feedReads().length;
      setup.github.label(REPO, 31, "makita", OCTOCAT);
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      assert.equal(feedReads().length, before);
      assert.deepEqual(yield* cursor, []);
      yield* setup.makitaAccount.resumeAllForSession.pipe(setup.asOwner);
      assert.deepEqual(yield* setup.makitaIntake.pollDue, []);
      // The label put during the pause is not replayed.
      assert.lengthOf(yield* events, 1);
      setup.github.label(REPO, 32, "makita", OCTOCAT);
      yield* due;
      assert.deepEqual(
        (yield* setup.makitaIntake.pollDue).map((event) => event.number),
        [32],
      );
    }),
);

live(
  "a repository GitHub hides is marked and warned about; a refused token stops the poller; a rate limit holds every repository",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup, due, cursor, feedReads } = ctx;
      const config = yield* ctx.configure();
      setup.github.failures.set(REPO, 404);
      yield* setup.makitaIntake.pollDue;
      const hidden = (yield* cursor)[0]!;
      assert.equal(hidden.lastError, "not-found");
      assert.isNotNull(hidden.unreachableSince);
      const listed = yield* setup.makitaConfigs
        .listForSession({ spaceId: setup.acmeId })
        .pipe(ctx.setup.asOwner);
      assert.include(
        listed.configs.find((row) => row.configId === config.configId)!.warnings,
        "repo-unreachable",
      );
      const account = yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner);
      assert.include(account.account!.warnings, "repo-unreachable");
      // It stays marked since the first failure.
      yield* due;
      yield* setup.makitaIntake.pollDue;
      assert.equal((yield* cursor)[0]!.unreachableSince, hidden.unreachableSince);

      // Readable again: the mark goes.
      setup.github.failures.delete(REPO);
      yield* due;
      yield* setup.makitaIntake.pollDue;
      assert.isNull((yield* cursor)[0]!.unreachableSince);

      // A rate limit: nothing more is asked until it ends.
      setup.github.failures.set(REPO, 429);
      yield* due;
      yield* setup.makitaIntake.pollDue;
      setup.github.failures.delete(REPO);
      const held = feedReads().length;
      yield* due;
      yield* setup.makitaIntake.pollDue;
      assert.equal(feedReads().length, held);
    }),
);

live("a refused token stops the poller and marks the account", () =>
  Effect.gen(function* () {
    const ctx = yield* makitaReady;
    const { setup, due, feedReads } = ctx;
    yield* ctx.configure();
    yield* setup.makitaIntake.pollDue;
    setup.github.failures.set(REPO, 401);
    yield* due;
    yield* setup.makitaIntake.pollDue;
    const account = yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner);
    assert.equal(account.account!.status, "token-invalid");
    const reads = feedReads().length;
    yield* due;
    yield* setup.makitaIntake.pollDue;
    assert.equal(feedReads().length, reads);
  }),
);

live(
  "asks again after 30 s with recent triggers, 2 minutes without, never before X-Poll-Interval",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup, due, cursor } = ctx;
      yield* ctx.configure();
      const nextIn = Effect.gen(function* () {
        const row = (yield* cursor)[0]!;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        return DateTime.toEpochMillis(DateTime.makeUnsafe(row.nextPollAt!)) - now;
      });
      yield* setup.makitaIntake.pollDue;
      const quiet = yield* nextIn;
      assert.isTrue(quiet > SLOW_POLL_MS - 5_000 && quiet <= SLOW_POLL_MS, String(quiet));
      setup.github.label(REPO, 40, "makita", OCTOCAT);
      yield* due;
      yield* setup.makitaIntake.pollDue;
      const busy = yield* nextIn;
      assert.isTrue(busy > FAST_POLL_MS - 5_000 && busy <= FAST_POLL_MS, String(busy));
      setup.github.pollIntervals.set(REPO, 300);
      setup.github.label(REPO, 41, "makita", OCTOCAT);
      yield* due;
      yield* setup.makitaIntake.pollDue;
      const asked = yield* nextIn;
      assert.isTrue(asked > 295_000 && asked <= 300_000, String(asked));
    }),
);
