// @effect-diagnostics globalJsonInEffect:off - the audit rows as stored.
/**
 * Makita ticket 08: a User links their GitHub account by posting, from it, a one-time code bound to
 * it; nobody links another person's account; «Only me» and «members» answer linked accounts, read
 * again at every event, so unlinking or leaving the Space counts at once.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { linkedIdsOf, linkedUserOf } from "./GitHubIdentities.ts";
import {
  GRACE_GH,
  type MakitaReady,
  makitaReady,
  OCTOCAT,
  STRANGER,
} from "./MakitaFixtures.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const REPO = "acme/widgets";

/** One poll and one pass of the tasks, as the Scheduler runs them. */
const tick = (ctx: MakitaReady) =>
  Effect.gen(function* () {
    yield* ctx.due;
    yield* ctx.setup.makitaIntake.pollDue;
    yield* ctx.setup.makitaTasks.startQueued;
  });

const auditOf = (ctx: MakitaReady, action: string) =>
  ctx.setup.server.sql<{
    readonly source: string;
    readonly actor: string | null;
    readonly target: string;
    readonly space: string | null;
    readonly detail: string;
  }>`
    SELECT actor_source AS source, actor_user_id AS actor, target_id AS target,
      space_id AS space, detail_json AS detail
    FROM audit_log WHERE action = ${action} ORDER BY audit_id
  `;

const eventOf = (ctx: MakitaReady, key: string) =>
  Effect.map(ctx.events, (rows) => rows.find((row) => row.key === key));

live(
  "a code posted from its own account links it once; a copied, used or expired code links nothing; «Only me» follows the link and a renamed login",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const asGrace = CommandActor.actAs(setup.people.member);
      const asAda = CommandActor.actAs(setup.people.admin);
      yield* ctx.configure({ callersMode: "creator", callers: [] });
      yield* setup.makitaIntake.pollDue;

      // Grace has no link yet: her own label is not hers to Makita.
      setup.github.label(REPO, 30, "makita", GRACE_GH);
      yield* tick(ctx);
      assert.equal((yield* ctx.events).at(-1)?.outcome, "ignored-not-allowed");
      assert.lengthOf(setup.launches, 0);

      const asked = yield* setup.githubIdentities
        .linkCodeForSession({ login: "@grace-gh" })
        .pipe(asGrace);
      assert.match(asked.code, /^[2-9A-HJ-NP-Z]{8}$/u);
      assert.equal(asked.login, "Grace-GH");
      assert.equal(asked.comment, `@makita-bot link ${asked.code}`);
      const waiting = yield* setup.githubIdentities.getForSession.pipe(asGrace);
      assert.deepInclude(waiting, { linked: null, makitaLogin: "makita-bot" });
      assert.deepInclude(waiting.pending, { login: "Grace-GH", state: "waiting" });
      // The code is kept only as its hash.
      const stored = yield* setup.server.sql<{ readonly hash: string }>`
        SELECT code_hash AS hash FROM github_link_codes
      `;
      assert.notInclude(JSON.stringify(stored), asked.code);

      // Someone copies the line from another account: the code is bound to Grace-GH.
      const copied = setup.github.commentOn(REPO, 30, STRANGER, asked.comment);
      yield* tick(ctx);
      assert.equal((yield* setup.githubIdentities.getForSession.pipe(asGrace)).linked, null);
      assert.lengthOf(setup.github.reactions, 0);
      assert.deepInclude(yield* eventOf(ctx, `gh:issue-comment:${copied.id}`), {
        outcome: "command",
        detail: "link",
        configId: null,
      });

      // Grace-GH posts it: linked, answered with a 👍, audited; no task starts.
      const posted = setup.github.commentOn(REPO, 30, GRACE_GH, `${asked.comment}\nthanks`);
      yield* tick(ctx);
      const linked = yield* setup.githubIdentities.getForSession.pipe(asGrace);
      assert.deepInclude(linked.linked, { githubUserId: GRACE_GH.id, login: "Grace-GH" });
      assert.equal(linked.pending, null);
      assert.deepEqual(
        setup.github.reactions.map((reaction) => [reaction.commentId, reaction.content]),
        [[posted.id, "+1"]],
      );
      assert.lengthOf(setup.launches, 0);
      // The narrow reads later tickets use: who linked this id, which id this User linked.
      const holder = yield* linkedUserOf(setup.server.sql, GRACE_GH.id);
      assert.deepEqual(Option.getOrNull(holder), setup.people.member);
      assert.isTrue(Option.isNone(yield* linkedUserOf(setup.server.sql, STRANGER.id)));
      assert.deepEqual(
        [...(yield* linkedIdsOf(setup.server.sql, [setup.people.member, setup.people.admin]))],
        [[setup.people.member, GRACE_GH.id]],
      );
      const links = yield* auditOf(ctx, "github_identity.link");
      assert.lengthOf(links, 1);
      assert.deepInclude(links[0], { actor: setup.people.member, target: setup.people.member });
      assert.deepEqual(JSON.parse(links[0]!.detail), {
        githubUserId: GRACE_GH.id,
        login: "Grace-GH",
        repo: REPO,
      });

      // Used once: posted again, nothing more happens.
      setup.github.commentOn(REPO, 30, GRACE_GH, asked.comment);
      yield* tick(ctx);
      assert.lengthOf(setup.github.reactions, 1);
      assert.lengthOf(yield* auditOf(ctx, "github_identity.link"), 1);

      // Ada's code expires before octocat posts it.
      const adas = yield* setup.githubIdentities
        .linkCodeForSession({ login: OCTOCAT.login })
        .pipe(asAda);
      yield* setup.server.sql`
        UPDATE github_link_codes SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE user_id = ${setup.people.admin}
      `;
      setup.github.commentOn(REPO, 30, OCTOCAT, adas.comment);
      yield* tick(ctx);
      const expired = yield* setup.githubIdentities.getForSession.pipe(asAda);
      assert.equal(expired.linked, null);
      assert.equal(expired.pending?.state, "expired");

      // «Only me»: Grace's account answers, by its id even after a rename.
      setup.github.label(REPO, 31, "makita", { login: "grace-renamed", id: GRACE_GH.id });
      yield* tick(ctx);
      assert.lengthOf(setup.launches, 1);
      assert.equal((yield* ctx.events).at(-1)?.outcome, "started");

      // Unlinked: the next event is not hers any more, with no edit to the configuration.
      const unlinked = yield* setup.githubIdentities.unlinkForSession({}).pipe(asGrace);
      assert.equal(unlinked.linked, null);
      assert.deepEqual(JSON.parse((yield* auditOf(ctx, "github_identity.unlink"))[0]!.detail), {
        githubUserId: GRACE_GH.id,
        login: "Grace-GH",
        reason: "user",
      });
      setup.github.label(REPO, 32, "makita", GRACE_GH);
      yield* tick(ctx);
      assert.equal((yield* ctx.events).at(-1)?.outcome, "ignored-not-allowed");
      assert.lengthOf(setup.launches, 1);
    }).pipe(Effect.scoped),
);

live(
  "nobody links an account someone else linked; «members» answers the Space's linked Admins and Members until they leave, never a Guest; only its User or the Owner unlinks",
  () =>
    Effect.gen(function* () {
      const ctx = yield* makitaReady;
      const { setup } = ctx;
      const { admin, member, guest } = setup.people;
      const link = (userId: typeof admin, user: typeof OCTOCAT) =>
        Effect.gen(function* () {
          const asked = yield* setup.githubIdentities
            .linkCodeForSession({ login: user.login })
            .pipe(CommandActor.actAs(userId));
          return setup.github.commentOn(REPO, 40, user, asked.comment);
        });
      const config = yield* ctx.configure({ callersMode: "members", callers: [] });
      assert.deepEqual([config.callersMode, config.callers], ["members", []]);
      yield* setup.makitaIntake.pollDue;

      // Ada (Admin) links octocat; Grace then tries to claim octocat with a code of her own.
      yield* link(admin, OCTOCAT);
      yield* tick(ctx);
      const claimed = yield* link(member, OCTOCAT);
      yield* tick(ctx);
      const grace = yield* setup.githubIdentities.getForSession.pipe(CommandActor.actAs(member));
      assert.equal(grace.linked, null);
      assert.equal(grace.pending?.state, "taken");
      assert.deepEqual(
        setup.github.reactions.map((reaction) => reaction.content),
        ["+1", "confused"],
      );
      assert.equal(setup.github.reactions[1]?.commentId, claimed.id);
      const ada = yield* setup.githubIdentities.getForSession.pipe(CommandActor.actAs(admin));
      assert.equal(ada.linked?.login, "octocat");
      assert.deepEqual(
        (yield* auditOf(ctx, "github_identity.link")).map((row) => row.target),
        [admin],
      );

      // Linus (Guest) links Grace-GH: a Guest's account does not count.
      yield* link(guest, GRACE_GH);
      yield* tick(ctx);
      setup.github.label(REPO, 41, "makita", OCTOCAT);
      setup.github.label(REPO, 42, "makita", GRACE_GH);
      yield* tick(ctx);
      const outcomes = (yield* ctx.events)
        .filter((row) => row.number === 41 || row.number === 42)
        .map((row) => [row.number, row.outcome]);
      assert.deepEqual(outcomes, [
        [41, "started"],
        [42, "ignored-not-allowed"],
      ]);

      // Ada leaves Acme: octocat no longer counts at the next event.
      const removed = yield* setup.server.request(`/api/spaces/${setup.acmeId}/members/remove`, {
        body: { userId: admin },
        cookie: setup.ownerCookie,
      });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      yield* setup.directory.membershipsChanged([admin]);
      setup.github.label(REPO, 43, "makita", OCTOCAT);
      yield* tick(ctx);
      assert.equal((yield* ctx.events).at(-1)?.outcome, "ignored-not-allowed");

      // Grace may not unlink Ada's (answered like a missing one); an agent reads nothing.
      const refused = yield* setup.githubIdentities
        .unlinkForSession({ userId: admin })
        .pipe(CommandActor.actAs(member), Effect.flip);
      assert.equal(refused.reason, "not-found");
      const agent = yield* setup.githubIdentities.getForSession.pipe(
        CommandActor.actAsResolved({ _tag: "User", userId: member, via: "agent" }),
        Effect.flip,
      );
      assert.equal(agent.reason, "forbidden");
      // The Owner unlinks Linus's.
      yield* setup.githubIdentities.unlinkForSession({ userId: guest }).pipe(setup.asOwner);
      const linus = yield* setup.githubIdentities.getForSession.pipe(CommandActor.actAs(guest));
      assert.equal(linus.linked, null);
      const unlink = (yield* auditOf(ctx, "github_identity.unlink"))[0]!;
      assert.deepInclude(unlink, { actor: setup.ownerId, target: guest, space: null });
      assert.equal(JSON.parse(unlink.detail).reason, "owner");
    }).pipe(Effect.scoped),
);
