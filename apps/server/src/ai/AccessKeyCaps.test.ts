// @effect-diagnostics globalDate:off - fixed instants for the test clock.
/**
 * Access-keys ticket 05: an access key's token caps over its whole life and UTC calendar periods,
 * counting input not read from the cache, output, cache writes and estimates, from the daily
 * summary plus what the usage log has not written yet.
 */
import { assert, describe, it } from "@effect/vitest";
import { ACCESS_KEY_NO_LIMITS, SpaceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as AccessKeyCaps from "./AccessKeyCaps.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";

const at = (iso: string) => Date.parse(iso);

const layer = AccessKeyCaps.layer.pipe(
  Layer.provideMerge(AiGatewayActivity.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const request = (
  keyId: string,
  atIso: string,
  usage: AiGatewayActivity.GatewayRequestRecord["usage"],
  extra: Partial<AiGatewayActivity.GatewayRequestRecord> = {},
): AiGatewayActivity.GatewayRequestRecord => ({
  at: atIso,
  keyId,
  keyKind: "access",
  userId: null,
  accessKeyId: keyId,
  spaceId: SpaceId.make("org-acme"),
  threadId: null,
  shape: "anthropic",
  route: "/api/ai/anthropic/v1/messages",
  accountId: "acct" as never,
  provider: "claude",
  model: "claude-sonnet-5-5",
  status: 200,
  durationMs: 1,
  failovers: 0,
  usage,
  ...extra,
});

const caps = (limits: Partial<typeof ACCESS_KEY_NO_LIMITS>) => ({
  ...ACCESS_KEY_NO_LIMITS,
  ...limits,
});

/** Written days of `ak_1` (and one of another key's, never counted). */
const writeDays = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, access_key_id,
      requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      uncached_input_tokens, estimated_tokens)
    VALUES ('2026-11-18', '', 'org-acme', 'acct', 'm', 'ak_1', 2, 100, 40, 99999, 10, 100, 0),
      ('2026-11-16', '', 'org-acme', 'acct', 'm', 'ak_1', 1, 1000, 0, 0, 0, 1000, 0),
      ('2026-11-02', '', 'org-acme', 'acct', 'm', 'ak_1', 1, 0, 0, 0, 0, 0, 10000),
      ('2026-10-31', '', 'org-acme', 'acct', 'm', 'ak_1', 1, 100000, 0, 0, 0, NULL, 0),
      ('2026-11-18', '', 'org-acme', 'acct', 'm', 'ak_2', 1, 7777, 7777, 0, 0, 7777, 0)
  `;
});

describe("AccessKeyCaps", () => {
  it.effect(
    "counts a day, an ISO week and a month in UTC, and the total since it was made; cache reads never",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* writeDays;
        const keyCaps = yield* AccessKeyCaps.AccessKeyCaps;
        // Wednesday 2026-11-18.
        yield* TestClock.setTime(at("2026-11-18T10:00:00.000Z"));
        const usage = (yield* keyCaps.check("ak_1", ACCESS_KEY_NO_LIMITS)).usage;
        assert.deepEqual(
          [usage.day, usage.week, usage.month, usage.total],
          [150, 1150, 11150, 111150],
        );
        assert.equal(usage.cacheReadTokens, 99999);
        assert.deepEqual(usage.resets, {
          day: "2026-11-19T00:00:00.000Z",
          week: "2026-11-23T00:00:00.000Z",
          month: "2026-12-01T00:00:00.000Z",
        });
        assert.isNull((yield* keyCaps.check("ak_1", caps({ day: 151 }))).exhausted);
        assert.deepEqual((yield* keyCaps.check("ak_1", caps({ day: 150 }))).exhausted, {
          which: "day",
          amount: 150,
          used: 150,
          resetsAt: "2026-11-19T00:00:00.000Z",
        });
        assert.equal(
          (yield* keyCaps.check("ak_1", caps({ week: 1000 }))).exhausted?.resetsAt,
          "2026-11-23T00:00:00.000Z",
        );
        assert.equal(
          (yield* keyCaps.check("ak_1", caps({ month: 11150 }))).exhausted?.resetsAt,
          "2026-12-01T00:00:00.000Z",
        );
        // Several reached: the total first, then the month, the week and the day.
        assert.deepEqual(
          (yield* keyCaps.check("ak_1", caps({ total: 100, day: 100, week: 100 }))).exhausted,
          { which: "total", amount: 100, used: 111150, resetsAt: null },
        );
        assert.equal(
          (yield* keyCaps.check("ak_1", caps({ day: 100, week: 100, month: 100 }))).exhausted
            ?.which,
          "month",
        );

        // A new UTC day, week and month each start from nothing; the total never does.
        yield* TestClock.setTime(at("2026-11-19T00:00:00.000Z"));
        assert.isNull((yield* keyCaps.check("ak_1", caps({ day: 150 }))).exhausted);
        assert.equal((yield* keyCaps.check("ak_1", caps({ week: 1000 }))).exhausted?.which, "week");
        yield* TestClock.setTime(at("2026-11-23T00:00:00.000Z"));
        assert.isNull((yield* keyCaps.check("ak_1", caps({ week: 1000 }))).exhausted);
        assert.equal(
          (yield* keyCaps.check("ak_1", caps({ month: 11150 }))).exhausted?.which,
          "month",
        );
        yield* TestClock.setTime(at("2026-12-01T00:00:00.000Z"));
        const december = yield* keyCaps.check("ak_1", caps({ month: 11150, total: 111150 }));
        assert.deepEqual([december.usage.month, december.exhausted?.which], [0, "total"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "counts what the usage log has not written yet, and an estimate for an answer with no usage",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const keyCaps = yield* AccessKeyCaps.AccessKeyCaps;
        const activity = yield* AiGatewayActivity.AiGatewayActivity;
        yield* TestClock.setTime(at("2026-11-18T10:00:00.000Z"));
        const whole = request("ak_1", "2026-11-18T09:00:00.000Z", {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
        });
        const cut = request("ak_1", "2026-11-18T09:01:00.000Z", null, { estimatedTokens: 40 });
        // Another key's, a shed one and a count of tokens: none counts.
        const others = [
          request("ak_2", "2026-11-18T09:02:00.000Z", null, { estimatedTokens: 999 }),
          request("ak_1", "2026-11-18T09:03:00.000Z", null, { status: 429, shed: true }),
          request("ak_1", "2026-11-18T09:04:00.000Z", null, {
            route: "/api/ai/anthropic/v1/messages/count_tokens",
          }),
        ];
        for (const record of [whole, cut, ...others]) yield* activity.record(record);
        const state = yield* keyCaps.check("ak_1", caps({ day: 55 }));
        assert.deepEqual([state.usage.day, state.usage.total, state.usage.requests], [55, 55, 2]);
        assert.equal(state.exhausted?.which, "day");
        // Written (or lost): taken back out, so it is never counted twice.
        yield* activity.settle([whole, cut, ...others]);
        assert.equal((yield* keyCaps.check("ak_1", ACCESS_KEY_NO_LIMITS)).usage.total, 0);
      }).pipe(Effect.provide(layer)),
  );

  it("says the cap and its reset in UTC, and that the total does not come back by itself", () => {
    assert.equal(
      AccessKeyCaps.capReachedMessage({
        which: "day",
        amount: 2_000_000,
        used: 2_000_400,
        resetsAt: "2026-11-24T00:00:00.000Z",
      }),
      "This access key reached its daily token limit (2,000,000); it resets 2026-11-24 00:00 UTC.",
    );
    assert.equal(
      AccessKeyCaps.capReachedMessage({
        which: "total",
        amount: 10_000_000,
        used: 10_000_001,
        resetsAt: null,
      }),
      "This access key used its total token limit (10,000,000). Ask whoever gave it to you to raise it.",
    );
  });
});
