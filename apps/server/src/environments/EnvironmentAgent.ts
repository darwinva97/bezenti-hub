/**
 * What a joined Environment does for its Hub: it runs the executor operations the Hub asks for on
 * this machine's own executor, streams each provider session's events back in order, and keeps
 * the ones the Hub has not acknowledged to resend after a reconnect. See
 * docs/internals/environment-auth.md#joined-environments.
 */
// @effect-diagnostics nodeBuiltinImport:off -- path joins only; no I/O.
// @effect-diagnostics anyUnknownInErrorContext:off -- each operation's errors are encoded by its own schema.
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  ENVIRONMENT_EXECUTOR_FRAME_METHODS,
  EnvironmentAttachmentReadResult,
  EnvironmentWorkspaceStreamCancel,
  EnvironmentTextGenerationCancel,
  FilesystemBrowseError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  TerminalEnvironmentUnavailableError,
  EnvironmentExecutorEventAck,
  EnvironmentExecutorRetiredSessions,
  type EnvironmentId,
  type EnvironmentLiveProviderSession,
  type EnvironmentOrchestrationCapabilities,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SecretEnv,
  TextGenerationError,
  type ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { openSessionWithSecrets } from "@t3tools/provider-core/server/instanceEnvironment";
import { rememberKnownSecrets } from "@t3tools/shared/secretMasking";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as MachineAssets from "../assets/MachineAssets.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ScratchWorkspace from "../environment/ScratchWorkspace.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import {
  type ExecutorCallResult,
  type ExecutorChannel,
  makeExecutorChannel,
} from "../environment/ExecutorChannel.ts";
import {
  isRemoteOperation,
  ProviderEventJson,
  REMOTE_OPERATIONS,
  REMOTE_STREAM_ITEMS,
  type RemoteInput,
  type RemoteOperation,
  type RemoteStreamOperation,
  type WireAttachmentRef,
  type WireCheckout,
} from "../environment/RemoteExecutorWire.ts";
import { captureRecoveredChanges } from "../environment/MovedWorkspace.ts";
import { makePreviewProxyTarget } from "../preview/PreviewProxy.ts";
import { terminalOutputStream } from "../terminal/OutputProtocol.ts";
import * as AiGatewayRelay from "./AiGatewayRelay.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JoinedWorkspaceRoots from "../workspace/JoinedWorkspaceRoots.ts";
import { makeWorkspaceRpcCalls } from "../workspace/WorkspaceRpcCalls.ts";

/**
 * Spec 5 ticket 05: values this machine receives are shown as `[NAME]` in its own logs, spans
 * and provider event logs from then on (the Hub masks what it stores and shows).
 */
const knowSecrets = (secretEnv: SecretEnv | undefined) => {
  if (secretEnv?.variables !== undefined) {
    // A Vault Variable is configuration: never masked.
    rememberKnownSecrets(secretEnv.variables.filter((variable) => variable.plain !== true));
  }
};

/** Calls answered, by idempotency key, so a resend gets the first answer instead of a rerun. */
const IDEMPOTENCY_MEMORY = 512;
/** Unacknowledged events kept per session; past it the oldest go and a reconnect cannot fill them. */
const SPOOL_LIMIT = 5_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** A new checkout from the Hub is tried again this many times, with backoff, before it fails. */
const HUB_CLONE_RETRIES = 3;
/** The driver named in errors about a session this machine does not have. */
const UNKNOWN_DRIVER = ProviderDriverKind.make("environment");

interface LocalSession {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly features: {
    readonly injectHistory: boolean;
    readonly compactThread: boolean;
    readonly stopTask: boolean;
    readonly unloadThread: boolean;
    readonly hasPendingBackgroundWork: boolean;
    readonly backgroundTasksEndWithProcess: boolean;
  };
  /** The Hub-issued MCP credential this session's agent uses, if any. */
  readonly credentialId: string | undefined;
  seq: number;
  /** Ended on this machine; kept until the Hub acknowledges its last frame. */
  ended: boolean;
  readonly spool: Array<{ readonly seq: number; readonly method: string; readonly frame: unknown }>;
}

export class EnvironmentAgent extends Context.Service<
  EnvironmentAgent,
  {
    /** What the hello and each heartbeat say about this machine's orchestration side. */
    readonly report: Effect.Effect<{
      readonly workspaceRoot: string;
      readonly orchestration: EnvironmentOrchestrationCapabilities;
      readonly sessions: ReadonlyArray<EnvironmentLiveProviderSession>;
    }>;
    /** Serves one welcomed connection until the scope closes. */
    readonly attach: (
      write: (text: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      { readonly receive: (frame: unknown) => Effect.Effect<boolean> },
      never,
      Scope.Scope
    >;
  }
>()("t3/environments/EnvironmentAgent") {}

const codec = (schema: Schema.Top) => Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
const decodeAck = Schema.decodeUnknownOption(EnvironmentExecutorEventAck);
const decodeRetired = Schema.decodeUnknownOption(EnvironmentExecutorRetiredSessions);
const decodeAttachment = Schema.decodeUnknownOption(EnvironmentAttachmentReadResult);
const decodeStreamCancel = Schema.decodeUnknownOption(EnvironmentWorkspaceStreamCancel);
const decodeGenerationCancel = Schema.decodeUnknownOption(EnvironmentTextGenerationCancel);
const OUTSIDE_MESSAGE = "That is outside this Thread's workspace.";
const entriesOutside = { failure: "outside_thread_workspace", message: OUTSIDE_MESSAGE } as const;
const fileOutside = (cwd: string, relativePath: string) =>
  ({
    cwd,
    relativePath,
    failure: "resolved_path_outside_root",
    message: OUTSIDE_MESSAGE,
  }) as const;
const encodeEvent = Schema.encodeUnknownEffect(ProviderEventJson);

export interface EnvironmentAgentInput {
  readonly environmentId: EnvironmentId;
  readonly hubUrl: string;
  /** The Environment credential, for the Hub repository; without it nothing is uploaded. */
  readonly credential: string | undefined;
}

export const make = Effect.fn("EnvironmentAgent.make")(function* (input: EnvironmentAgentInput) {
  const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
  const local = yield* registry.get(registry.hubMachineEnvironmentId).pipe(Effect.orDie);
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const digester = yield* Digest.Digest;
  // Optional so joined mode needs nothing the Hub's routes do not; the server always has it.
  const vcs = yield* Effect.serviceOption(VcsProcess.VcsProcess);
  const agentScope = yield* Effect.scope;
  const roots = yield* JoinedWorkspaceRoots.JoinedWorkspaceRoots;
  const workspaceRoot = NodePath.resolve(config.baseDir, "projects");
  const mcpEndpoint = new URL("/mcp", input.hubUrl).toString();
  // Spec 4 ticket 06: this machine's agents reach the Hub's AI gateway at a loopback address.
  const aiGatewayRelay = yield* AiGatewayRelay.make(input.hubUrl);

  const sessions = new Map<string, LocalSession>();
  const answered = new Map<
    string,
    { readonly answer: Deferred.Deferred<ExecutorCallResult>; settled: boolean }
  >();
  /** Text generations the Hub asked for by id, so it can cancel one it stopped waiting for. */
  const generations = new Map<string, Fiber.Fiber<unknown, unknown>>();
  let channel: ExecutorChannel | undefined;
  /** The Hub's open workspace streams, each on the socket that opened it. */
  const workspaceStreams = new Map<
    string,
    { readonly channel: ExecutorChannel; readonly scope: Scope.Closeable }
  >();
  // The joined server always has the workspace services; an executor without them answers none.
  const workspaceRpc = Effect.suspend(() =>
    Option.match(local.workspace.rpc, {
      onSome: Effect.succeed,
      onNone: () => Effect.die(new Error("This machine has no workspace services.")),
    }),
  );
  const workspaceCalls = Effect.map(workspaceRpc, makeWorkspaceRpcCalls);
  /** This machine's own state, which a Thread's file URL never serves. */
  const isServerInternalPath = yield* makeIsServerInternalPath.pipe(
    Effect.map(
      (check) => (filePath: string) => check(filePath).pipe(Effect.orElseSucceed(() => true)),
    ),
    Effect.provide(Path.layer),
  );
  /** Dev servers on this machine, for the previews the Hub serves. */
  const previewProxy = makePreviewProxyTarget();

  const sha256Hex = (bytes: Uint8Array) =>
    digester.digest(Digest.sha256, bytes).pipe(
      Effect.orDie,
      Effect.map((digest) => Buffer.from(digest).toString("hex")),
    );

  const send = (method: string, frame: unknown) =>
    Effect.suspend(() => (channel === undefined ? Effect.void : channel.event(method, frame)));

  /** Next in the session's order: kept until acknowledged, and sent now if connected. */
  const spoolAndSend = (
    providerSessionId: string,
    session: LocalSession,
    method: string,
    frame: (seq: number) => unknown,
  ) =>
    Effect.suspend(() => {
      session.seq += 1;
      const framed = frame(session.seq);
      session.spool.push({ seq: session.seq, method, frame: framed });
      const sent = send(method, framed);
      if (session.spool.length <= SPOOL_LIMIT) return sent;
      session.spool.shift();
      return Effect.logWarning("Dropped an unacknowledged event past the spool limit", {
        providerSessionId,
      }).pipe(Effect.andThen(sent));
    });

  /** Gone from this machine: its process, its spool and, if still its own, its MCP credential. */
  const forgetSession = Effect.fn("EnvironmentAgent.forgetSession")(function* (
    providerSessionId: string,
    session: LocalSession,
  ) {
    if (sessions.get(providerSessionId) === session) sessions.delete(providerSessionId);
    yield* Scope.close(session.scope, Exit.void);
    const current = yield* mcpSessions.read(session.threadId);
    // A newer session of the Thread may hold a newer credential; only this one's goes.
    if (session.credentialId !== undefined && current?.providerSessionId === session.credentialId) {
      yield* mcpSessions.clear(session.threadId);
    }
  });

  /**
   * Streams a session's events: spooled with a `seq` until acknowledged, live output as is. Its
   * end goes in the same order, so a machine offline when it happens still reports it.
   */
  const pump = (providerSessionId: string, session: LocalSession) =>
    session.runtime.events.pipe(
      Stream.runForEach((event) =>
        encodeEvent(event).pipe(
          Effect.orDie,
          Effect.flatMap((encoded) =>
            event.type === "command_output.delta"
              ? send(ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent, {
                  providerSessionId,
                  event: encoded,
                })
              : spoolAndSend(
                  providerSessionId,
                  session,
                  ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent,
                  (seq) => ({ providerSessionId, seq, event: encoded }),
                ),
          ),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (sessions.get(providerSessionId) !== session) return;
          const error =
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
              : undefined;
          const encoded =
            error === undefined
              ? undefined
              : yield* Schema.encodeUnknownEffect(codec(ProviderAdapter.ProviderAdapterV2Error))(
                  error,
                ).pipe(Effect.option, Effect.map(Option.getOrUndefined));
          session.ended = true;
          yield* spoolAndSend(
            providerSessionId,
            session,
            ENVIRONMENT_EXECUTOR_FRAME_METHODS.sessionEnded,
            (seq) => ({
              providerSessionId,
              seq,
              ...(encoded === undefined ? {} : { error: encoded }),
            }),
          );
          yield* Scope.close(session.scope, Exit.void);
        }),
      ),
    );

  /**
   * The Project's checkout: used where it is, else made from the Hub's copy of its own checkout
   * (with this machine's credential, `origin` the Project's own remote) when the Hub has one, else
   * cloned from the Project's own remote. A Thread without a Project's scratch
   * workspace is made empty instead, as its own git repository.
   */
  const ensureCheckout = Effect.fn("EnvironmentAgent.ensureCheckout")(function* (
    checkout: WireCheckout,
  ) {
    if (checkout.scratch === true) {
      if (Option.isNone(vcs)) {
        return yield* Effect.fail(`This machine cannot make the folder ${checkout.path}.`);
      }
      return yield* ScratchWorkspace.ensureScratchRepository(
        { vcs: vcs.value, fileSystem, path: NodePath },
        checkout.path,
      ).pipe(Effect.mapError((cause) => cause.message));
    }
    if (yield* fileSystem.exists(checkout.path).pipe(Effect.orElseSucceed(() => false))) return;
    // A Project in a folder of its repository: the repository is made at `path` without it.
    const suffix = checkout.subfolder === undefined ? "" : `/${checkout.subfolder}`;
    const normalized = checkout.path.split(NodePath.sep).join("/");
    if (suffix !== "" && !normalized.endsWith(suffix)) {
      return yield* Effect.fail(
        `The Project's checkout ${checkout.path} is not its repository's folder ${checkout.subfolder}.`,
      );
    }
    const repository = suffix === "" ? checkout.path : checkout.path.slice(0, -suffix.length);
    if (
      suffix !== "" &&
      (yield* fileSystem.exists(repository).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* Effect.fail(
        `${repository} exists on this machine but has no ${checkout.subfolder}: update it, or remove it to have it made again.`,
      );
    }
    // The Hub has a checkout of the Project: the new one is made from it, or not at all. A Hub
    // that fails for a moment is tried again, within the time a clone of `origin` gets; a refusal
    // or a Hub with nothing to check out is not. It is never replaced by `origin`.
    if (checkout.fromHub !== undefined) {
      if (input.credential === undefined || Option.isNone(vcs)) {
        return yield* Effect.fail(
          `This machine cannot make the Project's checkout ${checkout.path} from the Hub.`,
        );
      }
      return yield* HubRepository.cloneFromHub(
        { vcs: vcs.value, fileSystem, path: NodePath },
        {
          target: repository,
          remote: HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(input.hubUrl, { projectId: checkout.fromHub.projectId }),
            input.credential,
          ),
          originUrl: checkout.cloneUrl,
          branch: checkout.fromHub.branch,
          upstreams: checkout.fromHub.upstreams ?? [],
        },
      ).pipe(
        Effect.retry({
          while: HubRepository.isTransientHubFailure,
          times: HUB_CLONE_RETRIES,
          schedule: Schedule.exponential("1 second"),
        }),
        Effect.timeoutOrElse({
          duration: Duration.millis(CLONE_TIMEOUT_MS),
          orElse: () => Effect.fail({ message: "it took longer than a clone may." }),
        }),
        Effect.mapError(
          (cause) => `Could not make the Project's checkout from the Hub: ${cause.message}`,
        ),
      );
    }
    // The Hub has none (no checkout of its own, or one in a root it does not trust): `origin`.
    if (checkout.cloneUrl === null || Option.isNone(vcs)) {
      return yield* Effect.fail(
        `The Project's checkout ${checkout.path} does not exist on this machine, and the Project has no remote to clone.`,
      );
    }
    yield* fileSystem
      .makeDirectory(NodePath.dirname(repository), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => `Could not create ${NodePath.dirname(repository)}: ${cause.message}`,
        ),
      );
    yield* vcs.value
      .run({
        operation: "EnvironmentAgent.cloneCheckout",
        command: "git",
        args: ["clone", "--", checkout.cloneUrl, repository],
        cwd: NodePath.dirname(repository),
        timeoutMs: CLONE_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((cause) => `Could not clone the Project: ${cause.message}`));
  });

  // The Hub's repository of a Project, over HTTP with this machine's credential.
  const credential = input.credential;
  const hubRepository = HubRepository.makeCheckoutTransfers({
    vcs: Option.getOrUndefined(vcs),
    remoteOf:
      credential === undefined
        ? undefined
        : (key) =>
            Effect.succeed(
              HubRepository.withEnvironmentCredential(
                HubRepository.hubRepositoryUrl(input.hubUrl, key),
                credential,
              ),
            ),
    unavailable: "This machine cannot reach the Hub repository.",
  });

  /** Fetches from the Hub, by hash, the attachments a turn needs and this machine lacks. */
  const ensureAttachments = Effect.fn("EnvironmentAgent.ensureAttachments")(function* (
    driver: ProviderDriverKind,
    threadId: ThreadId,
    attachments: ReadonlyArray<ChatAttachment>,
    refs: ReadonlyArray<WireAttachmentRef>,
  ) {
    for (const ref of refs) {
      const attachment = attachments.find((candidate) => candidate.id === ref.id);
      const path =
        attachment === undefined
          ? null
          : resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (path === null) continue;
      const existing = yield* fileSystem.readFile(path).pipe(Effect.option);
      if (Option.isSome(existing) && (yield* sha256Hex(existing.value)) === ref.sha256) continue;
      const unreadable = new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "An attachment could not be fetched from the Hub",
        reason: "attachment_unreadable",
      });
      if (channel === undefined) return yield* unreadable;
      const answer = yield* channel
        .request({
          method: ENVIRONMENT_EXECUTOR_FRAME_METHODS.attachmentRead,
          payload: { threadId, attachmentId: ref.id, sha256: ref.sha256 },
        })
        .pipe(Effect.mapError(() => unreadable));
      const result = answer._tag === "success" ? decodeAttachment(answer.value) : Option.none();
      if (Option.isNone(result)) return yield* unreadable;
      const bytes = Buffer.from(result.value.base64, "base64");
      if ((yield* sha256Hex(bytes)) !== ref.sha256) return yield* unreadable;
      yield* fileSystem
        .makeDirectory(config.attachmentsDir, { recursive: true })
        .pipe(Effect.ignore);
      yield* fileSystem.writeFile(path, bytes).pipe(Effect.mapError(() => unreadable));
    }
  });

  const sessionOf = (providerSessionId: string) =>
    Effect.suspend(() => {
      const session = sessions.get(providerSessionId);
      return session === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterSessionStoppedError({ driver: UNKNOWN_DRIVER }),
          )
        : Effect.succeed(session);
    });

  const openSession = Effect.fn("EnvironmentAgent.openSession")(function* (
    request: RemoteInput<"provider.openSession">,
  ) {
    const known = sessions.get(request.providerSessionId);
    if (known !== undefined) {
      return { providerSession: known.runtime.providerSession, features: known.features };
    }
    const instanceId = request.instanceId as ProviderInstanceId;
    const openError = (cause: unknown) =>
      new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: UNKNOWN_DRIVER,
        providerSessionId: request.providerSessionId,
        cause,
      });
    const adapter = yield* local.provider.adapters.get(instanceId).pipe(Effect.mapError(openError));
    if (request.checkout !== undefined) {
      yield* ensureCheckout(request.checkout).pipe(Effect.mapError(openError));
      const hubRefs = request.checkout.hubRefs;
      // Once the Hub repository has the Thread's checkpoints, this checkout gets the ones it lacks.
      if (hubRefs !== undefined) {
        yield* hubRepository
          .fetch({
            cwd: request.checkout.path,
            ...HubRepository.keyOf(hubRefs),
            checkpointRefs: hubRefs.refs,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not fetch the Thread's checkpoints from the Hub", { cause }),
            ),
          );
      }
    }
    // The agent here reaches the Hub's MCP, with the credential the Hub issued for this Thread.
    if (request.mcp === undefined) {
      yield* mcpSessions.clear(request.threadId);
    } else {
      yield* mcpSessions.set({
        environmentId: input.environmentId,
        threadId: request.threadId,
        providerSessionId: request.mcp.credentialId,
        providerInstanceId: instanceId,
        endpoint: mcpEndpoint,
        authorizationHeader: request.mcp.authorizationHeader,
        browserToolsAvailable: request.mcp.browserToolsAvailable,
        capabilities: new Set(request.mcp.capabilities),
      });
    }
    knowSecrets(request.secretEnv);
    // Spec 4 ticket 06: the Thread's gateway key goes the same way as its secrets, with this
    // machine's relay and the Thread's own provider home (no login of this machine is used).
    const aiGateway = yield* AiGatewayRelay.prepareGatewaySession({
      access: request.aiGateway,
      threadId: request.threadId,
      driver: adapter.driver,
      stateDir: config.stateDir,
      baseUrl: aiGatewayRelay.baseUrl,
    }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem), Effect.mapError(openError));
    const scope = yield* Scope.fork(agentScope);
    // Spec 5: the Thread's secrets go into the provider process's environment and nowhere else:
    // never logged, written or kept here once the session opened (the adapter refuses them if it
    // cannot put them in its process).
    const runtime = yield* openSessionWithSecrets(adapter, {
      threadId: request.threadId,
      providerSessionId: request.providerSessionId,
      modelSelection: request.modelSelection,
      runtimePolicy: request.runtimePolicy,
      ...(request.resumeFromSession === undefined
        ? {}
        : { resumeFromSession: request.resumeFromSession }),
      ...(request.initialNativeThreadId === undefined
        ? {}
        : { initialNativeThreadId: request.initialNativeThreadId }),
      ...(request.initialProviderItemIdentityVersion === undefined
        ? {}
        : { initialProviderItemIdentityVersion: request.initialProviderItemIdentityVersion }),
      ...(request.secretEnv === undefined ? {} : { secretEnv: request.secretEnv }),
      ...(aiGateway === undefined ? {} : { aiGateway }),
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const session: LocalSession = {
      threadId: request.threadId,
      driver: adapter.driver,
      runtime,
      scope,
      features: {
        injectHistory: runtime.injectHistory !== undefined,
        compactThread: runtime.compactThread !== undefined,
        stopTask: runtime.stopTask !== undefined,
        unloadThread: runtime.unloadThread !== undefined,
        hasPendingBackgroundWork: runtime.hasPendingBackgroundWork !== undefined,
        backgroundTasksEndWithProcess: runtime.backgroundTasksEndWithProcess === true,
      },
      credentialId: request.mcp?.credentialId,
      seq: 0,
      ended: false,
      spool: [],
    };
    sessions.set(request.providerSessionId, session);
    yield* pump(request.providerSessionId, session).pipe(Effect.forkIn(agentScope));
    return { providerSession: runtime.providerSession, features: session.features };
  });

  const closeWorkspaceStream = (subscriptionId: string) =>
    Effect.suspend(() => {
      const open = workspaceStreams.get(subscriptionId);
      if (open === undefined) return Effect.void;
      workspaceStreams.delete(subscriptionId);
      return Scope.close(open.scope, Exit.void);
    });

  /**
   * Streams `events` to the Hub as `workspace.stream` frames on the socket that asked. Live only:
   * it ends with that socket, and with the Hub's `workspace.streamCancel`.
   */
  const openWorkspaceStream = Effect.fn("EnvironmentAgent.openWorkspaceStream")(function* <A, E>(
    operation: RemoteStreamOperation,
    subscriptionId: string,
    events: Stream.Stream<A, E>,
    asked: ExecutorChannel | undefined,
  ) {
    if (asked === undefined) return;
    yield* closeWorkspaceStream(subscriptionId);
    const scope = yield* Scope.fork(agentScope);
    workspaceStreams.set(subscriptionId, { channel: asked, scope });
    const end = (error?: unknown) =>
      Effect.suspend(() => {
        if (workspaceStreams.get(subscriptionId)?.scope !== scope) return Effect.void;
        workspaceStreams.delete(subscriptionId);
        return asked
          .event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamEnd, {
            subscriptionId,
            ...(error === undefined ? {} : { error }),
          })
          .pipe(
            // Its own fiber runs in the scope, so the scope closes from outside it.
            Effect.andThen(Scope.close(scope, Exit.void).pipe(Effect.forkDetach)),
            Effect.asVoid,
          );
      });
    const encodeItem = Schema.encodeUnknownEffect(codec(REMOTE_STREAM_ITEMS[operation]));
    yield* events.pipe(
      Stream.runForEach((event) =>
        encodeItem(event).pipe(
          Effect.orDie,
          Effect.flatMap((item) =>
            asked.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamItem, {
              subscriptionId,
              item,
            }),
          ),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return end();
        const failure = Cause.findErrorOption(exit.cause);
        return Option.isNone(failure)
          ? end()
          : Schema.encodeUnknownEffect(codec(REMOTE_OPERATIONS[operation].error))(
              failure.value,
            ).pipe(
              Effect.option,
              Effect.flatMap((encoded) => end(Option.getOrUndefined(encoded))),
            );
      }),
      Effect.forkIn(scope),
    );
  });

  const terminalOutside = (threadId: string) =>
    new TerminalEnvironmentUnavailableError({ threadId, reason: "outside_thread_workspace" });

  /** A terminal's folders, relative to the Thread's root, as real paths inside it. */
  const terminalFoldersIn = Effect.fn("EnvironmentAgent.terminalFoldersIn")(function* <
    I extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
  >(workspace: JoinedWorkspaceRoots.Workspace, input: I) {
    const cwd = input.cwd === undefined ? undefined : yield* workspace.inside(input.cwd);
    const worktreePath =
      input.worktreePath === undefined || input.worktreePath === null
        ? input.worktreePath
        : yield* workspace.inside(input.worktreePath);
    return {
      ...input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.worktreePath === undefined ? {} : { worktreePath }),
    };
  });

  const openTerminalStream = Effect.fn("EnvironmentAgent.openTerminalStream")(function* (
    request: RemoteInput<"terminal.stream">,
    origin: ExecutorChannel | undefined,
  ) {
    const { terminals } = yield* workspaceRpc;
    knowSecrets(request.secretEnv);
    const input = yield* roots
      .withRoot(request.root, (workspace) => terminalFoldersIn(workspace, request.input))
      .pipe(
        Effect.catchTags({
          WorkspaceRootEscapeError: () => Effect.fail(terminalOutside(request.input.threadId)),
        }),
      );
    yield* openWorkspaceStream(
      "terminal.stream",
      request.subscriptionId,
      request.mode === "attach"
        ? terminals.attachOutputStream(input, request.viewerId ?? request.subscriptionId, {
            secrets: request.secretEnv,
            // Spec 5 ticket 07: a shell started without the Hub's facts reports none.
            facts: request.facts ?? null,
          })
        : terminalOutputStream(
            (listener, registerCleanup) =>
              terminals.observeStream(input, listener, registerCleanup),
            (listener, registerCleanup) => terminals.resyncStream(input, listener, registerCleanup),
          ),
      origin,
    );
  });

  /**
   * A workspace call held to its root: `cwd` (and the other paths it names, relative to it) must
   * resolve, symlinks followed, inside the Thread's workspace, else the call's own refusal.
   */
  const inRoot = <I extends { readonly cwd?: string | undefined }, A, E>(
    request: { readonly root: string; readonly input: I },
    refuse: () => E,
    paths: (input: I) => ReadonlyArray<string>,
    run: (input: I & { readonly cwd: string }) => Effect.Effect<A, E>,
  ) =>
    roots
      .withRoot(request.root, (workspace) =>
        Effect.gen(function* () {
          const cwd = yield* workspace.inside(request.input.cwd ?? ".");
          for (const relative of paths(request.input)) yield* workspace.inside(relative);
          return yield* run({ ...request.input, cwd });
        }),
      )
      .pipe(Effect.catchTags({ WorkspaceRootEscapeError: () => Effect.fail(refuse()) }));

  const underCwd = (cwd: string | undefined, relative: string) =>
    NodePath.posix.join(cwd ?? ".", relative.split("\\").join("/"));

  const unsupported = (session: LocalSession, operation: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: session.driver,
      detail: `This session does not support ${operation}`,
    });

  /** Runs one decoded operation on this machine. */
  const run = (
    operation: RemoteOperation,
    request: unknown,
    origin: ExecutorChannel | undefined,
  ): Effect.Effect<unknown, unknown> => {
    const onSession = <A>(
      body: (session: LocalSession, input: never) => Effect.Effect<A, unknown>,
    ) => {
      const { providerSessionId, input: sessionInput } = request as {
        readonly providerSessionId: string;
        readonly input: never;
      };
      return sessionOf(providerSessionId).pipe(
        Effect.flatMap((session) => body(session, sessionInput)),
      );
    };
    const checkpoints = local.workspace.checkpoints;
    switch (operation) {
      case "provider.openSession":
        return openSession(request as RemoteInput<"provider.openSession">);
      case "provider.ensureThread":
        return onSession((session, input) => session.runtime.ensureThread(input));
      case "provider.resumeThread":
        return onSession((session, input) => session.runtime.resumeThread(input));
      case "provider.startTurn": {
        const {
          providerSessionId,
          input: turn,
          attachments,
        } = request as RemoteInput<"provider.startTurn">;
        return sessionOf(providerSessionId).pipe(
          Effect.flatMap((session) =>
            ensureAttachments(
              session.driver,
              turn.threadId,
              turn.message.attachments,
              attachments,
            ).pipe(Effect.andThen(session.runtime.startTurn(turn))),
          ),
        );
      }
      case "provider.steer": {
        const {
          providerSessionId,
          input: steer,
          attachments,
        } = request as RemoteInput<"provider.steer">;
        return sessionOf(providerSessionId).pipe(
          Effect.flatMap((session) =>
            ensureAttachments(
              session.driver,
              steer.threadId,
              steer.message.attachments,
              attachments,
            ).pipe(Effect.andThen(session.runtime.steerTurn(steer))),
          ),
        );
      }
      case "provider.compactThread":
        return onSession((session, input) =>
          session.runtime.compactThread === undefined
            ? Effect.fail(unsupported(session, "compaction"))
            : session.runtime.compactThread(input),
        );
      case "provider.interrupt":
        return onSession((session, input) => session.runtime.interruptTurn(input));
      case "provider.respond":
        return onSession((session, input) => session.runtime.respondToRuntimeRequest(input));
      case "provider.readThreadSnapshot":
        return onSession((session, input) => session.runtime.readThreadSnapshot(input));
      case "provider.rollback":
        return onSession((session, input) => session.runtime.rollbackThread(input));
      case "provider.forkThread":
        return onSession((session, input) => session.runtime.forkThread(input));
      case "provider.injectHistory":
        return onSession((session, input) =>
          session.runtime.injectHistory === undefined
            ? Effect.succeed(false)
            : session.runtime.injectHistory(input),
        );
      case "provider.stopTask":
        return onSession((session, input) =>
          session.runtime.stopTask === undefined
            ? Effect.fail(unsupported(session, "stopping a task"))
            : session.runtime.stopTask(input),
        );
      case "provider.unloadThread":
        return onSession((session, input) =>
          session.runtime.unloadThread === undefined
            ? Effect.void
            : session.runtime.unloadThread(input),
        );
      case "provider.hasPendingBackgroundWork":
        return onSession(
          (session) => session.runtime.hasPendingBackgroundWork ?? Effect.succeed(false),
        );
      case "provider.detach": {
        const { providerSessionId } = request as RemoteInput<"provider.detach">;
        return Effect.suspend(() => {
          const session = sessions.get(providerSessionId);
          return session === undefined ? Effect.void : forgetSession(providerSessionId, session);
        });
      }
      // The Hub asks this machine's provider to write a moved Thread's handoff summary.
      case "textGeneration.threadHandoff": {
        const textGeneration = local.textGeneration;
        return textGeneration === undefined
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadHandoff",
                detail: "This machine has no text generation.",
              }),
            )
          : Effect.gen(function* () {
              const input = request as RemoteInput<"textGeneration.threadHandoff">;
              const running = yield* textGeneration.threadHandoff(input).pipe(Effect.forkDetach);
              if (input.generationId !== undefined) generations.set(input.generationId, running);
              return yield* Fiber.join(running).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (input.generationId !== undefined) generations.delete(input.generationId);
                  }),
                ),
              );
            });
      }
      // The Hub asks this machine to title one of its Threads (the Hub runs no agents itself).
      case "textGeneration.threadTitle":
        return local.textGeneration === undefined
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "This machine has no text generation.",
              }),
            )
          : local.textGeneration.threadTitle(request as RemoteInput<"textGeneration.threadTitle">);
      case "checkpoint.isGitRepository":
        return checkpoints.isGitRepository(
          (request as RemoteInput<"checkpoint.isGitRepository">).cwd,
        );
      case "checkpoint.hasRef":
        return checkpoints.hasCheckpointRef(request as RemoteInput<"checkpoint.hasRef">);
      case "checkpoint.capture":
        return checkpoints.captureCheckpoint(request as RemoteInput<"checkpoint.capture">);
      case "checkpoint.restore":
        return checkpoints.restoreCheckpoint(request as RemoteInput<"checkpoint.restore">);
      case "checkpoint.diff":
        return checkpoints.diffCheckpoints(request as RemoteInput<"checkpoint.diff">);
      case "checkpoint.listAuthoredPaths":
        return checkpoints
          .listAuthoredPaths(request as RemoteInput<"checkpoint.listAuthoredPaths">)
          .pipe(Effect.map((paths) => (paths === null ? null : [...paths])));
      case "checkpoint.deleteRefs":
        return checkpoints.deleteCheckpointRefs(request as RemoteInput<"checkpoint.deleteRefs">);
      case "checkpoint.push":
        return hubRepository.push(request as RemoteInput<"checkpoint.push">);
      case "checkpoint.fetch":
        return hubRepository.fetch(request as RemoteInput<"checkpoint.fetch">);
      case "checkpoint.ensureScratch":
        return local.workspace.hubRepository.ensureScratch(
          (request as RemoteInput<"checkpoint.ensureScratch">).folder,
        );
      case "move.publishScratch":
        return local.workspace.move.publishScratch(request as RemoteInput<"move.publishScratch">);
      // A Thread moves here: its checkout (cloned when missing) fetches what it continues from.
      case "move.fetch": {
        const moved = request as RemoteInput<"move.fetch">;
        return ensureCheckout(moved.checkout).pipe(
          Effect.mapError(
            (detail) =>
              new VcsProcessExitError({
                operation: "EnvironmentAgent.move.fetch",
                command: "git clone",
                cwd: moved.checkout.path,
                exitCode: 1,
                detail,
              }),
          ),
          Effect.andThen(
            moved.refs.length === 0
              ? Effect.void
              : hubRepository.fetch({
                  cwd: moved.checkout.path,
                  ...HubRepository.keyOf(moved),
                  checkpointRefs: moved.refs,
                }),
          ),
          // A Thread without a Project brings its folder's own branches and HEAD.
          Effect.andThen(
            moved.scratchHistory === undefined
              ? Effect.void
              : hubRepository.fetchPrefix({
                  cwd: moved.checkout.path,
                  ...HubRepository.keyOf(moved),
                  prefix: moved.scratchHistory,
                }),
          ),
          Effect.as({ checkout: moved.checkout.path }),
        );
      }
      case "move.prepare":
        return local.workspace.move.prepare(request as RemoteInput<"move.prepare">);
      // Back with a Thread that moved away: what it never uploaded goes to the Hub, through this
      // machine's own credential; the workspace stays as it is.
      case "move.recover": {
        const recover = request as RemoteInput<"move.recover">;
        if (Option.isNone(vcs)) {
          return Effect.fail(
            new VcsProcessExitError({
              operation: "EnvironmentAgent.move.recover",
              command: "git",
              cwd: recover.cwd,
              exitCode: 1,
              detail: "This machine has no git.",
            }),
          );
        }
        return captureRecoveredChanges(
          { vcs: vcs.value, checkpoints: local.workspace.checkpoints, fileSystem },
          recover,
        ).pipe(
          Effect.tap(({ status }) =>
            status === "recovered"
              ? hubRepository.push({
                  cwd: recover.cwd,
                  ...HubRepository.keyOf(recover),
                  checkpointRefs: [recover.recoveredRef],
                })
              : Effect.void,
          ),
        );
      }
      // The Hub already authorized these and resolved their paths onto this machine.
      case "files.read": {
        const rooted = request as RemoteInput<"files.read">;
        const { cwd, relativePath } = rooted.input;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () => new ProjectReadFileError(fileOutside(cwd, relativePath)),
            (input) => [underCwd(input.cwd, input.relativePath)],
            calls.readFile,
          ),
        );
      }
      case "files.write": {
        const rooted = request as RemoteInput<"files.write">;
        const { cwd, relativePath } = rooted.input;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () => new ProjectWriteFileError(fileOutside(cwd, relativePath)),
            (input) => [underCwd(input.cwd, input.relativePath)],
            calls.writeFile,
          ),
        );
      }
      // Ticket 15: a Thread's file a URL serves; the Hub authorized it and named its root.
      case "files.inspectAsset": {
        const asked = request as RemoteInput<"files.inspectAsset">;
        return roots
          .withRoot(asked.root, (workspace) =>
            MachineAssets.inspectOnMachine(workspace, asked.relativePath, isServerInternalPath),
          )
          .pipe(
            Effect.catchTags({
              WorkspaceRootEscapeError: () =>
                Effect.fail(
                  new MachineAssets.MachineAssetError({
                    reason: "outside",
                    relativePath: asked.relativePath,
                  }),
                ),
            }),
          );
      }
      case "files.streamAsset": {
        const { subscriptionId, root, ...read } = request as RemoteInput<"files.streamAsset">;
        const window = roots
          .withRoot(root, (workspace) =>
            MachineAssets.readOnMachine(workspace, read, isServerInternalPath),
          )
          .pipe(
            Effect.catchTags({
              WorkspaceRootEscapeError: () =>
                Effect.fail(
                  new MachineAssets.MachineAssetError({
                    reason: "outside",
                    relativePath: read.relativePath,
                  }),
                ),
            }),
            Effect.map((items) => Stream.fromIterable(items)),
          );
        return openWorkspaceStream(
          "files.streamAsset",
          subscriptionId,
          Stream.unwrap(window),
          origin,
        );
      }
      case "search.paths": {
        const rooted = request as RemoteInput<"search.paths">;
        const { cwd, query, limit } = rooted.input;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () =>
              new ProjectSearchEntriesError({
                cwd,
                queryLength: query.length,
                limit,
                ...entriesOutside,
              }),
            () => [],
            calls.searchEntries,
          ),
        );
      }
      case "search.contents": {
        const rooted = request as RemoteInput<"search.contents">;
        const { cwd, query, limit } = rooted.input;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () =>
              new ProjectSearchContentsError({
                cwd,
                queryLength: query.length,
                limit,
                ...entriesOutside,
              }),
            () => [],
            calls.searchContents,
          ),
        );
      }
      case "entries.list": {
        const rooted = request as RemoteInput<"entries.list">;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () => new ProjectListEntriesError({ cwd: rooted.input.cwd, ...entriesOutside }),
            (input) =>
              input.directoryPath === undefined || input.directoryPath === ""
                ? []
                : [underCwd(input.cwd, input.directoryPath)],
            calls.listEntries,
          ),
        );
      }
      case "entries.listIgnored": {
        const rooted = request as RemoteInput<"entries.listIgnored">;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () => new ProjectListEntriesError({ cwd: rooted.input.cwd, ...entriesOutside }),
            () => [],
            calls.listIgnoredFiles,
          ),
        );
      }
      case "entries.browse": {
        const rooted = request as RemoteInput<"entries.browse">;
        const { partialPath, cwd } = rooted.input;
        return Effect.flatMap(workspaceCalls, (calls) =>
          inRoot(
            rooted,
            () =>
              new FilesystemBrowseError({
                partialPath,
                ...(cwd === undefined ? {} : { cwd }),
                failure: "outside_thread_workspace",
                message: OUTSIDE_MESSAGE,
              }),
            (input) => [underCwd(input.cwd, input.partialPath)],
            calls.browse,
          ),
        );
      }
      case "terminal.open": {
        const rooted = request as RemoteInput<"terminal.open">;
        return Effect.flatMap(workspaceRpc, ({ terminals }) =>
          roots
            .withRoot(rooted.root, (workspace) => terminalFoldersIn(workspace, rooted.input))
            .pipe(
              Effect.catchTags({
                WorkspaceRootEscapeError: () => Effect.fail(terminalOutside(rooted.input.threadId)),
              }),
              // Spec 5: the opening User's secrets, for this shell's environment alone.
              Effect.flatMap((input) => {
                knowSecrets(rooted.secretEnv);
                return terminals.open(input, {
                  secrets: rooted.secretEnv,
                  facts: rooted.facts ?? null,
                });
              }),
            ),
        );
      }
      case "terminal.write":
        return Effect.flatMap(workspaceRpc, ({ terminals }) =>
          terminals.write(request as RemoteInput<"terminal.write">),
        );
      case "terminal.resize": {
        const { input: size, viewerId } = request as RemoteInput<"terminal.resize">;
        return Effect.flatMap(workspaceRpc, ({ terminals }) => terminals.resize(size, viewerId));
      }
      case "terminal.clear":
        return Effect.flatMap(workspaceRpc, ({ terminals }) =>
          terminals.clear(request as RemoteInput<"terminal.clear">),
        );
      case "terminal.close":
        return Effect.flatMap(workspaceRpc, ({ terminals }) =>
          terminals.close(request as RemoteInput<"terminal.close">),
        );
      case "terminal.reconcile":
        return Effect.flatMap(workspaceRpc, ({ terminals }) =>
          terminals.reconcile(request as RemoteInput<"terminal.reconcile">),
        );
      case "terminal.stream":
        return openTerminalStream(request as RemoteInput<"terminal.stream">, origin);
      case "preview.open":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.open(request as RemoteInput<"preview.open">),
        );
      case "preview.resize":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.resize(request as RemoteInput<"preview.resize">),
        );
      case "preview.adjust":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.adjust(request as RemoteInput<"preview.adjust">),
        );
      case "preview.close":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.close(request as RemoteInput<"preview.close">),
        );
      case "preview.list":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.list(request as RemoteInput<"preview.list">),
        );
      case "preview.reportStatus":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          previews.reportStatus(request as RemoteInput<"preview.reportStatus">),
        );
      case "preview.events":
        return Effect.flatMap(workspaceRpc, ({ previews }) =>
          openWorkspaceStream(
            "preview.events",
            (request as RemoteInput<"preview.events">).subscriptionId,
            previews.events,
            origin,
          ),
        );
      // A preview the Hub serves: the Hub checked who asks; this machine reaches its loopback.
      case "preview.proxyHttp": {
        const { subscriptionId, ...proxied } = request as RemoteInput<"preview.proxyHttp">;
        return openWorkspaceStream(
          "preview.proxyHttp",
          subscriptionId,
          previewProxy.http(proxied),
          origin,
        );
      }
      case "preview.proxySocket": {
        const { subscriptionId, ...proxied } = request as RemoteInput<"preview.proxySocket">;
        return openWorkspaceStream(
          "preview.proxySocket",
          subscriptionId,
          previewProxy.socket(proxied),
          origin,
        );
      }
      case "preview.proxySocketSend":
        return previewProxy.send(request as RemoteInput<"preview.proxySocketSend">);
    }
  };

  /** Decodes, runs and encodes one request; errors outside the operation's own become protocol errors. */
  const answer = Effect.fn("EnvironmentAgent.answer")(function* (
    method: string,
    payload: unknown,
    origin: ExecutorChannel | undefined,
  ): Effect.fn.Return<ExecutorCallResult> {
    if (!isRemoteOperation(method)) {
      return { _tag: "failure", error: `This machine does not answer '${method}'.` };
    }
    const spec = REMOTE_OPERATIONS[method];
    const request = yield* Schema.decodeUnknownEffect(codec(spec.input))(payload).pipe(
      Effect.option,
    );
    if (Option.isNone(request)) {
      return { _tag: "failure", error: `The request for '${method}' could not be read.` };
    }
    const exit = yield* Effect.exit(run(method, request.value, origin));
    if (Exit.isSuccess(exit)) {
      const value = yield* Schema.encodeUnknownEffect(codec(spec.output))(exit.value).pipe(
        Effect.orElseSucceed(() => null),
      );
      return { _tag: "success", value };
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) {
      const encoded = yield* Schema.encodeUnknownEffect(codec(spec.error))(failure.value).pipe(
        Effect.option,
      );
      if (Option.isSome(encoded)) return { _tag: "failure", error: encoded.value };
    }
    yield* Effect.logWarning("An Environment request failed", { method, cause: exit.cause });
    const fallback = method.startsWith("provider.")
      ? new ProviderAdapter.ProviderAdapterProtocolError({
          driver: UNKNOWN_DRIVER,
          detail: Cause.pretty(exit.cause).slice(0, 500),
        })
      : undefined;
    const encodedFallback =
      fallback === undefined
        ? Option.none()
        : yield* Schema.encodeUnknownEffect(codec(spec.error))(fallback).pipe(Effect.option);
    return {
      _tag: "failure",
      error: Option.getOrElse(encodedFallback, () => Cause.pretty(exit.cause).slice(0, 500)),
    };
  });

  /**
   * An idempotency key runs once: a resend while it runs joins it, and one after it succeeded gets
   * the same answer. A failure is not kept, so the effect's next attempt runs the call again.
   */
  /** Answers a request that came on `origin`, the socket a stream it opens is bound to. */
  const onRequest = (
    request: {
      readonly method: string;
      readonly payload: unknown;
      readonly idempotencyKey: string | undefined;
    },
    origin: ExecutorChannel | undefined,
  ): Effect.Effect<ExecutorCallResult> => {
    const key = request.idempotencyKey;
    if (key === undefined) return answer(request.method, request.payload, origin);
    return Effect.suspend(() => {
      const known = answered.get(key);
      if (known !== undefined) {
        // Most recently used last, so eviction takes the oldest settled answers.
        answered.delete(key);
        answered.set(key, known);
        return Deferred.await(known.answer);
      }
      const entry = { answer: Deferred.makeUnsafe<ExecutorCallResult>(), settled: false };
      answered.set(key, entry);
      for (const [candidate, kept] of answered) {
        if (answered.size <= IDEMPOTENCY_MEMORY) break;
        // A call still running is never forgotten: its resend must join it.
        if (kept.settled) answered.delete(candidate);
      }
      return answer(request.method, request.payload, origin).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            entry.settled = true;
            if (result._tag === "failure" && answered.get(key) === entry) answered.delete(key);
          }).pipe(Effect.andThen(Deferred.succeed(entry.answer, result))),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (answered.get(key) === entry) answered.delete(key);
          }),
        ),
      );
    });
  };

  const onEvent = (method: string, payload: unknown): Effect.Effect<void> => {
    if (method === ENVIRONMENT_EXECUTOR_FRAME_METHODS.textGenerationCancel) {
      // The Hub stopped waiting for a summary: stop paying for it.
      const cancelled = decodeGenerationCancel(payload);
      const running = Option.isNone(cancelled)
        ? undefined
        : generations.get(cancelled.value.generationId);
      return running === undefined ? Effect.void : Fiber.interrupt(running).pipe(Effect.asVoid);
    }
    if (method === ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamCancel) {
      const cancelled = decodeStreamCancel(payload);
      return Option.isNone(cancelled)
        ? Effect.void
        : closeWorkspaceStream(cancelled.value.subscriptionId);
    }
    if (method === ENVIRONMENT_EXECUTOR_FRAME_METHODS.retired) {
      // Sessions the Hub no longer has: nothing would read them, so their processes go.
      const retired = decodeRetired(payload);
      if (Option.isNone(retired)) return Effect.void;
      return Effect.forEach(
        retired.value.providerSessionIds,
        (providerSessionId) => {
          const session = sessions.get(providerSessionId);
          return session === undefined ? Effect.void : forgetSession(providerSessionId, session);
        },
        { discard: true },
      );
    }
    if (method !== ENVIRONMENT_EXECUTOR_FRAME_METHODS.ack) return Effect.void;
    return Effect.sync(() => {
      const acks = decodeAck(payload);
      if (Option.isNone(acks)) return;
      for (const ack of acks.value.acks) {
        const session = sessions.get(ack.providerSessionId);
        if (session === undefined) continue;
        while (session.spool.length > 0 && session.spool[0]!.seq <= ack.seq) session.spool.shift();
        // Its end reached the Hub: nothing about it is left to resend.
        if (session.ended && session.spool.length === 0) sessions.delete(ack.providerSessionId);
      }
    });
  };

  return EnvironmentAgent.of({
    report: Effect.gen(function* () {
      const described = yield* local.host.describe;
      return {
        workspaceRoot,
        orchestration: {
          providers: described.providers,
          unavailableProviders: described.unavailableProviders,
        },
        sessions: [...sessions.entries()].map(([providerSessionId, session]) => ({
          providerSessionId,
          threadId: session.threadId,
          lastSeq: session.seq,
        })),
      };
    }),
    attach: Effect.fn("EnvironmentAgent.attach")(function* (write) {
      let origin: ExecutorChannel | undefined;
      const connected = yield* makeExecutorChannel({
        environmentId: input.environmentId,
        write,
        onRequest: (request) => onRequest(request, origin),
        onEvent,
      });
      origin = connected;
      yield* Effect.addFinalizer(() =>
        connected.close.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (channel === connected) channel = undefined;
            }),
          ),
          // Live streams end with their socket; the Hub opens them again on the next one.
          Effect.andThen(
            Effect.forEach(
              [...workspaceStreams.entries()].filter(([, open]) => open.channel === connected),
              ([subscriptionId]) => closeWorkspaceStream(subscriptionId),
              { discard: true },
            ),
          ),
        ),
      );
      // What the Hub had not acknowledged when the last connection dropped, in order; it drops
      // duplicates. New events wait in the spool until the replay catches up, then go live: the
      // check and the switch happen without yielding, so none is skipped or overtakes an older one.
      const replayed = new Map<LocalSession, number>();
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const session of sessions.values()) {
          for (const entry of session.spool) {
            if (entry.seq <= (replayed.get(session) ?? 0)) continue;
            yield* connected.event(entry.method, entry.frame);
            replayed.set(session, entry.seq);
            progressed = true;
          }
        }
      }
      channel = connected;
      return { receive: connected.receive };
    }),
  });
});

export const layer = (input: EnvironmentAgentInput) => Layer.effect(EnvironmentAgent, make(input));
