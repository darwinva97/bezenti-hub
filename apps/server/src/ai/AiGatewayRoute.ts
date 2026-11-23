/**
 * `/api/ai/*` (spec 4 ticket 04): the HTTP door of the AI gateway. It reads the route and the key,
 * asks AiGatewayKeys who the request is, and hands the rest to AiGatewayProxy. Thin on purpose:
 * every other door reuses the proxy. docs/internals/ai-gateway.md.
 */
import { AI_GATEWAY_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AiGatewayProxy from "./AiGatewayProxy.ts";
import {
  errorBody,
  type GatewayShape,
  gatewayKeyOf,
  matchGatewayRoute,
  parseRequestPath,
} from "./gatewayShapes.ts";

/** Every answer of the layer: never compressed (that would hold SSE back) nor cached. */
const RESPONSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
};

const json = (status: number, body: unknown, extra: Readonly<Record<string, string>> = {}) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      ...(status === 401 ? { "www-authenticate": 'Bearer realm="T3 Code AI gateway"' } : {}),
      ...extra,
    },
  });

const shapeError = (shape: GatewayShape, status: number, message: string) =>
  json(status, errorBody(shape, status, message));

const shapeOf = (request: HttpServerRequest.HttpServerRequest): GatewayShape => {
  const url = parseRequestPath(request.url);
  return url === undefined ? "openai" : matchGatewayRoute(request.method, url.pathname).shape;
};

const handlerFor = (deps: {
  readonly keys: AiGatewayKeys.AiGatewayKeys["Service"];
  readonly proxy: AiGatewayProxy.AiGatewayProxy["Service"];
}) => {
  /** A request that ends before an account: its method, matched route and status, logged. */
  const refused = (
    request: HttpServerRequest.HttpServerRequest,
    route: string,
    shape: GatewayShape,
    status: number,
    message: string,
  ) =>
    Effect.logInfo("AI gateway request refused").pipe(
      Effect.annotateLogs({ method: request.method, route, status }),
      Effect.as(shapeError(shape, status, message)),
    );

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = parseRequestPath(request.url);
    if (url === undefined) return yield* refused(request, "unknown", "openai", 400, "Bad request.");
    const route = matchGatewayRoute(request.method, url.pathname);
    if (route._tag === "not-found") {
      return yield* refused(request, "unknown", route.shape, 404, "Not found.");
    }
    if (route._tag === "method-not-allowed") {
      return yield* refused(request, "unknown", route.shape, 405, "Method not allowed.");
    }
    const shape = route.shape;
    // A key in the query string would reach logs and proxies: never accepted, even a valid one.
    if (url.searchParams.has("key") || url.searchParams.has("api_key")) {
      return yield* refused(
        request,
        route.route,
        shape,
        401,
        "Send the AI gateway key in a header, not in the address.",
      );
    }
    const lookup = gatewayKeyOf(shape, request.headers);
    if (lookup._tag !== "key") {
      return yield* refused(
        request,
        route.route,
        shape,
        401,
        lookup._tag === "ambiguous"
          ? "Send one AI gateway key."
          : "This request needs an AI gateway key.",
      );
    }
    const caller = yield* deps.keys.authorize(Redacted.make(lookup.key)).pipe(Effect.result);
    if (caller._tag === "Failure") {
      return yield* refused(
        request,
        route.route,
        shape,
        caller.failure.status,
        caller.failure.message,
      );
    }
    const answer = yield* deps.proxy.forward({
      caller: caller.success,
      route,
      method: request.method,
      sse: url.searchParams.get("alt") === "sse",
      headers: request.headers,
      body: request.stream,
    });
    if (answer._tag === "json") {
      if (answer.status >= 400) {
        yield* Effect.logInfo("AI gateway request refused").pipe(
          Effect.annotateLogs({
            method: request.method,
            route: route.route,
            status: answer.status,
          }),
        );
      }
      return json(answer.status, answer.body, answer.headers);
    }
    return HttpServerResponse.stream(answer.body, {
      status: answer.status,
      headers: RESPONSE_HEADERS,
      contentType: answer.contentType,
    });
    // The slots and the upstream request live in the request's scope: until the answer is sent.
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // A client that went away is not a failure of the gateway.
        if (!Cause.hasInterruptsOnly(cause)) {
          yield* Effect.logWarning("AI gateway request failed", { cause });
        }
        return shapeError(shapeOf(request), 502, "The AI gateway failed.");
      }),
    ),
  );
  return handler;
};

/** Registered on a Hub that keeps AI accounts; a joined machine serves none of `/api/ai/*`. */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const keys = yield* Effect.serviceOption(AiGatewayKeys.AiGatewayKeys);
    const proxy = yield* Effect.serviceOption(AiGatewayProxy.AiGatewayProxy);
    if (Option.isNone(keys) || Option.isNone(proxy)) return;
    const handler = handlerFor({ keys: keys.value, proxy: proxy.value });
    yield* router.add("*", `${AI_GATEWAY_ROUTE_PREFIX}/*`, handler);
  }),
);
