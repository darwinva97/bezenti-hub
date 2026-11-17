// @effect-diagnostics globalTimers:off - The poll runs in React subscriptions, outside an Effect runtime.
// Where each Thread runs, as every client shows it: the Hub's Environments list (each machine's
// name and live status), a Thread's Active environment read from it, and the words and steps of
// moving a Thread to another machine. Web and mobile share these so they say the same things.
import {
  type HubEnvironmentStatus,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  NO_ENVIRONMENT_ADVICE,
  type OrchestrationV2ThreadMove,
  type OrchestrationV2ThreadMoveStep,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import { environmentEndpointUrl } from "./endpoint.ts";

/** The Hub's Environments with a bearer session, as mobile holds one for its Hub. */
export const fetchRemoteHubEnvironments = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "environments").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/environments"),
        10_000,
        client.list({ headers: { authorization: `Bearer ${input.bearerToken}` } }),
      ),
    ),
  );

/** Every machine with its mode, Space and owner, for the Owner only (others get 403). */
export const fetchRemoteHubEnvironmentOverview = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "environments").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/environments/overview"),
        10_000,
        client.overview({ headers: { authorization: `Bearer ${input.bearerToken}` } }),
      ),
    ),
  );

/** «Try again» on a Sandbox that failed to start, with a bearer session; answers once starting. */
export const startRemoteHubEnvironment = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly environmentId: EnvironmentId;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "environments").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/environments/start"),
        10_000,
        client.start({
          headers: { authorization: `Bearer ${input.bearerToken}` },
          payload: { environmentId: input.environmentId },
        }),
      ),
    ),
  );

/**
 * Status and providers change on heartbeats, every ten seconds on the Hub; a machine that drops
 * shows «Reconnecting» at once and «Offline» a minute later, so a short poll keeps rows live.
 */
const HUB_ENVIRONMENTS_REFRESH_MS = 5000;
/** With only the Hub machine there is nothing to keep live: a slow check notices a first join. */
const HUB_ENVIRONMENTS_IDLE_REFRESH_MS = 60_000;
/** A Sandbox that is starting is online (or failed) within seconds: the list follows it closely. */
const HUB_ENVIRONMENTS_STARTING_REFRESH_MS = 1000;

/** «loading» until the first answer, «error» while the last read failed. */
export type HubEnvironmentsStatus = "loading" | "ready" | "error";

/** What a poller reads: a list of machines with their status (the Hub's list, the Owner's overview). */
interface PolledEnvironmentList<E> {
  readonly environments: ReadonlyArray<E>;
  readonly sandboxesUnavailable?: string | null | undefined;
}

export interface HubEnvironmentsPoller<
  E extends { readonly status: HubEnvironmentStatus } = HubEnvironmentSummary,
> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ReadonlyArray<E>;
  /** Why the Hub runs no Sandboxes, from the last list; null while it runs them or until known. */
  readonly sandboxesUnavailable: () => string | null;
  readonly status: () => HubEnvironmentsStatus;
  /** Reads the list now, as a view that just changed something asks. */
  readonly refresh: () => void;
  /** Forgets the list, as when the session it was read with ends. */
  readonly reset: () => void;
  /** Pauses reading while the app is in the background; resumes with a read. */
  readonly setActive: (active: boolean) => void;
}

/**
 * One list for every view that shows machines, read while subscribed and the app is active:
 * every `intervalMs` with machines joined, `idleIntervalMs` with the Hub machine alone. A failed
 * read keeps the last list («error»); an unchanged answer does not notify; only the latest read's
 * answer counts.
 */
export function makeHubEnvironmentsPoller<
  E extends { readonly status: HubEnvironmentStatus } = HubEnvironmentSummary,
>(options: {
  readonly fetch: () => Promise<PolledEnvironmentList<E>>;
  readonly intervalMs?: number;
  readonly idleIntervalMs?: number;
}): HubEnvironmentsPoller<E> {
  let environments: ReadonlyArray<E> = [];
  let sandboxesUnavailable: string | null = null;
  let status: HubEnvironmentsStatus = "loading";
  let generation = 0;
  // Each read's number; only the latest one's answer is kept.
  let requested = 0;
  let active = true;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const running = () => active && listeners.size > 0;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    stop();
    if (!running()) return;
    const interval = environments.some((environment) => environment.status === "starting")
      ? Math.min(
          options.intervalMs ?? HUB_ENVIRONMENTS_REFRESH_MS,
          HUB_ENVIRONMENTS_STARTING_REFRESH_MS,
        )
      : environments.length > 1
        ? (options.intervalMs ?? HUB_ENVIRONMENTS_REFRESH_MS)
        : (options.idleIntervalMs ?? HUB_ENVIRONMENTS_IDLE_REFRESH_MS);
    timer = setTimeout(refresh, interval);
  };

  function refresh() {
    stop();
    requested += 1;
    const id = requested;
    const pending = options.fetch();
    // Read after starting: a fetch that resets for a new session keeps its own answer.
    const started = generation;
    const current = () => started === generation && id === requested;
    void pending.then(
      (list) => {
        if (!current()) return;
        const unavailable = list.sandboxesUnavailable ?? null;
        const changed =
          status !== "ready" ||
          unavailable !== sandboxesUnavailable ||
          JSON.stringify(list.environments) !== JSON.stringify(environments);
        environments = list.environments;
        sandboxesUnavailable = unavailable;
        status = "ready";
        schedule();
        if (changed) notify();
      },
      () => {
        if (!current()) return;
        const changed = status !== "error";
        status = "error";
        schedule();
        if (changed) notify();
      },
    );
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1 && active) refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    snapshot: () => environments,
    sandboxesUnavailable: () => sandboxesUnavailable,
    status: () => status,
    refresh,
    reset: () => {
      generation += 1;
      const changed = environments.length > 0 || status !== "loading";
      environments = [];
      sandboxesUnavailable = null;
      status = "loading";
      if (changed) notify();
    },
    setActive: (next) => {
      if (next === active) return;
      active = next;
      if (!next) stop();
      else if (listeners.size > 0) refresh();
    },
  };
}

/**
 * Whether the User may move a Thread to another Environment: only a User who may continue it
 * (moving continues it elsewhere), and only with another machine to go to; a Thread whose machine
 * was removed can always go to the Hub machine.
 */
export function canMoveThread(input: {
  readonly canContinue: boolean;
  /** How many Environments the User sees, the Hub machine included. */
  readonly environmentCount: number;
  readonly activeEnvironmentId: EnvironmentId | null | undefined;
}): boolean {
  return input.canContinue && (input.environmentCount > 1 || input.activeEnvironmentId === null);
}

/** What a Thread's header and row say about where it runs. */
export interface ActiveEnvironmentView {
  readonly name: string;
  readonly status: HubEnvironmentStatus;
  readonly isHubMachine: boolean;
  /** Its Environment was removed: it runs nowhere until it moves («needs an environment»). */
  readonly needsEnvironment: boolean;
  /** A Space's Sandbox, which the Hub starts for work and stops when idle. */
  readonly isSandbox: boolean;
  /** Why a `failed` Sandbox's last start failed. */
  readonly startError: string | null;
}

/** The words for a Thread whose Environment was removed. */
export const NEEDS_ENVIRONMENT_LABEL = "Needs an environment";
/** The words for a Thread whose turn waits for its machine to come back. */
export const PAUSED_OFFLINE_LABEL = "Paused, environment offline";
/** The words for a Thread whose Sandbox is booting for its work. */
export const SANDBOX_STARTING_LABEL = "Starting the Sandbox…";
/** The words for a Thread whose Sandbox failed to start; the reason follows. */
export const SANDBOX_FAILED_LABEL = "The Sandbox could not start";
/** What starts a failed Sandbox again. */
export const SANDBOX_RETRY_LABEL = "Try again";

export const ENVIRONMENT_STATUS_LABELS: Record<HubEnvironmentStatus, string> = {
  online: "Online",
  reconnecting: "Reconnecting",
  offline: "Offline",
  stopped: "Stopped",
  starting: "Starting",
  failed: "Failed to start",
};

/** What a Sandbox's `online` reads as: its server runs. */
const SANDBOX_RUNNING_LABEL = "Running";

/**
 * The status as it is shown: the Hub machine is always online (it is the Hub), whatever its row
 * says.
 */
export function shownEnvironmentStatus(
  environment: Pick<HubEnvironmentSummary, "kind" | "status">,
): HubEnvironmentStatus {
  return environment.kind === "hub" ? "online" : environment.status;
}

/**
 * A status in words, the same on every client: «Running» for a Sandbox that is online, else
 * `ENVIRONMENT_STATUS_LABELS`.
 */
export function environmentStatusLabel(
  status: HubEnvironmentStatus,
  kind: HubEnvironmentSummary["kind"],
): string {
  return kind === "sandbox" && status === "online"
    ? SANDBOX_RUNNING_LABEL
    : ENVIRONMENT_STATUS_LABELS[status];
}

/**
 * The colour every client gives a status: green while it runs work, amber while it is on its way
 * (reconnecting, starting), red once a start failed, grey while it is off (offline, stopped).
 */
export type EnvironmentStatusTone = "success" | "warning" | "danger" | "muted";

export const ENVIRONMENT_STATUS_TONES: Record<HubEnvironmentStatus, EnvironmentStatusTone> = {
  online: "success",
  reconnecting: "warning",
  starting: "warning",
  failed: "danger",
  offline: "muted",
  stopped: "muted",
};

/** Whether a status dot pulses: only while a Sandbox is starting. */
export const environmentStatusPulses = (status: HubEnvironmentStatus) => status === "starting";

/**
 * The four ways a machine is used: the Hub machine (the Hub's own process), a Space's Sandbox
 * (the Hub runs it), a machine dedicated to a Space, and a User's personal machine.
 */
export type EnvironmentUse = "hub" | "sandbox" | "dedicated" | "personal";

export function environmentUseOf(
  environment: Pick<HubEnvironmentSummary, "kind" | "mode">,
): EnvironmentUse {
  if (environment.kind === "hub") return "hub";
  if (environment.kind === "sandbox" || environment.mode === "sandbox") return "sandbox";
  return environment.mode === "dedicated" ? "dedicated" : "personal";
}

export const ENVIRONMENT_USE_LABELS: Record<EnvironmentUse, string> = {
  hub: "Hub machine",
  sandbox: "Sandbox",
  dedicated: "Dedicated machine",
  personal: "Personal machine",
};

/**
 * What a machine is, with its Space or owner as far as the viewer knows them: «Runs the Hub»,
 * «Sandbox of Acme», «Dedicated to Acme», «Your personal machine», «Grace's personal machine».
 */
export function environmentUseDescription(
  environment: Pick<HubEnvironmentSummary, "kind" | "mode" | "ownerUserId" | "lent">,
  context: {
    /** The machine's Space by name; null or undefined when not known. */
    readonly spaceName?: string | null | undefined;
    /** The personal machine's owner by name, when the viewer knows it. */
    readonly ownerName?: string | null | undefined;
    /** Undefined when the viewer is not known (a session from before the Owner). */
    readonly viewerUserId?: string | undefined;
  } = {},
): string {
  switch (environmentUseOf(environment)) {
    case "hub":
      return "Runs the Hub";
    case "sandbox":
      return context.spaceName == null ? "Sandbox" : `Sandbox of ${context.spaceName}`;
    case "dedicated":
      // A machine lent to the Space (Grants): its lender controls it and sees what runs there.
      if (environment.lent !== undefined) {
        return `Lent to ${context.spaceName ?? "a Space"} by ${environment.lent.lenderName ?? "another User"}, who sees everything that runs on it`;
      }
      return `Dedicated to ${context.spaceName ?? "a Space"}`;
    case "personal":
      if (context.viewerUserId !== undefined && environment.ownerUserId === context.viewerUserId) {
        return "Your personal machine";
      }
      if (context.ownerName != null) return `${context.ownerName}'s personal machine`;
      return context.viewerUserId === undefined
        ? "Personal machine"
        : "Another User's personal machine";
  }
}

/** What a Thread says because of where it runs, beyond the machine's own status. */
export type ThreadEnvironmentState =
  | "needs-environment"
  | "paused-offline"
  | "sandbox-starting"
  | "sandbox-failed";

/**
 * The Thread's state because of where it runs: its machine removed, its Sandbox starting or failed
 * to start, or a turn under way on a machine not online (paused until it returns). Null otherwise,
 * a stopped Sandbox included: it starts when the Thread's work needs it.
 */
export function threadEnvironmentState(
  environment: ActiveEnvironmentView | null,
  turnUnderWay: boolean,
): ThreadEnvironmentState | null {
  if (environment === null) return null;
  if (environment.needsEnvironment) return "needs-environment";
  if (environment.isSandbox && environment.status === "starting") return "sandbox-starting";
  if (environment.isSandbox && environment.status === "failed") return "sandbox-failed";
  if (turnUnderWay && !environment.isHubMachine && environment.status !== "online") {
    return "paused-offline";
  }
  return null;
}

/**
 * A Thread's Active environment, a field of the Thread from the stream, by name and live status;
 * a Thread that names none runs on the Hub machine. Null when the User can't see the machine.
 */
export function activeEnvironmentOf(
  list: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  if (environmentId === null) {
    return {
      name: "No environment",
      status: "offline",
      isHubMachine: false,
      needsEnvironment: true,
      isSandbox: false,
      startError: null,
    };
  }
  const id = environmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
  const environment = list.find((entry) => entry.id === id);
  if (environment === undefined) return null;
  return {
    name: environment.name,
    status: shownEnvironmentStatus(environment),
    isHubMachine: environment.kind === "hub",
    needsEnvironment: false,
    isSandbox: environment.kind === "sandbox",
    startError: environment.startError ?? null,
  };
}

/** A Thread's machine's status in words, as Settings says it for that machine. */
export function activeEnvironmentStatusLabel(environment: ActiveEnvironmentView): string {
  return environmentStatusLabel(
    environment.status,
    environment.isSandbox ? "sandbox" : environment.isHubMachine ? "hub" : "external",
  );
}

/** "Laptop" while online, "Laptop, offline" otherwise: the words an accessible name ends with. */
export function activeEnvironmentLabel(environment: ActiveEnvironmentView): string {
  if (environment.needsEnvironment) return NEEDS_ENVIRONMENT_LABEL.toLowerCase();
  return environment.status === "online"
    ? environment.name
    : `${environment.name}, ${ENVIRONMENT_STATUS_LABELS[environment.status].toLowerCase()}`;
}

/** Why a Thread could not run on the Environment, or null when it can (any provider, for null). */
export function environmentUnavailableReason(
  environment: HubEnvironmentSummary,
  providerInstanceId: ProviderInstanceId | null,
): string | null {
  if (environment.kind === "hub") return null;
  // A Space's Sandbox that is not running starts when a Thread is sent to it.
  if (environment.kind === "sandbox" && environment.status !== "online") return null;
  if (environment.status !== "online") {
    return environment.status === "reconnecting" ? "Reconnecting" : "Offline";
  }
  if (providerInstanceId === null) return null;
  const provider = environment.providers.find((entry) => entry.instanceId === providerInstanceId);
  if (provider === undefined || !provider.installed || !provider.enabled) {
    return "Provider not available";
  }
  return null;
}

/**
 * The providers a Thread can use on the machine it runs on. The Hub reports its own machine's,
 * where it runs no agents and has no CLIs; whether one is there is the machine's to say, as it
 * reports it to the Hub. A Sandbox that never ran reported none: the Hub's stand in until it has.
 */
export function providersOnEnvironment(
  providers: ReadonlyArray<ServerProvider>,
  environment: Pick<HubEnvironmentSummary, "kind" | "name" | "providers"> | null | undefined,
): ReadonlyArray<ServerProvider> {
  if (environment == null || environment.kind === "hub" || environment.providers.length === 0) {
    return providers;
  }
  return providers.map((provider) => {
    const there = environment.providers.find((entry) => entry.instanceId === provider.instanceId);
    // The Hub's sign-in, install and update state describe the Hub's machine, not this one.
    const {
      setup: _setup,
      message: _message,
      unavailableReason: _unavailableReason,
      installedVersion: _installedVersion,
      versionAdvisory: _versionAdvisory,
      compatibilityAdvisory: _compatibilityAdvisory,
      updateState: _updateState,
      ...rest
    } = provider;
    if (there !== undefined && there.enabled && there.installed) {
      return {
        ...rest,
        enabled: true,
        installed: true,
        version: there.version,
        status: "ready",
        auth: { status: "unknown" },
        availability: "available",
      };
    }
    const reason = `Not installed on ${environment.name}.`;
    return {
      ...rest,
      enabled: there?.enabled ?? false,
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: reason,
      availability: "unavailable",
      unavailableReason: reason,
    };
  });
}

/** What each step of a move is doing, as the Thread and the move dialog say it. */
const MOVE_STEP_LABELS: Record<OrchestrationV2ThreadMoveStep, string> = {
  "waiting-for-turn": "Finishing the turn",
  "final-checkpoint": "Uploading a final checkpoint",
  fetching: "Fetching the checkpoint",
  preparing: "Preparing the workspace",
  handoff: "Handing over",
  switched: "Ready",
};

const MOVE_STEPS: ReadonlyArray<OrchestrationV2ThreadMoveStep> = [
  "waiting-for-turn",
  "final-checkpoint",
  "fetching",
  "preparing",
  "handoff",
  "switched",
];

/** A machine's name for the move's words; a Thread that names none ran on the Hub machine. */
export function environmentNameOf(
  environments: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
): string {
  if (environmentId === null) return "no Environment";
  return (
    environments.find((environment) => environment.id === environmentId)?.name ??
    (environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID
      ? "Hub machine"
      : "another Environment")
  );
}

/** What the move is doing now; a turn waiting on the User says so, since the move waits too. */
export function moveStepLabel(move: OrchestrationV2ThreadMove): string {
  return move.step === "waiting-for-turn" && move.waitingOn === "user"
    ? "Waiting for your answer in the running turn"
    : MOVE_STEP_LABELS[move.step];
}

/** Every Environment but the one the Thread runs on; a Thread whose machine was removed may go anywhere. */
export function moveCandidates(
  environments: ReadonlyArray<HubEnvironmentSummary>,
  sourceId: EnvironmentId | null | undefined,
): ReadonlyArray<HubEnvironmentSummary> {
  const source = sourceId === undefined ? HUB_MACHINE_ENVIRONMENT_ID : sourceId;
  return environments.filter((environment) => environment.id !== source);
}

/**
 * The Environments a new Thread of the Space can be sent to: a Sandbox, and a machine dedicated to
 * a Space, only runs its own Space's Threads, so another Space's is left out. `spaceId` undefined
 * (not known) leaves out every one.
 */
export function placeableEnvironments(
  environments: ReadonlyArray<HubEnvironmentSummary>,
  spaceId: string | null | undefined,
): ReadonlyArray<HubEnvironmentSummary> {
  return environments.filter(
    (environment) =>
      (environment.kind !== "sandbox" && environment.mode !== "dedicated") ||
      (spaceId != null && environment.spaceId === spaceId),
  );
}

/**
 * Why a new Thread has nowhere to run (no Sandboxes, and the Hub machine runs none), as the Hub
 * says it after «No Environment can run this Thread»: why there are no Sandboxes, and what to do.
 */
export function noPlacementReason(sandboxesUnavailable: string | null): string {
  return `${sandboxesUnavailable ?? "There is no Sandbox you can run Threads in for this Space."} ${NO_ENVIRONMENT_ADVICE}`;
}

/** What the move dialog explains before the User chooses. */
export function moveExplanation(input: {
  readonly sourceRemoved: boolean;
  readonly sourceName: string;
  readonly withoutProject: boolean;
}): string {
  if (input.sourceRemoved) {
    return "The machine this Thread ran on was removed or no longer runs Threads. The Thread keeps its history and goes on on the machine you choose, from the last checkpoint it uploaded.";
  }
  const fetches = input.withoutProject
    ? "The new machine fetches it into the Thread's own folder there, with the folder's branches; repositories nested in the folder stay behind."
    : "The new machine fetches it into a worktree of the Thread's own, with its branch, and runs the Project's setup script there, which also rebuilds ignored files such as dependencies.";
  return `The Thread keeps its history and goes on running on the machine you choose. If ${input.sourceName} is online, it first uploads a final checkpoint with any changes made by hand. ${fetches} If ${input.sourceName} is offline, the Thread continues from the last checkpoint it uploaded, and changes it kept are put on a separate branch when it comes back.`;
}

export type MoveProgressStepState = "done" | "current" | "failed" | "pending";

export interface MoveProgressView {
  /** One sentence on where the move is, for a live status region. */
  readonly summary: string;
  readonly steps: ReadonlyArray<{
    readonly step: OrchestrationV2ThreadMoveStep;
    readonly label: string;
    readonly state: MoveProgressStepState;
  }>;
  /** Which checkpoint the Thread continues from, once the move knows. */
  readonly continuesFrom: string | null;
  /** Why it failed, as the Hub said. */
  readonly failure: string | null;
  /** Where the target's own workspace changes were kept. */
  readonly setAside: string | null;
}

/** A move as its progress shows it: summary, each step's state, and what it continues from. */
export function moveProgressView(
  move: OrchestrationV2ThreadMove,
  sourceName: string,
  targetName: string,
): MoveProgressView {
  const failedStep = move.failure?.step ?? move.step;
  const current = MOVE_STEPS.indexOf(move.status === "failed" ? failedStep : move.step);
  const summary =
    move.status === "switched"
      ? `Moved to ${targetName}.`
      : move.status === "failed"
        ? `The move stopped at «${MOVE_STEP_LABELS[failedStep]}». The Thread stays on ${sourceName}.`
        : move.status === "cancelled"
          ? `The move was cancelled. The Thread stays on ${sourceName}.`
          : `Moving to ${targetName}: ${moveStepLabel(move)}`;
  const continuesFrom =
    move.continuesFrom === undefined
      ? null
      : move.continuesFrom.kind === "final"
        ? "It continues from a final checkpoint, with the changes made by hand."
        : move.continuesFrom.kind === "uploaded"
          ? `${sourceName} was offline: it continues from the checkpoint of turn ${move.continuesFrom.appRunOrdinal ?? "?"}, the last one uploaded.`
          : `${sourceName} was offline and never uploaded a checkpoint: it continues from the Project as it is on ${targetName}.`;
  return {
    summary,
    steps: MOVE_STEPS.map((step, index) => ({
      step,
      label:
        step === "final-checkpoint" && move.sourceOffline === true
          ? `${MOVE_STEP_LABELS[step]} (skipped: ${sourceName} was offline)`
          : MOVE_STEP_LABELS[step],
      state:
        move.status === "switched" || index < current
          ? "done"
          : index === current
            ? move.status === "failed"
              ? "failed"
              : "current"
            : "pending",
    })),
    continuesFrom,
    failure: move.status === "failed" && move.failure !== undefined ? move.failure.message : null,
    setAside:
      move.setAsideRefs !== undefined && move.setAsideRefs.length > 0
        ? `What ${targetName} had in the workspace is kept in ${move.setAsideRefs.join(", ")}.`
        : null,
  };
}
