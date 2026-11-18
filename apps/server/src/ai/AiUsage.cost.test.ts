// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off - a client on the real port over the fake CLIProxyAPI.
/**
 * Grants ticket 05: AI usage at the list price in force each day (only `api-key`, the cache priced
 * as cache whatever the shape), and a lent subscription's approximate share of its quota windows.
 */
import { assert, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiUsageSummaryInput,
  type ServerProviderUsageWindow,
  type SpaceId,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { lendAiAccount } from "../grants/Grants.testkit.ts";
import type { AiPrice } from "./aiPrices.ts";
import { acmeSetup, call, hubWith, messages, platform, posix } from "./AiGatewayRoute.testkit.ts";
import type { Hub } from "./AiGatewayRoute.testkit.ts";
import type * as AiUsage from "./AiUsage.ts";

const live = it.live.skipIf(!posix || platform === undefined);

const price = (overrides: Partial<AiPrice>): AiPrice => ({
  provider: "claude",
  model: "claude-sonnet-5-5*",
  validFrom: "2026-01-01",
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  source: "test",
  ...overrides,
});

/** Two versions of one model's price, the second from 2026-11-10; and one OpenAI model. */
const PRICES: ReadonlyArray<AiPrice> = [
  price({}),
  price({ validFrom: "2026-11-10", input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }),
  price({ provider: "codex", model: "gpt-test", input: 1, output: 2, cacheRead: 0.1 }),
];

let windows: ReadonlyArray<ServerProviderUsageWindow> | null = null;
const windowsFor = { accountId: "" };

const usageOptions = (extra: Partial<AiUsage.AiUsageOptions> = {}): AiUsage.AiUsageOptions => ({
  retentionDays: 90,
  sweepEveryMs: 86_400_000,
  prices: PRICES,
  subscriptionWindows: (accountId) =>
    Effect.succeed(accountId === windowsFor.accountId ? windows : null),
  ...extra,
});

const summaryAs = (setup: Hub, userId: UserId, input: AiUsageSummaryInput = {}) =>
  setup.usage.summary(input).pipe(CommandActor.actAs(userId));

const NOVEMBER = { fromDay: "2026-11-01", toDay: "2026-11-12" } as const;

/** One daily summary row as the writer leaves it. */
const daily = (
  setup: Hub,
  row: {
    readonly day: string;
    readonly userId: UserId;
    readonly spaceId: SpaceId;
    readonly accountId: string;
    readonly model: string;
    readonly input: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly uncached: number | null;
  },
) => setup.server.sql`
  INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, uncached_input_tokens)
  VALUES (${row.day}, ${row.userId}, ${row.spaceId}, ${row.accountId}, ${row.model}, '', 1,
    ${row.input}, ${row.output ?? 0}, ${row.cacheRead ?? 0}, 0, ${row.uncached})
`;

/** One per-request row as the writer leaves it. */
const request = (
  setup: Hub,
  row: {
    readonly id: string;
    readonly at: string;
    readonly userId: UserId;
    readonly spaceId: SpaceId;
    readonly accountId: string;
    readonly model?: string;
    readonly shape?: string;
    readonly threadId?: string;
    readonly grantId?: string | null;
    readonly input: number;
    readonly output?: number;
    readonly cacheRead?: number | null;
  },
) => setup.server.sql`
  INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
    model, shape, status, duration_ms, failovers, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, grant_id)
  VALUES (${row.id}, ${row.at}, ${row.at.slice(0, 10)}, ${row.userId}, ${row.spaceId},
    ${row.threadId ?? null}, 'key', ${row.accountId}, ${row.model ?? "m"},
    ${row.shape ?? "anthropic"}, 200, 5, 0, ${row.input}, ${row.output ?? 0},
    ${row.cacheRead ?? null}, NULL, ${row.grantId ?? null})
`;

live("values each day at the price in force that day; a new price leaves the day before", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: usageOptions() });
    const ids = yield* acmeSetup(setup);
    const grace = setup.people.member;
    for (const day of ["2026-11-09", "2026-11-10"]) {
      yield* daily(setup, {
        day,
        userId: grace,
        spaceId: setup.acmeId,
        accountId: ids.claudeA,
        model: "claude-sonnet-5-5",
        input: 1_000_000,
        uncached: 1_000_000,
      });
    }

    const view = yield* summaryAs(setup, setup.ownerId, NOVEMBER);
    assert.deepEqual(
      view.rows.map((row) => [row.day, row.estimatedUsd]),
      [
        ["2026-11-10", 6],
        ["2026-11-09", 3],
      ],
    );
    assert.equal(view.estimatedUsd, 9);
    assert.equal(view.unpricedTokens, 0);
    assert.match(view.pricesReviewedOn ?? "", /^\d{4}-\d{2}-\d{2}$/u);
  }).pipe(Effect.scoped),
);

live("only api-key use is priced: a subscription has none, an unknown model is unpriced", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: usageOptions() });
    const ids = yield* acmeSetup(setup);
    const grace = setup.people.member;
    // Acme Claude B as a subscription (signed in elsewhere; only its kind matters here).
    yield* setup.server.sql`
      UPDATE ai_accounts SET type = 'subscription' WHERE account_id = ${ids.claudeB}
    `;
    const base = { day: "2026-11-05", userId: grace, spaceId: setup.acmeId } as const;
    yield* daily(setup, {
      ...base,
      accountId: ids.claudeB,
      model: "claude-sonnet-5-5",
      input: 1000,
      uncached: 1000,
    });
    yield* daily(setup, {
      ...base,
      accountId: ids.claudeA,
      model: "claude-unknown-9",
      input: 400,
      output: 100,
      uncached: 400,
    });
    // From before the uncached input was kept: nothing says what part of it was cached.
    yield* daily(setup, {
      ...base,
      accountId: ids.claudeA,
      model: "claude-sonnet-5-5",
      input: 50,
      uncached: null,
    });

    const view = yield* summaryAs(setup, setup.ownerId, NOVEMBER);
    assert.deepEqual(
      view.rows.map((row) => row.estimatedUsd),
      [null, null, null],
    );
    assert.isNull(view.estimatedUsd);
    // The api-key tokens without a price; never the subscription's.
    assert.equal(view.unpricedTokens, 400 + 100 + 50);
  }).pipe(Effect.scoped),
);

live("a request through the gateway is priced without the cache its answer read", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: usageOptions() });
    yield* acmeSetup(setup);
    const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
    // The fake answers 11 input (the cache left out, Anthropic's way), 3 cache read, 7 output.
    const answer = yield* call(setup, "/api/ai/anthropic/v1/messages", {
      key,
      body: messages("claude-sonnet-5-5"),
    });
    assert.equal(answer.status, 200);
    yield* setup.settled(1);

    const today = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const view = yield* summaryAs(setup, setup.ownerId, { fromDay: today, toDay: today });
    // Today is after 2026-11-10: the second version.
    assert.closeTo(view.estimatedUsd ?? 0, (11 * 6 + 3 * 0.6 + 7 * 30) / 1_000_000, 1e-12);
  }).pipe(Effect.scoped),
);

live("a Thread's use is priced from each request's shape: OpenAI's input counts the cache in", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: usageOptions() });
    yield* acmeSetup(setup);
    const openai = yield* setup.account("Acme OpenAI", "codex", { spaceIds: [setup.acmeId] });
    const grace = setup.people.member;
    const base = {
      at: "2026-11-05T10:00:00.000Z",
      userId: grace,
      spaceId: setup.acmeId,
      accountId: openai,
      model: "gpt-test",
      threadId: "thread-1",
    } as const;
    yield* request(setup, { ...base, id: "o1", shape: "openai", input: 1000, cacheRead: 800 });
    yield* request(setup, { ...base, id: "o2", shape: "openai", input: 100, output: 50 });

    const view = yield* summaryAs(setup, grace, {
      ...NOVEMBER,
      threadId: ThreadId.make("thread-1"),
    });
    // 300 uncached at 1, 800 cached at 0.1, 50 output at 2.
    assert.closeTo(view.estimatedUsd ?? 0, (300 * 1 + 800 * 0.1 + 50 * 2) / 1_000_000, 1e-12);
    assert.closeTo(view.rows[0]?.estimatedUsd ?? 0, view.estimatedUsd ?? 0, 1e-12);
  }).pipe(Effect.scoped),
);

live("the estimate counts every row even when the rows are cut", () =>
  Effect.gen(function* () {
    const setup = yield* hubWith({}, { usage: usageOptions({ maxRows: 1 }) });
    const ids = yield* acmeSetup(setup);
    for (const day of ["2026-11-09", "2026-11-10"]) {
      yield* daily(setup, {
        day,
        userId: setup.people.member,
        spaceId: setup.acmeId,
        accountId: ids.claudeA,
        model: "claude-sonnet-5-5",
        input: 1_000_000,
        uncached: 1_000_000,
      });
    }

    const view = yield* summaryAs(setup, setup.ownerId, NOVEMBER);
    assert.isTrue(view.truncated);
    assert.equal(view.rows.length, 1);
    assert.equal(view.estimatedUsd, 9);
  }).pipe(Effect.scoped),
);

live(
  "a lent subscription shows each window's share that went through the loan; its percentage only to the lender",
  () =>
    Effect.gen(function* () {
      const setup = yield* hubWith({}, { usage: usageOptions() });
      yield* acmeSetup(setup);
      const { admin, guest, globexMember: gus } = setup.people;
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
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
      const HOUR = 3_600_000;
      windowsFor.accountId = gusAccount;
      windows = [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 50,
          resetsAt: iso(now + HOUR),
          windowDurationMins: 300,
        },
        // One model's window: its tokens would be that model's alone.
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Weekly · Opus",
          usedPercent: 90,
          resetsAt: iso(now + HOUR),
          windowDurationMins: 10_080,
        },
        // No length: no start to count tokens from.
        { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 10 },
      ];
      const lent = { accountId: gusAccount, grantId, spaceId: setup.acmeId };
      const inWindow = iso(now - HOUR);
      yield* request(setup, { ...lent, id: "r1", at: inWindow, userId: admin, input: 300 });
      yield* request(setup, { ...lent, id: "r2", at: inWindow, userId: guest, input: 100 });
      // Gus's own use of it, in his Personal space: in the account's tokens, not the loan's.
      yield* request(setup, {
        id: "r3",
        at: inWindow,
        userId: gus,
        spaceId: `personal:${gus}` as SpaceId,
        accountId: gusAccount,
        input: 600,
      });
      // OpenAI-shaped, the input holding the cache reads: only what was not read counts, the
      // caps' own rule (100 of the loan's, 900 of Gus's own).
      yield* request(setup, {
        ...lent,
        id: "r5",
        at: inWindow,
        userId: guest,
        shape: "openai",
        input: 1100,
        cacheRead: 1000,
      });
      yield* request(setup, {
        id: "r6",
        at: inWindow,
        userId: gus,
        spaceId: `personal:${gus}` as SpaceId,
        accountId: gusAccount,
        shape: "openai",
        input: 4500,
        cacheRead: 3600,
      });
      // Before the window began.
      yield* request(setup, {
        ...lent,
        id: "r4",
        at: iso(now - 6 * HOUR),
        userId: guest,
        input: 5000,
      });

      // An api-key loan has no quota.
      assert.isUndefined((yield* summaryAs(setup, gus, { grantId })).quotaShare);

      yield* setup.server.sql`
        UPDATE ai_accounts SET type = 'subscription' WHERE account_id = ${gusAccount}
      `;
      // (300 + 100 + 100) / 2000 of the session's 50 %.
      assert.deepEqual((yield* summaryAs(setup, gus, { grantId })).quotaShare, [
        {
          windowId: "five_hour",
          label: "Session",
          kind: "session",
          resetsAt: iso(now + HOUR),
          sharePercent: 12.5,
          of: "loan",
          usedPercent: 50,
        },
      ]);
      // Acme's Admin: the whole loan in Acme, not the account's percentage.
      const ada = (yield* summaryAs(setup, admin, { grantId })).quotaShare;
      assert.deepEqual(
        ada?.map((share) => [share.sharePercent, share.of, share.usedPercent]),
        [[12.5, "loan", undefined]],
      );
      // Linus, a Guest: his own part only, (100 + 100) / 2000.
      const linus = (yield* summaryAs(setup, guest, { grantId })).quotaShare;
      assert.deepEqual(
        linus?.map((share) => [share.sharePercent, share.of, share.usedPercent]),
        [[5, "own", undefined]],
      );
      // Not asked for one loan: no share.
      assert.isUndefined((yield* summaryAs(setup, gus)).quotaShare);
      // The provider says nothing: nothing is shown.
      windows = null;
      assert.isUndefined((yield* summaryAs(setup, gus, { grantId })).quotaShare);
    }).pipe(Effect.scoped),
);
