// @effect-diagnostics nodeBuiltinImport:off -- statfs has no Effect FileSystem equivalent.
/**
 * Joined mode: a server that `t3 join` attached to a Hub. It serves no clients, sign-in or user
 * WebSocket; it keeps one outbound socket to the Hub and answers `/health` on loopback, which
 * `t3 status` reads. See docs/internals/environment-auth.md#joined-environments.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import {
  ENVIRONMENT_CLOSE_MESSAGES,
  ENVIRONMENT_CLOSE_REASONS,
  ENVIRONMENT_CONNECT_PATH,
  ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  ENVIRONMENT_HEARTBEAT_INTERVAL_MS,
  type EnvironmentCloseReason,
  environmentCloseReasonOf,
  type EnvironmentDiskSpace,
  EnvironmentHeartbeatFrame,
  EnvironmentHelloFrame,
  type EnvironmentId,
  type EnvironmentProviderSummary,
  EnvironmentWelcomeFrame,
  type HostResourcesSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Random from "effect/Random";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import * as EnvironmentAgent from "./EnvironmentAgent.ts";
import { makeFrameReader } from "./socketFrames.ts";
import {
  DEDICATED_CREDENTIAL_SECRET,
  ENVIRONMENT_CREDENTIAL_SECRET,
  type JoinedHubState,
  writeJoinedHubState,
} from "./joinedHubState.ts";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export const toProviderSummary = (provider: ServerProvider): EnvironmentProviderSummary => ({
  instanceId: provider.instanceId,
  provider: provider.driver,
  displayName: provider.displayName ?? null,
  enabled: provider.enabled,
  installed: provider.installed,
  version: provider.version,
  capabilities: {
    runtimeModes: [...(provider.supportedRuntimeModes ?? [])],
    conversationRollback: provider.supportsConversationRollback ?? false,
    textGeneration: provider.supportsTextGeneration ?? false,
  },
});

export const readDiskSpace = (directory: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(directory)).pipe(
    Effect.map((stats): EnvironmentDiskSpace => ({
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    })),
    Effect.orElseSucceed(() => null),
  );

/** Exponential with full jitter in its upper half, so machines a Hub restart drops spread out. */
const reconnectDelayMs = (attempt: number, unit: number) => {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + (ceiling / 2) * unit);
};

export interface ConnectionOutcome {
  /** The Hub accepted this machine before the connection ended. */
  readonly welcomed: boolean;
  /** Why the Hub closed it, when it said. */
  readonly reason: EnvironmentCloseReason | undefined;
  readonly message: string;
}

const encodeHello = Schema.encodeSync(Schema.fromJsonString(EnvironmentHelloFrame));
const encodeHeartbeat = Schema.encodeSync(Schema.fromJsonString(EnvironmentHeartbeatFrame));
const decodeWelcome = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentWelcomeFrame));

const parseFrame = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      // An unhandled `error` on a failed dial would exit the process; the reader reports it.
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

/** One connection to the Hub, from dial to close: hello, welcome, then heartbeats. */
export const connectOnce = Effect.fn("JoinedHub.connectOnce")(function* (input: {
  readonly hubUrl: string;
  readonly credential: string;
  readonly expectedHubId: EnvironmentId;
  readonly hello: Effect.Effect<EnvironmentHelloFrame>;
  readonly heartbeat: Effect.Effect<EnvironmentHeartbeatFrame>;
  readonly onWelcome: (welcome: EnvironmentWelcomeFrame) => Effect.Effect<void>;
  /** Serves the Hub's requests on this connection; without it, frames after welcome are read and dropped. */
  readonly serve?: (
    write: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<
    { readonly receive: (frame: unknown) => Effect.Effect<boolean> },
    never,
    Scope.Scope
  >;
}) {
  const url = new URL(ENVIRONMENT_CONNECT_PATH, input.hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const welcomed = yield* Ref.make(false);
  const socket = yield* Socket.makeWebSocket(url.toString(), {
    openTimeout: "15 seconds",
    headers: { authorization: `Bearer ${input.credential}` },
  }).pipe(Effect.provide(webSocketConstructor));
  const session = Effect.scoped(
    Effect.gen(function* () {
      const nextFrame = makeFrameReader(yield* socket.reader);
      const writer = yield* socket.writer;
      yield* writer.write(encodeHello(yield* input.hello));
      const welcome = decodeWelcome(yield* nextFrame);
      if (Option.isNone(welcome)) {
        return {
          welcomed: false,
          reason: "protocol-error",
          message: "The Hub did not welcome this machine.",
        } satisfies ConnectionOutcome;
      }
      // The address may now answer as another Hub; this machine's credential is not for it.
      if (welcome.value.hubEnvironmentId !== input.expectedHubId) {
        yield* writer.write(new Socket.CloseEvent(1000)).pipe(Effect.ignore);
        return {
          welcomed: false,
          reason: "credential-other-hub",
          message: ENVIRONMENT_CLOSE_MESSAGES["credential-other-hub"],
        } satisfies ConnectionOutcome;
      }
      yield* Ref.set(welcomed, true);
      yield* input.onWelcome(welcome.value);
      yield* Effect.forever(
        Effect.sleep(ENVIRONMENT_HEARTBEAT_INTERVAL_MS).pipe(
          Effect.andThen(input.heartbeat),
          Effect.flatMap((frame) => writer.write(encodeHeartbeat(frame))),
        ),
      ).pipe(Effect.forkScoped);
      const served =
        input.serve === undefined
          ? undefined
          : yield* input.serve((text) => writer.write(text).pipe(Effect.ignore));
      // Reading also keeps the close from the Hub coming.
      return yield* Effect.forever(
        nextFrame.pipe(
          Effect.flatMap((text) => {
            if (served === undefined) return Effect.void;
            const frame = parseFrame(text);
            return frame === undefined ? Effect.void : served.receive(frame).pipe(Effect.asVoid);
          }),
        ),
      );
    }),
  );
  return yield* session.pipe(
    Effect.catchTags({
      SocketError: (error) =>
        Ref.get(welcomed).pipe(
          Effect.map((wasWelcomed): ConnectionOutcome => {
            const reason =
              error.reason._tag === "SocketCloseError"
                ? environmentCloseReasonOf(error.reason.code)
                : undefined;
            return {
              welcomed: wasWelcomed,
              reason,
              message: reason === undefined ? error.message : ENVIRONMENT_CLOSE_MESSAGES[reason],
            };
          }),
        ),
    }),
  );
});

export type JoinedConnectionState =
  | { readonly _tag: "connecting"; readonly attempt: number; readonly lastError: string | null }
  | { readonly _tag: "connected"; readonly since: string }
  /** The Hub refused this machine for good (removed, wrong Hub, version); `t3 join` fixes it. */
  | { readonly _tag: "stopped"; readonly reason: EnvironmentCloseReason; readonly message: string }
  /**
   * A dedicated machine: its Sandbox container's server is the one connected to the Hub. `failed`
   * after too many crashes; restarting `t3 serve` tries again.
   */
  | {
      readonly _tag: "sandbox";
      readonly state: "starting" | "running" | "restarting" | "failed";
      readonly since: string;
      readonly message: string | null;
    };

export class HubConnector extends Context.Service<
  HubConnector,
  {
    readonly joined: JoinedHubState;
    readonly state: Effect.Effect<JoinedConnectionState>;
  }
>()("t3/environments/JoinedHub/HubConnector") {}

/** What this machine tells the Hub about itself. */
const makeReports = Effect.fn("JoinedHub.makeReports")(function* (joined: JoinedHubState) {
  const agent = yield* EnvironmentAgent.EnvironmentAgent;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const hostResources = yield* HostResources.HostResources;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  // Contract 14: where this machine writes Secret files, so the Hub sends them only in memory.
  const secretFiles = yield* Effect.serviceOption(ThreadSecretFiles.ThreadSecretFiles);
  const providerSummaries = providers.getProviders.pipe(
    Effect.map((list) => list.map(toProviderSummary)),
  );
  const resources = Effect.all({
    hostResources: hostResources.read,
    disk: readDiskSpace(config.baseDir),
  });
  const hello: Effect.Effect<EnvironmentHelloFrame> = Effect.gen(function* () {
    const { hostResources: snapshot, disk } = yield* resources;
    const report = yield* agent.report;
    return {
      type: "hello",
      protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
      os: platform,
      hostname: NodeOS.hostname() || "unknown",
      providers: yield* providerSummaries,
      hostResources: snapshot satisfies HostResourcesSnapshot,
      disk,
      sessions: report.sessions,
      workspaceRoot: report.workspaceRoot,
      orchestration: report.orchestration,
      executorContractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
      secretFilesRoot: Option.isSome(secretFiles) ? secretFiles.value.root : null,
      // Only a server whose host wrote it into its Sandbox's state says it runs in one.
      ...(joined.sandboxed === true
        ? { sandbox: { runtime: joined.sandboxRuntime ?? "process" } }
        : {}),
    };
  });
  const heartbeat: Effect.Effect<EnvironmentHeartbeatFrame> = Effect.gen(function* () {
    const { hostResources: snapshot, disk } = yield* resources;
    return {
      type: "heartbeat",
      hostResources: snapshot,
      disk,
      providers: yield* providerSummaries,
      orchestration: (yield* agent.report).orchestration,
    };
  });
  return { hello, heartbeat, serve: agent.attach };
});

export const readCredential = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  name: string = ENVIRONMENT_CREDENTIAL_SECRET,
) =>
  secrets.get(name).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * A server inside a Sandbox serves only the Space its host wrote: welcomed as someone's personal
 * machine, or for another Space, it refuses and exits, so its host asks the Hub and follows it.
 */
export const sandboxedServerRefuses = (
  joined: Pick<JoinedHubState, "sandboxed" | "spaceId">,
  welcome: Pick<EnvironmentWelcomeFrame, "mode" | "spaceId">,
) =>
  joined.sandboxed === true &&
  (welcome.mode === "personal" ||
    (welcome.spaceId !== undefined &&
      joined.spaceId !== undefined &&
      welcome.spaceId !== joined.spaceId));

/** The exit code a Sandbox's server ends with when its mode or Space is no longer the Hub's. */
export const SANDBOX_MODE_CHANGED_EXIT = 78;

/** Refusals of a Sandbox's credential, after which its server exits for its host to ask. */
export const SANDBOX_CREDENTIAL_ENDED: ReadonlySet<EnvironmentCloseReason> = new Set([
  "credential-unknown",
  "credential-revoked",
  "space-missing",
]);

/** What a server joined as personal says once the Hub dedicated its machine to a Space. */
const DEDICATED_RESTART_MESSAGE =
  "The Hub's Owner dedicated this machine to a Space: it runs that Space's work in a Sandbox container. Restart its server (`t3 serve`); it needs rootless Podman and the Sandbox image.";

const layerConnector = (joined: JoinedHubState, credential: Option.Option<string>) =>
  Layer.effect(
    HubConnector,
    Effect.gen(function* () {
      const reports = yield* makeReports(joined);
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const state = yield* Ref.make<JoinedConnectionState>({
        _tag: "connecting",
        attempt: 0,
        lastError: null,
      });
      const run = Effect.gen(function* () {
        if (Option.isNone(credential)) {
          return yield* Ref.set(state, {
            _tag: "stopped",
            reason: "credential-missing",
            message: ENVIRONMENT_CLOSE_MESSAGES["credential-missing"],
          });
        }
        let attempt = 0;
        while (true) {
          const outcome = yield* connectOnce({
            hubUrl: joined.hubUrl,
            credential: credential.value,
            expectedHubId: joined.hubEnvironmentId,
            hello: reports.hello,
            heartbeat: reports.heartbeat,
            serve: reports.serve,
            onWelcome: (welcome) =>
              sandboxedServerRefuses(joined, welcome)
                ? Effect.gen(function* () {
                    yield* Effect.logWarning(
                      "The Hub no longer uses this machine for this Sandbox's Space; stopping.",
                    );
                    yield* Ref.set(state, {
                      _tag: "stopped",
                      reason: "environment-mode-changed",
                      message: ENVIRONMENT_CLOSE_MESSAGES["environment-mode-changed"],
                    });
                    // Its host sees the exit, asks the Hub and follows it.
                    return yield* Effect.sync(() => process.exit(SANDBOX_MODE_CHANGED_EXIT));
                  })
                : DateTime.now.pipe(
                    Effect.flatMap((now) =>
                      Ref.set(state, { _tag: "connected", since: DateTime.formatIso(now) }),
                    ),
                  ),
          });
          // Dedicated on the Hub while this server runs work itself: its credential goes where
          // only a dedicated host reads it, and once restarted it runs that work in a Sandbox.
          if (outcome.reason === "not-sandboxed" && joined.sandboxed !== true) {
            yield* secrets
              .set(DEDICATED_CREDENTIAL_SECRET, new TextEncoder().encode(credential.value))
              .pipe(
                Effect.andThen(secrets.remove(ENVIRONMENT_CREDENTIAL_SECRET)),
                Effect.andThen(
                  writeJoinedHubState(config.joinedHubPath, { ...joined, mode: "dedicated" }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                  ),
                ),
                Effect.ignore,
              );
            yield* Effect.logWarning(DEDICATED_RESTART_MESSAGE);
            return yield* Ref.set(state, {
              _tag: "stopped",
              reason: "environment-mode-changed",
              message: DEDICATED_RESTART_MESSAGE,
            });
          }
          if (outcome.reason !== undefined && ENVIRONMENT_CLOSE_REASONS[outcome.reason].final) {
            yield* Effect.logWarning("The Hub refused this machine", { reason: outcome.reason });
            // A Sandbox's credential ends with its Space: its host learns why by asking the Hub.
            if (joined.sandboxed === true && SANDBOX_CREDENTIAL_ENDED.has(outcome.reason)) {
              return yield* Effect.sync(() => process.exit(SANDBOX_MODE_CHANGED_EXIT));
            }
            return yield* Ref.set(state, {
              _tag: "stopped",
              reason: outcome.reason,
              message: outcome.message,
            });
          }
          attempt = outcome.welcomed ? 0 : attempt + 1;
          yield* Ref.set(state, {
            _tag: "connecting",
            attempt,
            lastError: outcome.message || null,
          });
          yield* Effect.sleep(reconnectDelayMs(attempt, yield* Random.next));
        }
      });
      yield* Effect.forkScoped(run);
      return HubConnector.of({ joined, state: Ref.get(state) });
    }),
  );

/** The connection to the Hub and the agent that serves its requests on this machine. */
export const layer = (joined: JoinedHubState) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Read once: the socket and the Hub repository use the same credential.
      const credential = yield* readCredential(yield* ServerSecretStore.ServerSecretStore);
      return layerConnector(joined, credential).pipe(
        Layer.provide(
          EnvironmentAgent.layer({
            environmentId: joined.environmentId,
            hubUrl: joined.hubUrl,
            credential: Option.getOrUndefined(credential),
          }),
        ),
      );
    }),
  );

/** `/health` on loopback: what `t3 status` shows about a joined machine. */
export const layerHealthRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const connector = yield* HubConnector;
    yield* router.add(
      "GET",
      "/health",
      Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          mode: "joined",
          environmentMode: connector.joined.mode ?? "personal",
          hubUrl: connector.joined.hubUrl,
          environmentId: connector.joined.environmentId,
          name: connector.joined.name,
          connection: yield* connector.state,
        });
      }),
    );
  }),
);
