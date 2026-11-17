// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Owned-resources 09 at the AI gateway: an Organization's AI account, added by its Admin, serves
 * whoever works there and nobody else: not Globex, not a Member's Personal space, and not a
 * Member removed from it, from their next request on.
 */
import { assert, it } from "@effect/vitest";
import { type AiAccountId, SpaceId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { call, hub, messages, platform, posix, upstreamModels } from "./AiGatewayRoute.testkit.ts";

const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);
const path = "/api/ai/anthropic/v1/messages";

it.live.skipIf(!posix || platform === undefined)(
  "an Organization's AI account serves whoever works there, nobody in Globex or a Personal space, and no one removed from it",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { admin, member, guest, globexMember } = setup.people;
      const acmeOwner = { kind: "organization", spaceId: setup.acmeId } as const;
      // Ada, Acme's Admin, adds it; Grace, a Member, may not.
      const refused = yield* setup.accounts
        .create({
          name: "Grace's try",
          provider: "claude",
          apiKey: Redacted.make("sk-acme-member-try-0123456789abcdef"),
          owner: acmeOwner,
        })
        .pipe(CommandActor.actAs(member), Effect.flip);
      assert.equal(refused.reason, "forbidden");
      const made = yield* setup.accounts
        .create({
          name: "Acme Claude",
          provider: "claude",
          apiKey: Redacted.make("sk-acme-org-claude-0123456789abcdef"),
          owner: acmeOwner,
        })
        .pipe(CommandActor.actAs(admin));
      const acmes: AiAccountId = made.id;
      assert.deepEqual(made.owner, acmeOwner);
      // Settings offer Ada a section for Acme; Grace none.
      const adas = yield* setup.accounts.list.pipe(CommandActor.actAs(admin));
      assert.deepInclude(adas.owners ?? [], { owner: acmeOwner, name: "Acme" });
      const gracesOwners = (yield* setup.accounts.list.pipe(CommandActor.actAs(member))).owners;
      assert.notDeepInclude(gracesOwners ?? [], { owner: acmeOwner, name: "Acme" });
      const pin = messages(`acct-${acmes}/claude-sonnet-5-5`);
      const allowed = Context.get(setup.context, AllowedAiAccounts.AllowedAiAccounts);
      const ids = (userId: UserId, spaceId: SpaceId) =>
        allowed.for(userId, spaceId).pipe(Effect.map((list) => list.map((account) => account.id)));

      // Everyone who works in Acme, Guests included, as a Thread there may.
      for (const who of [admin, member, guest]) {
        const { key } = yield* setup.thread(who, setup.acmeId);
        assert.equal((yield* call(setup, path, { key, body: messages() })).status, 200);
        assert.equal(setup.upstream().at(-1)!.model, `acct-${acmes}/claude-sonnet-5-5`);
        assert.deepEqual(yield* ids(who, setup.acmeId), [acmes]);
      }
      // Members see it, read-only, in their list.
      const graces = yield* setup.accounts.list.pipe(CommandActor.actAs(member));
      const seen = graces.accounts.find((account) => account.id === acmes);
      assert.deepInclude(seen, { canManage: false, details: null, usableIn: [setup.acmeId] });

      // Not in Globex, not in Grace's Personal space.
      const before = setup.upstream().length;
      const globex = yield* setup.thread(globexMember, setup.globexId);
      assert.equal((yield* call(setup, path, { key: globex.key, body: pin })).status, 403);
      assert.deepEqual(yield* ids(globexMember, setup.globexId), []);
      const home = yield* setup.thread(member, personalOf(member));
      assert.equal((yield* call(setup, path, { key: home.key, body: pin })).status, 403);
      assert.deepEqual(yield* ids(member, personalOf(member)), []);
      assert.notInclude(upstreamModels(setup).slice(before), `acct-${acmes}/claude-sonnet-5-5`);

      // Grace removed from Acme: her next request there is refused.
      const last = yield* setup.thread(member, setup.acmeId);
      assert.equal((yield* call(setup, path, { key: last.key, body: messages() })).status, 200);
      yield* setup.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${setup.acmeId} AND user_id = ${member}
      `;
      yield* setup.directory.membershipsChanged([member]);
      assert.equal((yield* call(setup, path, { key: last.key, body: messages() })).status, 403);
      assert.deepEqual(yield* ids(member, setup.acmeId), []);
    }).pipe(Effect.scoped),
);
