/**
 * Beside a lent personal machine's own server: one Sandbox per active Grant, each connecting with
 * a credential the Hub issues it for its Space alone (the machine's own only asks). It follows the
 * Hub's answer each round. See docs/internals/sandboxes.md#lent-machines.
 */
import {
  EnvironmentSelfResult,
  type EnvironmentSelfReport,
  type LentSandboxAssignment,
  type LentSandboxReport,
  type SandboxHostReport,
  SpaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { hostExposureRefusal, listeningOutsideLoopback } from "../sandboxes/hostExposure.ts";
import {
  type HomeMeasurement,
  type SandboxLimits,
  SandboxRuntime,
  type SandboxRuntimeError,
} from "../sandboxes/SandboxRuntime.ts";
import {
  DISK_MEASURE_FAILURES_ALLOWED,
  fitLimitsToHost,
  hostCapacity,
  hostSpaceShortage,
} from "../sandboxes/sandboxLimits.ts";
import {
  allowedHostPorts,
  dedicatedRuntimeFromConfig,
} from "../sandboxes/sandboxRuntimeFromConfig.ts";
import * as JoinedHub from "./JoinedHub.ts";
import { ENVIRONMENT_CREDENTIAL_SECRET, type JoinedHubState } from "./joinedHubState.ts";

const LENT_PREFIX = "lent-";

/** The Sandbox a lent machine runs for one Grant: one home per Grant, never reused. */
export const lentSandboxIdOf = (grantId: string) =>
  `${LENT_PREFIX}${grantId.replace(/[^A-Za-z0-9_.-]/gu, "-")}`;

/** As for a dedicated machine's Sandbox: more than this many ends in the window, and it stays failed. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** How often the host asks the Hub when nothing else makes it ask. */
const LENT_ROUND_MS = 60_000;

/** What the Hub says of this machine's lent Sandboxes now. */
export type LentAnswer =
  | { readonly _tag: "lent"; readonly sandboxes: ReadonlyArray<LentSandboxAssignment> }
  /** Its credential is refused: removed from the Hub, or its owner off. */
  | { readonly _tag: "removed" }
  /** No answer, or an older Hub that lends nothing: nothing changes. */
  | { readonly _tag: "unreachable" };

const decodeSelf = HttpClientResponse.schemaBodyJson(EnvironmentSelfResult);

/** Reports to the Hub and asks which Sandboxes this machine runs (`/self/report`). */
export const reportToHubAt =
  (hubUrl: string, credential: string) =>
  (report: EnvironmentSelfReport): Effect.Effect<LentAnswer> =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        HttpClientRequest.post(new URL("/api/environments/self/report", hubUrl).toString()).pipe(
          HttpClientRequest.bearerToken(credential),
          HttpClientRequest.bodyJson(report),
          Effect.flatMap((request) => client.execute(request)),
        ),
      ),
      Effect.flatMap((response): Effect.Effect<LentAnswer, unknown> =>
        response.status === 401 || response.status === 403
          ? Effect.succeed({ _tag: "removed" })
          : response.status === 200
            ? Effect.map(decodeSelf(response), (self) => ({
                _tag: "lent" as const,
                sandboxes: self.lent ?? [],
              }))
            : Effect.succeed({ _tag: "unreachable" }),
      ),
      Effect.timeout("10 seconds"),
      Effect.provide(FetchHttpClient.layer),
      Effect.orElseSucceed((): LentAnswer => ({ _tag: "unreachable" })),
    );

/** The lent Sandbox homes on disk under `rootDir`: directories only (never their logs). */
export const lentHomesIn = Effect.fn("LentSandboxHost.lentHomesIn")(
  function* (rootDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homes: Array<string> = [];
    for (const entry of yield* fs.readDirectory(rootDir)) {
      if (!entry.startsWith(LENT_PREFIX)) continue;
      const info = yield* fs.stat(path.join(rootDir, entry)).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") homes.push(entry);
    }
    return homes;
  },
  Effect.orElseSucceed((): ReadonlyArray<string> => []),
);

interface Status {
  state: LentSandboxReport["state"];
  message: string | null;
  diskUsedBytes: number | null;
  diskMeasureFailures: number;
}

/** A disk measurement as the Hub counts it: a failure keeps the last size and counts. */
const measured = (status: Status, measurement: HomeMeasurement): Status =>
  measurement._tag === "measured"
    ? { ...status, diskUsedBytes: measurement.bytes, diskMeasureFailures: 0 }
    : measurement._tag === "unavailable"
      ? status
      : {
          ...status,
          diskUsedBytes: Math.max(status.diskUsedBytes ?? 0, measurement.atLeastBytes ?? 0),
          diskMeasureFailures: Math.min(
            status.diskMeasureFailures + 1,
            DISK_MEASURE_FAILURES_ALLOWED,
          ),
        };

/**
 * Runs the lent Sandboxes the Hub names: a Grant gone takes its Sandbox and home; a new one starts
 * with a credential asked for it alone. Nothing runs while the machine cannot host or its disk is
 * almost full. Rounds come from `nextRound`.
 */
export const superviseLentSandboxes = Effect.fn("LentSandboxHost.supervise")(function* (input: {
  readonly joined: JoinedHubState;
  readonly askHub: (report: EnvironmentSelfReport) => Effect.Effect<LentAnswer>;
  /** Whether it can host, and its limits and size, as of now. */
  readonly hostReport: Effect.Effect<SandboxHostReport>;
  /** The runtime, read each round: none while this machine cannot run Sandboxes. */
  readonly runtime: Effect.Effect<Option.Option<SandboxRuntime["Service"]>>;
  readonly homesOnDisk: Effect.Effect<ReadonlyArray<string>>;
  /** Completes when the next round is due. */
  readonly nextRound: Effect.Effect<void>;
  /** Called once each round was followed, with what it reported (tests watch it). */
  readonly onRound?: (report: EnvironmentSelfReport) => Effect.Effect<void>;
}) {
  const scope = yield* Effect.scope;
  const statuses = new Map<string, Status>();
  const fibers = new Map<string, Fiber.Fiber<void>>();
  let lastHost: SandboxHostReport | undefined;

  const reportOf = (credentialsFor: ReadonlyArray<string>): Effect.Effect<EnvironmentSelfReport> =>
    Effect.map(
      lastHost === undefined ? input.hostReport : Effect.succeed(lastHost),
      (sandboxHost) => ({
        sandboxHost,
        sandboxes: [...statuses].map(([grantId, status]) => ({ grantId, ...status })),
        credentialsFor,
      }),
    );

  const set = (grantId: string, next: Partial<Status>) => {
    const current = statuses.get(grantId) ?? {
      state: "starting",
      message: null,
      diskUsedBytes: null,
      diskMeasureFailures: 0,
    };
    statuses.set(grantId, { ...current, ...next });
  };

  /** One Grant's Sandbox, (re)started with a fresh credential until its Grant is gone. */
  const supervise = Effect.fn("LentSandboxHost.superviseOne")(function* (
    runtime: SandboxRuntime["Service"],
    grantId: string,
  ) {
    const sandboxId = lentSandboxIdOf(grantId);
    const ends: Array<number> = [];
    const failed = (error: SandboxRuntimeError) => error.detail;
    while (true) {
      set(grantId, { state: "starting", message: null });
      const answer = yield* input.askHub(yield* reportOf([grantId]));
      if (answer._tag !== "lent") {
        set(grantId, {
          state: "restarting",
          message: "waiting for the Hub to give its Sandbox a credential.",
        });
        yield* Effect.sleep(RESTART_MAX_MS);
        continue;
      }
      const entry = answer.sandboxes.find((sandbox) => sandbox.grantId === grantId);
      // Its Grant ended meanwhile: the round deletes it.
      if (entry === undefined || entry.credential === undefined) {
        set(grantId, { state: "stopped", message: "its loan ended." });
        return;
      }
      const made = yield* runtime
        .create({
          sandboxId,
          spaceId: SpaceId.make(entry.spaceId),
          environmentId: entry.environmentId,
          name: entry.name,
          hubEnvironmentId: input.joined.hubEnvironmentId,
          credential: Redacted.make(entry.credential),
        })
        .pipe(Effect.result);
      if (Result.isFailure(made)) {
        return set(grantId, { state: "failed", message: failed(made.failure) });
      }
      const limits: SandboxLimits = fitLimitsToHost(entry.limits, {
        cpus: lastHost?.hostCpus ?? Number.POSITIVE_INFINITY,
        memoryBytes: lastHost?.hostMemoryBytes ?? Number.POSITIVE_INFINITY,
      });
      const started = yield* runtime.start(sandboxId, { limits }).pipe(Effect.result);
      let message: string;
      if (Result.isFailure(started)) {
        message = failed(started.failure);
      } else {
        set(grantId, { state: "running", message: null });
        const exitCode = yield* started.success.exited;
        message = `its server ended with exit code ${exitCode ?? "unknown"}.`;
      }
      yield* Effect.logWarning("A lent Sandbox ended", { grantId, message });
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      ends.push(nowMs);
      while (ends.length > 0 && (ends[0] ?? nowMs) < nowMs - CRASH_WINDOW_MS) ends.shift();
      if (ends.length > CRASH_LIMIT) {
        return set(grantId, {
          state: "failed",
          message: `${message} It ended ${ends.length} times in 10 minutes; restart \`t3 serve\` to try again.`,
        });
      }
      set(grantId, { state: "restarting", message });
      yield* Effect.sleep(Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (ends.length - 1)));
    }
  });

  const stopOne = Effect.fn("LentSandboxHost.stopOne")(function* (
    runtime: SandboxRuntime["Service"],
    grantId: string,
    remove: boolean,
  ) {
    const fiber = fibers.get(grantId);
    fibers.delete(grantId);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    const sandboxId = lentSandboxIdOf(grantId);
    yield* (remove ? runtime.delete(sandboxId) : runtime.stop(sandboxId)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not stop a lent Sandbox", { grantId, detail: error.detail }),
      ),
    );
  });

  /** Follows one answer; false once this machine is gone from the Hub. */
  const follow = Effect.fn("LentSandboxHost.follow")(function* (
    answer: LentAnswer,
    runtime: SandboxRuntime["Service"] | undefined,
  ) {
    if (answer._tag === "unreachable") return true;
    const wanted =
      answer._tag === "removed"
        ? new Set<string>()
        : new Set(answer.sandboxes.map((sandbox) => sandbox.grantId));
    if (runtime === undefined) return answer._tag !== "removed";
    // Gone from the Hub's answer: its Sandbox and its home go.
    for (const grantId of statuses.keys()) {
      if (wanted.has(grantId)) continue;
      yield* stopOne(runtime, grantId, true);
      statuses.delete(grantId);
    }
    for (const home of yield* input.homesOnDisk) {
      const owned = [...wanted].some((grantId) => lentSandboxIdOf(grantId) === home);
      if (!owned) {
        yield* runtime.delete(home).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not delete a lent Sandbox's home", {
              sandboxId: home,
              detail: error.detail,
            }),
          ),
        );
      }
    }
    if (answer._tag === "removed") return false;
    const host = lastHost;
    const full =
      host?.hostFreeBytes == null || host.hostTotalBytes == null
        ? undefined
        : hostSpaceShortage(
            { freeBytes: host.hostFreeBytes, totalBytes: host.hostTotalBytes },
            fibers.size > 0 ? "run" : "start",
          );
    if (host?.ready !== true || full !== undefined) {
      // Nothing of theirs runs while the machine cannot host it, or its disk is almost full.
      for (const grantId of fibers.keys()) yield* stopOne(runtime, grantId, false);
      for (const grantId of wanted) {
        set(grantId, {
          state: "stopped",
          message:
            full === undefined
              ? `this machine cannot run Sandboxes now: ${host?.reason ?? "unknown"}`
              : `this machine's disk is almost full; its owner's own work goes on. ${full}`,
        });
      }
      return true;
    }
    // A Sandbox that failed for good stays so until its host restarts, as a dedicated one.
    for (const grantId of wanted) {
      if (fibers.has(grantId)) continue;
      fibers.set(grantId, yield* Effect.forkIn(supervise(runtime, grantId), scope));
    }
    return true;
  });

  while (true) {
    lastHost = yield* input.hostReport;
    const runtime = Option.getOrUndefined(yield* input.runtime);
    if (runtime !== undefined) {
      for (const grantId of statuses.keys()) {
        const status = statuses.get(grantId);
        if (status === undefined) continue;
        statuses.set(
          grantId,
          measured(status, yield* runtime.measureHome(lentSandboxIdOf(grantId))),
        );
      }
    }
    const report = yield* reportOf([]);
    const answer = yield* input.askHub(report);
    const goesOn = yield* follow(answer, runtime);
    if (input.onRound !== undefined) yield* input.onRound(report);
    if (!goesOn) return;
    yield* input.nextRound;
  }
});

/** Builds the host report from what the runtime and the machine say now. */
const hostReportOf = Effect.fn("LentSandboxHost.hostReportOf")(function* (input: {
  readonly runtime: Option.Option<SandboxRuntime["Service"]>;
  readonly refusal: string | undefined;
  readonly reachablePorts: ReadonlyArray<number>;
  readonly cpus: number;
  readonly memoryBytes: number;
}) {
  const runtime = Option.getOrUndefined(input.runtime);
  const support =
    runtime === undefined
      ? { cpus: false, memory: false, pids: false, note: null }
      : yield* runtime.limitSupport;
  const space = runtime === undefined ? null : yield* runtime.hostSpace;
  return {
    ready: runtime !== undefined && input.refusal === undefined,
    reason: input.refusal ?? (runtime === undefined ? "no Sandbox runtime here." : null),
    limitSupport: {
      cpus: support.cpus,
      memory: support.memory,
      pids: support.pids,
      note: support.note,
    },
    reachablePorts: input.reachablePorts.toSorted((a, b) => a - b),
    hostCpus: input.cpus,
    hostMemoryBytes: input.memoryBytes,
    hostFreeBytes: space?.freeBytes ?? null,
    hostTotalBytes: space?.totalBytes ?? null,
  } satisfies SandboxHostReport;
});

/**
 * Beside a personal machine's own server: hosts its lent Sandboxes (`<base dir>-lent-sandboxes`,
 * apart from any other runtime's homes and containers on the machine). Without rootless Podman
 * and the image, or with a host port reachable that its owner did not list, it hosts nothing and
 * reports why each round, so the Hub refuses new loans of it with that reason.
 */
export const layer = (joined: JoinedHubState) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const credential = yield* JoinedHub.readCredential(secrets, ENVIRONMENT_CREDENTIAL_SECRET);
      if (Option.isNone(credential)) return;
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<
        ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
      >();
      const rootDir = path.join(
        path.dirname(config.baseDir),
        `${path.basename(config.baseDir)}-lent-sandboxes`,
      );
      let runtime = Option.none<SandboxRuntime["Service"]>();
      let unavailable: string | undefined;
      let recheck = false;
      /** The runtime once it can run; asked again each round while it cannot. */
      const currentRuntime = Effect.gen(function* () {
        if (Option.isSome(runtime)) return runtime;
        const checked = yield* dedicatedRuntimeFromConfig(joined.hubUrl, { recheck, rootDir });
        recheck = true;
        if (Result.isFailure(checked)) {
          unavailable = checked.failure.message;
          return runtime;
        }
        const built = yield* Layer.buildWithScope(checked.success, scope).pipe(Effect.option);
        if (Option.isNone(built)) {
          unavailable = "its Sandbox runtime could not start; see the server log.";
          return runtime;
        }
        unavailable = undefined;
        runtime = Option.some(Context.get(built.value, SandboxRuntime));
        return runtime;
      });
      const capacity = hostCapacity(null);
      const hostReport = Effect.gen(function* () {
        const current = yield* currentRuntime;
        const allowed = yield* allowedHostPorts;
        // Asked anew each round: a service bound since then stops the lent Sandboxes.
        const exposed = hostExposureRefusal(
          listeningOutsideLoopback().filter((listener) => listener.port !== config.port),
          allowed,
        );
        return yield* hostReportOf({
          runtime: current,
          refusal: unavailable ?? exposed,
          reachablePorts: [...allowed],
          cpus: capacity.cpus,
          memoryBytes: capacity.memoryBytes,
        });
      }).pipe(Effect.provide(context));
      yield* superviseLentSandboxes({
        joined,
        askHub: reportToHubAt(joined.hubUrl, credential.value),
        hostReport,
        runtime: Effect.suspend(() => Effect.succeed(runtime)),
        homesOnDisk: lentHomesIn(rootDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
        nextRound: Effect.sleep(LENT_ROUND_MS),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("This machine's lent Sandboxes stopped", cause),
        ),
        Effect.forkIn(scope),
      );
    }),
  );
