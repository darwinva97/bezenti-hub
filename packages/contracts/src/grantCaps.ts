/**
 * A lent AI account's caps (Grants ticket 03): what a Grant may use per UTC calendar period, and
 * how much of it is used now. Apart from `grants.ts` so the AI account picker can show it.
 */
import * as Schema from "effect/Schema";

/** A cap's calendar period, in UTC: a day, an ISO week (from Monday) or a month. */
export const GrantCapPeriod = Schema.Literals(["day", "week", "month"]);
export type GrantCapPeriod = typeof GrantCapPeriod.Type;

export const GrantCap = Schema.Struct({
  amount: Schema.Int.check(Schema.isGreaterThan(0)),
  period: GrantCapPeriod,
});
export type GrantCap = typeof GrantCap.Type;

/** One cap now: used in the current period, of how much, and when the next period starts. */
export const GrantCapUse = Schema.Struct({
  used: Schema.Number,
  amount: Schema.Number,
  period: GrantCapPeriod,
  resetsAt: Schema.String,
});
export type GrantCapUse = typeof GrantCapUse.Type;

/** A Grant's caps now; a null cap is none. */
export const GrantCapState = Schema.Struct({
  tokens: Schema.NullOr(GrantCapUse),
  requests: Schema.NullOr(GrantCapUse),
});
export type GrantCapState = typeof GrantCapState.Type;
