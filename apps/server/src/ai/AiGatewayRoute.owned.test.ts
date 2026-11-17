// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Owned-resources 08 at the AI gateway: a User's own AI account reaches their Personal space and
 * nothing else, whatever path asks for it (a Thread key, a pin, a local CLI key, failover), and
 * comes before what the Owner allowed them there.
 */
import { assert, it } from "@effect/vitest";
import { type AiAccountId, type AiAccountProvider, SpaceId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import {
  call,
  hub,
  messages,
  platform,
  posix,
  upstreamModels,
  type Hub,
} from "./AiGatewayRoute.testkit.ts";

/** An AI account `userId` adds for themselves, with no allowance. */
const ownAccount = Effect.fn(function* (
  setup: Hub,
  userId: UserId,
  name: string,
  provider: AiAccountProvider = "claude",
) {
  const made = yield* setup.accounts
    .create({
      name,
      provider: provider as never,
      apiKey: Redacted.make(`sk-own-${name.replaceAll(" ", "-")}-0123456789abcdef`),
    })
    .pipe(CommandActor.actAs(userId));
  return made.id;
});

const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);
const path = "/api/ai/anthropic/v1/messages";

it.live.skipIf(!posix || platform === undefined)(
  "a User's own AI account reaches their Personal space only: never their Thread in Acme, nor anyone else's Personal space, by any key",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ana = setup.people.member;
      const bob = setup.people.globexMember;
      const anas = yield* ownAccount(setup, ana, "Ana Claude");
      const pin = (accountId: AiAccountId) => messages(`acct-${accountId}/claude-sonnet-5-5`);
      const allowed = Context.get(setup.context, AllowedAiAccounts.AllowedAiAccounts);
      const ids = (userId: UserId, spaceId: SpaceId) =>
        allowed.for(userId, spaceId).pipe(Effect.map((list) => list.map((account) => account.id)));

      // Her Personal space: a Thread uses it by default, and a pin and her CLI key reach it.
      const home = yield* setup.thread(ana, personalOf(ana));
      const used = yield* call(setup, path, { key: home.key, body: messages() });
      assert.equal(used.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${anas}/claude-sonnet-5-5`);
      const pinnedHome = yield* setup.thread(ana, personalOf(ana), anas);
      assert.equal(
        (yield* call(setup, path, { key: pinnedHome.key, body: messages() })).status,
        200,
      );
      const homeCli = yield* setup.keys.createForUser({
        actorUserId: ana,
        spaceId: personalOf(ana),
        name: "Ana laptop",
      });
      assert.equal(
        (yield* call(setup, path, { key: Redacted.value(homeCli.key), body: pin(anas) })).status,
        200,
      );
      assert.deepEqual(yield* ids(ana, personalOf(ana)), [anas]);

      // Her Thread in Acme, where she works: not by default, not pinned, not by naming it, not
      // with a CLI key for Acme, not in the picker.
      const before = setup.upstream().length;
      const acme = yield* setup.thread(ana, setup.acmeId);
      const acmeDefault = yield* call(setup, path, { key: acme.key, body: messages() });
      assert.notEqual(acmeDefault.status, 200);
      const acmeNamed = yield* call(setup, path, { key: acme.key, body: pin(anas) });
      assert.equal(acmeNamed.status, 403);
      const acmePinned = yield* setup.thread(ana, setup.acmeId, anas);
      const pinnedRefused = yield* call(setup, path, { key: acmePinned.key, body: messages() });
      assert.equal(pinnedRefused.status, 403);
      assert.notInclude(pinnedRefused.text, "Ana Claude");
      const acmeCli = yield* setup.keys.createForUser({
        actorUserId: ana,
        spaceId: setup.acmeId,
        name: "Ana for Acme",
      });
      assert.equal(
        (yield* call(setup, path, { key: Redacted.value(acmeCli.key), body: pin(anas) })).status,
        403,
      );
      assert.deepEqual(yield* ids(ana, setup.acmeId), []);

      // Bob's Personal space, by his Thread key and his CLI key: never Ana's.
      const bobs = yield* setup.thread(bob, personalOf(bob));
      assert.equal((yield* call(setup, path, { key: bobs.key, body: pin(anas) })).status, 403);
      const bobCli = yield* setup.keys.createForUser({
        actorUserId: bob,
        spaceId: personalOf(bob),
        name: "Bob laptop",
      });
      assert.equal(
        (yield* call(setup, path, { key: Redacted.value(bobCli.key), body: pin(anas) })).status,
        403,
      );
      assert.notInclude(yield* ids(bob, personalOf(bob)), anas);
      // None of those refused requests reached CLIProxyAPI with her account.
      assert.notInclude(upstreamModels(setup).slice(before), `acct-${anas}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "in a Personal space its User's own accounts come first, then what the Owner allowed them, and failover keeps that order",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ana = setup.people.member;
      // The Owner's, allowed to Ana herself (wherever she works); then two of her own.
      const owners = yield* setup.account("Owner Claude", "claude", { userIds: [ana] });
      const first = yield* ownAccount(setup, ana, "Ana Claude A");
      const second = yield* ownAccount(setup, ana, "Ana Claude B");
      const allowed = Context.get(setup.context, AllowedAiAccounts.AllowedAiAccounts);
      assert.deepEqual(
        (yield* allowed.for(ana, personalOf(ana))).map((account) => account.id),
        [first, second, owners],
      );
      // In Acme she gets only what the Owner allowed her.
      assert.deepEqual(
        (yield* allowed.for(ana, setup.acmeId)).map((account) => account.id),
        [owners],
      );

      const { key } = yield* setup.thread(ana, personalOf(ana));
      const ask = () => call(setup, path, { key, body: messages() });
      assert.equal((yield* ask()).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${first}/claude-sonnet-5-5`);
      // Hers out of quota: her second, then the Owner's.
      setup.flag(`fake-quota-${first}`);
      assert.equal((yield* ask()).status, 200);
      assert.deepEqual(upstreamModels(setup).slice(-2), [
        `acct-${first}/claude-sonnet-5-5`,
        `acct-${second}/claude-sonnet-5-5`,
      ]);
      setup.flag(`fake-quota-${second}`);
      assert.equal((yield* ask()).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${owners}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "the Owner's own AI accounts serve the Owner's Personal space without an allowance",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const mine = yield* setup.account("Owner Claude", "claude", {});
      const { key } = yield* setup.thread(setup.ownerId, personalOf(setup.ownerId));
      assert.equal((yield* call(setup, path, { key, body: messages() })).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${mine}/claude-sonnet-5-5`);
      // Not in Acme, where nothing allows it.
      const acme = yield* setup.thread(setup.ownerId, setup.acmeId);
      assert.notEqual((yield* call(setup, path, { key: acme.key, body: messages() })).status, 200);
    }).pipe(Effect.scoped),
);
