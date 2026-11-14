/**
 * The AI gateway's work for one authorized request (spec 4 ticket 04), whatever door it came by:
 * read the body under a deadline, plan the route, hold a slot, pin `acct-<id>/<model>`, fail over
 * on 429 within one provider, stream the answer through the tap and record it. docs: ai-gateway.md.
 */
import type { AiAccountId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import type { GatewayCaller } from "./AiGatewayKeys.ts";
import {
  bodyTemplate,
  CHOSEN_NOT_ALLOWED,
  errorBody,
  FORWARDED_REQUEST_HEADERS,
  type GatewayRoute,
  type GatewayShape,
  modelListBody,
  noQuotaMessage,
  parseJsonObject,
  parseRequestedModel,
  planRoute,
  type RoutableAccount,
  systemForDeveloper,
  upstreamErrorMessage,
  upstreamModelOf,
} from "./gatewayShapes.ts";
import { makeResponseTap } from "./gatewayTap.ts";

export interface AiGatewayProxyLimits {
  /** A body over this is refused (413) before CLIProxyAPI sees any of it. */
  readonly maxRequestBytes: number;
  /** A body must arrive whole within this, and never pause longer than `bodyIdleMs`. */
  readonly bodyDeadlineMs: number;
  readonly bodyIdleMs: number;
  /** Bodies being read at once, per User and for the Hub. */
  readonly readersPerUser: number;
  readonly readersTotal: number;
  /** Requests in flight at once: per key, per User, for the Hub. */
  readonly perKey: number;
  readonly perUser: number;
  readonly total: number;
  /** Request bytes held at once by the Hub (bodies and their copies), 503 beyond. */
  readonly bufferedBytesTotal: number;
  /** To the answer's first byte; the whole answer; a pause upstream; a client not reading. */
  readonly firstByteMs: number;
  readonly answerMs: number;
  readonly upstreamIdleMs: number;
  readonly clientStallMs: number;
  /** An upstream error (or 429) body is read for at most this long and 64 KiB. */
  readonly errorReadMs: number;
}

const MINUTE = 60_000;
export const DEFAULT_AI_GATEWAY_PROXY_LIMITS: AiGatewayProxyLimits = {
  maxRequestBytes: 32 * 1024 * 1024,
  bodyDeadlineMs: MINUTE,
  bodyIdleMs: 15_000,
  readersPerUser: 8,
  readersTotal: 64,
  perKey: 16,
  perUser: 32,
  total: 256,
  bufferedBytesTotal: 512 * 1024 * 1024,
  firstByteMs: 10 * MINUTE,
  answerMs: 60 * MINUTE,
  upstreamIdleMs: 5 * MINUTE,
  clientStallMs: 2 * MINUTE,
  errorReadMs: 10_000,
};

/** A body is held about three times over (bytes, parsed, the rewritten copy): counted so. */
const COPIES_PER_BODY = 3;
const ERROR_BODY_LIMIT = 64 * 1024;

export interface ProxyRequest {
  readonly caller: GatewayCaller;
  readonly route: Extract<GatewayRoute, { readonly _tag: "models" | "proxy" }>;
  readonly method: string;
  /** Gemini's `alt=sse`: the only query parameter that crosses. */
  readonly sse: boolean;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Stream.Stream<Uint8Array, StreamFailure>;
}

export type ProxyAnswer =
  | { readonly _tag: "json"; readonly status: number; readonly body: unknown }
  | {
      readonly _tag: "stream";
      readonly status: number;
      readonly contentType: string;
      readonly body: Stream.Stream<Uint8Array, StreamFailure>;
    };

export class AiGatewayProxy extends Context.Service<
  AiGatewayProxy,
  {
    /** The answer to one authorized request; its slot and upstream call live in the scope. */
    readonly forward: (request: ProxyRequest) => Effect.Effect<ProxyAnswer, never, Scope.Scope>;
  }
>()("t3/ai/AiGatewayProxy") {}

const refuse = (shape: GatewayShape, status: number, message: string): ProxyAnswer => ({
  _tag: "json",
  status,
  body: errorBody(shape, status, message),
});

class BodyRefused extends Schema.TaggedError<BodyRefused>()("BodyRefused", {
  status: Schema.Literals([408, 413, 503]),
  message: Schema.String,
}) {}

const isBodyRefused = Schema.is(BodyRefused);

/** An answer stopped by the gateway: its deadline, a silent upstream, a client not reading. */
class AnswerCut extends Schema.TaggedError<AnswerCut>()("AnswerCut", {
  reason: Schema.Literals(["answer-deadline", "upstream-idle", "client-stalled"]),
}) {}

/** Whatever a body stream may fail with: an HTTP error of either side, or a cut. */
type StreamFailure = { readonly _tag: string };

/** Counters for the gateway's pools: a key, a User and the Hub; taken all or none. */
const makePool = (limits: { perKey?: number; perUser: number; total: number }) => {
  const byKey = new Map<string, number>();
  const byUser = new Map<string, number>();
  let total = 0;
  const bump = (map: Map<string, number>, id: string, by: number) => {
    const next = (map.get(id) ?? 0) + by;
    if (next <= 0) map.delete(id);
    else map.set(id, next);
  };
  return {
    take: (keyId: string, userId: string) => {
      if (
        (limits.perKey !== undefined && (byKey.get(keyId) ?? 0) >= limits.perKey) ||
        (byUser.get(userId) ?? 0) >= limits.perUser ||
        total >= limits.total
      ) {
        return false;
      }
      bump(byKey, keyId, 1);
      bump(byUser, userId, 1);
      total += 1;
      return true;
    },
    give: (keyId: string, userId: string) => {
      bump(byKey, keyId, -1);
      bump(byUser, userId, -1);
      total -= 1;
    },
  };
};

const make = Effect.fn("AiGatewayProxy.make")(function* (limits: AiGatewayProxyLimits) {
  {
    const accounts = yield* AiAccounts.AiAccounts;
    const gateway = yield* AiGateway.AiGateway;
    const activity = yield* AiGatewayActivity.AiGatewayActivity;
    const httpClient = yield* HttpClient.HttpClient;
    const slots = makePool({ perKey: limits.perKey, perUser: limits.perUser, total: limits.total });
    const readers = makePool({ perUser: limits.readersPerUser, total: limits.readersTotal });
    let buffered = 0;

    /** Takes a slot of `pool` for the scope; false when none is free. */
    const hold = (pool: ReturnType<typeof makePool>, caller: GatewayCaller) =>
      Effect.acquireRelease(
        Effect.sync(() => pool.take(caller.keyId, caller.userId)),
        (taken) => Effect.sync(() => (taken ? pool.give(caller.keyId, caller.userId) : undefined)),
      );

    /** Bytes held for the scope, within the Hub's budget. */
    const reserve = (bytes: number) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (buffered + bytes > limits.bufferedBytesTotal) return false;
          buffered += bytes;
          return true;
        }),
        (taken) => Effect.sync(() => (taken ? void (buffered -= bytes) : undefined)),
      );

    /** The body, under its deadline and the Hub's budget; refused before any slot is held. */
    const readBody = Effect.fn("AiGatewayProxy.readBody")(function* (
      request: ProxyRequest,
    ): Effect.fn.Return<Buffer, BodyRefused, Scope.Scope> {
      const declared = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > limits.maxRequestBytes) {
        return yield* new BodyRefused({ status: 413, message: "The request is too large." });
      }
      const chunks: Array<Uint8Array> = [];
      let size = 0;
      yield* Stream.runForEach(
        request.body.pipe(
          Stream.timeoutOrElse({
            duration: limits.bodyIdleMs,
            orElse: () =>
              Stream.fail(
                new BodyRefused({ status: 408, message: "The request body stopped arriving." }),
              ),
          }),
        ),
        (chunk) =>
          Effect.gen(function* () {
            size += chunk.length;
            if (size > limits.maxRequestBytes) {
              return yield* new BodyRefused({ status: 413, message: "The request is too large." });
            }
            if (!(yield* reserve(chunk.length * COPIES_PER_BODY))) {
              return yield* new BodyRefused({
                status: 503,
                message: "The AI gateway is busy. Try again shortly.",
              });
            }
            chunks.push(chunk);
          }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: limits.bodyDeadlineMs,
          orElse: () =>
            Effect.fail(
              new BodyRefused({
                status: 408,
                message: "The request body took too long to arrive.",
              }),
            ),
        }),
        Effect.mapError((error) =>
          isBodyRefused(error)
            ? error
            : new BodyRefused({ status: 408, message: "The request body could not be read." }),
        ),
      );
      return Buffer.concat(chunks);
    });

    /** What an upstream error or 429 said, at most 64 KiB, for at most `errorReadMs`. */
    const readError = Effect.fn("AiGatewayProxy.readError")(function* (
      stream: Stream.Stream<Uint8Array, StreamFailure>,
    ) {
      let text = "";
      yield* Stream.runForEach(
        stream.pipe(Stream.takeWhile(() => text.length < ERROR_BODY_LIMIT)),
        (chunk) =>
          Effect.sync(() => {
            text += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              .toString("utf8")
              .slice(0, ERROR_BODY_LIMIT - text.length);
          }),
      ).pipe(Effect.timeout(limits.errorReadMs), Effect.ignore);
      return text;
    });

    const modelsOf = (accountId: AiAccountId) =>
      accounts.modelsOf(accountId).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

    /**
     * An answer that cannot outlive its deadline, a stalled upstream or a client that stops
     * reading (it is pulled only once the client took the previous chunk).
     */
    const guarded = Effect.fn("AiGatewayProxy.guarded")(function* (
      upstream: Stream.Stream<Uint8Array, StreamFailure>,
    ) {
      const pull = yield* Stream.toPull(upstream);
      const started = yield* Clock.currentTimeMillis;
      const state = { waitingForClient: false, since: started };
      const mark = (waitingForClient: boolean) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          state.waitingForClient = waitingForClient;
          state.since = now;
        });
      // Asked again only once the client took the last chunk; between the two, it is its turn.
      const next = mark(false).pipe(
        Effect.andThen(pull),
        Effect.tap(() => mark(true)),
      );
      const tick = Math.max(
        25,
        Math.min(limits.clientStallMs, limits.upstreamIdleMs, limits.answerMs) / 4,
      );
      const watchdog = Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(tick);
          const now = yield* Clock.currentTimeMillis;
          if (now - started > limits.answerMs) return "answer-deadline" as const;
          const quiet = now - state.since;
          if (state.waitingForClient && quiet > limits.clientStallMs)
            return "client-stalled" as const;
          if (!state.waitingForClient && quiet > limits.upstreamIdleMs)
            return "upstream-idle" as const;
        }
      }).pipe(
        Effect.tap((reason) =>
          Effect.logInfo("AI gateway answer cut").pipe(Effect.annotateLogs({ reason })),
        ),
        Effect.flatMap((reason) => Effect.fail(new AnswerCut({ reason }))),
      );
      return Stream.fromPull(Effect.succeed(next)).pipe(Stream.interruptWhen(watchdog));
    });

    const forward = Effect.fn("AiGatewayProxy.forward")(function* (request: ProxyRequest) {
      const { caller, route } = request;
      const shape = route.shape;
      const startedAt = yield* DateTime.now;
      const allowed: ReadonlyArray<RoutableAccount> = caller.allowed;
      const chosenGone =
        caller.chosenAccountId !== null &&
        !allowed.some((account) => account.id === caller.chosenAccountId);

      if (route._tag === "models") {
        // The same answer as a call: a Thread whose account is gone lists nothing else instead.
        if (chosenGone) return refuse(shape, 403, CHOSEN_NOT_ALLOWED);
        const listed =
          caller.chosenAccountId !== null
            ? allowed.filter((account) => account.id === caller.chosenAccountId)
            : allowed;
        const models = yield* Effect.forEach(listed, (account) => modelsOf(account.id), {
          concurrency: "unbounded",
        });
        return {
          _tag: "json",
          status: 200,
          body: modelListBody(shape, models.flat()),
        } satisfies ProxyAnswer;
      }

      let recorded = false;
      // Only a model the plan accepted is kept: a refused name is the client's, never stored.
      let model: string | null = null;
      let failovers = 0;
      let lastAccount: RoutableAccount | null = null;
      const record = Effect.fn("AiGatewayProxy.record")(
        function* (input: {
          readonly account: RoutableAccount | null;
          readonly status: number;
          readonly failovers: number;
          readonly usage: AiGatewayActivity.GatewayRequestRecord["usage"];
          readonly shed?: true;
        }) {
          if (recorded) return;
          recorded = true;
          const endedAt = yield* DateTime.now;
          const entry: AiGatewayActivity.GatewayRequestRecord = {
            at: DateTime.formatIso(startedAt),
            keyId: caller.keyId,
            keyKind: caller.kind,
            userId: caller.userId,
            spaceId: caller.spaceId,
            threadId: caller.threadId,
            shape,
            route: route.route,
            accountId: input.account?.id ?? null,
            provider: input.account?.provider ?? null,
            model: model,
            status: input.status,
            durationMs: DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(startedAt),
            failovers: input.failovers,
            usage: input.usage,
            ...(input.shed === true ? { shed: true as const } : {}),
          };
          // Method, route, account, model, status and tokens: never a key, a header or a body.
          // A refusal is already logged by the route: debug here, so it is not logged twice.
          yield* (
            input.shed === true || (input.status >= 400 && input.account === null)
              ? Effect.logDebug
              : Effect.logInfo
          )("AI gateway request").pipe(
            Effect.annotateLogs({
              method: request.method,
              route: route.route,
              account: entry.accountId ?? "none",
              model: model,
              status: input.status,
              failovers: input.failovers,
              inputTokens: input.usage?.inputTokens ?? null,
              outputTokens: input.usage?.outputTokens ?? null,
            }),
          );
          yield* activity.record(entry);
        },
        (effect, input) =>
          effect.pipe(
            Effect.withSpan("AiGateway.request", {
              attributes: {
                "http.request.method": request.method,
                "t3.ai.route": route.route,
                "t3.ai.account": input.account?.id ?? "none",
                "t3.ai.model": model,
                "http.response.status_code": input.status,
                "t3.ai.failovers": input.failovers,
                "t3.ai.input_tokens": input.usage?.inputTokens ?? -1,
                "t3.ai.output_tokens": input.usage?.outputTokens ?? -1,
              },
            }),
          ),
      );

      /**
       * A refusal after authentication is still a request: counted as failed, no tokens. A limit
       * (429) is shed load: it only adds to the daily summary, so a flood cannot fill the log.
       */
      const refuseRecorded = (status: number, message: string) =>
        record({
          account: lastAccount,
          status,
          failovers,
          usage: null,
          ...(status === 429 ? { shed: true as const } : {}),
        }).pipe(Effect.as(refuse(shape, status, message)));
      // A request that never got an answer is counted too, unless an answer recorded it: 499 when
      // the client left, 502 when the Hub itself failed (the client is answered 502).
      yield* Effect.addFinalizer((exit) =>
        record({
          account: lastAccount,
          status: Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? 502 : 499,
          failovers,
          usage: null,
        }),
      );

      const endpoint = yield* gateway.endpoint;
      if (Option.isNone(endpoint)) {
        return yield* refuseRecorded(503, "The AI gateway is not running.");
      }
      if (request.headers["content-encoding"] !== undefined) {
        return yield* refuseRecorded(415, "Send the request body uncompressed.");
      }
      // The body first, in a small pool of its own: a slow sender holds no request slot.
      if (!readers.take(caller.keyId, caller.userId)) {
        return yield* refuseRecorded(
          429,
          "Too many requests to the AI gateway at once. Try again.",
        );
      }
      const body = yield* readBody(request).pipe(
        Effect.ensuring(Effect.sync(() => readers.give(caller.keyId, caller.userId))),
        Effect.result,
      );
      if (body._tag === "Failure") {
        return yield* refuseRecorded(body.failure.status, body.failure.message);
      }
      const json = parseJsonObject(body.success);
      if (json === undefined) {
        return yield* refuseRecorded(400, "The request body must be a JSON object.");
      }
      const requested = parseRequestedModel(route.pathModel ?? json.model);
      const served = new Map(
        yield* Effect.forEach(
          allowed,
          (account) =>
            Effect.map(modelsOf(account.id), (models) => [account.id, new Set(models)] as const),
          { concurrency: "unbounded" },
        ),
      );
      const plan = planRoute({
        allowed,
        chosenAccountId: caller.chosenAccountId,
        keyKind: caller.kind,
        requested,
        serves: (accountId, model) => served.get(accountId)?.has(model) === true,
      });
      if (plan._tag === "refused") return yield* refuseRecorded(plan.status, plan.message);
      model = plan.model;
      if (!(yield* hold(slots, caller))) {
        return yield* refuseRecorded(
          429,
          "Too many requests to the AI gateway at once. Try again.",
        );
      }

      // OpenAI streams carry their tokens only when asked: the Hub asks, and hides that chunk
      // from a client that did not.
      const streamOptions = json.stream_options as Record<string, unknown> | undefined;
      const askUsage =
        shape === "openai" &&
        route.route.endsWith("/chat/completions") &&
        json.stream === true &&
        streamOptions?.include_usage !== true;
      const asked = askUsage
        ? { ...json, stream_options: { ...streamOptions, include_usage: true } }
        : json;
      const plainBody = route.pathModel === undefined ? bodyTemplate(asked) : () => body.success;
      // An OpenAI-compatible upstream is asked with `system` for `developer`; written at most once.
      let compatibleBody: ReturnType<typeof bodyTemplate> | undefined;
      const bodyFor = (account: RoutableAccount, upstreamModel: string) => {
        if (
          shape !== "openai" ||
          route.pathModel !== undefined ||
          account.provider !== "openai-compatible"
        ) {
          return plainBody(upstreamModel);
        }
        compatibleBody ??= bodyTemplate(systemForDeveloper(asked));
        return compatibleBody(upstreamModel);
      };
      const forwarded: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (value !== undefined) forwarded[name] = value;
      }
      const query = shape === "gemini" && request.sse ? "?alt=sse" : "";
      const client = HttpClient.withScope(httpClient);
      const send = (account: RoutableAccount) => {
        const upstreamModel = upstreamModelOf(account.id, plan.model);
        return client
          .execute(
            HttpClientRequest.post(
              `${endpoint.value.baseUrl}${route.upstreamPath(upstreamModel)}${query}`,
            ).pipe(
              HttpClientRequest.setHeaders({ ...forwarded, "accept-encoding": "identity" }),
              HttpClientRequest.bearerToken(Redacted.value(endpoint.value.clientKey)),
              HttpClientRequest.bodyUint8Array(bodyFor(account, upstreamModel), "application/json"),
            ),
          )
          .pipe(
            // An upstream redirect is never followed (it would be a request the Hub did not plan).
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.timeout(limits.firstByteMs),
            Effect.result,
          );
      };

      for (const [index, account] of plan.candidates.entries()) {
        lastAccount = account;
        const sent = yield* send(account);
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("AI gateway: CLIProxyAPI did not answer").pipe(
            Effect.annotateLogs({ route: route.route, account: account.id }),
          );
          yield* record({ account, status: 502, failovers, usage: null });
          return refuse(shape, 502, "The AI gateway did not answer. Try again.");
        }
        const response = sent.success;
        if (response.status === 429) {
          yield* readError(response.stream);
          if (index < plan.candidates.length - 1) {
            failovers += 1;
            continue;
          }
          yield* record({ account, status: 429, failovers, usage: null });
          return refuse(shape, 429, noQuotaMessage(plan.candidates[0]!.provider));
        }
        if (response.status < 200 || response.status >= 300) {
          const text = yield* readError(response.stream);
          // CLIProxyAPI refusing the Hub's own key, or answering 1xx/3xx, is the Hub's problem.
          const status =
            response.status === 401 || response.status === 403 || response.status < 400
              ? 502
              : response.status;
          yield* record({ account, status, failovers, usage: null });
          return refuse(shape, status, upstreamErrorMessage(response.status, text));
        }
        // Counting tokens is not using the account: the Thread's header does not move for it.
        if (caller.threadId !== null && !route.route.endsWith("/count_tokens")) {
          yield* activity.noteInUse({
            threadId: caller.threadId,
            accountId: account.id,
            model: plan.model,
            provider: account.provider,
          });
        }
        const contentType = response.headers["content-type"] ?? "application/json";
        const tap = makeResponseTap({
          sse: /text\/event-stream/iu.test(contentType),
          prefix: upstreamModelOf(account.id, "").slice(0, -1),
          dropUsageChunks: askUsage,
        });
        // Recorded even if the answer is never read (the client left before it).
        yield* Effect.addFinalizer(() =>
          record({ account, status: response.status, failovers, usage: null }),
        );
        let finished = false;
        const answer = (yield* guarded(response.stream)).pipe(
          Stream.map(tap.chunk),
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                finished = true;
                return tap.end();
              }),
            ),
          ),
          Stream.filter((chunk) => chunk.length > 0),
          // Tokens only from an answer that ended: one cut off counts the request, not its tokens.
          Stream.ensuring(
            Effect.suspend(() =>
              record({
                account,
                status: response.status,
                failovers,
                usage: finished ? tap.usage() : null,
              }),
            ),
          ),
        );
        return {
          _tag: "stream",
          status: response.status,
          contentType,
          body: answer,
        } satisfies ProxyAnswer;
      }
      return yield* refuseRecorded(503, "No AI account could serve this request.");
    });

    return AiGatewayProxy.of({ forward });
  }
});

/** With these limits (tests); `layer` reads the body limit from the environment. */
export const layerWith = (limits: AiGatewayProxyLimits) =>
  Layer.effect(AiGatewayProxy, make(limits));

export const layer = Layer.effect(
  AiGatewayProxy,
  Effect.gen(function* () {
    const maxRequestBytes = yield* Config.Int("T3CODE_AI_GATEWAY_MAX_REQUEST_BYTES").pipe(
      Config.withDefault(DEFAULT_AI_GATEWAY_PROXY_LIMITS.maxRequestBytes),
    );
    return yield* make({ ...DEFAULT_AI_GATEWAY_PROXY_LIMITS, maxRequestBytes });
  }),
);
