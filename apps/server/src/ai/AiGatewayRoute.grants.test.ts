// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Grants ticket 01 at the AI gateway: an AI account lent to a Space by an active Grant is used
 * there, after the Space's own; a waiting, rejected or ended Grant gives nothing, and ending one
 * refuses the next request. A disabled lender or an archived lending Organization lends nothing.
 */
import { assert, it } from "@effect/vitest";
import { type AiAccountId, SpaceId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import * as Grants from "../grants/Grants.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { call, hub, messages, platform, posix, type Hub } from "./AiGatewayRoute.testkit.ts";

const path = "/api/ai/anthropic/v1/messages";
const NO_CAP = { kind: "ai-account", tokens: null, requests: null } as const;
const AT = "2026-11-01T00:00:00.000Z";

/** An AI account of `owner` (a User, or an Organization by its Admin `actor`). */
const accountOf = Effect.fn(function* (
  setup: Hub,
  actor: UserId,
  name: string,
  owner?: { readonly kind: "organization"; readonly spaceId: SpaceId },
) {
  const made = yield* setup.accounts
    .create({
      name,
      provider: "claude" as never,
      apiKey: Redacted.make(`sk-lent-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      ...(owner === undefined ? {} : { owner }),
    })
    .pipe(CommandActor.actAs(actor));
  return made.id;
});

/** An active Grant written as the service would leave it (for lenders the testkit cannot act as). */
const activeGrant = Effect.fn(function* (
  setup: Hub,
  input: {
    readonly id: string;
    readonly accountId: AiAccountId;
    readonly lender: { readonly kind: "user" | "organization"; readonly id: string };
    readonly spaceId: SpaceId;
  },
) {
  yield* setup.server.sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
      target_kind, target_id, state, limits_json, created_at, created_by, decided_at, decided_by)
    VALUES (${input.id}, 'ai-account', ${input.accountId}, ${input.lender.kind},
      ${input.lender.id}, 'space', ${input.spaceId}, 'active', ${JSON.stringify(NO_CAP)}, ${AT},
      NULL, ${AT}, NULL)
  `;
});

const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);

it.live.skipIf(!posix || platform === undefined)(
  "a lent AI account serves the Space only while its Grant is active, after the Space's own",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const grants = Context.get(setup.server.services, Grants.Grants);
      const allowed = Context.get(setup.context, AllowedAiAccounts.AllowedAiAccounts);
      const { admin: ada, member: grace } = setup.people;
      const graces = yield* accountOf(setup, grace, "Grace Claude");
      const usable = (userId: UserId, spaceId: SpaceId) =>
        allowed
          .for(userId, spaceId)
          .pipe(Effect.map((list) => list.map((account) => [account.id, account.via.kind])));

      // Waiting: nothing in Acme yet, by any key.
      const given = yield* grants
        .give(
          {
            resource: { kind: "ai-account", aiAccountId: graces },
            spaceId: setup.acmeId,
            limits: NO_CAP,
          },
          { strongFactor: false },
        )
        .pipe(CommandActor.actAs(grace));
      assert.equal(given.state, "pending");
      assert.deepEqual(yield* usable(ada, setup.acmeId), []);
      const pinned = yield* setup.thread(ada, setup.acmeId, graces);
      assert.equal((yield* call(setup, path, { key: pinned.key, body: messages() })).status, 403);

      // Active: Ada's Thread in Acme uses it; Grace's own Personal space still has it as own.
      const accepted = yield* grants
        .accept({ grantId: given.id }, { strongFactor: false })
        .pipe(CommandActor.actAs(ada));
      assert.equal(accepted.state, "active");
      assert.deepEqual(yield* usable(ada, setup.acmeId), [[graces, "grant"]]);
      assert.deepEqual(yield* usable(grace, personalOf(grace)), [[graces, "own"]]);
      const lent = (yield* allowed.for(ada, setup.acmeId))[0]!;
      assert.deepEqual(lent.via.kind === "grant" && lent.via.lenderName, "grace");
      const used = yield* call(setup, path, { key: pinned.key, body: messages() });
      assert.equal(used.status, 200, used.text);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${graces}/claude-sonnet-5-5`);
      // Not in Globex, where it was not lent.
      assert.deepEqual(yield* usable(setup.people.globexMember, setup.globexId), []);

      // Ended: the very next request of that Thread is refused, and nothing reaches upstream.
      yield* grants.end({ grantId: given.id }).pipe(CommandActor.actAs(grace));
      const before = setup.upstream().length;
      const refused = yield* call(setup, path, { key: pinned.key, body: messages() });
      assert.equal(refused.status, 403);
      assert.equal(setup.upstream().length, before);
      assert.deepEqual(yield* usable(ada, setup.acmeId), []);

      // Rejected: nothing either.
      const again = yield* grants
        .give(
          {
            resource: { kind: "ai-account", aiAccountId: graces },
            spaceId: setup.acmeId,
            limits: NO_CAP,
          },
          { strongFactor: false },
        )
        .pipe(CommandActor.actAs(grace));
      yield* grants.reject({ grantId: again.id }).pipe(CommandActor.actAs(ada));
      assert.deepEqual(yield* usable(ada, setup.acmeId), []);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a disabled lender or an archived lending Organization lends nothing while it lasts",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const allowed = Context.get(setup.context, AllowedAiAccounts.AllowedAiAccounts);
      const { admin: ada, member: grace, globexMember: gus } = setup.people;
      const ids = (userId: UserId, spaceId: SpaceId) =>
        allowed.for(userId, spaceId).pipe(Effect.map((list) => list.map((account) => account.id)));

      // Grace's lent to Acme; Acme's lent to Gus's Personal space.
      const graces = yield* accountOf(setup, grace, "Grace Claude");
      const acmes = yield* accountOf(setup, ada, "Acme Claude", {
        kind: "organization",
        spaceId: setup.acmeId,
      });
      yield* activeGrant(setup, {
        id: "grant-grace",
        accountId: graces,
        lender: { kind: "user", id: grace },
        spaceId: setup.acmeId,
      });
      yield* activeGrant(setup, {
        id: "grant-acme",
        accountId: acmes,
        lender: { kind: "organization", id: setup.acmeId },
        spaceId: personalOf(gus),
      });
      assert.include(yield* ids(ada, setup.acmeId), graces);
      assert.deepEqual(yield* ids(gus, personalOf(gus)), [acmes]);
      const gusThread = yield* setup.thread(gus, personalOf(gus), acmes);
      assert.equal(
        (yield* call(setup, path, { key: gusThread.key, body: messages() })).status,
        200,
      );

      // Grace disabled: her loan stops serving Acme (and comes back if she is turned on again).
      yield* setup.server.sql`UPDATE users SET disabled_at = ${AT} WHERE user_id = ${grace}`;
      assert.notInclude(yield* ids(ada, setup.acmeId), graces);
      yield* setup.server.sql`UPDATE users SET disabled_at = NULL WHERE user_id = ${grace}`;
      assert.include(yield* ids(ada, setup.acmeId), graces);

      // Acme archived: what it lent stops serving Gus, and his next request is refused.
      yield* setup.server
        .sql`UPDATE spaces SET archived_at = ${AT} WHERE space_id = ${setup.acmeId}`;
      assert.deepEqual(yield* ids(gus, personalOf(gus)), []);
      const before = setup.upstream().length;
      assert.equal(
        (yield* call(setup, path, { key: gusThread.key, body: messages() })).status,
        403,
      );
      assert.equal(setup.upstream().length, before);

      // An account that changed owner after it was lent: the old Grant gives nothing.
      yield* setup.server
        .sql`UPDATE spaces SET archived_at = NULL WHERE space_id = ${setup.acmeId}`;
      yield* setup.server.sql`
        UPDATE ai_accounts SET owner_kind = 'user', owner_id = ${ada} WHERE account_id = ${acmes}
      `;
      assert.deepEqual(yield* ids(gus, personalOf(gus)), []);
    }).pipe(Effect.scoped),
);
