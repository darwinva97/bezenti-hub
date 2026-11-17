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
  type AiUsageRow,
  type AiUsageScope,
  type AiUsageSummary,
  type AiUsageSummaryInput,
  type AiUsageTotals,
  addAiUsageTotals,
  AI_USAGE_NO_TOTALS,
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
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";

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
  readonly requests: number;
  readonly failedRequests: number;
  readonly unknownRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const make = Effect.fn("AiUsage.make")(function* (options: AiUsageOptions) {
  {
    const sql = yield* SqlClient.SqlClient;
    const activity = yield* AiGatewayActivity.AiGatewayActivity;
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const allowed = yield* AllowedAiAccounts.AllowedAiAccounts;
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
      yield* sql`
        INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id,
          account_id, provider, model, shape, status, duration_ms, failovers,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, grant_id)
        VALUES (${usageId}, ${request.at}, ${day}, ${request.userId}, ${request.spaceId},
          ${request.threadId}, ${request.keyId}, ${request.accountId}, ${request.provider},
          ${request.model}, ${request.shape}, ${request.status}, ${request.durationMs},
          ${request.failovers}, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null},
          ${usage?.cacheReadTokens ?? null}, ${usage?.cacheWriteTokens ?? null}, ${grantId})
      `;
      yield* sql`
        INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, grant_id, requests,
          failed_requests, unknown_requests, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
        VALUES (${day}, ${request.userId}, ${request.spaceId}, ${accountId}, ${model},
          ${grantId ?? ""}, 1, ${failed ? 1 : 0}, ${unknown ? 1 : 0}, ${usage?.inputTokens ?? 0},
          ${usage?.outputTokens ?? 0}, ${usage?.cacheReadTokens ?? 0},
          ${usage?.cacheWriteTokens ?? 0})
        ON CONFLICT (day, user_id, space_id, account_id, model, grant_id) DO UPDATE SET
          requests = requests + 1,
          failed_requests = failed_requests + excluded.failed_requests,
          unknown_requests = unknown_requests + excluded.unknown_requests,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens
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
                failed_requests)
              VALUES (${entry.day}, ${entry.userId}, ${entry.spaceId}, '', '', ${entry.count},
                ${entry.count})
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
        const key = `${day}|${request.userId}|${request.spaceId}`;
        const entry = shedCounts.get(key);
        if (entry === undefined) {
          shedCounts.set(key, { day, userId: request.userId, spaceId: request.spaceId, count: 1 });
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
     * Who the session may see, from its rights and never from the data: the Owner (not limited to
     * one Space) all; others their own rows and every row of each Organization they run. `visible`
     * holds that, and a session bound to one Space reaches that Space only.
     */
    const viewer = Effect.fn("AiUsage.viewer")(function* () {
      const userId = yield* actor;
      const can = yield* spaces
        .authorizer(userId)
        .pipe(Effect.catch(storage("check what you may do")));
      const limit = yield* CommandActor.spaceLimit;
      const everything = can("aiAccount.manage", AccessPolicy.installation);
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
      const visible = sql.and([
        everything
          ? sql`1 = 1`
          : sql.or([
              sql`user_id = ${userId}`,
              ...(administered.length > 0 ? [sql.in("space_id", administered)] : []),
            ]),
        ...(limit === undefined ? [] : [sql`space_id = ${limit}`]),
      ]);
      return { userId, can, everything, readSpaces, scope, visible };
    });

    const summary = Effect.fn("AiUsage.summary")(function* (input: AiUsageSummaryInput) {
      const { userId, can, everything, readSpaces, scope, visible } = yield* viewer();

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
        visible,
        ...(input.spaceId === undefined ? [] : [sql`space_id = ${input.spaceId}`]),
        ...(input.userId === undefined ? [] : [sql`user_id = ${input.userId}`]),
        ...(input.accountId === undefined ? [] : [sql`account_id = ${input.accountId}`]),
        ...(input.threadId === undefined ? [] : [sql`thread_id = ${input.threadId}`]),
      ];
      const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

      const rows =
        input.threadId === undefined
          ? yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId", account_id AS "accountId",
                model, requests, failed_requests AS "failedRequests",
                unknown_requests AS "unknownRequests", input_tokens AS "inputTokens",
                output_tokens AS "outputTokens", cache_read_tokens AS "cacheReadTokens",
                cache_write_tokens AS "cacheWriteTokens"
              FROM ai_usage_daily WHERE ${sql.and(filters)}
              ORDER BY day DESC, space_id, user_id, account_id, model
              LIMIT ${maxRows + 1}
            `.pipe(Effect.catch(storage("read the AI usage")))
          : yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId",
                COALESCE(account_id, '') AS "accountId", COALESCE(model, '') AS "model",
                COUNT(*) AS "requests",
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS "failedRequests",
                SUM(CASE WHEN status < 400 AND input_tokens IS NULL AND output_tokens IS NULL
                  THEN 1 ELSE 0 END) AS "unknownRequests",
                COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens"
              FROM ai_usage WHERE ${sql.and(filters)}
              GROUP BY day, user_id, space_id, COALESCE(account_id, ''), COALESCE(model, '')
              ORDER BY day DESC, space_id, user_id, account_id, model
              LIMIT ${maxRows + 1}
            `.pipe(Effect.catch(storage("read the AI usage")));
      const truncated = rows.length > maxRows;
      const kept = truncated ? rows.slice(0, maxRows) : rows;

      const outRows: Array<AiUsageRow> = kept.map((row) => ({
        day: row.day,
        userId: row.userId as UserId,
        spaceId: row.spaceId as SpaceId,
        accountId: row.accountId === "" ? null : (row.accountId as AiAccountId),
        model: row.model === "" ? null : row.model,
        requests: row.requests,
        failedRequests: row.failedRequests,
        unknownRequests: row.unknownRequests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
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

      const labels = yield* labelsOf(userId, everything, can, readSpaces, outRows);
      return {
        fromDay,
        toDay,
        scope,
        rows: outRows,
        totals,
        labels,
        truncated,
        retentionDays: options.retentionDays,
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
    ) {
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
      const mayName = new Set<string>();
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
            : [{ id, name: everything || can("space.view", space.resource) ? space.name : null }];
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
      const { visible } = yield* viewer();
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
            visible,
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
