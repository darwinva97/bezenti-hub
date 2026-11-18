/**
 * Grants ticket 03: a lent AI account's caps, checked by the gateway before each request goes to
 * it: UTC calendar periods; used = daily summary + what the usage log has not written yet, so only
 * requests already in flight can pass a cap. docs/internals/ai-gateway.md, «Caps».
 */
import type { AiAccountGrantLimits, GrantCapPeriod } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AiGatewayActivity from "./AiGatewayActivity.ts";

const DAY_MS = 86_400_000;

/** How much of one cap is used in its current period, and when that period ends. */
export interface CapUse {
  readonly used: number;
  readonly amount: number;
  readonly period: GrantCapPeriod;
  /** The next period's start, ISO (UTC midnight). */
  readonly resetsAt: string;
}

export interface GrantCapState {
  readonly tokens: CapUse | null;
  readonly requests: CapUse | null;
  /** The first cap reached (tokens before requests); null while both have room. */
  readonly exhausted: (CapUse & { readonly which: "tokens" | "requests" }) | null;
}

export class GrantCapsError extends Schema.TaggedError<GrantCapsError>()("GrantCapsError", {
  message: Schema.String,
}) {}

export class GrantCaps extends Context.Service<
  GrantCaps,
  {
    /** Where a Grant stands against its caps now; no cap: nothing used, nothing reached. */
    readonly check: (
      grantId: string,
      limits: AiAccountGrantLimits,
    ) => Effect.Effect<GrantCapState, GrantCapsError>;
  }
>()("t3/ai/GrantCaps") {}

const dayString = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);

/** The UTC calendar period holding `now`: its first day and the next period's start. */
export const periodOf = (
  period: GrantCapPeriod,
  now: number,
): { readonly fromDay: string; readonly resetsAt: string } => {
  const today = Math.floor(now / DAY_MS);
  if (period === "day") {
    return { fromDay: dayString(today * DAY_MS), resetsAt: isoOf((today + 1) * DAY_MS) };
  }
  if (period === "week") {
    // 1970-01-01 was a Thursday: (day + 3) % 7 counts days since Monday.
    const monday = today - ((today + 3) % 7);
    return { fromDay: dayString(monday * DAY_MS), resetsAt: isoOf((monday + 7) * DAY_MS) };
  }
  const [year, month] = dayString(today * DAY_MS)
    .split("-")
    .map(Number) as [number, number];
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return {
    fromDay: `${year}-${String(month).padStart(2, "0")}-01`,
    resetsAt: `${next}T00:00:00.000Z`,
  };
};

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const PERIOD_WORDS: Record<GrantCapPeriod, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

/**
 * The 429 a client gets when no allowed account is left because a Grant's cap was reached: the
 * account, the Space it is lent to, the cap and its reset. Never anyone's usage.
 */
export const capReachedMessage = (input: {
  readonly accountName: string;
  readonly spaceName: string;
  readonly reached: CapUse & { readonly which: "tokens" | "requests" };
}) =>
  `The AI account ${input.accountName} lent to ${input.spaceName} reached its ${PERIOD_WORDS[input.reached.period]} ${input.reached.which === "tokens" ? "token" : "request"} cap; it resets ${input.reached.resetsAt.slice(0, 10)} 00:00 UTC. Switch AI account.`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activity = yield* AiGatewayActivity.AiGatewayActivity;

  const check = Effect.fn("GrantCaps.check")(function* (
    grantId: string,
    limits: AiAccountGrantLimits,
  ) {
    if (limits.tokens === null && limits.requests === null) {
      return { tokens: null, requests: null, exhausted: null } satisfies GrantCapState;
    }
    const now = yield* Clock.currentTimeMillis;
    const caps = [
      ["tokens", limits.tokens],
      ["requests", limits.requests],
    ] as const;
    const periods = caps.flatMap(([which, cap]) =>
      cap === null ? [] : [{ which, cap, ...periodOf(cap.period, now) }],
    );
    const since = periods.map((entry) => entry.fromDay).toSorted()[0]!;
    // Input not read from the cache (grants ticket 14); a row from before migration 147, whose
    // part read from the cache nobody kept, counts all its input: never less than was used.
    const written = yield* sql<{
      readonly day: string;
      readonly tokens: number;
      readonly requests: number;
    }>`
      SELECT day,
        COALESCE(SUM(COALESCE(uncached_input_tokens, input_tokens) + output_tokens
          + cache_write_tokens), 0) AS tokens,
        COALESCE(SUM(requests), 0) AS requests
      FROM ai_usage_daily WHERE grant_id = ${grantId} AND day >= ${since}
      GROUP BY day
    `.pipe(
      Effect.catch((cause) =>
        Effect.logError("GrantCaps: could not read a loan's use", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new GrantCapsError({ message: "Could not check the loan's cap." })),
          ),
        ),
      ),
    );
    const days = [...written, ...(yield* activity.unwritten(grantId))];
    const useOf = (entry: (typeof periods)[number]): CapUse => ({
      used: days
        .filter((day) => day.day >= entry.fromDay)
        .reduce((sum, day) => sum + (entry.which === "tokens" ? day.tokens : day.requests), 0),
      amount: entry.cap.amount,
      period: entry.cap.period,
      resetsAt: entry.resetsAt,
    });
    const state: Record<"tokens" | "requests", CapUse | null> = { tokens: null, requests: null };
    for (const entry of periods) state[entry.which] = useOf(entry);
    const reached = (["tokens", "requests"] as const).find((which) => {
      const use = state[which];
      return use !== null && use.used >= use.amount;
    });
    return {
      tokens: state.tokens,
      requests: state.requests,
      exhausted: reached === undefined ? null : { ...state[reached]!, which: reached },
    } satisfies GrantCapState;
  });

  return GrantCaps.of({ check });
});

export const layer = Layer.effect(GrantCaps, make);
