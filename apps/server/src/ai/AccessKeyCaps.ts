/**
 * What an access key used, as its caps count it (access-keys tickets 04 and 05): its daily rows
 * (`ai_usage_daily.access_key_id`) plus what the usage log has not written yet, so a cap never
 * counts less than was used. UTC calendar periods, as a Grant's. docs: ai-gateway.md.
 */
import type { AccessKeyLimits, AccessKeyUsage } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import { periodOf } from "./GrantCaps.ts";

export class AccessKeyCapsError extends Schema.TaggedError<AccessKeyCapsError>()(
  "AccessKeyCapsError",
  { message: Schema.String },
) {}

/** Which cap: the whole life of the key, or a UTC calendar period. */
export type AccessKeyCapKind = "total" | "month" | "week" | "day";

/** A cap reached: how much, how much was used, and when it resets (null: never, the total). */
export interface AccessKeyCapReached {
  readonly which: AccessKeyCapKind;
  readonly amount: number;
  readonly used: number;
  readonly resetsAt: string | null;
}

export interface AccessKeyCapState {
  readonly usage: AccessKeyUsage;
  /** The first cap reached in the spec's order (total, month, week, day); null: room in all. */
  readonly exhausted: AccessKeyCapReached | null;
}

export class AccessKeyCaps extends Context.Service<
  AccessKeyCaps,
  {
    /** Each key's use now; a key with no use has zeros. */
    readonly usageOf: (
      keyIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, AccessKeyUsage>, AccessKeyCapsError>;
    /** Where a key stands against its caps now (access-keys ticket 05). */
    readonly check: (
      keyId: string,
      limits: AccessKeyLimits,
    ) => Effect.Effect<AccessKeyCapState, AccessKeyCapsError>;
  }
>()("t3/ai/AccessKeyCaps") {}

const PERIOD_WORDS = { day: "daily", week: "weekly", month: "monthly" } as const;

/**
 * What a client is told when a cap is reached, in UTC; never anyone else's use. The total does
 * not come back by itself; a period resets.
 */
export const capReachedMessage = (reached: AccessKeyCapReached) =>
  reached.which === "total" || reached.resetsAt === null
    ? `This access key used its total token limit (${reached.amount.toLocaleString("en-US")}). Ask whoever gave it to you to raise it.`
    : `This access key reached its ${PERIOD_WORDS[reached.which]} token limit (${reached.amount.toLocaleString("en-US")}); it resets ${reached.resetsAt.slice(0, 10)} 00:00 UTC.`;

/**
 * The tokens caps count of a daily row: input not read from the cache (all its input for a row
 * from before migration 147), output, cache writes and the estimate of answers with no usage.
 */
const COUNTED = `COALESCE(uncached_input_tokens, input_tokens) + output_tokens + cache_write_tokens
  + estimated_tokens`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activity = yield* AiGatewayActivity.AiGatewayActivity;

  const usageOf = Effect.fn("AccessKeyCaps.usageOf")(function* (keyIds: ReadonlyArray<string>) {
    const answer = new Map<string, AccessKeyUsage>();
    const ids = [...new Set(keyIds)];
    if (ids.length === 0) return answer as ReadonlyMap<string, AccessKeyUsage>;
    const now = yield* Clock.currentTimeMillis;
    const day = periodOf("day", now);
    const week = periodOf("week", now);
    const month = periodOf("month", now);
    const counted = sql.literal(COUNTED);
    const rows = yield* sql<{
      readonly keyId: string;
      readonly day: number;
      readonly week: number;
      readonly month: number;
      readonly total: number;
      readonly requests: number;
      readonly cacheRead: number;
      readonly unknown: number;
      readonly estimated: number;
    }>`
      SELECT access_key_id AS "keyId",
        COALESCE(SUM(CASE WHEN day >= ${day.fromDay} THEN ${counted} END), 0) AS "day",
        COALESCE(SUM(CASE WHEN day >= ${week.fromDay} THEN ${counted} END), 0) AS "week",
        COALESCE(SUM(CASE WHEN day >= ${month.fromDay} THEN ${counted} END), 0) AS "month",
        COALESCE(SUM(${counted}), 0) AS "total",
        COALESCE(SUM(requests), 0) AS "requests",
        COALESCE(SUM(cache_read_tokens), 0) AS "cacheRead",
        COALESCE(SUM(unknown_requests), 0) AS "unknown",
        COALESCE(SUM(estimated_tokens), 0) AS "estimated"
      FROM ai_usage_daily WHERE ${sql.in("access_key_id", ids)}
      GROUP BY access_key_id
    `.pipe(
      Effect.catch((cause) =>
        Effect.logError("AccessKeyCaps: could not read an access key's use", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new AccessKeyCapsError({ message: "Could not read the key's use." })),
          ),
        ),
      ),
    );
    const written = new Map(rows.map((row) => [row.keyId, row]));
    for (const keyId of ids) {
      const row = written.get(keyId);
      let [inDay, inWeek, inMonth, total, requests] = [
        row?.day ?? 0,
        row?.week ?? 0,
        row?.month ?? 0,
        row?.total ?? 0,
        row?.requests ?? 0,
      ];
      // Recorded and not written yet: counted at once, never twice (it leaves on commit).
      for (const entry of yield* activity.unwritten(AiGatewayActivity.accessKeySubject(keyId))) {
        total += entry.tokens;
        requests += entry.requests;
        if (entry.day >= month.fromDay) inMonth += entry.tokens;
        if (entry.day >= week.fromDay) inWeek += entry.tokens;
        if (entry.day >= day.fromDay) inDay += entry.tokens;
      }
      answer.set(keyId, {
        day: inDay,
        week: inWeek,
        month: inMonth,
        total,
        requests,
        cacheReadTokens: row?.cacheRead ?? 0,
        unknownRequests: row?.unknown ?? 0,
        estimatedTokens: row?.estimated ?? 0,
        resets: { day: day.resetsAt, week: week.resetsAt, month: month.resetsAt },
      });
    }
    return answer as ReadonlyMap<string, AccessKeyUsage>;
  });

  const check = Effect.fn("AccessKeyCaps.check")(function* (
    keyId: string,
    limits: AccessKeyLimits,
  ) {
    const usage = (yield* usageOf([keyId])).get(keyId)!;
    const order: ReadonlyArray<AccessKeyCapKind> = ["total", "month", "week", "day"];
    const reached = order.flatMap((which): ReadonlyArray<AccessKeyCapReached> => {
      const amount = limits[which];
      const used = usage[which];
      if (amount === null || used < amount) return [];
      return [{ which, amount, used, resetsAt: which === "total" ? null : usage.resets[which] }];
    })[0];
    return { usage, exhausted: reached ?? null } satisfies AccessKeyCapState;
  });

  return AccessKeyCaps.of({ usageOf, check });
});

export const layer = Layer.effect(AccessKeyCaps, make);
