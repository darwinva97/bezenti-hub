/**
 * The machine's half of a preview the Hub serves (`HubPreviews.ts`): HTTP requests and WebSockets
 * to a dev server on this machine's own loopback, by port. A joined machine runs them for the Hub
 * over its Environment channel (`preview.proxyHttp`, `preview.proxySocket`); the Hub machine runs
 * them in process. Bodies travel as base64, in chunks small enough for one frame each.
 */
import * as NodeModule from "node:module";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Undici from "undici";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const undici = NodeModule.createRequire(import.meta.url)("undici") as typeof Undici;
const undiciFetch = undici.fetch;
const UndiciWebSocket = undici.WebSocket;
type UndiciWebSocket = Undici.WebSocket;

/** The largest body chunk one stream item carries. */
const PREVIEW_PROXY_CHUNK_BYTES = 64 * 1024;
/** The executor contract that brought these operations: an older machine does not know them. */
export const PREVIEW_PROXY_CONTRACT_VERSION = 8;
/** How long the dev server has to answer a request's head, or a WebSocket's handshake. */
const RESPONSE_HEAD_TIMEOUT = "30 seconds";
const SOCKET_HANDSHAKE_TIMEOUT = "15 seconds";
/** Messages from the dev server held for a Hub that has not taken them; past it the socket ends. */
const MAX_SOCKET_BACKLOG = 1_024;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const Path = Schema.String.check(Schema.isPattern(/^\//), Schema.isMaxLength(8_192));

export const PreviewProxyHeaders = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
export type PreviewProxyHeaders = typeof PreviewProxyHeaders.Type;

/**
 * The dev server could not be reached, was too slow, refused what was asked (`invalid`), or its
 * connection broke. `offline` and `outdated` are the Hub's: the machine is not connected, or its
 * T3 predates these operations.
 */
export class PreviewProxyError extends Schema.TaggedError<PreviewProxyError>()(
  "PreviewProxyError",
  {
    reason: Schema.Literals(["unreachable", "timeout", "invalid", "closed", "offline", "outdated"]),
    port: Schema.Number,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    switch (this.reason) {
      case "unreachable":
        return `Nothing answers on port ${this.port}.`;
      case "timeout":
        return `Port ${this.port} did not answer in time.`;
      case "invalid":
        return `The request could not be sent to port ${this.port}.`;
      case "closed":
        return `The connection to port ${this.port} closed.`;
      case "offline":
        return "The Environment is not connected.";
      case "outdated":
        return "The Environment's T3 is too old to serve previews through the Hub.";
    }
  }
}

/** undici refuses some methods and headers (CONNECT, TRACE, Expect) before it connects. */
const isRefusedRequest = (cause: unknown) =>
  // A connection that fails is "fetch failed"; a request undici will not send says why.
  cause instanceof TypeError && cause.message !== "fetch failed";

export const PreviewProxyHttpRequest = Schema.Struct({
  port: Port,
  method: Schema.String.check(Schema.isMaxLength(32)),
  /** Path and query on the dev server. */
  path: Path,
  headers: PreviewProxyHeaders,
  /** The request body, base64. */
  body: Schema.optionalKey(Schema.String),
});
export type PreviewProxyHttpRequest = typeof PreviewProxyHttpRequest.Type;

/** A response: its head first, then its body in chunks. */
export const PreviewProxyHttpItem = Schema.Union([
  Schema.TaggedStruct("head", { status: Schema.Int, headers: PreviewProxyHeaders }),
  Schema.TaggedStruct("chunk", { base64: Schema.String }),
]);
export type PreviewProxyHttpItem = typeof PreviewProxyHttpItem.Type;

export const PreviewProxySocketRequest = Schema.Struct({
  /** Chosen by the Hub: how its messages name this socket (`preview.proxySocketSend`). */
  connectionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  port: Port,
  path: Path,
  protocols: Schema.Array(Schema.String),
  headers: PreviewProxyHeaders,
});
export type PreviewProxySocketRequest = typeof PreviewProxySocketRequest.Type;

const SocketMessage = Schema.Union([
  Schema.TaggedStruct("text", { data: Schema.String }),
  Schema.TaggedStruct("binary", { base64: Schema.String }),
  Schema.TaggedStruct("close", { code: Schema.Int, reason: Schema.String }),
]);

/** A socket's life: opened (with the subprotocol the server chose), messages, then closed. */
export const PreviewProxySocketItem = Schema.Union([
  Schema.TaggedStruct("open", { protocol: Schema.String }),
  ...SocketMessage.members,
]);
export type PreviewProxySocketItem = typeof PreviewProxySocketItem.Type;

export const PreviewProxySocketSend = Schema.Struct({
  connectionId: Schema.String,
  message: SocketMessage,
});
export type PreviewProxySocketSend = typeof PreviewProxySocketSend.Type;

export interface PreviewProxyTarget {
  readonly http: (
    request: PreviewProxyHttpRequest,
  ) => Stream.Stream<PreviewProxyHttpItem, PreviewProxyError>;
  readonly socket: (
    request: PreviewProxySocketRequest,
  ) => Stream.Stream<PreviewProxySocketItem, PreviewProxyError>;
  readonly send: (input: PreviewProxySocketSend) => Effect.Effect<void, PreviewProxyError>;
}

const upstreamUrl = (scheme: "http" | "ws", port: number, path: string) =>
  `${scheme}://localhost:${port}${path}`;

const toChunks = (bytes: Uint8Array): ReadonlyArray<PreviewProxyHttpItem> => {
  const chunks: Array<PreviewProxyHttpItem> = [];
  for (let offset = 0; offset < bytes.byteLength; offset += PREVIEW_PROXY_CHUNK_BYTES) {
    chunks.push({
      _tag: "chunk",
      base64: Buffer.from(bytes.subarray(offset, offset + PREVIEW_PROXY_CHUNK_BYTES)).toString(
        "base64",
      ),
    });
  }
  return chunks;
};

/** A close code a WebSocket may send: the reserved ones (1005, 1006, 1015) read as a normal close. */
const sendableCloseCode = (code: number) =>
  code === 1000 ||
  (code >= 3000 && code <= 4999) ||
  (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)
    ? code
    : 1000;

/** Reaches dev servers on this machine's loopback. One per machine: it names the open sockets. */
export const makePreviewProxyTarget = (): PreviewProxyTarget => {
  const sockets = new Map<string, UndiciWebSocket>();

  const http: PreviewProxyTarget["http"] = (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const method = request.method.toUpperCase();
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            undiciFetch(upstreamUrl("http", request.port, request.path), {
              method,
              headers: request.headers.map(([name, value]) => [name, value] as [string, string]),
              ...(request.body === undefined || method === "GET" || method === "HEAD"
                ? {}
                : { body: Buffer.from(request.body, "base64") }),
              // The browser follows redirects itself, through the Hub.
              redirect: "manual",
              signal,
            }),
          catch: (cause) =>
            new PreviewProxyError({
              reason: isRefusedRequest(cause) ? "invalid" : "unreachable",
              port: request.port,
              detail: String(cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: RESPONSE_HEAD_TIMEOUT,
            orElse: () =>
              Effect.fail(new PreviewProxyError({ reason: "timeout", port: request.port })),
          }),
        );
        const head: PreviewProxyHttpItem = {
          _tag: "head",
          status: response.status,
          headers: [...response.headers.entries()],
        };
        const body = response.body;
        if (body === null) return Stream.make(head);
        return Stream.concat(
          Stream.make(head),
          Stream.fromReadableStream({
            evaluate: () => body,
            onError: (cause) =>
              new PreviewProxyError({
                reason: "closed",
                port: request.port,
                detail: String(cause),
              }),
          }).pipe(Stream.flatMap((bytes) => Stream.fromIterable(toChunks(bytes)))),
        );
      }),
    );

  const socket: PreviewProxyTarget["socket"] = (request) =>
    Stream.callback<PreviewProxySocketItem, PreviewProxyError>((queue) =>
      Effect.gen(function* () {
        const upstream = new UndiciWebSocket(upstreamUrl("ws", request.port, request.path), {
          protocols: [...request.protocols],
          headers: request.headers.map(([name, value]) => [name, value] as [string, string]),
        });
        upstream.binaryType = "arraybuffer";
        let opened = false;
        sockets.set(request.connectionId, upstream);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (sockets.get(request.connectionId) === upstream) {
              sockets.delete(request.connectionId);
            }
            if (upstream.readyState === UndiciWebSocket.CONNECTING) upstream.close();
            else if (upstream.readyState === UndiciWebSocket.OPEN) upstream.close(1000);
          }),
        );
        const fail = (reason: PreviewProxyError["reason"]) => {
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new PreviewProxyError({ reason, port: request.port })),
          );
          if (upstream.readyState <= UndiciWebSocket.OPEN) upstream.close();
        };
        // A dev server that never finishes the handshake does not hold the Hub's socket.
        yield* Effect.sleep(SOCKET_HANDSHAKE_TIMEOUT).pipe(
          Effect.andThen(Effect.sync(() => (opened ? undefined : fail("timeout")))),
          Effect.forkScoped,
        );
        upstream.addEventListener("open", () => {
          opened = true;
          Queue.offerUnsafe(queue, { _tag: "open", protocol: upstream.protocol });
        });
        upstream.addEventListener("message", (event) => {
          const data: unknown = event.data;
          // Bounded: a reader this far behind loses the socket instead of growing this queue.
          if (Queue.sizeUnsafe(queue) >= MAX_SOCKET_BACKLOG) return fail("closed");
          Queue.offerUnsafe(
            queue,
            typeof data === "string"
              ? { _tag: "text", data }
              : {
                  _tag: "binary",
                  base64: Buffer.from(data as ArrayBuffer).toString("base64"),
                },
          );
        });
        upstream.addEventListener("close", (event) => {
          if (!opened) {
            // A refused or failed handshake: nothing listens there, or it is not a WebSocket.
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new PreviewProxyError({ reason: "unreachable", port: request.port })),
            );
            return;
          }
          Queue.offerUnsafe(queue, {
            _tag: "close",
            code: sendableCloseCode(event.code),
            reason: event.reason,
          });
          Queue.endUnsafe(queue);
        });
      }),
    );

  const send: PreviewProxyTarget["send"] = ({ connectionId, message }) =>
    Effect.suspend(() => {
      const upstream = sockets.get(connectionId);
      if (upstream === undefined || upstream.readyState !== UndiciWebSocket.OPEN) {
        return Effect.fail(new PreviewProxyError({ reason: "closed", port: 0 }));
      }
      return Effect.try({
        try: () => {
          switch (message._tag) {
            case "text":
              return upstream.send(message.data);
            case "binary":
              return upstream.send(Buffer.from(message.base64, "base64"));
            case "close":
              return upstream.close(sendableCloseCode(message.code), message.reason);
          }
        },
        catch: (cause) =>
          new PreviewProxyError({ reason: "closed", port: 0, detail: String(cause) }),
      });
    });

  return { http, socket, send };
};
