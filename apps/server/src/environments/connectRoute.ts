/**
 * `/api/environment/connect`: the one socket each joined Environment keeps open to the Hub. The
 * upgrade is accepted before the credential is checked, so every refusal reaches the machine as a
 * close code it can explain (`ENVIRONMENT_CLOSE_REASONS`) instead of a bare failed handshake.
 */
import {
  ENVIRONMENT_CLOSE_REASONS,
  ENVIRONMENT_CONNECT_PATH,
  ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
  ENVIRONMENT_HELLO_TIMEOUT_MS,
  ENVIRONMENT_RECONNECTING_AFTER_MS,
  type EnvironmentCloseReason,
  type EnvironmentId,
  EnvironmentToHubFrame,
  type EnvironmentWelcomeFrame,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentConnections from "./EnvironmentConnections.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { bearerOf, isSecureEnvironmentTransport } from "./http.ts";
import { type FrameReader, makeFrameReader } from "./socketFrames.ts";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentToHubFrame));
const encodeWelcome = (frame: EnvironmentWelcomeFrame) => JSON.stringify(frame);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

type SessionEnd = EnvironmentCloseReason | "peer-closed";

// The request span covers the whole session; frames are too frequent for spans of their own.
const makeHandler = Effect.fnUntraced(function* (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  connections: EnvironmentConnections.EnvironmentConnections["Service"],
  remote: Option.Option<RemoteEnvironments.RemoteEnvironments["Service"]>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Upgrade Required", { status: 426 });
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      // The handshake completes when the reader is acquired; a close written before it is lost.
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const closeWith = (reason: EnvironmentCloseReason) =>
        writer
          .write(new Socket.CloseEvent(ENVIRONMENT_CLOSE_REASONS[reason].code, reason))
          .pipe(Effect.ignore);

      if (!isSecureEnvironmentTransport(request)) return yield* closeWith("insecure-transport");
      const credential = bearerOf(request.headers.authorization);
      const check = yield* registry.checkCredential(credential);
      if (check._tag === "refused") return yield* closeWith(check.reason);
      const { environmentId } = check;

      const nextFrame = makeFrameReader(reader);
      const helloText = yield* nextFrame.pipe(
        Effect.timeoutOption(ENVIRONMENT_HELLO_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(helloText)) return yield* closeWith("hello-timeout");
      // The version is read before the frame is decoded: another version may change its shape.
      const raw = parseJson(helloText.value);
      const version =
        typeof raw === "object" && raw !== null && "protocolVersion" in raw
          ? raw.protocolVersion
          : undefined;
      if (version !== undefined && version !== ENVIRONMENT_CONNECTION_PROTOCOL_VERSION) {
        return yield* closeWith("incompatible-version");
      }
      const hello = decodeFrame(helloText.value);
      if (Option.isNone(hello) || hello.value.type !== "hello") {
        return yield* closeWith("protocol-error");
      }
      // A dedicated machine runs its Space's work only in its Sandbox container, whose server
      // alone holds the credential that connects (`checkCredential`) and says so in its hello.
      // So does a Sandbox on a lent machine (Grants): its host's own server never connects as it.
      if ((check.mode === "dedicated" || check.lent) && hello.value.sandbox === undefined) {
        return yield* closeWith("not-sandboxed");
      }
      const closeRequested = yield* Deferred.make<EnvironmentCloseReason>();
      const attached = yield* connections.attach(environmentId, (reason) =>
        Deferred.succeed(closeRequested, reason).pipe(Effect.asVoid),
      );
      // Asked again once the socket is tracked: a removal since the upgrade found nothing to
      // close, and one from now on closes it.
      const current = yield* registry.checkCredential(credential);
      if (current._tag === "refused") return yield* closeWith(current.reason);
      // Dedicated since the first check: the gate applies to what it is welcomed as.
      if (current.mode === "dedicated" && hello.value.sandbox === undefined) {
        return yield* closeWith("not-sandboxed");
      }
      yield* registry.recordHello(environmentId, hello.value);
      yield* writer.write(
        encodeWelcome({
          type: "welcome",
          protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
          hubEnvironmentId: registry.hubId,
          environmentId,
          name: current.name,
          mode: current.mode,
          ...(current.spaceId === null ? {} : { spaceId: current.spaceId }),
        }),
      );
      // After the welcome, so the machine reads its welcome before any request.
      const connection = Option.isNone(remote)
        ? undefined
        : yield* remote.value.connect({
            environmentId,
            hello: hello.value,
            write: (text) => writer.write(text).pipe(Effect.ignore),
          });
      yield* attached.markReady;
      const end = yield* Effect.raceFirst(
        Deferred.await(closeRequested),
        receive(environmentId, nextFrame, registry, connection),
      );
      // A removed machine will not come back: its sessions end with the socket.
      if (end === "environment-removed" || end === "owner-inactive") {
        yield* connection?.retireOnClose ?? Effect.void;
      }
      if (end !== "peer-closed") yield* closeWith(end);
    }).pipe(
      Effect.catchTags({
        EnvironmentStorageError: (error) =>
          Effect.logWarning("environment connection failed", { cause: error.cause }),
      }),
      Effect.ignore,
    ),
  ).pipe(Effect.as(HttpServerResponse.empty()));
});

const receive = Effect.fn("EnvironmentConnection.receive")(function* (
  environmentId: EnvironmentId,
  nextFrame: FrameReader,
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  connection: RemoteEnvironments.RemoteConnection | undefined,
): Effect.fn.Return<SessionEnd, EnvironmentRegistry.EnvironmentStorageError> {
  while (true) {
    const text = yield* nextFrame.pipe(
      Effect.timeoutOption(ENVIRONMENT_RECONNECTING_AFTER_MS),
      Effect.catchTags({ SocketError: () => Effect.succeed(undefined) }),
    );
    if (text === undefined) return "peer-closed" as const;
    if (Option.isNone(text)) return "heartbeat-timeout" as const;
    const frame = decodeFrame(text.value);
    if (Option.isNone(frame)) return "protocol-error" as const;
    if (frame.value.type === "heartbeat") {
      yield* registry.recordHeartbeat(environmentId, frame.value);
      yield* connection?.heartbeat(frame.value) ?? Effect.void;
    } else if (frame.value.type !== "hello" && connection !== undefined) {
      yield* connection.receive(frame.value);
    }
    // Events are acknowledged in batches: once the frames that arrived together are handled.
    if (connection !== undefined && nextFrame.buffered() === 0) yield* connection.flushAcks;
  }
});

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const connections = yield* EnvironmentConnections.EnvironmentConnections;
    // Absent where the Hub runs no orchestration (the join flow's tests): sockets only say hello.
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    yield* router.add("GET", ENVIRONMENT_CONNECT_PATH, makeHandler(registry, connections, remote));
  }),
);
