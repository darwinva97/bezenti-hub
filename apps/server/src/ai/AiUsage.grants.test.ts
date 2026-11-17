// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Grants ticket 04: who sees the use of a lent AI account. Its lender sees its Grant's rows by
 * borrowing Space, User, day and model, never a Thread, a prompt or the borrowers' other
 * accounts; a borrower sees their own; an Admin their Space's; the Owner every Space's
 * consumption and no Thread of a Space they do not run.
 */
import { assert, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiUsageSummaryInput,
  SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { lendAiAccount } from "../grants/Grants.testkit.ts";
import {
  acmeSetup,
  call,
  hub,
  messages,
  platform,
  posix,
  PROMPT,
  type Hub,
} from "./AiGatewayRoute.testkit.ts";

const live = it.live.skipIf(!posix || platform === undefined);
const WINDOW = { fromAt: "2000-01-01T00:00:00.000Z", toAt: "2100-01-01T00:00:00.000Z" };

const summaryAs = (setup: Hub, userId: UserId, input: AiUsageSummaryInput = {}) =>
  setup.usage.summary(input).pipe(CommandActor.actAs(userId));

/**
 * Gus (of Globex) lends his own account to Acme. Ada (Acme's Admin) and Linus (a Guest) use it;
 * Ada also uses Acme's own; Grace uses only Acme's own. Grace also works in her Personal space.
 */
const lentToAcme = Effect.fn(function* (setup: Hub) {
  const ids = yield* acmeSetup(setup);
  const { admin, guest, member, globexMember: gus } = setup.people;
  const made = yield* setup.accounts
    .create({
      name: "Gus Claude",
      provider: "claude" as never,
      apiKey: Redacted.make("sk-gus-lent-0123456789abcdef0123"),
    })
    .pipe(CommandActor.actAs(gus));
  const gusAccount = made.id as AiAccountId;
  const grantId = yield* lendAiAccount(setup.server.sql, {
    accountId: gusAccount,
    lender: { kind: "user", id: gus },
    spaceId: setup.acmeId,
  });
  const ask = (key: string) =>
    call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });
  const adaLent = yield* setup.thread(admin, setup.acmeId, gusAccount);
  const linusLent = yield* setup.thread(guest, setup.acmeId, gusAccount);
  const adaOwn = yield* setup.thread(admin, setup.acmeId, ids.claudeA);
  const graceOwn = yield* setup.thread(member, setup.acmeId, ids.claudeA);
  const gracePersonal = yield* setup.thread(member, SpaceId.make(`personal:${member}`));
  // Grace's Personal space has no account of hers: lend her one so her turn runs there.
  yield* lendAiAccount(setup.server.sql, {
    accountId: ids.claudeB,
    lender: { kind: "user", id: setup.ownerId },
    spaceId: SpaceId.make(`personal:${member}`),
  });
  for (const thread of [adaLent, linusLent, adaOwn, graceOwn, gracePersonal]) {
    assert.equal((yield* ask(thread.key)).status, 200);
  }
  yield* setup.settled(5);
  return { gus, gusAccount, grantId, adaLent, linusLent, adaOwn, graceOwn, gracePersonal };
});

live(
  "the lender sees their loan's use by Space, User, day and model, never a Thread, a prompt or another account",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const lent = yield* lentToAcme(setup);
      const { admin, guest } = setup.people;

      const view = yield* summaryAs(setup, lent.gus);
      // Only the rows of the Grant: Ada's and Linus's use of Gus's account in Acme.
      assert.deepEqual(
        view.rows
          .map((row) => [row.userId, row.spaceId, row.accountId, row.grantId, row.requests])
          .toSorted(),
        [
          [admin, setup.acmeId, lent.gusAccount, lent.grantId, 1],
          [guest, setup.acmeId, lent.gusAccount, lent.grantId, 1],
        ].toSorted(),
      );
      // Named for him: who used it, in which Space, on which of his accounts.
      assert.sameMembers(
        view.labels.users.map((user) => user.name),
        ["ada", "linus"],
      );
      assert.deepEqual(view.labels.spaces, [{ id: setup.acmeId, name: "Acme" }]);
      assert.deepEqual(
        view.labels.accounts.map((account) => account.name),
        ["Gus Claude"],
      );
      // Filtered by the Grant: the same.
      const byGrant = yield* summaryAs(setup, lent.gus, { grantId: lent.grantId });
      assert.equal(byGrant.totals.requests, 2);

      // Never a Thread: asking for one, even one that used his account, gives nothing.
      for (const thread of [lent.adaLent, lent.linusLent, lent.adaOwn]) {
        assert.equal(
          (yield* summaryAs(setup, lent.gus, { threadId: thread.threadId })).rows.length,
          0,
        );
      }
      const threads = yield* setup.usage.threadRequests(WINDOW).pipe(CommandActor.actAs(lent.gus));
      assert.deepEqual(threads, []);
      // Nothing in what he gets names a Thread or carries a prompt.
      const everything = JSON.stringify([view, byGrant]);
      for (const thread of [lent.adaLent, lent.linusLent, lent.adaOwn, lent.graceOwn]) {
        assert.notInclude(everything, thread.threadId);
      }
      assert.notInclude(everything, PROMPT);
      // Not Acme's own use, not Grace's, not Ada's other account.
      assert.notInclude(everything, setup.people.member);
    }).pipe(Effect.scoped),
);

live("a borrower sees their own use of the loan; an Admin their Space's, Grant by Grant", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const lent = yield* lentToAcme(setup);
    const { admin, guest, member } = setup.people;

    // Linus, a Guest, sees only his own: never Ada's use of the same loan.
    const linus = yield* summaryAs(setup, guest);
    assert.deepEqual([...new Set(linus.rows.map((row) => row.userId))], [guest]);
    assert.equal((yield* summaryAs(setup, guest, { userId: admin })).rows.length, 0);
    // Grace, a Member, does not see the loan's use by others either.
    assert.equal((yield* summaryAs(setup, member, { grantId: lent.grantId })).rows.length, 0);
    // Ada, Acme's Admin, sees Acme's, each row with the loan it went through: Gus's, and the
    // Owner's loan of «Acme Claude A» that Grace and she used.
    const ada = yield* summaryAs(setup, admin, { spaceId: setup.acmeId });
    const grants = ada.rows.map((row) => [row.userId, row.accountId, row.grantId ?? null]);
    assert.deepInclude(grants, [admin, lent.gusAccount, lent.grantId]);
    assert.deepInclude(grants, [guest, lent.gusAccount, lent.grantId]);
    assert.isTrue(
      grants.some(
        ([userId, accountId, grantId]) =>
          userId === member && accountId !== lent.gusAccount && grantId !== lent.grantId,
      ),
    );
  }).pipe(Effect.scoped),
);

live("the Owner sees every Space's consumption and no Thread of a Space they do not run", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const lent = yield* lentToAcme(setup);
    const { member } = setup.people;
    const personal = SpaceId.make(`personal:${member}`);
    // The Owner runs Acme as one of its Admins.
    yield* setup.server.sql`
      INSERT OR IGNORE INTO space_memberships (space_id, user_id, role, created_at)
      VALUES (${setup.acmeId}, ${setup.ownerId}, 'admin', '2026-11-01T00:00:00.000Z')
    `;
    yield* setup.directory.membershipsChanged([setup.ownerId]);

    // Grace's Personal space's use is counted for the Owner…
    const owner = yield* summaryAs(setup, setup.ownerId, { spaceId: personal });
    assert.equal(owner.totals.requests, 1);
    // …but its Thread is not the Owner's to read, by filter or in the Usage dialog.
    assert.equal(
      (yield* summaryAs(setup, setup.ownerId, { threadId: lent.gracePersonal.threadId })).rows
        .length,
      0,
    );
    const threads = yield* setup.usage
      .threadRequests(WINDOW)
      .pipe(CommandActor.actAs(setup.ownerId));
    assert.notInclude(
      threads.map((request) => request.threadId),
      lent.gracePersonal.threadId,
    );
    // Acme, which the Owner runs, stays readable Thread by Thread.
    assert.include(
      threads.map((request) => request.threadId),
      lent.graceOwn.threadId,
    );
  }).pipe(Effect.scoped),
);
