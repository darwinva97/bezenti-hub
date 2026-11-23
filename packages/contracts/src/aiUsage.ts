/**
 * AI usage (spec 4 ticket 05): what passed through the Hub's AI gateway layer, per day, User,
 * Space and AI account (and model). No quotas or limits: it is recorded and shown, never enforced.
 * Never a prompt, an answer or a key; tokens are counts read from the upstream's own `usage`.
 */
import * as Schema from "effect/Schema";

import { AiAccountId, AiAccountProvider } from "./aiAccounts.ts";
import { NonNegativeInt, SpaceId, ThreadId, UserId } from "./baseSchemas.ts";

/** A UTC calendar day, `YYYY-MM-DD`. */
export const AiUsageDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
export type AiUsageDay = typeof AiUsageDay.Type;

/** Every filter narrows what the session may already see; none widens it. */
export const AiUsageSummaryInput = Schema.Struct({
  /** First day, inclusive. Default: 29 days before `toDay` (30 days). */
  fromDay: Schema.optionalKey(AiUsageDay),
  /** Last day, inclusive. Default: today (UTC). */
  toDay: Schema.optionalKey(AiUsageDay),
  spaceId: Schema.optionalKey(SpaceId),
  userId: Schema.optionalKey(UserId),
  accountId: Schema.optionalKey(AiAccountId),
  /** One Thread's usage (its per-request rows, kept 90 days). */
  threadId: Schema.optionalKey(ThreadId),
  /** One loan's usage (Grants ticket 04): its lender sees it by Space and User, never a Thread. */
  grantId: Schema.optionalKey(Schema.String),
  /** One access key's usage (access-keys ticket 04). */
  accessKeyId: Schema.optionalKey(Schema.String),
});
export type AiUsageSummaryInput = typeof AiUsageSummaryInput.Type;

export const AiUsageTotals = Schema.Struct({
  requests: NonNegativeInt,
  /** Requests that ended in an error (a refusal, no quota left, the gateway not answering). */
  failedRequests: NonNegativeInt,
  /** Answered requests whose answer carried no usage (or was cut off): their tokens are unknown. */
  unknownRequests: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  /**
   * Access-keys ticket 04: tokens estimated for an access key's answers with no usage (cut short),
   * shown as «≈»; their requests are in `unknownRequests` too.
   */
  estimatedTokens: Schema.optionalKey(NonNegativeInt),
});
export type AiUsageTotals = typeof AiUsageTotals.Type;

export const AiUsageRow = Schema.Struct({
  day: AiUsageDay,
  /** Null for an access key's requests: they are its Space's, never a User's. */
  userId: Schema.NullOr(UserId),
  /** The access key that made the requests (access-keys ticket 04); absent or null: a User. */
  accessKeyId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  spaceId: SpaceId,
  /** Null for a request that reached no account. */
  accountId: Schema.NullOr(AiAccountId),
  model: Schema.NullOr(Schema.String),
  /** The Grant that lent the account (Grants ticket 04); null: the Space's own (or none). */
  grantId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ...AiUsageTotals.fields,
  /**
   * Grants ticket 05: what the row would cost at the list price in force that day, in USD. Only
   * `api-key` accounts; null for a subscription, no account, or a model without a price.
   */
  estimatedUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type AiUsageRow = typeof AiUsageRow.Type;

/**
 * Grants ticket 05: about how much of one quota window of a lent subscription went through the
 * loan: (the loan's tokens in the window / the account's tokens in the window) × the window's use.
 * Approximate: use of the account outside this Hub is in the percentage, not in its tokens.
 */
export const AiUsageQuotaShare = Schema.Struct({
  windowId: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  resetsAt: Schema.String,
  /** Percentage points of the window's quota (0–100). */
  sharePercent: Schema.Number,
  /** `loan`: the whole loan's share; `own`: only the viewer's part of it. */
  of: Schema.Literals(["loan", "own"]),
  /** The whole account's use of the window; only to its lender, who sees it anyway. */
  usedPercent: Schema.optionalKey(Schema.Number),
});
export type AiUsageQuotaShare = typeof AiUsageQuotaShare.Type;

/** Names for the ids in the rows (a name the session may not see is left out). */
export const AiUsageLabels = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: UserId, name: Schema.String })),
  /** The access keys the rows name, by label (access-keys ticket 04). */
  accessKeys: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  /** Null for a Space the viewer can no longer see: its rows stay, its name does not. */
  spaces: Schema.Array(Schema.Struct({ id: SpaceId, name: Schema.NullOr(Schema.String) })),
  accounts: Schema.Array(
    Schema.Struct({
      id: AiAccountId,
      /** Only the Owner and the accounts a User may use show their name. */
      name: Schema.NullOr(Schema.String),
      provider: AiAccountProvider,
    }),
  ),
});
export type AiUsageLabels = typeof AiUsageLabels.Type;

/**
 * `all`: the Owner, every User, Space and account. `spaces`: also an Organization's Admin, whole
 * Spaces, plus the session's own usage. `own`: only the session's User's.
 */
export const AiUsageScope = Schema.Literals(["all", "spaces", "own"]);
export type AiUsageScope = typeof AiUsageScope.Type;

export const AiUsageSummary = Schema.Struct({
  fromDay: AiUsageDay,
  toDay: AiUsageDay,
  scope: AiUsageScope,
  rows: Schema.Array(AiUsageRow),
  totals: AiUsageTotals,
  labels: AiUsageLabels,
  /** Whether the rows were cut at the most the answer carries. */
  truncated: Schema.Boolean,
  /** How long the per-request rows (a Thread's usage) are kept, in days. */
  retentionDays: NonNegativeInt,
  /** Grants ticket 05: the priced rows' estimate in USD; null when no row has a price. */
  estimatedUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Tokens (input, output, cache write) of `api-key` use with no price, left out of it. */
  unpricedTokens: Schema.optionalKey(NonNegativeInt),
  /** The day the Hub's list prices were last checked (`YYYY-MM-DD`). */
  pricesReviewedOn: Schema.optionalKey(Schema.String),
  /** Only for one subscription loan (`grantId`) whose provider reports its quota windows. */
  quotaShare: Schema.optionalKey(Schema.Array(AiUsageQuotaShare)),
});
export type AiUsageSummary = typeof AiUsageSummary.Type;

export const AiUsageErrorReason = Schema.Literals(["forbidden", "invalid", "storage"]);
export type AiUsageErrorReason = typeof AiUsageErrorReason.Type;

export class AiUsageError extends Schema.TaggedError<AiUsageError>()("AiUsageError", {
  reason: AiUsageErrorReason,
  message: Schema.String,
}) {}

export const AI_USAGE_NO_TOTALS: AiUsageTotals = {
  requests: 0,
  failedRequests: 0,
  unknownRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedTokens: 0,
};

export const addAiUsageTotals = (sum: AiUsageTotals, row: AiUsageTotals): AiUsageTotals => ({
  requests: sum.requests + row.requests,
  failedRequests: sum.failedRequests + row.failedRequests,
  unknownRequests: sum.unknownRequests + row.unknownRequests,
  inputTokens: sum.inputTokens + row.inputTokens,
  outputTokens: sum.outputTokens + row.outputTokens,
  cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
  cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
  estimatedTokens: (sum.estimatedTokens ?? 0) + (row.estimatedTokens ?? 0),
});
