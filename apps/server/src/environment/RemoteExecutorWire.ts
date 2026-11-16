/**
 * The payloads of the executor operations a joined Environment runs for the Hub, in their JSON
 * codecs. The envelope (frames, operation names, event and ack payloads) is the versioned contract
 * in `@t3tools/contracts` (`environmentExecutor.ts`); these are built from the provider adapter's
 * own schemas, which live beside the adapters, so both halves of the server share them here.
 */
import {
  AiGatewayAccess,
  CheckpointId,
  CheckpointRef,
  EnvironmentExecutorUnavailableError,
  FilesystemBrowseError,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ModelSelection,
  PreviewAdjustInput,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewOpenInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalReconcileInput,
  TerminalShellFacts,
  TerminalError,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
  TextGenerationError,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUserInputAnswers,
  RunAttemptId,
  SecretEnv,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsError,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

import {
  MoveFetchResult,
  MovePrepareInput,
  MovePrepareResult,
  MoveRecoverInput,
  MoveRecoverResult,
  MovePublishScratchInput,
  MovePublishScratchResult,
} from "./MovedWorkspace.ts";
import * as PreviewProxy from "../preview/PreviewProxy.ts";
import * as MachineAssets from "../assets/MachineAssets.ts";

const RuntimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy;
const ProviderThread = OrchestrationV2ProviderThread;

/** An attachment the turn carries, by the id the Hub stores it under and its content hash. */
export const WireAttachmentRef = Schema.Struct({ id: Schema.String, sha256: Schema.String });
export type WireAttachmentRef = typeof WireAttachmentRef.Type;

/** The per-Thread MCP credential the Hub issued; the Environment points it at the Hub's `/mcp`. */
export const WireMcpCredential = Schema.Struct({
  credentialId: Schema.String,
  authorizationHeader: Schema.String,
  browserToolsAvailable: Schema.Boolean,
  capabilities: Schema.Array(Schema.String),
});
export type WireMcpCredential = typeof WireMcpCredential.Type;

/**
 * Where the Project's checkout is on the Environment, where to make it from when missing, and the
 * Thread's checkpoint refs the Hub repository has, for the checkout to fetch the ones it lacks.
 */
export const WireCheckout = Schema.Struct({
  path: Schema.String,
  /**
   * The Project's own remote (the Hub checkout's `origin`, its password or token removed): a new
   * checkout names it `origin`, and is cloned from it only when `fromHub` is absent.
   */
  cloneUrl: Schema.NullOr(Schema.String),
  /**
   * Present when the Hub has its own checkout of the Project in a root it trusts: a new checkout
   * is made from the Hub's copy of it (`refs/t3/project/`) with the Environment credential, or
   * fails; `branch` is the one the Hub's checkout is on (none: its HEAD is detached). Sent only
   * to machines of executor contract 9 or later.
   */
  fromHub: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      branch: Schema.optionalKey(Schema.String),
      /** The Hub's branches whose upstream is `origin`: the new checkout's track the same. */
      upstreams: Schema.optionalKey(
        Schema.Array(Schema.Struct({ branch: Schema.String, merge: Schema.String })),
      ),
    }),
  ),
  /**
   * Where the Project's folder is in its repository ("packages/web"), when not at its top: `path`
   * ends with it, and a new checkout makes the repository at `path` without it.
   */
  subfolder: Schema.optionalKey(Schema.String),
  /** A Thread without a Project: `path` is its scratch workspace, made (with git) when missing. */
  scratch: Schema.optionalKey(Schema.Boolean),
  hubRefs: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      scratchThreadId: Schema.optionalKey(ThreadId),
      refs: Schema.Array(CheckpointRef),
    }),
  ),
});
export type WireCheckout = typeof WireCheckout.Type;

const OpenSessionInput = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  instanceId: Schema.String,
  modelSelection: ModelSelection,
  runtimePolicy: RuntimePolicy,
  resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
  mcp: Schema.optionalKey(WireMcpCredential),
  checkout: Schema.optionalKey(WireCheckout),
  /** Contract 10: the Thread owner's secrets, for the provider process's environment alone. */
  secretEnv: Schema.optionalKey(SecretEnv),
  /**
   * Contract 11: the Thread's session on the Hub's AI gateway (key, account, model). The machine
   * adds its own relay and provider home; never logged, kept or answered back.
   */
  aiGateway: Schema.optionalKey(AiGatewayAccess),
});

/** Which optional session methods the Environment's runtime has. */
const SessionFeatures = Schema.Struct({
  injectHistory: Schema.Boolean,
  compactThread: Schema.Boolean,
  stopTask: Schema.Boolean,
  unloadThread: Schema.Boolean,
  hasPendingBackgroundWork: Schema.Boolean,
  backgroundTasksEndWithProcess: Schema.Boolean,
});
export type WireSessionFeatures = typeof SessionFeatures.Type;

const OpenSessionResult = Schema.Struct({
  providerSession: OrchestrationV2ProviderSession,
  features: SessionFeatures,
});

/** A call on a session the Environment already opened. */
const onSession = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ providerSessionId: ProviderSessionId, input });

const TurnMessage = ProviderAdapter.ProviderAdapterV2TurnMessage;

const TurnInput = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: ProviderThread,
  message: TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});

const SteerInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  providerThread: ProviderThread,
  providerTurnId: ProviderTurnId,
  message: TurnMessage,
});

const ThreadSnapshot = Schema.Struct({
  providerThread: ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});

const RollbackTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread_start"),
    checkpointId: CheckpointId,
    appRunOrdinal: Schema.Literal(0),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn"),
    checkpointId: CheckpointId,
    appRunOrdinal: Schema.Number,
    providerTurn: OrchestrationV2ProviderTurn,
    message: Schema.optionalKey(
      Schema.Struct({
        role: OrchestrationV2ConversationMessage.fields.role,
        text: OrchestrationV2ConversationMessage.fields.text,
        attachments: OrchestrationV2ConversationMessage.fields.attachments,
      }),
    ),
  }),
]);

const Empty = Schema.Struct({});

const provider = <I extends Schema.Top, O extends Schema.Top>(input: I, output: O) => ({
  input,
  output,
  error: ProviderAdapter.ProviderAdapterV2Error,
});

const checkpoint = <I extends Schema.Top, O extends Schema.Top>(input: I, output: O) => ({
  input,
  output,
  error: Schema.Union([VcsError, EnvironmentExecutorUnavailableError]),
});

const workspace = <I extends Schema.Top, O extends Schema.Top, E extends Schema.Top>(
  input: I,
  output: O,
  error: E,
) => ({ input, output, error });

/** A workspace call: the Thread's workspace root on the machine, and paths relative to it. */
const rooted = <I extends Schema.Top>(input: I) => Schema.Struct({ root: Schema.String, input });

const DiffInput = Schema.Struct({
  cwd: Schema.String,
  fromCheckpointRef: CheckpointRef,
  toCheckpointRef: CheckpointRef,
  fallbackFromToHead: Schema.optionalKey(Schema.Boolean),
  ignoreWhitespace: Schema.Boolean,
  format: Schema.optionalKey(Schema.Literals(["patch", "numstat"])),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
  filePaths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const HubRepositoryTransfer = Schema.Struct({
  cwd: Schema.String,
  projectId: ProjectId,
  /** The Thread without a Project whose own repository this is (`/api/git/thread/<id>`). */
  scratchThreadId: Schema.optionalKey(ThreadId),
  checkpointRefs: Schema.Array(CheckpointRef),
});

/** Every operation a joined Environment answers today, with its codecs. */
export const REMOTE_OPERATIONS = {
  "provider.openSession": provider(OpenSessionInput, OpenSessionResult),
  "provider.ensureThread": provider(
    onSession(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.optionalKey(Schema.String),
        modelSelection: ModelSelection,
        runtimePolicy: RuntimePolicy,
        providerSessionId: Schema.optionalKey(ProviderSessionId),
        existingProviderThread: Schema.optionalKey(ProviderThread),
        forceNewNativeThread: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    ProviderThread,
  ),
  "provider.resumeThread": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        threadId: Schema.optionalKey(ThreadId),
        modelSelection: Schema.optionalKey(ModelSelection),
        runtimePolicy: Schema.optionalKey(RuntimePolicy),
      }),
    ),
    ProviderThread,
  ),
  "provider.startTurn": provider(
    Schema.Struct({
      providerSessionId: ProviderSessionId,
      input: TurnInput,
      attachments: Schema.Array(WireAttachmentRef),
    }),
    Schema.Void,
  ),
  "provider.compactThread": provider(onSession(TurnInput), Schema.Void),
  "provider.steer": provider(
    Schema.Struct({
      providerSessionId: ProviderSessionId,
      input: SteerInput,
      attachments: Schema.Array(WireAttachmentRef),
    }),
    Schema.Void,
  ),
  "provider.interrupt": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        providerTurnId: ProviderTurnId,
        requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    Schema.Void,
  ),
  "provider.respond": provider(
    onSession(
      Schema.Struct({
        requestId: RuntimeRequestId,
        decision: Schema.optionalKey(ProviderApprovalDecision),
        feedback: Schema.optionalKey(Schema.String),
        answers: Schema.optionalKey(ProviderUserInputAnswers),
      }),
    ),
    Schema.Void,
  ),
  "provider.readThreadSnapshot": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread })),
    ThreadSnapshot,
  ),
  "provider.rollback": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        target: RollbackTarget,
        providerThreadTurns: Schema.Array(OrchestrationV2ProviderTurn),
      }),
    ),
    ThreadSnapshot,
  ),
  "provider.forkThread": provider(
    onSession(
      Schema.Struct({
        sourceProviderThread: ProviderThread,
        sourceProviderTurns: Schema.optionalKey(Schema.Array(OrchestrationV2ProviderTurn)),
        providerTurnId: Schema.optionalKey(ProviderTurnId),
        targetThreadId: ThreadId,
        ownerNodeId: Schema.optionalKey(NodeId),
        modelSelection: Schema.optionalKey(ModelSelection),
        runtimePolicy: Schema.optionalKey(RuntimePolicy),
      }),
    ),
    ProviderThread,
  ),
  "provider.injectHistory": provider(
    onSession(
      Schema.Struct({
        messages: Schema.Array(OrchestrationV2HistoricalMessage),
        context: Schema.String,
        providerThread: ProviderThread,
      }),
    ),
    Schema.Boolean,
  ),
  "provider.stopTask": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread, taskId: Schema.String })),
    Schema.Void,
  ),
  "provider.unloadThread": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread })),
    Schema.Void,
  ),
  "provider.hasPendingBackgroundWork": provider(onSession(Empty), Schema.Boolean),
  "provider.detach": provider(onSession(Empty), Schema.Void),
  // A moved Thread's handoff summary, written with this machine's text generation.
  "textGeneration.threadHandoff": {
    input: Schema.Struct({
      cwd: Schema.String,
      threadTitle: Schema.String,
      transcript: Schema.String,
      changedFiles: Schema.Array(Schema.String),
      sourceEnvironmentName: Schema.String,
      targetEnvironmentName: Schema.String,
      modelSelection: ModelSelection,
      /** Names the call for `textGeneration.cancel`, which stops it when the Hub gives up. */
      generationId: Schema.optionalKey(Schema.String),
    }),
    output: Schema.Struct({
      summary: Schema.String,
      providerInstanceId: Schema.optionalKey(Schema.String),
    }),
    error: Schema.Union([TextGenerationError, EnvironmentExecutorUnavailableError]),
  },
  // A Thread's title, written with the text generation of the machine it runs on.
  "textGeneration.threadTitle": {
    input: Schema.Struct({
      cwd: Schema.String,
      message: Schema.String,
      previousTitle: Schema.optionalKey(Schema.String),
      forkSource: Schema.optionalKey(
        Schema.Struct({ title: Schema.String, history: Schema.String }),
      ),
      instructions: Schema.optionalKey(Schema.String),
      modelSelection: ModelSelection,
    }),
    output: Schema.Struct({ title: Schema.String }),
    error: Schema.Union([TextGenerationError, EnvironmentExecutorUnavailableError]),
  },
  "checkpoint.isGitRepository": checkpoint(Schema.Struct({ cwd: Schema.String }), Schema.Boolean),
  "checkpoint.hasRef": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRef: CheckpointRef }),
    Schema.Boolean,
  ),
  "checkpoint.capture": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRef: CheckpointRef }),
    Schema.Void,
  ),
  "checkpoint.restore": checkpoint(
    Schema.Struct({
      cwd: Schema.String,
      checkpointRef: CheckpointRef,
      fallbackToHead: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Boolean,
  ),
  "checkpoint.diff": checkpoint(DiffInput, Schema.String),
  "checkpoint.listAuthoredPaths": checkpoint(
    Schema.Struct({
      cwd: Schema.String,
      fromCheckpointRef: CheckpointRef,
      toCheckpointRef: CheckpointRef,
    }),
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
  "checkpoint.deleteRefs": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRefs: Schema.Array(CheckpointRef) }),
    Schema.Void,
  ),
  "checkpoint.push": checkpoint(HubRepositoryTransfer, Schema.Void),
  "checkpoint.fetch": checkpoint(HubRepositoryTransfer, Schema.Void),
  // A Thread without a Project's folder made before folders got git: it gets its repository.
  "checkpoint.ensureScratch": checkpoint(Schema.Struct({ folder: Schema.String }), Schema.Void),
  // A Thread without a Project leaves: its folder's branches and HEAD, as refs to push.
  "move.publishScratch": checkpoint(MovePublishScratchInput, MovePublishScratchResult),
  // Moving a Thread here: the checkout (cloned when missing) fetches what the Thread continues
  // from, then the Thread's branch or worktree is made over it and the setup script runs.
  "move.fetch": checkpoint(
    Schema.Struct({
      checkout: WireCheckout,
      projectId: ProjectId,
      scratchThreadId: Schema.optionalKey(ThreadId),
      /** A Thread without a Project: where its folder's own history is, fetched too. */
      scratchHistory: Schema.optionalKey(Schema.String),
      refs: Schema.Array(CheckpointRef),
    }),
    MoveFetchResult,
  ),
  "move.prepare": checkpoint(MovePrepareInput, MovePrepareResult),
  // Back with a Thread that moved away: its changes never uploaded go to a recovered ref.
  "move.recover": checkpoint(MoveRecoverInput, MoveRecoverResult),
  // Workspace calls name the Thread's workspace root on the machine and paths relative to it; the
  // machine refuses whatever resolves (symlinks included) outside the root. They carry the
  // contract's own errors, so the Hub hands a machine's answer to the client as it came.
  "files.read": workspace(
    rooted(ProjectReadFileInput),
    ProjectReadFileResult,
    ProjectReadFileError,
  ),
  "files.write": workspace(
    rooted(ProjectWriteFileInput),
    ProjectWriteFileResult,
    ProjectWriteFileError,
  ),
  /** Contract 15: a Thread's file a URL will serve, as it is now on the machine. */
  "files.inspectAsset": workspace(
    MachineAssets.MachineAssetInspectInput,
    MachineAssets.MachineAssetInspection,
    MachineAssets.MachineAssetError,
  ),
  /** Contract 15: one window of that file, streamed back (`MachineAssetItem`s). */
  "files.streamAsset": workspace(
    Schema.Struct({
      subscriptionId: Schema.String,
      ...MachineAssets.MachineAssetReadInput.fields,
    }),
    Schema.Void,
    MachineAssets.MachineAssetError,
  ),
  "search.paths": workspace(
    rooted(ProjectSearchEntriesInput),
    ProjectSearchEntriesResult,
    ProjectSearchEntriesError,
  ),
  "search.contents": workspace(
    rooted(ProjectSearchContentsInput),
    ProjectSearchContentsResult,
    ProjectSearchContentsError,
  ),
  "entries.list": workspace(
    rooted(ProjectListEntriesInput),
    ProjectListEntriesResult,
    ProjectListEntriesError,
  ),
  "entries.listIgnored": workspace(
    rooted(ProjectListIgnoredFilesInput),
    ProjectListIgnoredFilesResult,
    ProjectListEntriesError,
  ),
  "entries.browse": workspace(
    rooted(FilesystemBrowseInput),
    FilesystemBrowseResult,
    FilesystemBrowseError,
  ),
  "terminal.open": workspace(
    Schema.Struct({
      root: Schema.String,
      input: TerminalOpenInput,
      /** Contract 10: the opening User's secrets, for the shell's environment alone. */
      secretEnv: Schema.optionalKey(SecretEnv),
      /** Contract 12: what a shell this starts was started with, kept with its session. */
      facts: Schema.optionalKey(TerminalShellFacts),
    }),
    TerminalSessionSnapshot,
    TerminalError,
  ),
  "terminal.write": workspace(TerminalWriteInput, Schema.Void, TerminalError),
  "terminal.resize": workspace(
    Schema.Struct({ input: TerminalResizeInput, viewerId: Schema.optionalKey(Schema.String) }),
    Schema.Void,
    TerminalError,
  ),
  "terminal.clear": workspace(TerminalClearInput, Schema.Void, TerminalError),
  "terminal.close": workspace(TerminalCloseInput, Schema.Void, TerminalError),
  /** Contract 12: closes the shells the Hub's word no longer allows; answers how many. */
  "terminal.reconcile": workspace(TerminalReconcileInput, Schema.Number, TerminalError),
  /** Opens a stream of `TerminalAttachStreamEvent`s; its items come as `workspace.stream` frames. */
  "terminal.stream": workspace(
    Schema.Struct({
      subscriptionId: Schema.String,
      mode: Schema.Literals(["attach", "observe"]),
      root: Schema.String,
      input: TerminalAttachInput,
      viewerId: Schema.optionalKey(Schema.String),
      /** Contract 10: for a shell the attach starts, the opening User's secrets. */
      secretEnv: Schema.optionalKey(SecretEnv),
      /** Contract 12: for a shell the attach starts, what it is started with. */
      facts: Schema.optionalKey(TerminalShellFacts),
    }),
    Schema.Void,
    TerminalError,
  ),
  "preview.open": workspace(PreviewOpenInput, PreviewSessionSnapshot, PreviewError),
  "preview.resize": workspace(PreviewResizeInput, PreviewSessionSnapshot, PreviewError),
  "preview.adjust": workspace(PreviewAdjustInput, PreviewSessionSnapshot, PreviewError),
  "preview.close": workspace(PreviewCloseInput, Schema.Void, PreviewError),
  "preview.list": workspace(PreviewListInput, PreviewListResult, PreviewError),
  "preview.reportStatus": workspace(PreviewReportStatusInput, Schema.Void, PreviewError),
  /** Opens the machine's stream of `PreviewEvent`s, every Thread's, while its socket lives. */
  "preview.events": workspace(
    Schema.Struct({ subscriptionId: Schema.String }),
    Schema.Void,
    PreviewError,
  ),
  /**
   * A request to a dev server on the machine's loopback, for a preview the Hub serves: its
   * response streams back (`PreviewProxyHttpItem`s). The Hub checked who asks before sending it.
   */
  "preview.proxyHttp": workspace(
    Schema.Struct({
      subscriptionId: Schema.String,
      ...PreviewProxy.PreviewProxyHttpRequest.fields,
    }),
    Schema.Void,
    PreviewProxy.PreviewProxyError,
  ),
  /** A WebSocket to a dev server on the machine's loopback; what it receives streams back. */
  "preview.proxySocket": workspace(
    Schema.Struct({
      subscriptionId: Schema.String,
      ...PreviewProxy.PreviewProxySocketRequest.fields,
    }),
    Schema.Void,
    PreviewProxy.PreviewProxyError,
  ),
  /** A message (or the close) the browser sent on a proxied WebSocket, in order. */
  "preview.proxySocketSend": workspace(
    PreviewProxy.PreviewProxySocketSend,
    Schema.Void,
    PreviewProxy.PreviewProxyError,
  ),
} as const;

/**
 * The item each stream-opening operation streams, in its JSON codec. A proxied response's chunks
 * are up to 64 KiB each (`PREVIEW_PROXY_CHUNK_BYTES`).
 */
export const REMOTE_STREAM_ITEMS = {
  "terminal.stream": TerminalAttachStreamEvent,
  "preview.events": PreviewEvent,
  "preview.proxyHttp": PreviewProxy.PreviewProxyHttpItem,
  "preview.proxySocket": PreviewProxy.PreviewProxySocketItem,
  "files.streamAsset": MachineAssets.MachineAssetItem,
} as const;
export type RemoteStreamOperation = keyof typeof REMOTE_STREAM_ITEMS;
export type RemoteStreamItem<O extends RemoteStreamOperation> =
  (typeof REMOTE_STREAM_ITEMS)[O]["Type"];

export type RemoteOperation = keyof typeof REMOTE_OPERATIONS;
export type RemoteInput<O extends RemoteOperation> = (typeof REMOTE_OPERATIONS)[O]["input"]["Type"];
export type RemoteOutput<O extends RemoteOperation> =
  (typeof REMOTE_OPERATIONS)[O]["output"]["Type"];
export type RemoteError<O extends RemoteOperation> = (typeof REMOTE_OPERATIONS)[O]["error"]["Type"];

export const isRemoteOperation = (method: string): method is RemoteOperation =>
  Object.hasOwn(REMOTE_OPERATIONS, method);

/** The provider event a session streams, in its JSON codec. */
export const ProviderEventJson = Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event);
