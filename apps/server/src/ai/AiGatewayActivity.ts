/**
 * What the AI gateway layer did (spec 4 ticket 04): one record per request, which ticket 05 turns
 * into usage rows (`subscribeRequests`), and the AI account each Thread's requests last went
 * to, kept and published when it changes (a failover, a switch) so the Thread's header shows the
 * account in use (decision 7). Never a key, a header or a prompt.
 */
import type { AiAccountId, AiAccountProvider, SpaceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { GatewayCallerKind } from "./AiGatewayKeys.ts";
import { type GatewayShape, type GatewayUsage, uncachedInputOf } from "./gatewayShapes.ts";

/** One request through `/api/ai/*`, as far as the Hub knows when it ends. */
export interface GatewayRequestRecord {
  readonly at: string;
  readonly keyId: string;
  readonly keyKind: GatewayCallerKind;
  /** Null for an access key: its use counts on the key, in its Space (access-keys ticket 01). */
  readonly userId: UserId | null;
  /** The access key's id (`ak_…`); absent or null for a gateway key. */
  readonly accessKeyId?: string | null;
  readonly spaceId: SpaceId;
  readonly threadId: ThreadId | null;
  readonly shape: GatewayShape;
  readonly route: string;
  /** The account that answered, after any failover; null when none was reached. */
  readonly accountId: AiAccountId | null;
  readonly provider: AiAccountProvider | null;
  readonly model: string | null;
  readonly status: number;
  readonly durationMs: number;
  /** Accounts tried before the one that answered (each out of quota). */
  readonly failovers: number;
  /** Null when the answer never finished (cut off, failed). */
  readonly usage: GatewayUsage | null;
  /** A request refused for load (a limit): counted in the daily summary, never as its own row. */
  readonly shed?: true;
  /** The Grant that lent the account that answered (grants ticket 03); absent or null: own. */
  readonly grantId?: string | null;
  /**
   * An access key's estimate for an answer with no usage (cut short, or none sent; access-keys
   * ticket 04): counted by its caps and shown as «≈», never 0. Absent for everything else.
   */
  readonly estimatedTokens?: number;
}

/** What a cap's subject (a Grant, an access key) used on one UTC day and is not written yet. */
export interface UnwrittenUse {
  readonly day: string;
  readonly tokens: number;
  readonly requests: number;
}

/**
 * The tokens caps count (grants ticket 03): input, output and cache writes. Cache reads are shown
 * but never counted (taken out of OpenAI's and Gemini's input, which holds them: grants ticket 14);
 * unknown tokens count 0, or an access key's estimate (access-keys ticket 04).
 */
const cappedTokensOf = (request: GatewayRequestRecord) =>
  uncachedInputOf(request.shape, request.usage) +
  (request.usage?.outputTokens ?? 0) +
  (request.usage?.cacheWriteTokens ?? 0) +
  (request.estimatedTokens ?? 0);

/** The subject of a Grant's caps in `unwritten`. */
export const grantSubject = (grantId: string) => `grant:${grantId}`;
/** The subject of an access key's caps in `unwritten` (access-keys ticket 05). */
export const accessKeySubject = (keyId: string) => `access-key:${keyId}`;

/**
 * The cap subjects a request counts for: its Grant, its access key (never a shed request, never a
 * count of tokens).
 */
const subjectsOf = (request: GatewayRequestRecord): ReadonlyArray<string> =>
  request.shed === true || request.route.endsWith("/count_tokens")
    ? []
    : [
        ...(request.grantId === undefined || request.grantId === null
          ? []
          : [grantSubject(request.grantId)]),
        ...(request.accessKeyId === undefined || request.accessKeyId === null
          ? []
          : [accessKeySubject(request.accessKeyId)]),
      ];

/** The AI account a Thread's requests go to now. */
export interface AccountInUse {
  readonly threadId: ThreadId;
  readonly accountId: AiAccountId;
  readonly model: string;
  /** Its provider, when the caller knows it (not kept: the header's own copy has it). */
  readonly provider?: AiAccountProvider;
}

export class AiGatewayActivity extends Context.Service<
  AiGatewayActivity,
  {
    /**
     * Called once per request when it ends; ticket 05 counts usage from these. A request through a
     * Grant is also held as unwritten until the usage log `settle`s it, so a cap sees it at once.
     */
    readonly record: (request: GatewayRequestRecord) => Effect.Effect<void>;
    /**
     * What a cap's subject (`grantSubject`, `accessKeySubject`) used that the usage log has not
     * written yet, by day (grants ticket 03).
     */
    readonly unwritten: (subject: string) => Effect.Effect<ReadonlyArray<UnwrittenUse>>;
    /** The usage log wrote (or lost) these: they are no longer unwritten. */
    readonly settle: (requests: ReadonlyArray<GatewayRequestRecord>) => Effect.Effect<void>;
    /** Subscribes now (nothing recorded after it returns is missed): every request from now on. */
    readonly subscribeRequests: Effect.Effect<
      Stream.Stream<GatewayRequestRecord>,
      never,
      Scope.Scope
    >;
    /** Notes the account a Thread's request went to; publishes it when it changed. */
    readonly noteInUse: (use: AccountInUse) => Effect.Effect<void>;
    /** Subscribes now: each change of a Thread's account in use from then on. */
    readonly subscribeAccountsInUse: Effect.Effect<Stream.Stream<AccountInUse>, never, Scope.Scope>;
    /** The account a Thread's requests went to last. */
    readonly inUse: (threadId: ThreadId) => Effect.Effect<Option.Option<AccountInUse>>;
    /** Forgets a deleted Thread's account in use. */
    readonly forgetThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/ai/AiGatewayActivity") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requests = yield* PubSub.unbounded<GatewayRequestRecord>();
  const changes = yield* PubSub.unbounded<AccountInUse>();
  // Subject → day → what is recorded and not yet written. Changed synchronously: a request
  // recorded is seen by the next cap check; it leaves only after the log committed (never
  // undercounted).
  const pending = new Map<string, Map<string, { tokens: number; requests: number }>>();
  const tally = (request: GatewayRequestRecord, sign: 1 | -1) => {
    const day = request.at.slice(0, 10);
    for (const subject of subjectsOf(request)) {
      const days = pending.get(subject) ?? new Map();
      const entry = days.get(day) ?? { tokens: 0, requests: 0 };
      entry.tokens += sign * cappedTokensOf(request);
      entry.requests += sign;
      if (entry.requests <= 0) days.delete(day);
      else days.set(day, entry);
      if (days.size === 0) pending.delete(subject);
      else pending.set(subject, days);
    }
  };

  const inUse = Effect.fn("AiGatewayActivity.inUse")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly accountId: string; readonly model: string }>`
      SELECT account_id AS "accountId", model FROM ai_gateway_thread_accounts
      WHERE thread_id = ${threadId}
    `.pipe(Effect.orElseSucceed(() => []));
    const row = rows[0];
    return row === undefined
      ? Option.none<AccountInUse>()
      : Option.some<AccountInUse>({
          threadId,
          accountId: row.accountId as AiAccountId,
          model: row.model,
        });
  });

  const noteInUse = Effect.fn("AiGatewayActivity.noteInUse")(function* (use: AccountInUse) {
    const before = yield* inUse(use.threadId);
    if (
      Option.isSome(before) &&
      before.value.accountId === use.accountId &&
      before.value.model === use.model
    ) {
      return;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO ai_gateway_thread_accounts (thread_id, account_id, model, updated_at)
      VALUES (${use.threadId}, ${use.accountId}, ${use.model}, ${at})
      ON CONFLICT (thread_id) DO UPDATE SET account_id = excluded.account_id,
        model = excluded.model, updated_at = excluded.updated_at
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewayActivity: could not note a Thread's AI account", { cause }),
      ),
    );
    yield* PubSub.publish(changes, use);
  });

  return AiGatewayActivity.of({
    record: Effect.fn("AiGatewayActivity.record")(function* (request: GatewayRequestRecord) {
      tally(request, 1);
      yield* PubSub.publish(requests, request);
    }),
    unwritten: Effect.fn("AiGatewayActivity.unwritten")(function* (subject: string) {
      return yield* Effect.sync(() =>
        [...(pending.get(subject) ?? new Map<string, { tokens: number; requests: number }>())].map(
          ([day, entry]) => ({ day, tokens: entry.tokens, requests: entry.requests }),
        ),
      );
    }),
    settle: Effect.fn("AiGatewayActivity.settle")(function* (
      written: ReadonlyArray<GatewayRequestRecord>,
    ) {
      yield* Effect.sync(() => {
        for (const request of written) tally(request, -1);
      });
    }),
    subscribeRequests: Effect.map(PubSub.subscribe(requests), Stream.fromSubscription),
    noteInUse,
    subscribeAccountsInUse: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    inUse,
    forgetThread: Effect.fn("AiGatewayActivity.forgetThread")(function* (threadId: ThreadId) {
      yield* sql`DELETE FROM ai_gateway_thread_accounts WHERE thread_id = ${threadId}`.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("AiGatewayActivity: could not forget a Thread's AI account", {
            cause,
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(AiGatewayActivity, make);
