/**
 * AI usage (spec 4 ticket 05): each request the gateway layer ends is one `ai_usage` row, added to
 * its `ai_usage_daily` summary by a fiber of its own, off the response's path. Counts only, no
 * quotas. docs: ai-gateway.md, «Usage».
 */
import {
  type AiAccountId,
  type AiAccountProvider,
  AiUsageError,
  type AiUsageErrorReason,
  type AiUsageLabels,
  type AiUsageQuotaShare,
  type AiUsageRow,
  type AiUsageScope,
  type AiUsageSummary,
  type AiUsageSummaryInput,
  type AiUsageTotals,
  addAiUsageTotals,
  AI_USAGE_NO_TOTALS,
  type AiAccountType,
  type ServerProviderUsageWindow,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import { AI_PRICES, AI_PRICES_REVIEWED, type AiPrice, costUsd, priceFor } from "./aiPrices.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { uncachedInputOf } from "./gatewayShapes.ts";

/** Per-request rows are kept this long; the daily summaries are kept for good. */
const AI_USAGE_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
/** The most rows one answer carries (a year of days for a few Users, Spaces and accounts). */
const DEFAULT_MAX_ROWS = 5000;
/** Records waiting for the writer; beyond this the newest are dropped (logged). */
const MAX_PENDING = 10_000;
const WRITE_BATCH = 200;
const SWEEP_BATCH = 5000;
/** The longest window one question may span. */
const MAX_WINDOW_DAYS = 366;
const DEFAULT_WINDOW_DAYS = 30;

export class AiUsage extends Context.Service<
  AiUsage,
  {
    /**
     * Per day, User, Space, AI account and model: the Owner everything; an Organization's Admin
     * their Spaces' (and their own); anyone else only their own usage. A `threadId` reads that
     * Thread's per-request rows, narrowed the same way.
     */
    readonly summary: (input: AiUsageSummaryInput) => Effect.Effect<AiUsageSummary, AiUsageError>;
    /**
     * Hub turns' answered requests with tokens between two instants (per-request rows: the last
     * 90 days), narrowed to what the session may see exactly as `summary` is. Feeds the Usage
     * dialog's Cost and Tokens (ticket 16): a Hub turn's own transcript is never scanned there.
     */
    readonly threadRequests: (window: {
      readonly fromAt: string;
      readonly toAt: string;
    }) => Effect.Effect<ReadonlyArray<AiUsageThreadRequest>, AiUsageError>;
    /** Deletes per-request rows older than the retention; the summaries stay. Returns how many. */
    readonly sweep: Effect.Effect<number>;
    /** Subscribes now: one outcome for each request written or lost from then on (for tests). */
    readonly outcomes: Effect.Effect<Stream.Stream<AiUsageWriteOutcome>, never, Scope.Scope>;
  }
>()("t3/ai/AiUsage") {}

/** One Hub turn's request through the gateway, with the tokens its answer reported. */
export interface AiUsageThreadRequest {
  readonly usageId: string;
  readonly at: string;
  readonly shape: string;
  readonly model: string;
  readonly threadId: string;
  /** The driver of the Thread's latest provider session (`claudeAgent`, `codex`…); or empty. */
  readonly driver: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/** A request the log took in: stored, or lost to a storage failure (logged). */
export interface AiUsageWriteOutcome {
  readonly written: boolean;
}

export interface AiUsageOptions {
  readonly retentionDays: number;
  /** How often the sweep runs (the first run is at start). */
  readonly sweepEveryMs: number;
  /** The most rows one answer carries (totals still count every request). */
  readonly maxRows?: number;
  /** Grants ticket 05: the list prices (default: the table shipped with this release). */
  readonly prices?: ReadonlyArray<AiPrice>;
  /** A subscription's quota windows (default: `AiAccounts.subscriptionWindows`). */
  readonly subscriptionWindows?: (
    accountId: AiAccountId,
  ) => Effect.Effect<ReadonlyArray<ServerProviderUsageWindow> | null>;
}

const DEFAULT_OPTIONS: AiUsageOptions = {
  retentionDays: AI_USAGE_RETENTION_DAYS,
  sweepEveryMs: DAY_MS,
};

const fail = (reason: AiUsageErrorReason, message: string) =>
  Effect.fail(new AiUsageError({ reason, message }));

const dayOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);
/** Midnight UTC of a `YYYY-MM-DD` day; NaN when it is not a real date (2026-02-31 is not). */
const dayMillis = (day: string) =>
  Option.match(DateTime.make(`${day}T00:00:00.000Z`), {
    onNone: () => Number.NaN,
    onSome: (parsed) => {
      const millis = DateTime.toEpochMillis(parsed);
      return dayOf(millis) === day ? millis : Number.NaN;
    },
  });

interface SummaryRow {
  readonly day: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly accountId: string;
  readonly model: string;
  readonly grantId: string;
  readonly requests: number;
  readonly failedRequests: number;
  readonly unknownRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Input not read from the cache; null: unknown (summaries from before it was kept). */
  readonly uncachedInputTokens: number | null;
}

/** What pricing needs of a row, or of a day, account and model's sum. */
type CostRow = Pick<
  SummaryRow,
  | "day"
  | "accountId"
  | "model"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "uncachedInputTokens"
>;

/**
 * `uncachedInputOf` (input not read from the cache, by shape) in SQL over `ai_usage` rows: a
 * Thread's, a truncated answer's sums, a quota window's tokens.
 */
const UNCACHED_INPUT_SQL = `CASE WHEN input_tokens IS NULL THEN 0
  WHEN shape = 'anthropic' THEN input_tokens
  ELSE MAX(input_tokens - COALESCE(cache_read_tokens, 0), 0) END`;

const make = Effect.fn("AiUsage.make")(function* (options: AiUsageOptions) {
  {
    const sql = yield* SqlClient.SqlClient;
    const activity = yield* AiGatewayActivity.AiGatewayActivity;
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const allowed = yield* AllowedAiAccounts.AllowedAiAccounts;
    const prices = options.prices ?? AI_PRICES;
    const windowsOf =
      options.subscriptionWindows ?? (yield* AiAccounts.AiAccounts).subscriptionWindows;
    const random = yield* SecureRandom.SecureRandom;
    const outcomes = yield* PubSub.unbounded<AiUsageWriteOutcome>();

    const storage = (what: string) => (cause: unknown) =>
      Effect.logError(`AiUsage: could not ${what}`, { cause }).pipe(
        Effect.andThen(fail("storage", `Could not ${what}.`)),
      );

    /** One request's row and its day's summary; run inside the caller's transaction. */
    const insert = Effect.fn("AiUsage.insert")(function* (
      request: AiGatewayActivity.GatewayRequestRecord,
    ) {
      const usageId = Buffer.from(yield* random.randomBytes(16)).toString("hex");
      const usage = request.usage;
      const failed = request.status >= 400;
      const unknown = !failed && (usage?.inputTokens ?? usage?.outputTokens ?? null) === null;
      const day = request.at.slice(0, 10);
      const accountId = request.accountId ?? "";
      const model = request.model ?? "";
      // Which Grant lent the account that answered (grants ticket 03); '' in the summary: own.
      const grantId = request.accountId === null ? null : (request.grantId ?? null);
      // An access key's request has no User (`''`); the key is its subject (access-keys 01).
      const userId = request.userId ?? "";
      yield* sql`
        INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id,
          account_id, provider, model, shape, status, duration_ms, failovers,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, grant_id,
          access_key_id)
        VALUES (${usageId}, ${request.at}, ${day}, ${userId}, ${request.spaceId},
          ${request.threadId}, ${request.keyId}, ${request.accountId}, ${request.provider},
          ${request.model}, ${request.shape}, ${request.status}, ${request.durationMs},
          ${request.failovers}, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null},
          ${usage?.cacheReadTokens ?? null}, ${usage?.cacheWriteTokens ?? null}, ${grantId},
          ${request.accessKeyId ?? null})
      `;
      // A summary whose uncached input is unknown (from before migration 147) stays unknown.
      yield* sql`
        INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
          failed_requests, unknown_requests, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, uncached_input_tokens)
        VALUES (${day}, ${userId}, ${request.spaceId}, ${accountId}, ${model},
          ${grantId ?? ""}, 1, ${failed ? 1 : 0}, ${unknown ? 1 : 0}, ${usage?.inputTokens ?? 0},
          ${usage?.outputTokens ?? 0}, ${usage?.cacheReadTokens ?? 0},
          ${usage?.cacheWriteTokens ?? 0}, ${uncachedInputOf(request.shape, usage)})
        ON CONFLICT (day, user_id, space_id, account_id, model, grant_id) DO UPDATE SET
          requests = requests + 1,
          failed_requests = failed_requests + excluded.failed_requests,
          unknown_requests = unknown_requests + excluded.unknown_requests,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
          uncached_input_tokens = uncached_input_tokens + excluded.uncached_input_tokens
      `;
    });

    const logLost = (cause: unknown) =>
      Effect.logWarning("AiUsage: could not record a request's usage", { cause }).pipe(
        Effect.as(false),
      );

    /**
     * Requests written together: rows and summaries in one transaction, so they never disagree. If
     * the batch cannot be written each request is tried alone, and only one that still fails is
     * lost (logged). An outcome is published for each.
     */
    const writeBatch = Effect.fn("AiUsage.writeBatch")(function* (
      batch: ReadonlyArray<AiGatewayActivity.GatewayRequestRecord>,
    ) {
      if (batch.length === 0) return;
      const together = yield* sql
        .withTransaction(Effect.forEach(batch, insert, { discard: true }))
        .pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
      if (together) {
        for (const _ of batch) yield* PubSub.publish(outcomes, { written: true });
        return;
      }
      for (const request of batch) {
        const written = yield* sql
          .withTransaction(insert(request))
          .pipe(Effect.as(true), Effect.catchCause(logLost));
        yield* PubSub.publish(outcomes, { written });
      }
    });
    const writeAll = (all: ReadonlyArray<AiGatewayActivity.GatewayRequestRecord>) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(all.length / WRITE_BATCH) }, (_, index) =>
          all.slice(index * WRITE_BATCH, (index + 1) * WRITE_BATCH),
        ),
        (batch) => writeBatch(batch).pipe(Effect.ignoreCause),
        { discard: true },
      );

    // Subscribed before this returns, so nothing is missed. `null` marks shed (limit-refused)
    // requests waiting in `shedCounts`: one marker at a time, one upsert per key and day.
    const pending = yield* Queue.dropping<AiGatewayActivity.GatewayRequestRecord | null>(
      MAX_PENDING,
    );
    const shedCounts = new Map<
      string,
      { day: string; userId: string; spaceId: string; count: number }
    >();
    let shedMarked = false;
    const flushShed = Effect.suspend(() => {
      const taken = [...shedCounts.values()];
      shedCounts.clear();
      shedMarked = false;
      if (taken.length === 0) return Effect.void;
      return sql
        .withTransaction(
          Effect.forEach(
            taken,
            (entry) => sql`
              INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, requests,
                failed_requests, uncached_input_tokens)
              VALUES (${entry.day}, ${entry.userId}, ${entry.spaceId}, '', '', ${entry.count},
                ${entry.count}, 0)
              ON CONFLICT (day, user_id, space_id, account_id, model, grant_id) DO UPDATE SET
                requests = requests + excluded.requests,
                failed_requests = failed_requests + excluded.failed_requests
            `,
            { discard: true },
          ),
        )
        .pipe(
          Effect.andThen(PubSub.publish(outcomes, { written: true })),
          Effect.catchCause((cause) =>
            Effect.logWarning("AiUsage: could not record refused requests", { cause }).pipe(
              Effect.andThen(PubSub.publish(outcomes, { written: false })),
            ),
          ),
        );
    });
    // Written or lost, a request is no longer unwritten for a Grant's caps (grants ticket 03):
    // only after its transaction, so a cap never undercounts.
    const writeItems = (items: ReadonlyArray<AiGatewayActivity.GatewayRequestRecord | null>) => {
      const records = items.filter((item) => item !== null);
      return writeAll(records).pipe(
        Effect.andThen(items.includes(null) ? flushShed : Effect.void),
        Effect.ensuring(activity.settle(records)),
      );
    };

    // Shutdown order (finalizers run last-added first): the feeder and the writer are stopped
    // first (the writer finishes the batch it holds: that part is uninterruptible), then what is
    // still queued is written here, once.
    yield* Effect.addFinalizer(() =>
      Queue.clear(pending).pipe(
        Effect.flatMap(writeItems),
        Effect.catchCause((cause) =>
          Effect.logWarning("AiUsage: usage still queued at shutdown was lost", { cause }),
        ),
      ),
    );
    const requests = yield* activity.subscribeRequests;
    yield* Stream.runForEach(requests, (request) => {
      // Counting tokens is not using a model: it would only add requests without tokens.
      if (request.route.endsWith("/count_tokens")) return activity.settle([request]);
      if (request.shed === true) {
        const day = request.at.slice(0, 10);
        const userId = request.userId ?? "";
        const key = `${day}|${userId}|${request.spaceId}`;
        const entry = shedCounts.get(key);
        if (entry === undefined) {
          shedCounts.set(key, { day, userId, spaceId: request.spaceId, count: 1 });
        } else entry.count += 1;
        if (shedMarked) return Effect.void;
        shedMarked = true;
        return Queue.offer(pending, null).pipe(Effect.asVoid);
      }
      return Queue.offer(pending, request).pipe(
        Effect.flatMap((queued) =>
          queued
            ? Effect.void
            : Effect.logWarning("AiUsage: the write queue is full; a request was not counted").pipe(
                Effect.andThen(activity.settle([request])),
              ),
        ),
      );
    }).pipe(Effect.forkScoped);
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.forever(
        restore(Queue.take(pending)).pipe(
          Effect.flatMap((first) =>
            Queue.clear(pending).pipe(Effect.flatMap((rest) => writeItems([first, ...rest]))),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - options.retentionDays * DAY_MS));
      // In batches (each at most SWEEP_BATCH ids, so no statement holds the lock for long); a batch
      // that fails ends the sweep with what was already removed.
      let removed = 0;
      for (;;) {
        const batch = yield* sql<{ readonly one: number }>`
          DELETE FROM ai_usage WHERE usage_id IN (
            SELECT usage_id FROM ai_usage WHERE at < ${cutoff} LIMIT ${SWEEP_BATCH}
          ) RETURNING 1 AS one
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("AiUsage: could not sweep old per-request rows", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        if (batch === undefined) return removed;
        removed += batch.length;
        if (batch.length < SWEEP_BATCH) return removed;
      }
    }).pipe(Effect.withSpan("AiUsage.sweep"));
    yield* sweep.pipe(Effect.repeat(Schedule.spaced(options.sweepEveryMs)), Effect.forkScoped);

    const actor = spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see AI usage."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("forbidden", "Sign in to see AI usage."),
          onSome: Effect.succeed,
        }),
      ),
    );

    /**
     * Who the session may see, from its rights, never the data: `visible` (summary rows: all for
     * the Owner; else own, run Organizations' and given loans', Grants 04) and `visibleThreads`
     * (own and run Spaces' only, never through a loan). A session bound to one Space: that Space.
     */
    const viewer = Effect.fn("AiUsage.viewer")(function* () {
      const userId = yield* actor;
      const can = yield* spaces
        .authorizer(userId)
        .pipe(Effect.catch(storage("check what you may do")));
      const limit = yield* CommandActor.spaceLimit;
      const everything = can("aiAccount.manage", AccessPolicy.installation);
      const principal = yield* spaces
        .principalOf(userId)
        .pipe(Effect.catch(storage("check what you may do")));
      // The Organizations they run, where they act for its loans (and, for the Owner, read Threads).
      const runs = [...principal.roles].flatMap(([spaceId, role]) =>
        role === "admin" ? [spaceId] : [],
      );
      // Loans they may see from the lender's side: their own, and their Organizations' as Admins.
      const given = yield* sql<{ readonly grantId: string; readonly resourceId: string }>`
        SELECT grant_id AS "grantId", resource_id AS "resourceId" FROM grants
        WHERE resource_kind = 'ai-account' AND target_kind = 'space' AND ${sql.or([
          sql`(lender_kind = 'user' AND lender_id = ${userId})`,
          ...(runs.length === 0
            ? []
            : [sql`(lender_kind = 'organization' AND ${sql.in("lender_id", runs)})`]),
        ])}
      `.pipe(Effect.catch(storage("read your loans")));
      const givenIds = given.map((grant) => grant.grantId);
      let administered: ReadonlyArray<SpaceId> = [];
      const readSpaces = new Map<
        SpaceId,
        { readonly resource: AccessPolicy.SpaceResource; readonly name: string }
      >();
      if (!everything) {
        const viewable = yield* spaces
          .viewableSpaces(userId)
          .pipe(Effect.catch(storage("read your Spaces")));
        const candidates = limit !== undefined ? [limit] : viewable === "all" ? [] : [...viewable];
        const known = yield* spaces
          .spacesById(candidates)
          .pipe(Effect.catch(storage("read your Spaces")));
        for (const [spaceId, space] of known) readSpaces.set(spaceId, space);
        administered = [...known].flatMap(([spaceId, space]) =>
          can("aiUsage.viewSpace", space.resource) ? [spaceId] : [],
        );
      }
      const scope: AiUsageScope = everything ? "all" : administered.length > 0 ? "spaces" : "own";
      const bound = limit === undefined ? [] : [sql`space_id = ${limit}`];
      const own = [
        sql`user_id = ${userId}`,
        ...(administered.length > 0 ? [sql.in("space_id", administered)] : []),
      ];
      const visible = sql.and([
        everything
          ? sql`1 = 1`
          : sql.or([...own, ...(givenIds.length > 0 ? [sql.in("grant_id", givenIds)] : [])]),
        ...bound,
      ]);
      // Threads: one's own and those of the Spaces one runs (the Owner's rights reach no further).
      const threadSpaces = [
        `personal:${userId}`,
        ...(everything ? runs : administered.filter((spaceId) => runs.includes(spaceId))),
      ];
      const visibleThreads = sql.and([
        sql.or([sql`user_id = ${userId}`, sql.in("space_id", threadSpaces)]),
        ...bound,
      ]);
      return {
        userId,
        can,
        everything,
        readSpaces,
        administered,
        scope,
        visible,
        visibleThreads,
        given,
      };
    });

    /** Each account's provider and kind, for pricing (only `api-key` has a price). */
    const accountKinds = (accountIds: ReadonlyArray<string>) =>
      accountIds.length === 0
        ? Effect.succeed(
            new Map<
              string,
              { readonly provider: AiAccountProvider; readonly type: AiAccountType }
            >(),
          )
        : sql<{
            readonly id: string;
            readonly provider: AiAccountProvider;
            readonly type: AiAccountType;
          }>`
            SELECT account_id AS "id", provider, type FROM ai_accounts
            WHERE ${sql.in("account_id", accountIds)}
          `.pipe(
            Effect.map((rows) => new Map(rows.map((row) => [row.id, row] as const))),
            Effect.catch(storage("read the AI accounts")),
          );

    /**
     * Grants ticket 05: a row's cost at the list price of its day, or null (not `api-key`, no
     * price, or an uncached input nobody kept); `unpriced`: `api-key` tokens left out.
     */
    const priceRow = (
      kinds: ReadonlyMap<string, { readonly provider: AiAccountProvider; readonly type: string }>,
      row: CostRow,
    ): { readonly usd: number | null; readonly unpriced: number } => {
      const account = kinds.get(row.accountId);
      if (account === undefined || account.type !== "api-key") return { usd: null, unpriced: 0 };
      const price = priceFor(prices, account.provider, row.model, row.day);
      if (price === null || row.uncachedInputTokens === null) {
        return { usd: null, unpriced: row.inputTokens + row.outputTokens + row.cacheWriteTokens };
      }
      return {
        usd: costUsd(price, {
          uncachedInputTokens: row.uncachedInputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
        }),
        unpriced: 0,
      };
    };

    const priceAll = (
      kinds: ReadonlyMap<string, { readonly provider: AiAccountProvider; readonly type: string }>,
      rows: ReadonlyArray<CostRow>,
    ) => {
      let usd: number | null = null;
      let unpriced = 0;
      for (const row of rows) {
        const priced = priceRow(kinds, row);
        if (priced.usd !== null) usd = (usd ?? 0) + priced.usd;
        unpriced += priced.unpriced;
      }
      return { usd, unpriced };
    };

    /**
     * Grants ticket 05: (loan's tokens in a window / the account's) × the window's percentage, the
     * loan's tokens being those the viewer may see; the percentage only to the lender. Windows of
     * one model are left out (their tokens would be that model's). docs: ai-gateway.md.
     */
    const quotaShareOf = Effect.fn("AiUsage.quotaShareOf")(function* (
      grantId: string,
      view: Effect.Success<ReturnType<typeof viewer>>,
    ) {
      const found = yield* sql<{
        readonly accountId: string;
        readonly targetId: string | null;
        readonly type: AiAccountType;
      }>`
        SELECT g.resource_id AS "accountId", g.target_id AS "targetId", a.type
        FROM grants g JOIN ai_accounts a ON a.account_id = g.resource_id
        WHERE g.grant_id = ${grantId} AND g.resource_kind = 'ai-account'
          AND g.target_kind = 'space'
      `.pipe(Effect.catch(storage("read the loan")));
      const grant = found[0];
      if (grant === undefined || grant.type !== "subscription" || grant.targetId === null) {
        return undefined;
      }
      const target = grant.targetId as SpaceId;
      const lender = view.given.some((given) => given.grantId === grantId);
      if (!view.everything && !lender && !view.readSpaces.has(target)) return undefined;
      const windows = yield* windowsOf(grant.accountId as AiAccountId);
      if (windows === null) return undefined;
      const now = yield* Clock.currentTimeMillis;
      const whole = view.everything || lender || view.administered.includes(target);
      // Tokens as a Grant's caps count them: uncached input + output + cache writes.
      const counted = sql.literal(
        `COALESCE(SUM(${UNCACHED_INPUT_SQL} + COALESCE(output_tokens, 0)
          + COALESCE(cache_write_tokens, 0)), 0)`,
      );
      const shares: Array<AiUsageQuotaShare> = [];
      for (const window of windows) {
        if (
          window.resetsAt === undefined ||
          window.windowDurationMins === undefined ||
          window.id.startsWith("seven_day_")
        ) {
          continue;
        }
        const resetsAt = Option.match(DateTime.make(window.resetsAt), {
          onNone: () => Number.NaN,
          onSome: DateTime.toEpochMillis,
        });
        // A window already reset: its percentage is stale, and says nothing of the new one.
        if (!(resetsAt > now)) continue;
        const fromAt = DateTime.formatIso(
          DateTime.makeUnsafe(resetsAt - window.windowDurationMins * 60_000),
        );
        const tokens = (loanOnly: boolean) =>
          sql<{ readonly tokens: number }>`
            SELECT ${counted} AS tokens FROM ai_usage
            WHERE ${sql.and([
              sql`account_id = ${grant.accountId}`,
              sql`at >= ${fromAt}`,
              ...(loanOnly ? [sql`grant_id = ${grantId}`, view.visible] : []),
            ])}
          `.pipe(
            Effect.map((rows) => rows[0]?.tokens ?? 0),
            Effect.catch(storage("read the AI usage")),
          );
        const accountTokens = yield* tokens(false);
        const loanTokens = yield* tokens(true);
        shares.push({
          windowId: window.id,
          label: window.label,
          kind: window.kind,
          resetsAt: window.resetsAt,
          sharePercent:
            accountTokens === 0
              ? 0
              : Math.min(100, (loanTokens * window.usedPercent) / accountTokens),
          of: whole ? "loan" : "own",
          ...(lender ? { usedPercent: window.usedPercent } : {}),
        });
      }
      return shares.length === 0 ? undefined : shares;
    });

    const summary = Effect.fn("AiUsage.summary")(function* (input: AiUsageSummaryInput) {
      const view = yield* viewer();
      const { userId, can, everything, readSpaces, scope, visible, visibleThreads, given } = view;

      const now = yield* Clock.currentTimeMillis;
      // Days are checked as given: an impossible one (2026-02-31) is refused, never rolled over.
      for (const day of [input.fromDay, input.toDay]) {
        if (day !== undefined && Number.isNaN(dayMillis(day))) {
          return yield* fail("invalid", "Those days are not dates.");
        }
      }
      const toDay = input.toDay ?? dayOf(now);
      const fromDay = input.fromDay ?? dayOf(dayMillis(toDay) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS);
      if (fromDay > toDay) return yield* fail("invalid", "The first day is after the last.");
      if ((dayMillis(toDay) - dayMillis(fromDay)) / DAY_MS >= MAX_WINDOW_DAYS) {
        return yield* fail("invalid", `Ask for at most ${MAX_WINDOW_DAYS} days at a time.`);
      }

      const filters = [
        sql`day >= ${fromDay}`,
        sql`day <= ${toDay}`,
        // An access key's rows have no User; access-keys ticket 04 shows them as the key's.
        sql`user_id <> ''`,
        // A Thread's rows never come through a loan given, and the Owner's only where they run.
        input.threadId === undefined ? visible : visibleThreads,
        ...(input.spaceId === undefined ? [] : [sql`space_id = ${input.spaceId}`]),
        ...(input.userId === undefined ? [] : [sql`user_id = ${input.userId}`]),
        ...(input.accountId === undefined ? [] : [sql`account_id = ${input.accountId}`]),
        ...(input.threadId === undefined ? [] : [sql`thread_id = ${input.threadId}`]),
        ...(input.grantId === undefined
          ? []
          : [
              input.threadId === undefined
                ? sql`grant_id = ${input.grantId}`
                : sql`COALESCE(grant_id, '') = ${input.grantId}`,
            ]),
      ];
      const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

      const rows =
        input.threadId === undefined
          ? yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId", account_id AS "accountId",
                model, grant_id AS "grantId", requests, failed_requests AS "failedRequests",
                unknown_requests AS "unknownRequests", input_tokens AS "inputTokens",
                output_tokens AS "outputTokens", cache_read_tokens AS "cacheReadTokens",
                cache_write_tokens AS "cacheWriteTokens",
                uncached_input_tokens AS "uncachedInputTokens"
              FROM ai_usage_daily WHERE ${sql.and(filters)}
              ORDER BY day DESC, space_id, user_id, account_id, model, grant_id
              LIMIT ${maxRows + 1}
            `.pipe(Effect.catch(storage("read the AI usage")))
          : yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId",
                COALESCE(account_id, '') AS "accountId", COALESCE(model, '') AS "model",
                COALESCE(grant_id, '') AS "grantId", COUNT(*) AS "requests",
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS "failedRequests",
                SUM(CASE WHEN status < 400 AND input_tokens IS NULL AND output_tokens IS NULL
                  THEN 1 ELSE 0 END) AS "unknownRequests",
                COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
                COALESCE(SUM(${sql.literal(UNCACHED_INPUT_SQL)}), 0) AS "uncachedInputTokens"
              FROM ai_usage WHERE ${sql.and(filters)}
              GROUP BY day, user_id, space_id, COALESCE(account_id, ''), COALESCE(model, ''),
                COALESCE(grant_id, '')
              ORDER BY day DESC, space_id, user_id, account_id, model
              LIMIT ${maxRows + 1}
            `.pipe(Effect.catch(storage("read the AI usage")));
      const truncated = rows.length > maxRows;
      const kept = truncated ? rows.slice(0, maxRows) : rows;

      // Cut rows must not undercount the estimate either: then it is priced from sums of its own.
      const costRows: ReadonlyArray<CostRow> = !truncated
        ? kept
        : input.threadId === undefined
          ? yield* sql<CostRow>`
              SELECT day, account_id AS "accountId", model,
                COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
                -- Unknown if any of the day's rows is.
                CASE WHEN COUNT(uncached_input_tokens) = COUNT(*)
                  THEN COALESCE(SUM(uncached_input_tokens), 0) END AS "uncachedInputTokens"
              FROM ai_usage_daily WHERE ${sql.and(filters)}
              GROUP BY day, account_id, model
            `.pipe(Effect.catch(storage("read the AI usage")))
          : yield* sql<CostRow>`
              SELECT day, COALESCE(account_id, '') AS "accountId", COALESCE(model, '') AS "model",
                COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
                COALESCE(SUM(${sql.literal(UNCACHED_INPUT_SQL)}), 0) AS "uncachedInputTokens"
              FROM ai_usage WHERE ${sql.and(filters)}
              GROUP BY day, COALESCE(account_id, ''), COALESCE(model, '')
            `.pipe(Effect.catch(storage("read the AI usage")));
      const kinds = yield* accountKinds([
        ...new Set(
          [...kept, ...costRows].flatMap((row) => (row.accountId === "" ? [] : [row.accountId])),
        ),
      ]);
      const cost = priceAll(kinds, costRows);

      const outRows: Array<AiUsageRow> = kept.map((row) => ({
        day: row.day,
        userId: row.userId as UserId,
        spaceId: row.spaceId as SpaceId,
        accountId: row.accountId === "" ? null : (row.accountId as AiAccountId),
        model: row.model === "" ? null : row.model,
        grantId: row.grantId === "" ? null : row.grantId,
        requests: row.requests,
        failedRequests: row.failedRequests,
        unknownRequests: row.unknownRequests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        estimatedUsd: priceRow(kinds, row).usd,
      }));
      // Cut rows must not undercount: the totals then come from a query of their own.
      const totals = !truncated
        ? outRows.reduce<AiUsageTotals>(addAiUsageTotals, AI_USAGE_NO_TOTALS)
        : yield* (
            input.threadId === undefined
              ? sql<AiUsageTotals>`
                SELECT COALESCE(SUM(requests), 0) AS requests,
                  COALESCE(SUM(failed_requests), 0) AS "failedRequests",
                  COALESCE(SUM(unknown_requests), 0) AS "unknownRequests",
                  COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                  COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                  COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                  COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens"
                FROM ai_usage_daily WHERE ${sql.and(filters)}
              `
              : sql<AiUsageTotals>`
                SELECT COUNT(*) AS requests,
                  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS "failedRequests",
                  COALESCE(SUM(CASE WHEN status < 400 AND input_tokens IS NULL
                    AND output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS "unknownRequests",
                  COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                  COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                  COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                  COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens"
                FROM ai_usage WHERE ${sql.and(filters)}
              `
          ).pipe(
            Effect.map((found) => found[0] ?? AI_USAGE_NO_TOTALS),
            Effect.catch(storage("read the AI usage")),
          );

      const labels = yield* labelsOf(userId, everything, can, readSpaces, outRows, given);
      const quotaShare =
        input.grantId === undefined || input.threadId !== undefined
          ? undefined
          : yield* quotaShareOf(input.grantId, view);
      return {
        fromDay,
        toDay,
        scope,
        rows: outRows,
        totals,
        labels,
        truncated,
        retentionDays: options.retentionDays,
        estimatedUsd: cost.usd,
        unpricedTokens: cost.unpriced,
        pricesReviewedOn: AI_PRICES_REVIEWED,
        ...(quotaShare === undefined ? {} : { quotaShare }),
      } satisfies AiUsageSummary;
    });

    /** Names for what the rows mention; an account's only to those who may know it. */
    const labelsOf = Effect.fn("AiUsage.labelsOf")(function* (
      viewer: UserId,
      everything: boolean,
      can: (action: AccessPolicy.Action, resource: AccessPolicy.Resource) => boolean,
      alreadyRead: ReadonlyMap<
        SpaceId,
        { readonly resource: AccessPolicy.SpaceResource; readonly name: string }
      >,
      rows: ReadonlyArray<AiUsageRow>,
      given: ReadonlyArray<{ readonly grantId: string; readonly resourceId: string }>,
    ) {
      // A lender knows where they lent and what: those Spaces' and accounts' names (Grants 04).
      const givenIds = new Set(given.map((grant) => grant.grantId));
      const lentTo = new Set(
        rows.flatMap((row) =>
          row.grantId !== undefined && row.grantId !== null && givenIds.has(row.grantId)
            ? [row.spaceId as string]
            : [],
        ),
      );
      const userIds = [...new Set(rows.map((row) => row.userId))];
      const spaceIds = [...new Set(rows.map((row) => row.spaceId))];
      const accountIds = [
        ...new Set(rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId]))),
      ];
      const users =
        userIds.length === 0
          ? []
          : yield* sql<{ readonly id: string; readonly name: string }>`
              SELECT user_id AS "id", display_name AS "name" FROM users
              WHERE ${sql.in("user_id", userIds)}
            `.pipe(Effect.catch(storage("read the Users")));
      // Only the Spaces the rights check did not already read.
      const knownSpaces = new Map(alreadyRead);
      const missing = spaceIds.filter((id) => !knownSpaces.has(id));
      if (missing.length > 0) {
        const more = yield* spaces
          .spacesById(missing)
          .pipe(Effect.catch(storage("read the Spaces")));
        for (const [id, space] of more) knownSpaces.set(id, space);
      }
      const accounts =
        accountIds.length === 0
          ? []
          : yield* sql<{
              readonly id: string;
              readonly name: string;
              readonly provider: AiAccountProvider;
            }>`
              SELECT account_id AS "id", name, provider FROM ai_accounts
              WHERE ${sql.in("account_id", accountIds)}
            `.pipe(Effect.catch(storage("read the AI accounts")));
      // Anyone but the Owner learns an account's name only if they may use it somewhere.
      const mayName = new Set<string>(given.map((grant) => grant.resourceId));
      if (!everything && accounts.length > 0) {
        const byUse = yield* allowed
          .forSpaces(viewer, spaceIds)
          .pipe(Effect.catch(storage("read the AI accounts you may use")));
        for (const usable of byUse.values()) for (const account of usable) mayName.add(account.id);
      }
      return {
        users: users.map((user) => ({ id: user.id as UserId, name: user.name })),
        // A Space the viewer can no longer see keeps its rows but no name (nor a new one).
        spaces: spaceIds.flatMap((id) => {
          const space = knownSpaces.get(id);
          return space === undefined
            ? []
            : [
                {
                  id,
                  name:
                    everything || lentTo.has(id) || can("space.view", space.resource)
                      ? space.name
                      : null,
                },
              ];
        }),
        accounts: accounts.map((account) => ({
          id: account.id as AiAccountId,
          name: everything || mayName.has(account.id) ? account.name : null,
          provider: account.provider,
        })),
      } satisfies AiUsageLabels;
    });

    const threadRequests = Effect.fn("AiUsage.threadRequests")(function* (window: {
      readonly fromAt: string;
      readonly toAt: string;
    }) {
      const { visibleThreads } = yield* viewer();
      // The driver of the Thread's latest provider session (empty when none is left): the shape
      // alone cannot tell Codex from OpenCode or Pi.
      return yield* sql<AiUsageThreadRequest>`
        SELECT u.usage_id AS "usageId", u.at, u.shape, u.model, u.thread_id AS "threadId",
          COALESCE((
            SELECT ps.driver FROM orchestration_v2_projection_provider_sessions ps
            WHERE ps.thread_id = u.thread_id ORDER BY ps.updated_at DESC LIMIT 1
          ), '') AS "driver",
          u.input_tokens AS "inputTokens", u.output_tokens AS "outputTokens",
          u.cache_read_tokens AS "cacheReadTokens", u.cache_write_tokens AS "cacheWriteTokens"
        FROM (
          SELECT * FROM ai_usage
          WHERE ${sql.and([
            sql`at >= ${window.fromAt}`,
            sql`at < ${window.toAt}`,
            sql`thread_id IS NOT NULL`,
            sql`model IS NOT NULL`,
            sql`status < 400`,
            sql`(input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`,
            visibleThreads,
          ])}
        ) u
        ORDER BY u.at, u.usage_id
      `.pipe(Effect.catch(storage("read the AI usage")));
    });

    return AiUsage.of({
      summary,
      threadRequests,
      sweep,
      outcomes: Effect.map(PubSub.subscribe(outcomes), Stream.fromSubscription),
    });
  }
});

export const layerWith = (options: AiUsageOptions) => Layer.effect(AiUsage, make(options));
export const layer = layerWith(DEFAULT_OPTIONS);
