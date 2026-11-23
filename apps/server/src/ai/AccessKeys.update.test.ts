// @effect-diagnostics globalJsonInEffect:off - reads the audit's JSON detail.
/**
 * Access-keys ticket 06: renew, extend and change an access key (caps, models, accounts, label)
 * with the same key, from the next request; on a real port over the fake CLIProxyAPI.
 */
import { assert, it } from "@effect/vitest";
import { ACCESS_KEY_NO_LIMITS, type AccessKeyLimits, type AiAccountId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  call,
  type Hub,
  hub,
  messages,
  platform,
  posix,
  upstreamModels,
} from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const WEEK = { days: 7 } as const;
const DAY_MS = 86_400_000;

const acmeClaude = (setup: Hub, name: string) =>
  setup.accounts
    .create({
      name,
      provider: "claude",
      apiKey: Redacted.make(`sk-${name.replaceAll(" ", "-").toLowerCase()}-0123456789abcdef`),
      owner: { kind: "organization", spaceId: setup.acmeId },
    })
    .pipe(
      CommandActor.actAs(setup.people.admin),
      Effect.map((made) => made.id),
    );

const keyWith = (
  setup: Hub,
  extra: { readonly limits?: Partial<AccessKeyLimits>; readonly models?: ReadonlyArray<string> },
) =>
  setup.accessKeys
    .createForSession({
      spaceId: setup.acmeId,
      label: "Partner",
      validity: WEEK,
      models: extra.models ?? ["*"],
      limits: { ...ACCESS_KEY_NO_LIMITS, day: 1000, ...extra.limits },
    })
    .pipe(CommandActor.actAs(setup.people.admin));

const asAda = (setup: Hub) => CommandActor.actAs(setup.people.admin);

const updates = (setup: Hub) =>
  setup.server.sql<{ readonly detail: string }>`
    SELECT detail_json AS detail FROM audit_log WHERE action = 'access_key.update' ORDER BY rowid
  `.pipe(
    Effect.map((rows) => rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>)),
  );

it.live.skipIf(!posix || platform === undefined)(
  "renewing an expired key makes the same key work again, audited as a renewal",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeClaude(setup, "Acme Claude");
      const made = yield* keyWith(setup, {});
      const key = Redacted.value(made.key);
      yield* setup.server.sql`
        UPDATE ai_access_keys SET expires_at = '2026-01-02T03:04:05.000Z'
        WHERE key_id = ${made.created.keyId}
      `;
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 403);
      const renewed = yield* setup.accessKeys
        .updateForSession({ keyId: made.created.keyId, validity: { days: 3 } })
        .pipe(asAda(setup));
      const now = yield* Clock.currentTimeMillis;
      assert.approximately(Date.parse(renewed.expiresAt) - now, 3 * DAY_MS, 60_000);
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 200);
      const [detail] = yield* updates(setup);
      assert.deepEqual(
        [detail?.changed, detail?.via, detail?.expiresAt, detail?.limits],
        ["expiresAt", "renew", renewed.expiresAt, "total=-,day=1000,week=-,month=-"],
      );
      // At most 366 days from the change; nothing else changes the key.
      const far = yield* setup.accessKeys
        .updateForSession({ keyId: made.created.keyId, validity: { days: 367 } })
        .pipe(asAda(setup), Effect.flip);
      assert.equal(far.reason, "invalid");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "lowering the daily cap below what is used refuses the next request; raising the total brings the service back",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeClaude(setup, "Acme Claude");
      const made = yield* keyWith(setup, { limits: { total: 1000 } });
      const key = Redacted.value(made.key);
      const ask = () => call(setup, MESSAGES, { key, body: messages() });
      const change = (limits: Partial<AccessKeyLimits>) =>
        setup.accessKeys
          .updateForSession({
            keyId: made.created.keyId,
            limits: { ...ACCESS_KEY_NO_LIMITS, ...limits },
          })
          .pipe(asAda(setup));
      for (let index = 1; index <= 2; index += 1) {
        assert.equal((yield* ask()).status, 200);
        yield* setup.settled(index);
      }
      // 36 used today: a daily cap of 20 refuses the next one.
      yield* change({ total: 1000, day: 20 });
      assert.equal((yield* ask()).status, 429);
      // A total of 30 is spent; raised to 1000 it serves again (the used total stays).
      const spent = yield* change({ total: 30, day: 1000 });
      assert.equal(spent.usage?.total, 36);
      assert.equal((yield* ask()).status, 403);
      yield* change({ total: 1000, day: 1000 });
      assert.equal((yield* ask()).status, 200);
      const details = yield* updates(setup);
      assert.deepEqual(
        details.map((detail) => [detail.changed, detail.via ?? null]),
        [
          ["limits", null],
          ["limits", null],
          ["limits", null],
        ],
      );
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a model removed is refused from the next request; accounts and label change with the same key",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const a: AiAccountId = yield* acmeClaude(setup, "Acme Claude A");
      const b: AiAccountId = yield* acmeClaude(setup, "Acme Claude B");
      const made = yield* keyWith(setup, { models: ["claude-sonnet-*"] });
      const key = Redacted.value(made.key);
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${a}/claude-sonnet-5-5`);
      yield* setup.accessKeys
        .updateForSession({ keyId: made.created.keyId, models: ["gpt-*"] })
        .pipe(asAda(setup));
      const refused = yield* call(setup, MESSAGES, { key, body: messages() });
      assert.equal(refused.status, 403);
      assert.include(refused.text, "This access key may not use claude-sonnet-5-5.");
      const changed = yield* setup.accessKeys
        .updateForSession({
          keyId: made.created.keyId,
          models: ["*"],
          accounts: [b],
          label: "Partner (B only)",
        })
        .pipe(asAda(setup));
      assert.deepEqual(
        [changed.label, changed.models, changed.accounts],
        ["Partner (B only)", ["*"], [b]],
      );
      assert.equal((yield* call(setup, MESSAGES, { key, body: messages() })).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${b}/claude-sonnet-5-5`);
      const details = yield* updates(setup);
      assert.deepEqual(
        details.map((detail) => detail.changed),
        ["models", "label,models,accounts"],
      );
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "only a Space's managers change its keys, never a revoked one nor in an archived Space; no change writes nothing",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { member, globexMember, admin } = setup.people;
      yield* acmeClaude(setup, "Acme Claude");
      const made = yield* keyWith(setup, {});
      const keyId = made.created.keyId;
      const renew = { keyId, validity: { days: 3 } } as const;
      for (const outsider of [member, globexMember]) {
        const refused = yield* setup.accessKeys
          .updateForSession(renew)
          .pipe(CommandActor.actAs(outsider), Effect.flip);
        assert.equal(refused.reason, "not-found");
      }
      const agent = yield* setup.accessKeys
        .updateForSession(renew)
        .pipe(
          CommandActor.actAsResolved({ _tag: "User", userId: admin, via: "agent" }),
          Effect.flip,
        );
      assert.equal(agent.reason, "forbidden");
      // The Owner sees and revokes a Personal space's key, but changes nothing there.
      const graces = yield* setup.accessKeys
        .createForSession({
          spaceId: `personal:${member}` as Hub["acmeId"],
          label: "Friend",
          validity: WEEK,
          models: ["*"],
          unlimited: true,
        })
        .pipe(CommandActor.actAs(member));
      const ownerThere = yield* setup.accessKeys
        .updateForSession({ keyId: graces.created.keyId, validity: { days: 3 } })
        .pipe(setup.asOwner, Effect.flip);
      assert.equal(ownerThere.reason, "forbidden");

      // The same values: answered as it is, nothing written or audited.
      const same = yield* setup.accessKeys
        .updateForSession({ keyId, label: "Partner", models: ["*"] })
        .pipe(asAda(setup));
      assert.equal(same.label, "Partner");
      assert.lengthOf(yield* updates(setup), 0);

      // Archived: revoking stays possible, changing does not.
      const archived = yield* setup.server.request(`/api/spaces/${setup.acmeId}/archive`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.equal(archived.status, 200);
      const inArchive = yield* setup.accessKeys
        .updateForSession(renew)
        .pipe(asAda(setup), Effect.flip);
      assert.equal(inArchive.reason, "forbidden");
      yield* setup.server.request(`/api/spaces/${setup.acmeId}/restore`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      // Revoked: never renewed.
      yield* setup.accessKeys.revokeForSession({ keyId }).pipe(asAda(setup));
      const revoked = yield* setup.accessKeys
        .updateForSession(renew)
        .pipe(asAda(setup), Effect.flip);
      assert.equal(revoked.reason, "invalid");
      assert.lengthOf(yield* updates(setup), 0);
    }).pipe(Effect.scoped),
);
