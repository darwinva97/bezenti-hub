/**
 * Where workspace RPCs (files, search, browse, terminals, previews) run: one naming a Thread on its
 * Active environment, inside its workspace there; one naming none on the Hub machine. The machine
 * comes from the Thread, never from a client path (`docs/internals/overview.md`, «Workspace RPCs»).
 */
import {
  FilesystemBrowseError,
  type FilesystemBrowseInput,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  type EnvironmentId,
  NO_SECRETS_FINGERPRINT,
  REMOTE_ASSETS_CONTRACT_VERSION,
  SECRET_ENV_CONTRACT_VERSION,
  type SecretEnv,
  SHELL_FACTS_CONTRACT_VERSION,
  type TerminalSessionSnapshot,
  type TerminalShellFacts,
  HUB_MACHINE_ENVIRONMENT_ID,
  HUB_RUNS_NO_AGENTS_MESSAGE,
  type PreviewAdjustInput,
  type PreviewCloseInput,
  PreviewEnvironmentUnavailableError,
  type PreviewError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewOpenInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  type ProjectId,
  ProjectListEntriesError,
  type ProjectListEntriesInput,
  type ProjectListIgnoredFilesInput,
  ProjectReadFileError,
  type ProjectReadFileInput,
  ProjectSearchContentsError,
  type ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  type ProjectSearchEntriesInput,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  TerminalEnvironmentUnavailableError,
  type TerminalError,
  type TerminalObserveInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalWriteInput,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as MachineAssets from "../assets/MachineAssets.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { terminalOutputStream } from "../terminal/OutputProtocol.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { makeWorkspaceRpcCalls } from "../workspace/WorkspaceRpcCalls.ts";
import * as EnvironmentDemand from "./EnvironmentDemand.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";
import * as HubRunsAgents from "./HubRunsAgents.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import * as RemoteEnvironments from "./RemoteEnvironments.ts";
import { locateInCheckout } from "./WorkspaceLocation.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import { hideErrorText } from "@t3tools/shared/secretMasking";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import {
  hiddenTerminalSnapshot,
  maskTerminalSnapshot,
  maskTerminalStream,
} from "../vaults/maskTerminal.ts";
import { HIDDEN_OUTPUT } from "../vaults/heldText.ts";
import {
  FILE_HOLDS_SECRETS,
  HIDDEN_CONTENT,
  maskReadFile,
  maskSearchContents,
  placeholderNames,
  searchOverFetchLimit,
} from "../vaults/maskWorkspace.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

/** Who asks: the session's User, whose rules a forwarded call keeps to. */
export interface WorkspaceCaller {
  readonly userId: UserId | undefined;
  /**
   * The User acts (opens a terminal, types, writes a file, opens a preview): a stopped Sandbox
   * starts for it. Reads and listings never start one, nor count as use.
   */
  readonly startsSandbox?: boolean;
}

/** The same caller, acting: a stopped Sandbox starts for the call. */
const acting = (caller: WorkspaceCaller): WorkspaceCaller => ({ ...caller, startsSandbox: true });

type Route =
  | { readonly _tag: "local" }
  | {
      readonly _tag: "remote";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly forward: EnvironmentExecutor.EnvironmentWorkspaceForward;
      /** The Thread's workspace as the Hub machine records it, which clients send. */
      readonly hubBase: string;
      /** The same workspace on the Thread's machine: the root every forwarded path is under. */
      readonly remoteBase: string;
    }
  | {
      readonly _tag: "offline";
      readonly name: string | undefined;
      /** A Sandbox that is not running, which a read does not start. */
      readonly stopped?: boolean;
    }
  | { readonly _tag: "refused" }
  /** An action (a terminal, a write) the Hub machine would run, and it runs no agents. */
  | { readonly _tag: "hub-off" };

const LOCAL: Route = { _tag: "local" };
const HUB_OFF: Route = { _tag: "hub-off" };
const REFUSED: Route = { _tag: "refused" };
const withThread = (error: TerminalEnvironmentUnavailableError, threadId: string) =>
  new TerminalEnvironmentUnavailableError({ ...error, threadId });

const offlineMessage = (name: string | undefined, stopped = false) =>
  stopped
    ? `Sandbox stopped: ${name ?? "the Sandbox"} starts when you send a message or open a terminal.`
    : name === undefined
      ? "Environment offline: this Thread has no Environment right now. Move it to one to use its files and terminals."
      : `Environment offline: ${name} is not connected. Start it to use this Thread's files and terminals.`;
const REFUSED_MESSAGE = "That is outside this Thread's workspace.";

/** A path inside a workspace, `/`-separated; undefined when it leaves it or names another root. */
const relativeInside = (path: string): string | undefined => {
  if (path.startsWith("~") || path.startsWith("/") || path.startsWith("\\")) return undefined;
  if (isWindowsAbsolutePath(path)) return undefined;
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments.length === 0 ? "." : segments.join("/");
};

const isAbsolute = (path: string) =>
  path.startsWith("/") || path.startsWith("\\") || isWindowsAbsolutePath(path);

const isTerminalUnavailable = Schema.is(TerminalEnvironmentUnavailableError);
/** An attach without a folder found no shell to reattach (as the machine says it, old or new). */
const noShellToReattach = (error: TerminalError) =>
  error._tag === "TerminalSessionLookupError" ||
  (isTerminalUnavailable(error) && error.reason === "outside_thread_workspace");

export const make = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const checkouts = yield* Effect.serviceOption(ProjectCheckouts.ProjectCheckouts);
  const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
  const remoteEnvironments = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
  // Sandboxes start for these calls and count them, and open terminals, as activity.
  const demand = yield* Effect.serviceOption(EnvironmentDemand.EnvironmentDemand);
  const runsAgents = yield* HubRunsAgents.HubRunsAgents;
  // Spec 5 ticket 04: a shell gets the secrets of the User who opens it, read as it opens.
  const secretDelivery = yield* Effect.serviceOption(SecretDelivery.SecretDelivery);
  // Spec 5 ticket 05: and what comes back from the Thread's machine is masked.
  const secretMasker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  // Spec 5 ticket 07: where secrets are delivered, a shell is used only while its facts hold.
  const factsSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const spaceDirectory = yield* Effect.serviceOption(SpaceDirectory.SpaceDirectory);
  const factsRule = Option.isSome(secretDelivery);
  const hubMachine = Option.isSome(registry)
    ? yield* Effect.option(registry.value.get(registry.value.hubMachineEnvironmentId))
    : Option.none();
  // The Hub machine's executor's services; a host built without the registry has its own.
  const hubMachineRpc = Option.flatMap(hubMachine, (executor) => executor.workspace.rpc);
  const hostRpc = Option.all({
    entries: yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries),
    files: yield* Effect.serviceOption(WorkspaceFileSystem.WorkspaceFileSystem),
    terminals: yield* Effect.serviceOption(TerminalManager.TerminalManager),
    previews: yield* Effect.serviceOption(PreviewManager.PreviewManager),
    ports: yield* Effect.serviceOption(PortScanner.PortDiscovery),
  });
  const localRpc = Option.isSome(hubMachineRpc) ? hubMachineRpc : hostRpc;
  const local = Option.match(localRpc, {
    onSome: Effect.succeed,
    onNone: () => Effect.die(new Error("This server has no workspace services.")),
  });
  const localCalls = Effect.map(local, makeWorkspaceRpcCalls);

  /** The Thread's workspace on its own machine, or why it cannot be reached from here. */
  const route = Effect.fn("ThreadWorkspace.route")(function* (
    threadId: string | undefined,
    caller: WorkspaceCaller,
  ) {
    // The Hub machine's services answer reads of the Hub's own copy (listings, search, reading
    // files, browsing folders), which run no code; with no agents on it, nothing that acts.
    const local = runsAgents || caller.startsSandbox !== true ? LOCAL : HUB_OFF;
    if (
      threadId === undefined ||
      Option.isNone(registry) ||
      Option.isNone(projections) ||
      Option.isNone(checkouts) ||
      Option.isNone(environments)
    ) {
      return local;
    }
    const environmentId = yield* registry.value.activeEnvironment(ThreadId.make(threadId));
    // A draft, or a Thread on the Hub machine: the Hub machine's services answer, as before.
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return local;
    if (environmentId === EnvironmentExecutor.NO_ENVIRONMENT_ID) {
      // A draft (not placed yet) on a Hub that runs no agents: as a call without a Thread.
      if (
        !runsAgents &&
        Option.isNone(yield* Effect.option(projections.value.getThread(ThreadId.make(threadId))))
      ) {
        return local;
      }
      return { _tag: "offline", name: undefined } satisfies Route;
    }
    const usable = yield* environments.value
      .usableBy({ userId: caller.userId, environmentId, threadId: ThreadId.make(threadId) })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(usable)) return REFUSED;
    const name = usable.value.name;
    const offline: Route = { _tag: "offline", name };
    if (Option.isSome(demand)) {
      // A User's action starts a stopped Sandbox and waits; a read answers at once, untouched.
      if (caller.startsSandbox !== true) {
        if (!(yield* demand.value.ready(environmentId))) {
          return { _tag: "offline", name, stopped: true } satisfies Route;
        }
      } else {
        const started = yield* demand.value
          .awaitStarted(environmentId, { actorUserId: caller.userId, explicit: true })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("A Sandbox did not start for a workspace call", {
                environmentId,
                detail: error.detail,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!started) return offline;
      }
    }
    const executor = yield* Effect.option(registry.value.get(environmentId));
    if (Option.isNone(executor) || Option.isNone(executor.value.workspace.forward)) return offline;
    const thread = yield* Effect.option(projections.value.getThread(ThreadId.make(threadId)));
    if (Option.isNone(thread) || Option.isNone(hubMachine)) return REFUSED;
    const projectId: ProjectId = thread.value.projectId;
    const hubCheckout = yield* hubMachine.value.workspace.paths.checkout(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    // A worktree the machine cannot resolve is refused, never swapped for the main checkout.
    const remoteWorktree = yield* EnvironmentExecutor.worktreeOn(
      registry.value,
      checkouts.value,
      executor.value,
      thread.value,
    ).pipe(Effect.option);
    if (Option.isNone(remoteWorktree)) return REFUSED;
    const remoteCheckout = yield* executor.value.workspace.paths.checkout(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    const hubBase = thread.value.worktreePath ?? hubCheckout;
    const remoteBase = remoteWorktree.value ?? remoteCheckout;
    if (hubBase === null || remoteBase === null) return REFUSED;
    return {
      _tag: "remote",
      environmentId,
      name,
      forward: executor.value.workspace.forward.value,
      hubBase,
      remoteBase,
    } satisfies Route;
  });

  /**
   * A path inside the Thread's workspace, relative to its root (`remoteBase`). Clients send the
   * workspace as the Hub records it or as the machine reported it; anything else is outside. The
   * machine resolves it against the root and refuses what its symlinks take outside.
   */
  const onMachine = (
    route: Extract<Route, { _tag: "remote" }>,
    absolute: string,
  ): string | undefined => {
    for (const base of [route.hubBase, route.remoteBase]) {
      const location = locateInCheckout({
        environmentId: HUB_MACHINE_ENVIRONMENT_ID,
        checkout: base,
        absolute,
      });
      if (location.base === "checkout") return location.path;
    }
    return undefined;
  };

  const fileFailure = (route: Route, input: { cwd: string; relativePath: string }) =>
    route._tag === "hub-off"
      ? {
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "hub_runs_no_agents" as const,
          message: HUB_RUNS_NO_AGENTS_MESSAGE,
        }
      : route._tag === "offline"
        ? {
            cwd: input.cwd,
            relativePath: input.relativePath,
            failure: "environment_offline" as const,
            message: offlineMessage(route.name, route.stopped),
          }
        : {
            cwd: input.cwd,
            relativePath: input.relativePath,
            failure: "workspace_path_outside_root" as const,
            message: REFUSED_MESSAGE,
          };

  const entriesFailure = (route: Route) =>
    route._tag === "hub-off"
      ? { failure: "environment_offline" as const, message: HUB_RUNS_NO_AGENTS_MESSAGE }
      : route._tag === "offline"
        ? {
            failure: "environment_offline" as const,
            message: offlineMessage(route.name, route.stopped),
          }
        : { failure: "outside_thread_workspace" as const, message: REFUSED_MESSAGE };

  /** A call its Thread names the machine for, with that call's own offline and refused errors. */
  const threadCall = Effect.fn("ThreadWorkspace.threadCall")(function* <A, E>(
    threadId: string | undefined,
    caller: WorkspaceCaller,
    refuse: (route: Route) => E,
    runLocal: (rpc: EnvironmentExecutor.EnvironmentWorkspaceRpc) => Effect.Effect<A, E>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      route: Extract<Route, { _tag: "remote" }>,
    ) => Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError> | undefined,
  ): Effect.fn.Return<A, E> {
    const where = yield* route(threadId, caller);
    if (where._tag === "local") return yield* Effect.flatMap(local, runLocal);
    if (where._tag !== "remote") return yield* Effect.fail(refuse(where));
    const call = runRemote(where.forward, where);
    if (call === undefined) return yield* Effect.fail(refuse(REFUSED));
    return yield* (
      call as Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError>
    ).pipe(
      Effect.catchTags({
        EnvironmentExecutorUnavailableError: () =>
          Effect.fail(refuse({ _tag: "offline", name: where.name })),
      }),
    ) as Effect.Effect<A, E>;
  });

  /** A call on a folder: the folder must be inside the Thread's workspace, resolved onto its machine. */
  const routed = <I extends { readonly cwd: string; readonly threadId?: string | undefined }, A, E>(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (input: I) => Effect.Effect<A, E>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      input: I,
      route: Extract<Route, { _tag: "remote" }>,
    ) => Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError> | undefined,
    refuse: (route: Route) => E,
  ): Effect.Effect<A, E> =>
    threadCall(
      input.threadId,
      caller,
      refuse,
      () => runLocal(input),
      (forward, where) => {
        const cwd = onMachine(where, input.cwd);
        return cwd === undefined ? undefined : runRemote(forward, { ...input, cwd }, where);
      },
    );

  const withoutThread = <A extends { readonly threadId?: unknown }>({
    threadId: _threadId,
    ...rest
  }: A) => rest;

  const terminalUnavailable =
    (threadId: string) =>
    (route: Route): TerminalError =>
      new TerminalEnvironmentUnavailableError({
        threadId,
        reason:
          route._tag === "hub-off"
            ? "hub_runs_no_agents"
            : route._tag === "offline"
              ? "environment_offline"
              : "outside_thread_workspace",
        ...(route._tag === "offline" && route.name !== undefined
          ? { environmentName: route.name }
          : {}),
      });

  const previewUnavailable =
    (threadId: string) =>
    (route: Route): PreviewError =>
      new PreviewEnvironmentUnavailableError({
        threadId,
        reason:
          route._tag === "hub-off"
            ? "hub_runs_no_agents"
            : route._tag === "offline"
              ? "environment_offline"
              : "outside_thread_workspace",
        ...(route._tag === "offline" && route.name !== undefined
          ? { environmentName: route.name }
          : {}),
      });

  /** A terminal call: its Thread names the machine; the folders it names must be the Thread's. */
  const terminalCall = <I extends { readonly threadId: string }, A>(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
    ) => Effect.Effect<A, TerminalError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      route: Extract<Route, { _tag: "remote" }>,
    ) =>
      | Effect.Effect<A, TerminalError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>
      | undefined,
  ): Effect.Effect<A, TerminalError> =>
    threadCall(
      input.threadId,
      caller,
      terminalUnavailable(input.threadId),
      (rpc) => runLocal(rpc.terminals),
      runRemote,
    );

  const previewCall = <A>(
    threadId: string,
    caller: WorkspaceCaller,
    runLocal: (
      previews: PreviewManager.PreviewManager["Service"],
    ) => Effect.Effect<A, PreviewError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
    ) => Effect.Effect<A, PreviewError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>,
  ): Effect.Effect<A, PreviewError> =>
    threadCall(
      threadId,
      caller,
      previewUnavailable(threadId),
      (rpc) => runLocal(rpc.previews),
      runRemote,
    );

  type Target = { readonly environmentId: EnvironmentId; readonly contractVersion: number };
  const secretsUnavailable = (threadId: string) => (error: { readonly message: string }) =>
    new TerminalEnvironmentUnavailableError({
      threadId,
      reason: "secrets_unavailable",
      detail: error.message,
    });
  /** Which secrets the caller's shells of the Thread on `target` get now: no value is read. */
  const terminalPlan = (
    threadId: string,
    caller: WorkspaceCaller,
    target: Target,
  ): Effect.Effect<SecretDelivery.SecretPlan | undefined, TerminalError> =>
    Option.isNone(secretDelivery)
      ? Effect.succeed(undefined)
      : secretDelivery.value
          .plan({ threadId: ThreadId.make(threadId), actingUserId: caller.userId, target })
          .pipe(Effect.mapError(secretsUnavailable(threadId)));
  /** The set's name only; an empty set is said explicitly, so a shell that had secrets is stale. */
  const currentSecrets = (plan: SecretDelivery.SecretPlan): SecretEnv =>
    plan.variables.length === 0
      ? { fingerprint: NO_SECRETS_FINGERPRINT, variables: [] }
      : { fingerprint: plan.fingerprint };
  const isSecretsRequired = (error: unknown) =>
    isTerminalUnavailable(error) && error.reason === "secrets_required";
  /**
   * Calls with the set's name; the machine answers `secrets_required` only when a shell would
   * start, and then the values are read and sent. A reattach to a running shell reads none.
   */
  const withTerminalSecrets = <A, E>(
    threadId: string,
    plan: SecretDelivery.SecretPlan | undefined,
    call: (secrets: SecretEnv | undefined) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | TerminalError> =>
    plan === undefined || Option.isNone(secretDelivery)
      ? call(undefined)
      : call(currentSecrets(plan)).pipe(
          Effect.catchIf(isSecretsRequired, () =>
            secretDelivery.value
              .resolve(plan)
              .pipe(Effect.mapError(secretsUnavailable(threadId)), Effect.flatMap(call)),
          ),
        );
  /** A machine before contract 10 gets no `secretEnv`: only an empty set, or a refusal. */
  const outdatedWith = (target: Target, plan: SecretDelivery.SecretPlan | undefined) =>
    target.contractVersion < SECRET_ENV_CONTRACT_VERSION &&
    plan !== undefined &&
    plan.variables.length > 0;
  const LOCAL_TARGET = {
    environmentId: HUB_MACHINE_ENVIRONMENT_ID,
    contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  };
  const remoteTarget = (where: Extract<Route, { _tag: "remote" }>) => ({
    environmentId: where.environmentId,
    contractVersion: where.forward.contractVersion(),
  });

  /** Spec 5 ticket 07: the facts a shell planned with `plan` starts with. */
  const factsOf = (plan: SecretDelivery.SecretPlan | undefined): TerminalShellFacts | null =>
    plan === undefined ? null : { spaceId: plan.spaceId, userId: plan.userId };
  /**
   * Whether a shell must not be used: it reports no facts, its User was removed, or its Space is
   * not its Thread's now. Fails closed: a read that fails counts as stale.
   */
  const shellStale = Effect.fn("ThreadWorkspace.shellStale")(
    function* (threadId: string, facts: TerminalShellFacts | undefined) {
      if (!factsRule) return false;
      if (facts === undefined) return true;
      if (facts.userId !== null) {
        if (Option.isNone(factsSql)) return true;
        const [user] = yield* factsSql.value<{ readonly removed: number }>`
          SELECT removed_at IS NOT NULL AS removed FROM users WHERE user_id = ${facts.userId}
        `;
        if (user === undefined || user.removed === 1) return true;
      }
      if (facts.spaceId !== null) {
        if (Option.isNone(spaceDirectory)) return true;
        const placement = yield* spaceDirectory.value.placementOf(ThreadId.make(threadId));
        if (Option.isNone(placement) || placement.value.space.id !== facts.spaceId) return true;
      }
      return false;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => true)),
  );
  /** What the Space directory's revision was when each shell was last found fit, by session. */
  const admitted = new Map<string, { readonly facts: TerminalShellFacts; revision: number }>();
  const sessionKey = (environmentId: EnvironmentId, input: TerminalRef) =>
    `${environmentId}\u0000${input.threadId}\u0000${input.terminalId}`;
  const revisionNow = Option.isNone(spaceDirectory)
    ? Effect.succeed(0)
    : spaceDirectory.value.revision;
  const refusedShell = (threadId: string) => terminalUnavailable(threadId)(REFUSED);
  /** Closes a shell the Hub refuses, with its history (it may show the old secrets). */
  const closeRefused = (key: string, close: StaleClose) =>
    Effect.sync(() => admitted.delete(key)).pipe(
      Effect.andThen(close),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not close a terminal left from another Space", { key, cause }),
      ),
    );
  /** A shell reported by its machine: admitted (remembered) or closed and refused. */
  const admit = Effect.fn("ThreadWorkspace.admit")(function* (
    environmentId: EnvironmentId,
    snapshot: TerminalSessionSnapshot,
    close: StaleClose,
  ) {
    if (!factsRule) return true;
    const key = sessionKey(environmentId, snapshot);
    const revision = yield* revisionNow;
    if (yield* shellStale(snapshot.threadId, snapshot.facts)) {
      yield* closeRefused(key, close);
      return false;
    }
    if (snapshot.facts !== undefined) admitted.set(key, { facts: snapshot.facts, revision });
    return true;
  });
  /** Before typing, resizing or clearing: only a shell admitted since the last Space change. */
  const checkAdmitted = Effect.fn("ThreadWorkspace.checkAdmitted")(function* (
    environmentId: EnvironmentId,
    input: TerminalRef,
    close: StaleClose,
  ) {
    if (!factsRule) return;
    const key = sessionKey(environmentId, input);
    const known = admitted.get(key);
    const revision = yield* revisionNow;
    if (known !== undefined && known.revision === revision) return;
    // Never seen through this Hub (or the Spaces changed since): its facts are read again.
    if (known !== undefined && !(yield* shellStale(input.threadId, known.facts))) {
      known.revision = revision;
      return;
    }
    if (known !== undefined) yield* closeRefused(key, close);
    return yield* refusedShell(input.threadId);
  });
  /** A machine before contract 12 reports no facts: its terminals are refused, with why. */
  const tooOldForTerminals = (where: Extract<Route, { _tag: "remote" }>) =>
    factsRule && where.forward.contractVersion() < SHELL_FACTS_CONTRACT_VERSION
      ? new TerminalEnvironmentUnavailableError({
          threadId: "",
          reason: "secrets_unavailable",
          detail: `${where.name} needs an update to open this Thread's terminals.`,
        })
      : undefined;

  /** The folders a terminal names, resolved onto the Thread's machine; undefined if outside. */
  const terminalFolders = <I extends TerminalAttachInput>(
    route: Extract<Route, { _tag: "remote" }>,
    input: I,
  ): I | undefined => {
    const cwd = input.cwd === undefined ? undefined : onMachine(route, input.cwd);
    if (input.cwd !== undefined && cwd === undefined) return undefined;
    const worktreePath =
      input.worktreePath === undefined || input.worktreePath === null
        ? input.worktreePath
        : onMachine(route, input.worktreePath);
    if (worktreePath === undefined && input.worktreePath !== undefined) return undefined;
    return {
      ...input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.worktreePath === undefined ? {} : { worktreePath }),
    };
  };

  type TerminalRef = { readonly threadId: string; readonly terminalId: string };
  type StaleClose = Effect.Effect<
    unknown,
    TerminalError | EnvironmentExecutor.EnvironmentExecutorUnavailableError
  >;
  const closeLocal = (terminals: TerminalManager.TerminalManager["Service"], input: TerminalRef) =>
    terminals.close({
      threadId: input.threadId,
      terminalId: input.terminalId,
      deleteHistory: true,
      endSession: true,
    });
  const closeRemote = (
    forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
    input: TerminalRef,
  ) =>
    forward.call("terminal.close", {
      threadId: input.threadId,
      terminalId: input.terminalId,
      deleteHistory: true,
      endSession: true,
    });

  /**
   * Terminals a caller opened or attached on another machine, by (User, Thread, terminal): typing
   * and resizing skip the full route and only check the Thread is still on that machine's socket.
   */
  const openTerminals = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly forward: EnvironmentExecutor.EnvironmentWorkspaceForward;
    }
  >();
  const terminalKey = (
    input: { readonly threadId: string; readonly terminalId: string },
    caller: WorkspaceCaller,
  ) => `${caller.userId ?? ""}\u0000${input.threadId}\u0000${input.terminalId}`;
  const remember = (
    input: { readonly threadId: string; readonly terminalId: string },
    caller: WorkspaceCaller,
    where: Extract<Route, { _tag: "remote" }>,
  ) =>
    Effect.sync(() => {
      openTerminals.set(terminalKey(input, caller), {
        environmentId: where.environmentId,
        name: where.name,
        forward: where.forward,
      });
    });

  /** A call on an open terminal: the remembered machine while it still holds the Thread. */
  const openTerminalCall = Effect.fn("ThreadWorkspace.openTerminalCall")(function* <
    I extends { readonly threadId: string; readonly terminalId: string },
    A,
  >(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
    ) => Effect.Effect<A, TerminalError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
    ) => Effect.Effect<A, TerminalError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>,
  ): Effect.fn.Return<A, TerminalError> {
    {
      const key = terminalKey(input, caller);
      const known = openTerminals.get(key);
      if (known !== undefined && Option.isSome(registry)) {
        const current = yield* Effect.option(registry.value.get(known.environmentId));
        const active = yield* registry.value.activeEnvironment(ThreadId.make(input.threadId));
        const forward = Option.flatMap(current, (executor) => executor.workspace.forward);
        if (
          active === known.environmentId &&
          Option.isSome(forward) &&
          forward.value === known.forward
        ) {
          if (Option.isSome(demand) && caller.startsSandbox === true) {
            yield* demand.value.touch(known.environmentId);
          }
          yield* checkAdmitted(known.environmentId, input, closeRemote(known.forward, input));
          return yield* runRemote(known.forward).pipe(
            Effect.catchTags({
              EnvironmentExecutorUnavailableError: () =>
                Effect.fail(
                  terminalUnavailable(input.threadId)({ _tag: "offline", name: known.name }),
                ),
            }),
          );
        }
        // It moved, or its machine reconnected or left: authorize it again.
        openTerminals.delete(key);
      }
      return yield* terminalCall(
        input,
        caller,
        (terminals) =>
          checkAdmitted(HUB_MACHINE_ENVIRONMENT_ID, input, closeLocal(terminals, input)).pipe(
            Effect.andThen(runLocal(terminals)),
          ),
        (forward, where) =>
          checkAdmitted(where.environmentId, input, closeRemote(forward, input)).pipe(
            Effect.andThen(runRemote(forward)),
          ),
      );
    }
  });

  /** Ends when the caller may no longer use the Environment, checked whenever executors change. */
  const untilUnusable = (
    environmentId: EnvironmentId,
    caller: WorkspaceCaller,
    threadId: string,
  ) =>
    Option.isNone(registry) || Option.isNone(environments)
      ? Effect.never
      : Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* registry.value.changes;
            while (true) {
              yield* PubSub.take(changes);
              const usable = yield* environments.value
                .usableBy({
                  userId: caller.userId,
                  environmentId,
                  threadId: ThreadId.make(threadId),
                })
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isNone(usable)) return;
            }
          }),
        );

  const terminalStream = (
    input: TerminalAttachInput,
    caller: WorkspaceCaller,
    mode: "attach" | "observe",
    viewerId: string | undefined,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
      start: TerminalManager.TerminalStart,
    ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
  ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const refuse = terminalUnavailable(input.threadId);
        const where = yield* route(input.threadId, caller);
        /**
         * Spec 5 ticket 07: every snapshot the shell reports is checked. A stale one closes (with
         * its history) and, for an attach, the stream starts once more with a new shell.
         */
        const guarded = (
          environmentId: EnvironmentId,
          events: () => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
          close: StaleClose,
          retries: number,
        ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> => {
          if (!factsRule) return events();
          const stale: TerminalError = refuse(REFUSED);
          const check = (
            event: TerminalAttachStreamEvent,
          ): Effect.Effect<TerminalAttachStreamEvent, TerminalError> =>
            event.type === "snapshot" || event.type === "restarted"
              ? Effect.flatMap(admit(environmentId, event.snapshot, close), (fit) =>
                  fit ? Effect.succeed(event) : Effect.fail(stale),
                )
              : Effect.succeed(event);
          return events().pipe(
            Stream.mapEffect(check),
            Stream.catchIf(
              (error) => error === stale,
              () =>
                attach && retries > 0
                  ? guarded(environmentId, events, close, retries - 1)
                  : Stream.fail(refuse(REFUSED)),
            ),
          );
        };
        // Spec 5: an attach may start the shell (a new terminal), with the caller's secrets.
        const attach = mode === "attach";
        /** Opens with the set's name; again with the values if a shell would start. */
        const withSecrets = (
          plan: SecretDelivery.SecretPlan | undefined,
          open: (
            secrets: SecretEnv | undefined,
          ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
        ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> =>
          plan === undefined || Option.isNone(secretDelivery)
            ? open(undefined)
            : open(currentSecrets(plan)).pipe(
                Stream.catchIf(isSecretsRequired, () =>
                  Stream.unwrap(
                    secretDelivery.value
                      .resolve(plan)
                      .pipe(Effect.mapError(secretsUnavailable(input.threadId)), Effect.map(open)),
                  ),
                ),
              );
        if (where._tag === "local") {
          const plan = attach
            ? yield* terminalPlan(input.threadId, caller, LOCAL_TARGET)
            : undefined;
          const terminals = (yield* local).terminals;
          const facts = factsOf(plan);
          return guarded(
            HUB_MACHINE_ENVIRONMENT_ID,
            () => withSecrets(plan, (secrets) => runLocal(terminals, { secrets, facts })),
            closeLocal(terminals, input),
            1,
          );
        }
        if (where._tag !== "remote") return Stream.fail(refuse(where));
        const tooOld = tooOldForTerminals(where);
        if (tooOld !== undefined) return Stream.fail(withThread(tooOld, input.threadId));
        const target = remoteTarget(where);
        const plan = attach ? yield* terminalPlan(input.threadId, caller, target) : undefined;
        const outdated = outdatedWith(target, plan);
        // A machine too old for secrets only reattaches a running shell: nothing that starts one.
        const { cwd: _cwd, restartIfNotRunning: _restart, ...attachOnly } = input;
        const resolved = terminalFolders(where, outdated ? attachOnly : input);
        if (resolved === undefined) return Stream.fail(refuse(REFUSED));
        yield* remember(input, caller, where);
        // An open terminal keeps its Sandbox from idling, for as long as the stream lives.
        if (Option.isSome(demand)) yield* demand.value.hold(where.environmentId);
        const facts = factsOf(plan);
        const open = (secrets: SecretEnv | undefined) =>
          where.forward
            .stream("terminal.stream", {
              mode,
              root: where.remoteBase,
              input: resolved,
              ...(viewerId === undefined ? {} : { viewerId }),
              ...(secrets === undefined ? {} : { secretEnv: secrets }),
              ...(attach && facts !== null ? { facts } : {}),
            })
            .pipe(
              Stream.catchTags({
                EnvironmentExecutorUnavailableError: () =>
                  Stream.fail(refuse({ _tag: "offline", name: where.name })),
              }),
              Stream.interruptWhen(untilUnusable(where.environmentId, caller, input.threadId)),
            );
        if (outdated && plan !== undefined && Option.isSome(secretDelivery)) {
          const delivery = secretDelivery.value;
          // No running shell to reattach: say why it does not start (the machine needs an update).
          return open(undefined).pipe(
            Stream.catchIf(noShellToReattach, () =>
              Stream.fromEffect(
                delivery
                  .resolve(plan)
                  .pipe(
                    Effect.mapError(secretsUnavailable(input.threadId)),
                    Effect.andThen(Effect.fail(refuse(REFUSED))),
                  ),
              ),
            ),
          );
        }
        return guarded(
          where.environmentId,
          () =>
            withSecrets(
              target.contractVersion < SECRET_ENV_CONTRACT_VERSION ? undefined : plan,
              open,
            ),
          closeRemote(where.forward, input),
          1,
        );
      }),
    );

  /**
   * Spec 5 ticket 07: an open answers the shell's snapshot; a stale one (a reused id still running
   * from before a move) closes with its history and the open runs once more for a new shell.
   */
  const openAdmitted = Effect.fn("ThreadWorkspace.openAdmitted")(function* <E>(
    environmentId: EnvironmentId,
    threadId: string,
    open: Effect.Effect<TerminalSessionSnapshot, E>,
    close: StaleClose,
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = yield* open;
      if (yield* admit(environmentId, snapshot, close)) return snapshot;
    }
    return yield* refusedShell(threadId);
  });

  const calls = {
    searchEntries: (input: ProjectSearchEntriesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.searchEntries(input)),
        (forward, input, where) =>
          forward.call("search.paths", { root: where.remoteBase, input: withoutThread(input) }),
        (where) =>
          new ProjectSearchEntriesError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...entriesFailure(where),
          }),
      ),
    searchContents: (input: ProjectSearchContentsInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.searchContents(input)),
        (forward, input, where) =>
          forward.call("search.contents", { root: where.remoteBase, input: withoutThread(input) }),
        (where) =>
          new ProjectSearchContentsError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...entriesFailure(where),
          }),
      ),
    listEntries: (input: ProjectListEntriesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.listEntries(input)),
        (forward, input, where) => {
          if (input.directoryPath === undefined || input.directoryPath === "") {
            return forward.call("entries.list", {
              root: where.remoteBase,
              input: withoutThread(input),
            });
          }
          const directoryPath = relativeInside(input.directoryPath);
          return directoryPath === undefined
            ? undefined
            : forward.call("entries.list", {
                root: where.remoteBase,
                input: { ...withoutThread(input), directoryPath },
              });
        },
        (where) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(where) }),
      ),
    listIgnoredFiles: (input: ProjectListIgnoredFilesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.listIgnoredFiles(input)),
        (forward, input, where) =>
          forward.call("entries.listIgnored", {
            root: where.remoteBase,
            input: withoutThread(input),
          }),
        (where) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(where) }),
      ),
    readFile: (input: ProjectReadFileInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.readFile(input)),
        (forward, input, where) => {
          // An absolute path inside the workspace is sent relative to the root, never as is.
          const absolute = isAbsolute(input.relativePath);
          const relativePath = absolute
            ? onMachine(where, input.relativePath)
            : relativeInside(input.relativePath);
          return relativePath === undefined
            ? undefined
            : forward.call("files.read", {
                root: where.remoteBase,
                input: { ...withoutThread(input), ...(absolute ? { cwd: "." } : {}), relativePath },
              });
        },
        (where) => new ProjectReadFileError(fileFailure(where, input)),
      ),
    writeFile: (input: ProjectWriteFileInput, caller: WorkspaceCaller) =>
      routed(
        input,
        acting(caller),
        (input) => Effect.flatMap(localCalls, (calls) => calls.writeFile(input)),
        (forward, input, where) => {
          // Only workspace-relative paths are writable, as on the Hub machine.
          const relativePath = relativeInside(input.relativePath);
          return relativePath === undefined
            ? undefined
            : forward.call("files.write", {
                root: where.remoteBase,
                input: { ...withoutThread(input), relativePath },
              });
        },
        (where) => new ProjectWriteFileError(fileFailure(where, input)),
      ),
    browse: Effect.fn("ThreadWorkspace.browse")(function* (
      input: FilesystemBrowseInput,
      caller: WorkspaceCaller,
    ) {
      const where = yield* route(input.threadId, caller);
      if (where._tag === "local") {
        return yield* Effect.flatMap(localCalls, (calls) => calls.browse(input));
      }
      const refuse = (route: Route) =>
        new FilesystemBrowseError({
          partialPath: input.partialPath,
          cwd: input.cwd,
          ...entriesFailure(route),
        });
      if (where._tag !== "remote") return yield* refuse(where);
      // On another machine only the Thread's own workspace can be browsed, relative to it.
      const cwd = onMachine(where, input.cwd ?? where.hubBase);
      if (
        cwd === undefined ||
        !isExplicitRelativePath(input.partialPath) ||
        relativeInside(input.partialPath) === undefined
      ) {
        return yield* refuse(REFUSED);
      }
      return yield* where.forward
        .call("entries.browse", {
          root: where.remoteBase,
          input: { partialPath: input.partialPath, cwd },
        })
        .pipe(
          Effect.catchTags({
            EnvironmentExecutorUnavailableError: () =>
              Effect.fail(refuse({ _tag: "offline", name: where.name })),
          }),
        );
    }),
    /**
     * Ticket 15: where a Thread's file served by URL is read. A read: a stopped Sandbox does not
     * start for it. A Thread on another machine is never served the Hub machine's copy.
     */
    machineAsset: Effect.fn("ThreadWorkspace.machineAsset")(function* (
      threadId: string,
      caller: WorkspaceCaller,
    ) {
      const where = yield* route(threadId, { userId: caller.userId });
      if (where._tag === "local" || where._tag === "hub-off") {
        return { _tag: "local" } satisfies MachineAssets.MachineAssetRoute;
      }
      if (where._tag === "refused") {
        return {
          _tag: "unavailable",
          reason: "outside_thread_workspace",
          detail: REFUSED_MESSAGE,
        } satisfies MachineAssets.MachineAssetRoute;
      }
      if (where._tag === "offline") {
        return {
          _tag: "unavailable",
          reason: "environment_offline",
          detail: offlineMessage(where.name, where.stopped),
        } satisfies MachineAssets.MachineAssetRoute;
      }
      // A machine before contract 15 knows no such operation: it says so, never a Hub copy.
      if (where.forward.contractVersion() < REMOTE_ASSETS_CONTRACT_VERSION) {
        return {
          _tag: "unavailable",
          reason: "machine_outdated",
          detail: `${where.name} needs an update to preview and download this Thread's files.`,
        } satisfies MachineAssets.MachineAssetRoute;
      }
      const forward = where.forward;
      const offline = () =>
        new MachineAssets.MachineAssetUnavailableError({
          reason: "environment_offline",
          detail: offlineMessage(where.name),
        });
      const source: MachineAssets.MachineAssetSource = {
        environmentId: where.environmentId,
        name: where.name,
        toRelative: (path) => (isAbsolute(path) ? onMachine(where, path) : relativeInside(path)),
        inspect: (relativePath) =>
          forward.call("files.inspectAsset", { root: where.remoteBase, relativePath }).pipe(
            Effect.catchTags({
              EnvironmentExecutorUnavailableError: () => Effect.fail(offline()),
            }),
          ),
        read: (input) =>
          forward
            .stream(
              "files.streamAsset",
              { root: where.remoteBase, ...input },
              { threadId: ThreadId.make(threadId) },
            )
            .pipe(
              Stream.catchTag("EnvironmentExecutorUnavailableError", () => Stream.fail(offline())),
            ),
      };
      return { _tag: "remote", source } satisfies MachineAssets.MachineAssetRoute;
    }),
    terminalOpen: (input: TerminalOpenInput, caller: WorkspaceCaller) =>
      terminalCall(
        input,
        acting(caller),
        // Spec 5: the shell gets the opening User's secrets, and keeps the facts of that plan.
        (terminals) =>
          terminalPlan(input.threadId, caller, LOCAL_TARGET).pipe(
            Effect.flatMap((plan) =>
              openAdmitted(
                HUB_MACHINE_ENVIRONMENT_ID,
                input.threadId,
                withTerminalSecrets(input.threadId, plan, (secrets) =>
                  terminals.open(input, { secrets, facts: factsOf(plan) }),
                ),
                closeLocal(terminals, input),
              ),
            ),
          ),
        (forward, where) => {
          const resolved = terminalFolders(where, input);
          const target = remoteTarget(where);
          const tooOld = tooOldForTerminals(where);
          if (tooOld !== undefined) return Effect.fail(withThread(tooOld, input.threadId));
          return resolved === undefined
            ? undefined
            : terminalPlan(input.threadId, caller, target).pipe(
                Effect.flatMap((plan) => {
                  const facts = factsOf(plan);
                  const open = (secrets: SecretEnv | undefined) =>
                    forward.call("terminal.open", {
                      root: where.remoteBase,
                      input: resolved,
                      ...(secrets === undefined ? {} : { secretEnv: secrets }),
                      ...(facts === null ? {} : { facts }),
                    });
                  // A machine too old for secrets: an empty set works as before, else it says why.
                  if (target.contractVersion < SECRET_ENV_CONTRACT_VERSION) {
                    return outdatedWith(target, plan) &&
                      plan !== undefined &&
                      Option.isSome(secretDelivery)
                      ? secretDelivery.value.resolve(plan).pipe(
                          Effect.mapError(secretsUnavailable(input.threadId)),
                          Effect.flatMap(() => open(undefined)),
                        )
                      : open(undefined);
                  }
                  return openAdmitted(
                    where.environmentId,
                    input.threadId,
                    withTerminalSecrets(input.threadId, plan, open),
                    closeRemote(forward, input),
                  );
                }),
                Effect.tap(() => remember(input, caller, where)),
              );
        },
      ),
    terminalWrite: (input: TerminalWriteInput, caller: WorkspaceCaller) =>
      openTerminalCall(
        input,
        acting(caller),
        (terminals) => terminals.write(input),
        (forward) => forward.call("terminal.write", input),
      ),
    terminalResize: (
      input: TerminalResizeInput,
      viewerId: string | undefined,
      caller: WorkspaceCaller,
    ) =>
      openTerminalCall(
        input,
        caller,
        (terminals) => terminals.resize(input, viewerId),
        (forward) =>
          forward.call("terminal.resize", {
            input,
            ...(viewerId === undefined ? {} : { viewerId }),
          }),
      ),
    terminalClear: (input: TerminalClearInput, caller: WorkspaceCaller) =>
      openTerminalCall(
        input,
        caller,
        (terminals) => terminals.clear(input),
        (forward) => forward.call("terminal.clear", input),
      ),
    terminalClose: (input: TerminalCloseInput, caller: WorkspaceCaller) =>
      terminalCall(
        input,
        caller,
        (terminals) => terminals.close(input),
        (forward) => forward.call("terminal.close", input),
      ),
    terminalAttach: (input: TerminalAttachInput, viewerId: string, caller: WorkspaceCaller) =>
      terminalStream(input, acting(caller), "attach", viewerId, (terminals, start) =>
        terminals.attachOutputStream(input, viewerId, start),
      ),
    terminalObserve: (input: TerminalObserveInput, caller: WorkspaceCaller) =>
      terminalStream(input, caller, "observe", undefined, (terminals) =>
        terminalOutputStream<TerminalAttachStreamEvent, TerminalError>(
          (listener, registerCleanup) => terminals.observeStream(input, listener, registerCleanup),
          (listener, registerCleanup) => terminals.resyncStream(input, listener, registerCleanup),
        ),
      ),
    previewOpen: (input: PreviewOpenInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        acting(caller),
        // A server tab a person opens browses in that person's profile (PreviewProfiles).
        (previews) =>
          previews.open(
            caller.userId === undefined ? input : { ...input, openedBy: caller.userId },
          ),
        (forward) => forward.call("preview.open", input),
      ),
    previewResize: (input: PreviewResizeInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.resize(input),
        (forward) => forward.call("preview.resize", input),
      ),
    previewAdjust: (input: PreviewAdjustInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.adjust(input),
        (forward) => forward.call("preview.adjust", input),
      ),
    previewClose: (input: PreviewCloseInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.close(input),
        (forward) => forward.call("preview.close", input),
      ),
    /** No previews while the machine is offline: listing never fails. */
    previewList: (input: PreviewListInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.list(input),
        (forward) => forward.call("preview.list", input),
      ).pipe(
        Effect.orElseSucceed((): PreviewListResult => ({
          sessions: [],
          serverEpoch: "environment-offline",
          revision: 0,
        })),
      ),
    previewReportStatus: (input: PreviewReportStatusInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.reportStatus(input),
        (forward) => forward.call("preview.reportStatus", input),
      ),
    /** This machine's preview events and every connected Environment's, as they happen. */
    previewEvents: Stream.merge(
      Option.match(localRpc, { onNone: () => Stream.empty, onSome: (rpc) => rpc.previews.events }),
      Option.match(remoteEnvironments, {
        onNone: () => Stream.empty,
        onSome: (remote) => remote.previewEvents,
      }),
    ),
  };

  // Spec 5 ticket 05: files, search and errors masked with the asking User's own values (never a
  // named Thread's); hidden when those cannot be read. A save that would put one of the User's
  // `[NAME]`s over its value is refused. Terminals: the Thread's values, or hidden.
  if (Option.isNone(secretMasker)) return calls;
  const masker = secretMasker.value;
  /** The caller's own values; none when they could not be read (what they mask is hidden). */
  const viewerOf = (caller: WorkspaceCaller) =>
    Effect.option(caller.userId === undefined ? masker.forViewer : masker.forUser(caller.userId));
  /** A call, with whatever a machine says in its error masked for the caller. */
  const maskingErrors = <A, E, R>(caller: WorkspaceCaller, call: Effect.Effect<A, E, R>) =>
    call.pipe(
      Effect.catch((error: E) =>
        Effect.flatMap(viewerOf(caller), (found) =>
          Effect.fail(
            Option.isSome(found)
              ? found.value.maskError(error)
              : hideErrorText(error, HIDDEN_OUTPUT),
          ),
        ),
      ),
    );
  return {
    ...calls,
    readFile: (input: ProjectReadFileInput, caller: WorkspaceCaller) =>
      maskingErrors(
        caller,
        // A copy read (bringing a checkout's ignored files to another machine) goes as it is:
        // `ws.ts` lets only a caller who may write files ask for one.
        input.forCopy === true
          ? calls.readFile(input, caller)
          : Effect.flatMap(calls.readFile(input, caller), (result) =>
              Effect.map(viewerOf(caller), (found) =>
                Option.isSome(found)
                  ? maskReadFile(found.value, result)
                  : { ...result, contents: HIDDEN_CONTENT, masked: true },
              ),
            ),
      ),
    searchContents: (input: ProjectSearchContentsInput, caller: WorkspaceCaller) =>
      maskingErrors(
        caller,
        Effect.gen(function* () {
          const found = yield* viewerOf(caller);
          if (Option.isNone(found)) return { matches: [], truncated: false };
          if (found.value.isEmpty) return yield* calls.searchContents(input, caller);
          // Filtered first, limited after: what a search shows never depends on a value.
          const result = yield* calls.searchContents(
            { ...input, limit: searchOverFetchLimit(input.limit) },
            caller,
          );
          return maskSearchContents(found.value, result, input.limit);
        }),
      ),
    writeFile: (input: ProjectWriteFileInput, caller: WorkspaceCaller) =>
      maskingErrors(
        caller,
        Effect.gen(function* () {
          const found = yield* viewerOf(caller);
          const placed = placeholderNames(input.contents);
          // Only a save carrying one of the caller's `[NAME]`s can put it over its value.
          const names = Option.isSome(found)
            ? new Set([...placed].filter((name) => found.value.names.has(name)))
            : placed;
          if (names.size > 0) {
            const refuse = new ProjectWriteFileError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              failure: "operation_failed",
              message: FILE_HOLDS_SECRETS,
            });
            // The file as it is now, read as the write would be (acting: a stopped Sandbox starts;
            // this read never leaves the Hub).
            const current = yield* calls
              .readFile(
                {
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  allowMissing: true,
                },
                acting(caller),
              )
              .pipe(Effect.option);
            // Fails closed: a file that cannot be read or checked whole is not written over.
            if (Option.isNone(current) || Option.isNone(found)) return yield* refuse;
            if (current.value.exists !== false) {
              if (current.value.truncated) return yield* refuse;
              const held = found.value
                .intervals(current.value.contents)
                .some((interval) => names.has(interval.name));
              if (held) return yield* refuse;
            }
          }
          return yield* calls.writeFile(input, caller);
        }),
      ),
    terminalOpen: (input: TerminalOpenInput, caller: WorkspaceCaller) =>
      Effect.flatMap(calls.terminalOpen(input, caller), (snapshot) =>
        masker.forThread(input.threadId).pipe(
          Effect.map((threadMasker) => maskTerminalSnapshot(threadMasker, snapshot)),
          Effect.orElseSucceed(() => hiddenTerminalSnapshot(snapshot)),
        ),
      ),
    terminalAttach: (input: TerminalAttachInput, viewerId: string, caller: WorkspaceCaller) =>
      maskTerminalStream(masker, input.threadId, calls.terminalAttach(input, viewerId, caller)),
    terminalObserve: (input: TerminalObserveInput, caller: WorkspaceCaller) =>
      maskTerminalStream(masker, input.threadId, calls.terminalObserve(input, caller)),
  };
});

export class ThreadWorkspace extends Context.Service<
  ThreadWorkspace,
  Effect.Success<typeof make>
>()("t3/environment/ThreadWorkspace") {}

/**
 * Over the executor registry, the projection and the Environments table where the host has them;
 * without them (hosts that run no Environments) every call answers on this machine.
 */
export const layer = Layer.effect(ThreadWorkspace, make);
