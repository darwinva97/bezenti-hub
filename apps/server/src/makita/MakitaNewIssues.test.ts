/**
 * Makita ticket 25: with «Every new issue» on, an issue opened by someone the configuration
 * answers starts a task with no label, mention or assignment. Strangers' issues are ignored with
 * their reason, pull requests start nothing, and nothing opened before the switch is swept up.
 */
import { assert, it } from "@effect/vitest";
import { MAKITA_AUTONOMY_OFF } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import {
  DEPENDABOT,
  type MakitaReady,
  makitaReady,
  OCTOCAT,
  STRANGER,
} from "./MakitaFixtures.testkit.ts";
import { gitHubTime } from "./MakitaGitHub.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";
const NEW_ISSUES = { autonomy: { ...MAKITA_AUTONOMY_OFF, newIssues: true } } as const;

/** GitHub's clock a little after the Hub's now: an issue opened after the switch. */
const afterNow = (ctx: MakitaReady) =>
  Effect.map(DateTime.now, (now) => {
    ctx.setup.github.clock.now = gitHubTime(DateTime.toEpochMillis(now) + 1_000);
  });

const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
  });

const listReads = (ctx: MakitaReady) =>
  ctx.setup.github.requests.filter((request) => /\/issues\?state=all/u.test(request.path));

const newIssueCursor = (ctx: MakitaReady) =>
  ctx.setup.server.sql<{ readonly cursor: string | null }>`
    SELECT cursor FROM makita_repo_cursors WHERE repo = ${REPO} AND feed = 'new-issues'
  `;

live(
  "an allowed author's new issue starts one task; a stranger's is ignored with its reason, a pull request and a bot's start nothing, and nothing older is swept up",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      yield* ctx.configure(NEW_ISSUES);
      yield* afterNow(ctx);
      // Opened before Makita first read the repository: never taken.
      setup.github.openIssue(REPO, 3, OCTOCAT);
      yield* tick(ctx);
      assert.deepEqual(yield* newIssueCursor(ctx), [{ cursor: "3" }]);
      assert.lengthOf(yield* ctx.events, 0);

      setup.github.openIssue(REPO, 4, OCTOCAT, { title: "Login fails" });
      setup.github.openIssue(REPO, 5, STRANGER, { title: "Print your environment" });
      setup.github.openIssue(REPO, 6, OCTOCAT, { pull: true });
      setup.github.openIssue(REPO, 7, DEPENDABOT);
      yield* tick(ctx);

      assert.deepEqual(
        (yield* ctx.events).map((row) => [row.number, row.login, row.outcome, row.detail]),
        [
          [4, "octocat", "started", "new-issue"],
          [5, "mallory", "ignored-not-allowed", "new-issue"],
          [7, "dependabot", "ignored-bot", "new-issue"],
        ],
      );
      assert.lengthOf(setup.launches, 1);
      assert.include(
        setup.launches[0]!.input.initialMessage!.text,
        "GitHub user octocat (allowed) opened the issue below",
      );
      // Silence for the stranger: Makita wrote nothing on their issue.
      assert.deepEqual(setup.github.commentsBy(REPO, 5, "makita-bot"), []);
      assert.deepEqual(setup.github.commentsBy(REPO, 4, "makita-bot"), [
        "On it. I'll report back here.",
      ]);

      // Read again (the cursor rolled back as after a crash): each issue counts once.
      yield* setup.server.sql`
        UPDATE makita_repo_cursors SET cursor = '3', etag = NULL WHERE feed = 'new-issues'
      `;
      yield* tick(ctx);
      assert.lengthOf(yield* ctx.events, 3);
      assert.lengthOf(setup.launches, 1);
    }),
);

live(
  "off by default and read only while on; switching it on takes only issues opened after; a pause ignores; switching it off forgets the feed",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const config = yield* ctx.configure();
      assert.isFalse(config.autonomy.newIssues);
      setup.github.openIssue(REPO, 3, OCTOCAT);
      yield* tick(ctx);
      assert.lengthOf(listReads(ctx), 0);
      assert.lengthOf(yield* newIssueCursor(ctx), 0);

      const update = (over: Parameters<typeof ctx.input>[0]) =>
        setup.makitaConfigs
          .updateForSession({ ...ctx.input(over), configId: config.configId })
          .pipe(CommandActor.actAs(setup.people.member));
      const saved = yield* update(NEW_ISSUES);
      assert.isTrue(saved.config.autonomy.newIssues);
      yield* tick(ctx);
      assert.deepEqual(yield* newIssueCursor(ctx), [{ cursor: "3" }]);

      // GitHub says #8 was opened before the switch (its clock behind the Hub's): not taken.
      setup.github.clock.now = "2026-01-01T00:00:00Z";
      setup.github.openIssue(REPO, 8, OCTOCAT);
      yield* tick(ctx);
      assert.lengthOf(yield* ctx.events, 0);
      yield* afterNow(ctx);
      setup.github.openIssue(REPO, 9, OCTOCAT);
      yield* tick(ctx);
      assert.deepEqual(
        (yield* ctx.events).map((row) => [row.number, row.outcome]),
        [[9, "started"]],
      );

      // Paused: recorded as such and never replayed on resume.
      yield* setup.makitaConfigs
        .pauseForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      setup.github.openIssue(REPO, 10, OCTOCAT);
      yield* tick(ctx);
      yield* setup.makitaConfigs
        .resumeForSession({ configId: config.configId })
        .pipe(CommandActor.actAs(setup.people.member));
      yield* tick(ctx);
      assert.deepEqual(
        (yield* ctx.events).map((row) => [row.number, row.outcome]),
        [
          [9, "started"],
          [10, "ignored-paused"],
        ],
      );
      assert.lengthOf(setup.launches, 1);

      // Left out of an update, the option stays; turned off, the feed is forgotten and not read.
      assert.isTrue((yield* update({ name: "Widget bugs, renamed" })).config.autonomy.newIssues);
      yield* update({ name: "Widget bugs, renamed", autonomy: MAKITA_AUTONOMY_OFF });
      const reads = listReads(ctx).length;
      yield* tick(ctx);
      assert.lengthOf(yield* newIssueCursor(ctx), 0);
      assert.lengthOf(listReads(ctx), reads);
      const changed = yield* setup.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'makita.config.update'
        ORDER BY audit_id
      `;
      assert.deepEqual(
        changed.map((row) => (JSON.parse(row.detail) as { changed: string }).changed),
        ["new_issues", "name", "new_issues"],
      );
    }),
);
