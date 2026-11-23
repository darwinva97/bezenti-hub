// @effect-diagnostics globalDate:off - fixed instants for the test clock.
/**
 * Grants ticket 03: a lent AI account's caps over UTC calendar periods, counting input, output and
 * cache-write tokens and every request, from the daily summary plus what the usage log has not
 * written yet.
 */
import { assert, describe, it } from "@effect/vitest";
import { SpaceId, ThreadId, UserId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as GrantCaps from "./GrantCaps.ts";

const at = (iso: string) => Date.parse(iso);

describe("periodOf", () => {
  it("starts a day at UTC midnight, a week on Monday and a month on the 1st", () => {
    // Wednesday 2026-11-18, late in the UTC day.
    const wednesday = at("2026-11-18T23:30:00.000Z");
    assert.deepEqual(GrantCaps.periodOf("day", wednesday), {
      fromDay: "2026-11-18",
      resetsAt: "2026-11-19T00:00:00.000Z",
    });
    assert.deepEqual(GrantCaps.periodOf("week", wednesday), {
      fromDay: "2026-11-16",
      resetsAt: "2026-11-23T00:00:00.000Z",
    });
    // A Sunday still belongs to the week that began the Monday before; a Monday begins one.
    assert.equal(GrantCaps.periodOf("week", at("2026-11-22T12:00:00.000Z")).fromDay, "2026-11-16");
    assert.equal(GrantCaps.periodOf("week", at("2026-11-23T00:00:00.000Z")).fromDay, "2026-11-23");
    assert.deepEqual(GrantCaps.periodOf("month", wednesday), {
      fromDay: "2026-11-01",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
    assert.deepEqual(GrantCaps.periodOf("month", at("2026-12-31T23:59:59.000Z")), {
      fromDay: "2026-12-01",
      resetsAt: "2027-01-01T00:00:00.000Z",
    });
  });
});

const layer = GrantCaps.layer.pipe(
  Layer.provideMerge(AiGatewayActivity.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const request = (
  grantId: string | null,
  atIso: string,
  usage: AiGatewayActivity.GatewayRequestRecord["usage"],
  extra: Partial<AiGatewayActivity.GatewayRequestRecord> = {},
): AiGatewayActivity.GatewayRequestRecord => ({
  at: atIso,
  keyId: "key",
  keyKind: "thread",
  userId: UserId.make("ana"),
  spaceId: SpaceId.make("org-acme"),
  threadId: ThreadId.make("thread"),
  shape: "anthropic",
  route: "/api/ai/anthropic/v1/messages",
  accountId: "acct" as never,
  provider: "claude",
  model: "claude-sonnet-5-5",
  status: 200,
  durationMs: 1,
  failovers: 0,
  usage,
  grantId,
  ...extra,
});

const TOKENS_A_DAY = (amount: number) =>
  ({ kind: "ai-account", tokens: { amount, period: "day" }, requests: null }) as const;

describe("GrantCaps.check", () => {
  it.effect(
    "counts written days of the period and what is still unwritten, never cache reads",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const caps = yield* GrantCaps.GrantCaps;
        const activity = yield* AiGatewayActivity.AiGatewayActivity;
        yield* TestClock.setTime(at("2026-11-18T10:00:00.000Z"));
        // Written: yesterday (another period) and today, with cache reads that never count.
        yield* sql`
        INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
        VALUES ('2026-11-17', 'ana', 'org-acme', 'acct', 'm', 'g1', 5, 900, 900, 0, 0),
          ('2026-11-18', 'ana', 'org-acme', 'acct', 'm', 'g1', 2, 10, 5, 50000, 3),
          ('2026-11-18', 'bob', 'org-acme', 'acct', 'm', 'g2', 9, 999, 999, 0, 0),
          ('2026-11-18', 'bob', 'org-acme', 'acct', 'm', '', 9, 999, 999, 0, 0)
      `;
        const first = yield* caps.check("g1", TOKENS_A_DAY(30));
        assert.equal(first.tokens?.used, 18);
        assert.isNull(first.exhausted);

        // Recorded and not yet written by the usage log: counted at once (no writer runs here).
        yield* activity.record(
          request("g1", "2026-11-18T10:00:00.000Z", {
            inputTokens: 8,
            outputTokens: 4,
            cacheReadTokens: 1000,
            cacheWriteTokens: 0,
          }),
        );
        const reached = yield* caps.check("g1", TOKENS_A_DAY(30));
        assert.equal(reached.tokens?.used, 30);
        assert.deepEqual(reached.exhausted, {
          which: "tokens",
          used: 30,
          amount: 30,
          period: "day",
          resetsAt: "2026-11-19T00:00:00.000Z",
        });
        // Once the log writes it, it is counted once (from the summary), not twice.
        yield* sql`
        UPDATE ai_usage_daily SET input_tokens = input_tokens + 8, output_tokens = output_tokens + 4,
          requests = requests + 1
        WHERE day = '2026-11-18' AND grant_id = 'g1'
      `;
        yield* activity.settle([
          request("g1", "2026-11-18T10:00:00.000Z", {
            inputTokens: 8,
            outputTokens: 4,
            cacheReadTokens: 1000,
            cacheWriteTokens: 0,
          }),
        ]);
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(30))).tokens?.used, 30);

        // The next day is a new period: allowed again.
        yield* TestClock.setTime(at("2026-11-19T00:00:00.000Z"));
        const tomorrow = yield* caps.check("g1", TOKENS_A_DAY(30));
        assert.equal(tomorrow.tokens?.used, 0);
        assert.isNull(tomorrow.exhausted);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "counts the input not read from the cache in every shape; a row from before it was kept counts all its input",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const caps = yield* GrantCaps.GrantCaps;
        const activity = yield* AiGatewayActivity.AiGatewayActivity;
        yield* TestClock.setTime(at("2026-11-18T10:00:00.000Z"));
        // Written: an OpenAI- or Gemini-shaped day whose 1000 input held 900 cache reads, and a day
        // from before migration 147 (uncached unknown): all of its input counts, never less.
        yield* sql`
        INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, uncached_input_tokens)
        VALUES ('2026-11-18', 'ana', 'org-acme', 'acct', 'gpt', 'g1', 1, 1000, 20, 900, 0, 100),
          ('2026-11-17', 'ana', 'org-acme', 'acct', 'gpt', 'g1', 1, 1000, 20, 900, 0, NULL)
      `;
        const week = {
          kind: "ai-account",
          tokens: { amount: 100_000, period: "week" },
          requests: null,
        } as const;
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(1000))).tokens?.used, 120);
        assert.equal((yield* caps.check("g1", week)).tokens?.used, 120 + 1020);

        // Not written yet: the same rule per shape. OpenAI's and Gemini's input holds the cache
        // reads (taken out); Anthropic's leaves them out already (all of it counts).
        const usage = {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
        };
        const openai = request("g1", "2026-11-18T10:00:00.000Z", usage, { shape: "openai" });
        const gemini = request("g1", "2026-11-18T10:00:01.000Z", usage, { shape: "gemini" });
        const anthropic = request("g1", "2026-11-18T10:00:02.000Z", {
          ...usage,
          cacheWriteTokens: 2,
        });
        yield* activity.record(openai);
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(1000))).tokens?.used, 120 + 15);
        yield* activity.record(gemini);
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(1000))).tokens?.used, 120 + 30);
        yield* activity.record(anthropic);
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(1000))).tokens?.used, 120 + 30 + 57);
        // Written (or lost): taken back out by the same rule, so nothing is left over.
        yield* activity.settle([openai, gemini, anthropic]);
        assert.deepEqual(yield* activity.unwritten(AiGatewayActivity.grantSubject("g1")), []);
        assert.equal((yield* caps.check("g1", TOKENS_A_DAY(1000))).tokens?.used, 120);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a request with unknown tokens counts 0 tokens and 1 request; shed ones nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const caps = yield* GrantCaps.GrantCaps;
      const activity = yield* AiGatewayActivity.AiGatewayActivity;
      yield* TestClock.setTime(at("2026-11-18T10:00:00.000Z"));
      const limits = {
        kind: "ai-account",
        tokens: { amount: 100, period: "week" },
        requests: { amount: 2, period: "day" },
      } as const;
      yield* activity.record(request("g1", "2026-11-18T09:00:00.000Z", null));
      yield* activity.record(
        request("g1", "2026-11-18T09:01:00.000Z", null, { status: 429, shed: true }),
      );
      yield* activity.record(
        request("g1", "2026-11-18T09:02:00.000Z", null, {
          route: "/api/ai/anthropic/v1/messages/count_tokens",
        }),
      );
      // Own use (no Grant) is never a loan's.
      yield* activity.record(request(null, "2026-11-18T09:03:00.000Z", null));
      const one = yield* caps.check("g1", limits);
      assert.deepEqual([one.tokens?.used, one.requests?.used, one.exhausted], [0, 1, null]);
      yield* activity.record(request("g1", "2026-11-18T09:04:00.000Z", null));
      const two = yield* caps.check("g1", limits);
      assert.equal(two.exhausted?.which, "requests");
      // No cap: nothing to check.
      const none = yield* caps.check("g1", { kind: "ai-account", tokens: null, requests: null });
      assert.deepEqual(none, { tokens: null, requests: null, exhausted: null });
    }).pipe(Effect.provide(layer)),
  );

  it("the cap's message names the account, the Space, the cap and its reset, nobody's use", () => {
    const text = GrantCaps.capReachedMessage({
      accountName: "Ana Claude",
      spaceName: "Acme",
      reached: {
        which: "tokens",
        used: 2034,
        amount: 2000,
        period: "week",
        resetsAt: "2026-11-23T00:00:00.000Z",
      },
    });
    assert.equal(
      text,
      "The AI account Ana Claude lent to Acme reached its weekly token cap; it resets 2026-11-23 00:00 UTC. Switch AI account.",
    );
    assert.notInclude(text, "2034");
  });
});
