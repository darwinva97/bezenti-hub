// @effect-diagnostics nodeBuiltinImport:off -- pins the machine's address; reads the Hub's own.
/**
 * «Add a machine over SSH»: after the Owner confirms the host key, the Hub runs four steps there
 * and keeps their output; a failure or cancel stops there and undoes the grant and registration.
 * See docs/internals/sandboxes.md, «Installing over SSH».
 */
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeOS from "node:os";

import {
  type EnvironmentId,
  type EnvironmentJoinGrantRequest,
  type EnvironmentJoinStatus,
  type SpaceId,
  type SshInstallConfirmRequest,
  type SshInstallRun,
  type SshInstallStartRequest,
  type SshInstallStep,
  type SshInstallStepId,
  type UserId,
} from "@t3tools/contracts";
import {
  assertEnvironmentHubUrl,
  isEnvironmentCredentialHash,
} from "@t3tools/shared/environmentJoin";
import { buildRemoteT3RunnerScript, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../../auth/utils.ts";
import * as EnvironmentRegistry from "../EnvironmentRegistry.ts";
import * as SshClient from "./SshClient.ts";
import {
  checkScript,
  forbiddenSshAddress,
  hostKeyAlgorithm,
  hostKeyFingerprint,
  installScript,
  machineNameRefusal,
  makeScrubber,
  type Scrubber,
  SECRET_WINDOW,
  normalizeSshHost,
  registerScript,
  serviceScript,
  sshUsernameRefusal,
  STEP_BUSY_EXIT,
  STEP_BUSY_MARKER,
  stepCommand,
  stopStepScript,
  undoScript,
} from "./sshInstallScripts.ts";

/** How the Hub runs its SSH installs; from its settings, or a test's. */
export class SshInstallPolicy extends Context.Service<
  SshInstallPolicy,
  {
    /** The T3 the machine gets: the Hub's version from its release source, or a checkout (dev). */
    readonly runner: RemoteT3RunnerOptions;
    /** The Hub's own version, whose Sandbox image the machine builds. */
    readonly version: string;
    /** How long each step may run. */
    readonly stepTimeoutMs: Readonly<Record<SshInstallStepId, number>>;
    /** How long the started service has to reach the Hub, and how often that is asked. */
    readonly reachTimeoutMs: number;
    readonly reachPollMs: number;
    /** How long a host key waits for the Owner, holding the key in memory. */
    readonly hostKeyTtlMs: number;
    /** How long the registration grant lives. */
    readonly grantTtlMs: number;
    /**
     * Whether the Hub may install onto its own machine (loopback, its own addresses): development
     * and tests only (`T3CODE_SSH_INSTALL_ALLOW_HUB_HOST=1`), as their SSH servers are there.
     */
    readonly allowHubHost: boolean;
    /** The Hub process's SSH agent (`SSH_AUTH_SOCK`), for runs that sign in with it. */
    readonly agentSocket: string | null;
    /** Tests only: runs after each step succeeds, before the next one (a cancel lands there). */
    readonly afterStep?: (runId: string, step: SshInstallStepId) => Effect.Effect<void>;
  }
>()("t3/environments/sshInstall/SshInstall/SshInstallPolicy") {}

const MINUTE = 60_000;
const DEFAULT_STEP_TIMEOUTS: Record<SshInstallStepId, number> = {
  check: 15 * MINUTE,
  // A first Sandbox image build downloads Debian, Node and the providers' CLIs.
  install: 75 * MINUTE,
  register: 3 * MINUTE,
  service: 3 * MINUTE,
};

const optionalSetting = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.map((value) => Option.getOrNull(value)),
    Effect.orElseSucceed(() => null),
  );

/** The production policy: `T3CODE_RELEASE_BASE_URL`, and a checkout's entry in development. */
const policyFromConfig = Effect.gen(function* () {
  const releaseBaseUrl = yield* optionalSetting("T3CODE_RELEASE_BASE_URL");
  // Development: the machine runs T3 from a checkout at this path (with its own Node).
  const nodeScriptPath = yield* optionalSetting("T3CODE_SSH_INSTALL_NODE_SCRIPT");
  const allowHubHost = (yield* optionalSetting("T3CODE_SSH_INSTALL_ALLOW_HUB_HOST")) === "1";
  const agentSocket = yield* optionalSetting("SSH_AUTH_SOCK");
  return SshInstallPolicy.of({
    runner: {
      archiveVersion: packageJson.version,
      releaseBaseUrl,
      nodeScriptPath,
      nodeEngineRange: null,
    },
    version: packageJson.version,
    stepTimeoutMs: DEFAULT_STEP_TIMEOUTS,
    reachTimeoutMs: 2 * MINUTE,
    reachPollMs: 1_000,
    hostKeyTtlMs: 10 * MINUTE,
    grantTtlMs: 5 * MINUTE,
    allowHubHost,
    agentSocket: agentSocket === "" ? null : agentSocket,
  });
});

export class SshInstallRefusedError extends Schema.TaggedError<SshInstallRefusedError>()(
  "SshInstallRefusedError",
  { message: Schema.String },
) {}

export class SshInstallConflictError extends Schema.TaggedError<SshInstallConflictError>()(
  "SshInstallConflictError",
  { message: Schema.String },
) {}

export class SshInstallRunNotFoundError extends Schema.TaggedError<SshInstallRunNotFoundError>()(
  "SshInstallRunNotFoundError",
  {},
) {}

export class SshInstallForgetError extends Schema.TaggedError<SshInstallForgetError>()(
  "SshInstallForgetError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The machine was removed, but the Hub could not delete its kept SSH key or host record; it tries again when it starts.";
  }
}

/** Unknown, expired, spent, or its run is not registering: all alike. */
export class SshInstallInvalidGrantError extends Schema.TaggedError<SshInstallInvalidGrantError>()(
  "SshInstallInvalidGrantError",
  {},
) {}

type OwnerOnlyError =
  | EnvironmentRegistry.EnvironmentAccessDeniedError
  | EnvironmentRegistry.EnvironmentStorageError;

export class SshInstall extends Context.Service<
  SshInstall,
  {
    /**
     * Reads the machine's host key; the run waits for whoever started it (the Owner, or an Admin
     * of the Organization it is for) to confirm it.
     */
    readonly start: (
      actorUserId: UserId,
      input: SshInstallStartRequest,
    ) => Effect.Effect<
      SshInstallRun,
      OwnerOnlyError | SshInstallRefusedError | SshInstallConflictError
    >;
    /** Whoever started the run confirms the host key shown: the steps start. */
    readonly confirm: (
      actorUserId: UserId,
      input: SshInstallConfirmRequest,
    ) => Effect.Effect<
      SshInstallRun,
      OwnerOnlyError | SshInstallConflictError | SshInstallRunNotFoundError
    >;
    /** Stops the run where it is and undoes it, as a failure does. */
    readonly cancel: (
      actorUserId: UserId,
      runId: string,
    ) => Effect.Effect<SshInstallRun, OwnerOnlyError | SshInstallRunNotFoundError>;
    /** Once the run has ended, how (for the Hub's own code and tests; no door reaches it). */
    readonly awaitFinished: (
      runId: string,
    ) => Effect.Effect<SshInstallRun, SshInstallRunNotFoundError>;
    /** The run and each step's output so far. */
    readonly status: (
      actorUserId: UserId,
      runId: string,
    ) => Effect.Effect<SshInstallRun, OwnerOnlyError | SshInstallRunNotFoundError>;
    /**
     * Deletes a removed machine's kept key and host record. Its removal from Settings waits for
     * it, so a failure reaches the Owner; every removal runs it, and the Hub's start retries it.
     */
    readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, SshInstallForgetError>;
    /** Each machine whose kept key and host record the Hub has forgotten, once it is removed. */
    readonly forgotten: Effect.Effect<PubSub.Subscription<EnvironmentId>, never, Scope.Scope>;
    /** `t3 join --grant-on-stdin` on the machine: registers it for the run that issued the grant. */
    readonly redeemGrant: (
      input: EnvironmentJoinGrantRequest,
    ) => Effect.Effect<
      EnvironmentJoinStatus,
      | SshInstallInvalidGrantError
      | EnvironmentRegistry.EnvironmentAccessDeniedError
      | EnvironmentRegistry.EnvironmentStorageError
    >;
  }
>()("t3/environments/sshInstall/SshInstall") {}

const STEP_TITLES: Record<SshInstallStepId, string> = {
  check: "Check the system and Podman",
  install: "Install T3 Code",
  register: "Register the machine",
  service: "Start its service",
};
const STEP_ORDER: ReadonlyArray<SshInstallStepId> = ["check", "install", "register", "service"];
/** Of each step's output, the last lines (each cut at a length) the Hub keeps. */
const OUTPUT_LINES_KEPT = 300;
const LINE_MAX_CHARS = 2_000;
/** Finished runs the Hub remembers, the newest. */
const FINISHED_RUNS_KEPT = 20;
const UNDO_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 10_000;
/** A line without its end yet longer than this is shown as it is: scrubbed, then cut. */
const PARTIAL_MAX_CHARS = 4 * LINE_MAX_CHARS;
/** Kept with the machine when the Owner asks to (`keepForUpdates`). */
export const keptKeySecretName = (environmentId: string) => `ssh-install-key-${environmentId}`;
const KeptKey = Schema.Struct({
  privateKey: Schema.String,
  passphrase: Schema.optionalKey(Schema.String),
});
const encodeKeptKey = Schema.encodeSync(Schema.fromJsonString(KeptKey));

/**
 * What a run that stopped from its install step on leaves on the machine, and how to remove it.
 * The Hub does not remove it there itself: «Try again» uses it, and a machine joined some other way
 * may too.
 */
const leftoverNote = (version: string) =>
  `Left on the machine: ~/.t3/ssh-install (T3 Code ${version} and its logs) and, if its build began, the Sandbox image localhost/t3code-sandbox:${version}. «Try again» uses them. If nothing else there uses T3 Code, remove them there with: rm -rf ~/.t3/ssh-install; podman rmi localhost/t3code-sandbox:${version}`;

interface MutableStep {
  readonly id: SshInstallStepId;
  state: SshInstallStep["state"];
  output: Array<string>;
  /** Its line not ended yet, as it came; `carried` marks which of its first characters are secret. */
  partial: string;
  carried: Uint8Array | undefined;
}

interface Run {
  readonly runId: string;
  readonly ownerUserId: UserId;
  readonly host: string;
  readonly address: string;
  readonly port: number;
  readonly username: string;
  readonly spaceId: SpaceId;
  readonly spaceName: string;
  readonly name: string;
  readonly hubUrl: string;
  readonly keepForUpdates: boolean;
  readonly startedAt: string;
  /** Wiped as the run ends: the key lives no longer than its run. */
  credentials: SshClient.SshCredentials | undefined;
  /** Of the key, its passphrase and (from step 3) the grant; emptied as the run ends. */
  scrubber: Scrubber;
  /** What this run did on the machine, which a failure or cancel says or undoes. */
  didInstall: boolean;
  /** Until `start` has returned: its host and port stay claimed, whatever the run's state. */
  starting: boolean;
  state: SshInstallRun["state"];
  hostKey: { algorithm: string; fingerprint: string } | null;
  steps: Array<MutableStep>;
  error: string | null;
  environmentId: EnvironmentId | null;
  keyKept: boolean;
  finishedAt: string | null;
  /** Set as the run starts ending: a grant redeemed after this undoes itself. */
  closing: boolean;
  /** The Owner asked to cancel: the run stops before its next step, however far it got. */
  cancelRequested: boolean;
  /** Set once it has ended, the first time: it ends once. */
  ended: boolean;
  /** Forgets the run when its host key is not confirmed in time; gone once it is, or it ends. */
  hostKeyTimer: Fiber.Fiber<void, never> | undefined;
  /** Done once the run has ended. */
  readonly done: Deferred.Deferred<void>;
  fiber: Fiber.Fiber<void, never> | undefined;
}

/** A line scrubbed whole (with what was known secret of its start), then cut to its length. */
const scrubLine = (scrubber: Scrubber, text: string, carried?: Uint8Array) =>
  scrubber.redact(text, scrubber.mask(text, carried)).slice(0, LINE_MAX_CHARS);

const viewOf = (run: Run): SshInstallRun => ({
  runId: run.runId,
  host: run.host,
  port: run.port,
  username: run.username,
  spaceId: run.spaceId,
  spaceName: run.spaceName,
  name: run.name,
  state: run.state,
  hostKey: run.hostKey,
  steps: run.steps.map((step) => ({
    id: step.id,
    title: STEP_TITLES[step.id],
    state: step.state,
    output:
      step.partial === ""
        ? [...step.output]
        : [...step.output, scrubLine(run.scrubber, step.partial, step.carried)],
  })),
  error: run.error,
  environmentId: run.environmentId,
  keyKept: run.keyKept,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  message: Schema.String,
}) {}
const isStepFailed = Schema.is(StepFailed);

/** What each step's exit code means, when the script says. */
const CHECK_EXITS: Record<number, string> = {
  10: "The machine is not Linux.",
  11: "Connect as a non-root user.",
  12: "Podman is missing and could not be installed (no passwordless sudo, or no known package manager). Install rootless Podman there, then add the machine again.",
  13: "Installing Podman failed.",
  14: "Podman does not run rootless for that user.",
  15: "Lingering is off for that user and could not be turned on (its service would stop at logout). As root there, run loginctl enable-linger with that user, then add the machine again.",
};

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const policy =
    Option.getOrUndefined(yield* Effect.serviceOption(SshInstallPolicy)) ??
    (yield* policyFromConfig);
  const scope = yield* Effect.scope;

  const runs = new Map<string, Run>();
  /** sha256(grant) → its run; spent on first use. */
  const grants = new Map<string, { readonly runId: string; readonly expiresAtMs: number }>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const sha256 = (value: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.map(base64UrlEncode));

  /** An active User: whatever else they may, a User turned off reaches no run. */
  const requireActive = (actorUserId: UserId) => registry.authorizeRegister(actorUserId);

  const isActive = (run: Run) =>
    run.starting || run.state === "awaiting-host-key" || run.state === "running";

  const forgetOldRuns = () => {
    const finished = [...runs.values()].filter((run) => !isActive(run));
    for (const run of finished.slice(0, Math.max(0, finished.length - FINISHED_RUNS_KEPT))) {
      runs.delete(run.runId);
    }
  };

  // Each line is scrubbed whole and only then cut. A line too long to wait for its end is shown
  // without its last characters, which wait for what follows with what is known secret of them.
  const appendOutput = (run: Run, step: MutableStep, chunk: string) => {
    const parts = (step.partial + chunk).split(/\r\n|\r|\n/u);
    const rest = parts.pop() ?? "";
    let carried = step.carried;
    for (const line of parts) {
      step.output.push(scrubLine(run.scrubber, line, carried));
      carried = undefined;
    }
    step.partial = rest;
    step.carried = carried;
    if (step.partial.length > PARTIAL_MAX_CHARS) {
      const mask = run.scrubber.mask(step.partial, step.carried);
      const cut = step.partial.length - (SECRET_WINDOW - 1);
      step.output.push(
        run.scrubber
          .redact(step.partial.slice(0, cut), mask.subarray(0, cut))
          .slice(0, LINE_MAX_CHARS),
      );
      step.partial = step.partial.slice(cut);
      step.carried = mask.slice(cut);
    }
    if (step.output.length > OUTPUT_LINES_KEPT) {
      step.output.splice(0, step.output.length - OUTPUT_LINES_KEPT);
    }
  };
  const flushOutput = (run: Run, step: MutableStep) => {
    if (step.partial !== "") {
      step.output.push(scrubLine(run.scrubber, step.partial, step.carried));
    }
    step.partial = "";
    step.carried = undefined;
  };
  const say = (run: Run, step: MutableStep, line: string) => appendOutput(run, step, `${line}\n`);

  const storedHostKey = Effect.fn("SshInstall.storedHostKey")(function* (
    host: string,
    port: number,
  ) {
    const rows = yield* sql<{ readonly fingerprint: string; readonly name: string }>`
      SELECT h.host_key_fingerprint AS fingerprint, e.name AS name
      FROM environment_ssh_hosts h
      JOIN environments e ON e.environment_id = h.environment_id
      WHERE h.host = ${host} AND h.port = ${port} AND e.revoked_at IS NULL
      ORDER BY h.installed_at DESC
    `.pipe(Effect.mapError((cause) => new EnvironmentRegistry.EnvironmentStorageError({ cause })));
    return rows[0];
  });

  const refuse = (message: string) => Effect.fail(new SshInstallRefusedError({ message }));

  /** Ends the run, once: the key goes, the steps not run say so, and its host key timer stops. */
  const finish = Effect.fn("SshInstall.finish")(function* (
    run: Run,
    outcome:
      | { readonly _tag: "succeeded" }
      | { readonly _tag: "failed"; readonly message: string }
      | { readonly _tag: "cancelled"; readonly message?: string },
  ) {
    if (run.ended) return;
    run.ended = true;
    run.credentials = undefined;
    run.state = outcome._tag;
    run.error =
      outcome._tag === "failed"
        ? run.scrubber.scrub(outcome.message)
        : outcome._tag === "cancelled"
          ? (outcome.message ?? "Cancelled by the Owner.")
          : null;
    for (const step of run.steps) {
      if (step.state === "pending" && outcome._tag !== "succeeded") step.state = "cancelled";
    }
    // Its output is all scrubbed by now: nothing of the key stays in memory with the run.
    for (const step of run.steps) flushOutput(run, step);
    run.scrubber = makeScrubber({});
    run.finishedAt = yield* nowIso;
    const timer = run.hostKeyTimer;
    run.hostKeyTimer = undefined;
    if (timer !== undefined) yield* Fiber.interrupt(timer);
    yield* Deferred.succeed(run.done, undefined);
  });

  const start: SshInstall["Service"]["start"] = Effect.fn("SshInstall.start")(
    function* (actorUserId, input) {
      // The rule a machine's dedication has (owned-resources 07): the Owner, or an Admin of the
      // Organization it is for, which must be there and open.
      yield* registry.authorizeDedicate(actorUserId, input.spaceId).pipe(
        Effect.catchIf(
          (error) =>
            error._tag === "EnvironmentAccessDeniedError" && error.reason === "not-an-organization",
          () => refuse("A machine is dedicated to an Organization that is not archived."),
        ),
      );
      const space = (yield* registry.dedicatedSpaces(actorUserId)).find(
        (entry) => entry.id === input.spaceId,
      );
      if (space === undefined) {
        return yield* refuse("A machine is dedicated to an Organization that is not archived.");
      }
      const host = normalizeSshHost(input.host);
      if (host === undefined) return yield* refuse("That is not a host name or IP address.");
      const usernameRefusal = sshUsernameRefusal(input.username);
      if (usernameRefusal !== undefined) return yield* refuse(usernameRefusal);
      const nameRefusal = machineNameRefusal(input.name);
      if (nameRefusal !== undefined) return yield* refuse(nameRefusal);
      const hubUrl = yield* Effect.try({
        try: () => assertEnvironmentHubUrl(input.hubUrl).origin,
        catch: (cause) =>
          new SshInstallRefusedError({
            message: cause instanceof Error ? cause.message : "That is not the Hub's address.",
          }),
      });
      let credentials: SshClient.SshCredentials;
      if (input.auth.kind === "key") {
        const privateKey = Redacted.value(input.auth.privateKey);
        const passphrase =
          input.auth.passphrase === undefined ? undefined : Redacted.value(input.auth.passphrase);
        const refusal = SshClient.keyRefusal(privateKey, passphrase);
        if (refusal !== undefined) return yield* refuse(refusal);
        credentials = { kind: "key", privateKey, passphrase };
      } else {
        const agentSocket = policy.agentSocket;
        if (agentSocket === null) {
          return yield* refuse("The Hub's process has no SSH agent (SSH_AUTH_SOCK is not set).");
        }
        credentials = { kind: "agent", agentSocket };
      }
      // Resolved once and pinned: every connection of the run goes to this address.
      const addresses = yield* Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(host, { all: true, verbatim: true }),
        catch: () => new SshInstallRefusedError({ message: `${host} does not resolve.` }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: DNS_TIMEOUT_MS,
          orElse: () => refuse(`${host} did not resolve in time.`),
        }),
      );
      const hubHost = policy.allowHubHost
        ? undefined
        : {
            ownAddresses: Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
              (entries ?? []).map((entry) => entry.address),
            ),
          };
      for (const { address } of addresses) {
        const forbidden = forbiddenSshAddress(address, hubHost);
        if (forbidden !== undefined) {
          return yield* refuse(`${host} is ${forbidden}; the Hub does not open SSH there.`);
        }
      }
      const address = addresses[0]?.address;
      if (address === undefined) return yield* refuse(`${host} does not resolve.`);
      const runId = base64UrlEncode(yield* random.randomBytes(18));
      const run: Run = {
        runId,
        ownerUserId: actorUserId,
        host,
        address,
        port: input.port,
        username: input.username,
        spaceId: input.spaceId,
        spaceName: space.name,
        name: input.name,
        hubUrl,
        keepForUpdates: input.keepForUpdates && credentials.kind === "key",
        startedAt: yield* nowIso,
        credentials,
        didInstall: false,
        starting: true,
        scrubber: makeScrubber(
          credentials.kind === "key"
            ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase }
            : {},
        ),
        state: "awaiting-host-key",
        hostKey: null,
        steps: STEP_ORDER.map((id) => ({
          id,
          state: "pending",
          output: [],
          partial: "",
          carried: undefined,
        })),
        error: null,
        environmentId: null,
        keyKept: false,
        finishedAt: null,
        closing: false,
        cancelRequested: false,
        ended: false,
        hostKeyTimer: undefined,
        fiber: undefined,
        done: yield* Deferred.make<void>(),
      };
      // Claimed with nothing in between: two runs to one machine never both go on.
      const claimed = yield* Effect.sync(() => {
        for (const other of runs.values()) {
          if (!isActive(other) || other.port !== run.port) continue;
          if (other.host === run.host || other.address === run.address) return false;
        }
        runs.set(runId, run);
        forgetOldRuns();
        return true;
      });
      if (!claimed) {
        run.starting = false;
        return yield* new SshInstallConflictError({
          message: `A run to ${host}:${input.port} is already under way.`,
        });
      }
      const failEarly = (message: string) =>
        finish(run, { _tag: "failed", message }).pipe(
          Effect.andThen(Effect.sync(() => viewOf(run))),
        );
      // Whatever stops it before the host key is shown (an error, an interrupt) ends the run.
      return yield* Effect.gen(function* () {
        const probed = yield* SshClient.probeHostKey({ address, port: input.port }).pipe(
          Effect.timeoutOrElse({
            duration: 30_000,
            orElse: () =>
              Effect.fail(
                new SshClient.SshFailure({
                  reason: "timeout",
                  detail: "The machine did not answer SSH in time.",
                }),
              ),
          }),
          Effect.result,
        );
        // Cancelled while the Hub was reading the key: nothing more to do.
        if (run.ended) return viewOf(run);
        if (probed._tag === "Failure") return yield* failEarly(probed.failure.detail);
        const fingerprint = hostKeyFingerprint(probed.success);
        const algorithm = hostKeyAlgorithm(probed.success);
        const stored = yield* storedHostKey(host, input.port);
        run.hostKey = { algorithm, fingerprint };
        if (stored !== undefined && stored.fingerprint !== fingerprint) {
          return yield* failEarly(
            `The machine's host key changed: ${stored.name} was installed with ${stored.fingerprint}, and ${host}:${input.port} now shows ${fingerprint}. The Hub did not sign in. If the machine was reinstalled, remove ${stored.name} first.`,
          );
        }
        // That machine is joined already: a second registration would only fail there, and undoing
        // it must not touch the machine that is.
        if (stored !== undefined) {
          return yield* failEarly(
            `${host}:${input.port} is already installed as ${stored.name}. To install it again, remove ${stored.name} first.`,
          );
        }
        if (run.ended) return viewOf(run);
        // Not confirmed in time: the run ends and its key goes.
        run.hostKeyTimer = yield* Effect.sleep(policy.hostKeyTtlMs).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              run.hostKeyTimer = undefined;
              return run.state === "awaiting-host-key"
                ? finish(run, {
                    _tag: "cancelled",
                    message: "The host key was not confirmed in time; add the machine again.",
                  })
                : Effect.void;
            }),
          ),
          Effect.forkIn(scope),
        );
        return viewOf(run);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : finish(
                run,
                Cause.hasInterrupts(exit.cause)
                  ? { _tag: "cancelled", message: "The run stopped before its host key was shown." }
                  : { _tag: "failed", message: "The run could not start." },
              ),
        ),
        Effect.ensuring(Effect.sync(() => (run.starting = false))),
      );
    },
  );

  /**
   * A run, to the User who started it only (`actorUserId`): anyone else's answers like a missing
   * one. The Hub's own code asks without one.
   */
  const find = (runId: string, actorUserId?: UserId) =>
    Effect.suspend(() => {
      const run = runs.get(runId);
      return run === undefined || (actorUserId !== undefined && run.ownerUserId !== actorUserId)
        ? Effect.fail(new SshInstallRunNotFoundError({}))
        : Effect.succeed(run);
    });

  /** Revokes the grant and whatever the run registered; undoes the machine's side if it can. */
  const undo = Effect.fn("SshInstall.undo")(function* (
    run: Run,
    session: SshClient.SshSession | undefined,
    step: MutableStep,
  ) {
    run.closing = true;
    for (const [hash, grant] of grants) if (grant.runId === run.runId) grants.delete(hash);
    const registered = run.environmentId;
    if (registered !== null) {
      yield* registry
        .remove({ actorUserId: run.ownerUserId, environmentId: registered, via: "ssh" })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => say(run, step, "The Hub removed the machine it had registered.")),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("SSH install: could not remove the machine it registered", {
              cause,
            }),
          ),
        );
      run.environmentId = null;
    }
    // Only what this run registered is undone there: a machine that refused to join (joined
    // already, to this Hub or another) keeps what it has.
    if (registered === null) return;
    if (session === undefined) {
      say(run, step, "The machine could not be reached to undo it there; run `t3 leave` on it.");
      return;
    }
    say(run, step, "Undoing it on the machine...");
    const undone = yield* session
      .exec(undoScript(), {
        onOutput: (chunk) => appendOutput(run, step, chunk),
        timeoutMs: UNDO_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    flushOutput(run, step);
    if (undone._tag === "Failure") {
      say(run, step, "The machine could not be reached to undo it there; run `t3 leave` on it.");
    }
  });

  const runStep = Effect.fn("SshInstall.runStep")(function* (
    run: Run,
    session: SshClient.SshSession,
    id: SshInstallStepId,
    script: string,
    stdin: string | undefined,
  ) {
    if (run.cancelRequested) return yield* Effect.interrupt;
    const step = run.steps.find((entry) => entry.id === id)!;
    step.state = "running";
    const token = base64UrlEncode(yield* random.randomBytes(12));
    // Only the step wrapper prints it: another step holds the machine, this one did nothing.
    let busyMarker = false;
    const exitCode = yield* session
      .exec(stepCommand(script, { token, step: id }), {
        ...(stdin === undefined ? {} : { stdin }),
        onOutput: (chunk) => {
          if (chunk.includes(STEP_BUSY_MARKER)) busyMarker = true;
          appendOutput(run, step, chunk);
        },
        timeoutMs: policy.stepTimeoutMs[id],
      })
      .pipe(
        // Its SSH channel closed, the step would go on there: its process group is stopped.
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            flushOutput(run, step);
            const busy = Exit.isSuccess(exit) && exit.value === STEP_BUSY_EXIT && busyMarker;
            if (id === "install" && !busy) run.didInstall = true;
            const leftRunning =
              Exit.isFailure(exit) &&
              (Cause.hasInterrupts(exit.cause) ||
                exit.cause.reasons.some(
                  (reason) => Cause.isFailReason(reason) && reason.error.reason === "timeout",
                ));
            if (!leftRunning) return;
            yield* session
              .exec(stopStepScript(token), {
                onOutput: (chunk) => appendOutput(run, step, chunk),
                timeoutMs: STOP_TIMEOUT_MS,
              })
              .pipe(Effect.ignore);
            flushOutput(run, step);
          }),
        ),
        Effect.mapError((failure) => new StepFailed({ message: failure.detail })),
      );
    if (exitCode === STEP_BUSY_EXIT && busyMarker) {
      return yield* new StepFailed({
        message:
          "Another installation is still running on the machine; its output says how to stop it there.",
      });
    }
    if (exitCode !== 0) {
      return yield* new StepFailed({
        message:
          (id === "check" ? CHECK_EXITS[exitCode] : undefined) ??
          `${STEP_TITLES[id]} failed (exit code ${exitCode}); its output says why.`,
      });
    }
    return step;
  });

  const awaitReached = Effect.fn("SshInstall.awaitReached")(function* (
    run: Run,
    step: MutableStep,
    environmentId: EnvironmentId,
  ) {
    say(run, step, "Waiting for the machine to reach the Hub...");
    const deadline = (yield* Clock.currentTimeMillis) + policy.reachTimeoutMs;
    while (true) {
      const reached = yield* registry
        .hasReachedHub(environmentId)
        .pipe(Effect.orElseSucceed(() => false));
      if (reached) {
        say(run, step, "The machine reached the Hub.");
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new StepFailed({
          message:
            "The machine's service started but did not reach the Hub in time. Check that it can open the Hub's address.",
        });
      }
      yield* Effect.sleep(policy.reachPollMs);
    }
  });

  const keep = Effect.fn("SshInstall.keep")(function* (run: Run, environmentId: EnvironmentId) {
    const credentials = run.credentials;
    const keyKept = run.keepForUpdates && credentials?.kind === "key";
    if (keyKept && credentials?.kind === "key") {
      yield* secrets.set(
        keptKeySecretName(environmentId),
        new TextEncoder().encode(
          encodeKeptKey({
            privateKey: credentials.privateKey,
            ...(credentials.passphrase === undefined ? {} : { passphrase: credentials.passphrase }),
          }),
        ),
      );
    }
    yield* sql`
      INSERT INTO environment_ssh_hosts (
        environment_id, host, port, username, host_key_algorithm, host_key_fingerprint,
        key_kept, installed_at, installed_by
      ) VALUES (
        ${environmentId}, ${run.host}, ${run.port}, ${run.username},
        ${run.hostKey?.algorithm ?? "unknown"}, ${run.hostKey?.fingerprint ?? ""},
        ${keyKept ? 1 : 0}, ${yield* nowIso}, ${run.ownerUserId}
      )
      ON CONFLICT (environment_id) DO UPDATE SET host = excluded.host, port = excluded.port,
        username = excluded.username, host_key_algorithm = excluded.host_key_algorithm,
        host_key_fingerprint = excluded.host_key_fingerprint, key_kept = excluded.key_kept,
        installed_at = excluded.installed_at, installed_by = excluded.installed_by
    `;
    run.keyKept = keyKept;
  });

  const afterStep = (run: Run, step: SshInstallStepId) =>
    policy.afterStep === undefined ? Effect.void : policy.afterStep(run.runId, step);

  const steps = Effect.fn("SshInstall.steps")(function* (run: Run, fingerprint: string) {
    const credentials = run.credentials;
    if (credentials === undefined) return yield* new StepFailed({ message: "The run ended." });
    let session: SshClient.SshSession | undefined;
    const work = Effect.gen(function* () {
      if (run.cancelRequested) return yield* Effect.interrupt;
      const check = run.steps[0]!;
      check.state = "running";
      say(run, check, `Connecting to ${run.username}@${run.host}:${run.port}...`);
      session = yield* SshClient.connect(
        { address: run.address, port: run.port, username: run.username },
        credentials,
        fingerprint,
      ).pipe(Effect.mapError((failure) => new StepFailed({ message: failure.detail })));
      const connected = session;
      yield* runStep(run, connected, "check", checkScript(), undefined);
      check.state = "succeeded";
      yield* afterStep(run, "check");

      const runner = yield* Effect.try({
        try: () => buildRemoteT3RunnerScript(policy.runner),
        catch: (cause) =>
          new StepFailed({
            message: cause instanceof Error ? cause.message : "The Hub has no T3 to install.",
          }),
      });
      (yield* runStep(
        run,
        connected,
        "install",
        installScript({ version: policy.version }),
        `${runner}\n`,
      )).state = "succeeded";
      yield* afterStep(run, "install");

      const grant = base64UrlEncode(yield* random.randomBytes(32));
      const grantHash = yield* sha256(grant);
      run.scrubber = makeScrubber({
        ...(credentials.kind === "key"
          ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase }
          : {}),
        grant,
      });
      grants.set(grantHash, {
        runId: run.runId,
        expiresAtMs: (yield* Clock.currentTimeMillis) + policy.grantTtlMs,
      });
      const register = yield* runStep(
        run,
        connected,
        "register",
        registerScript({ hubUrl: run.hubUrl, spaceId: run.spaceId, name: run.name }),
        `${grant}\n`,
      ).pipe(Effect.ensuring(Effect.sync(() => grants.delete(grantHash))));
      const environmentId = run.environmentId;
      if (environmentId === null) {
        return yield* new StepFailed({ message: "The machine did not register with the Hub." });
      }
      register.state = "succeeded";
      yield* afterStep(run, "register");

      const service = yield* runStep(run, connected, "service", serviceScript(), undefined);
      yield* awaitReached(run, service, environmentId);
      yield* keep(run, environmentId).pipe(
        Effect.mapError(() => new StepFailed({ message: "The Hub could not record the machine." })),
      );
      service.state = "succeeded";
    });
    yield* work.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const interrupted = Cause.hasInterrupts(exit.cause);
              // Where it stopped: the step running, or (stopped between two) the next one.
              const step =
                run.steps.find((entry) => entry.state === "running") ??
                run.steps.find((entry) => entry.state === "pending") ??
                run.steps[run.steps.length - 1]!;
              if (step.state === "running" || step.state === "pending") {
                step.state = interrupted ? "cancelled" : "failed";
              }
              yield* undo(run, session, step);
              if (run.didInstall) say(run, step, leftoverNote(policy.version));
            }),
      ),
      Effect.scoped,
    );
  });

  const confirm: SshInstall["Service"]["confirm"] = Effect.fn("SshInstall.confirm")(
    function* (actorUserId, input) {
      yield* requireActive(actorUserId);
      const run = yield* find(input.runId, actorUserId);
      const fingerprint = run.hostKey?.fingerprint;
      if (run.state !== "awaiting-host-key" || fingerprint === undefined) {
        return yield* new SshInstallConflictError({
          message: "This run is not waiting for its host key.",
        });
      }
      if (input.fingerprint !== fingerprint) {
        return yield* new SshInstallConflictError({
          message: "That is not the host key the Hub was shown; nothing was started.",
        });
      }
      run.state = "running";
      const timer = run.hostKeyTimer;
      run.hostKeyTimer = undefined;
      if (timer !== undefined) yield* Fiber.interrupt(timer);
      run.fiber = yield* steps(run, fingerprint).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => finish(run, { _tag: "succeeded" }),
          onFailure: Effect.fn("SshInstall.failed")(function* (cause) {
            if (Cause.hasInterrupts(cause)) return yield* finish(run, { _tag: "cancelled" });
            const failure = cause.reasons.find(Cause.isFailReason);
            const message =
              failure !== undefined && isStepFailed(failure.error)
                ? failure.error.message
                : "The run stopped unexpectedly.";
            if (failure === undefined) {
              yield* Effect.logWarning("SSH install stopped unexpectedly", { cause });
            }
            yield* finish(run, { _tag: "failed", message });
          }),
        }),
        Effect.onInterrupt(() => finish(run, { _tag: "cancelled" })),
        Effect.forkIn(scope),
      );
      return viewOf(run);
    },
  );

  const cancel: SshInstall["Service"]["cancel"] = Effect.fn("SshInstall.cancel")(
    function* (actorUserId, runId) {
      yield* requireActive(actorUserId);
      const run = yield* find(runId, actorUserId);
      if (run.ended) return viewOf(run);
      // Recorded first: a run whose steps have not started yet stops before the first one.
      run.cancelRequested = true;
      if (run.state === "awaiting-host-key") {
        yield* finish(run, { _tag: "cancelled" });
      } else if (run.fiber !== undefined) {
        // Waits for the undo: the answer shows what was cleaned up.
        yield* Fiber.interrupt(run.fiber);
        // A run interrupted before it began has run none of its own handlers.
        yield* finish(run, { _tag: "cancelled" });
      }
      return viewOf(run);
    },
  );

  const status: SshInstall["Service"]["status"] = Effect.fn("SshInstall.status")(
    function* (actorUserId, runId) {
      yield* requireActive(actorUserId);
      return viewOf(yield* find(runId, actorUserId));
    },
  );

  const redeemGrant: SshInstall["Service"]["redeemGrant"] = Effect.fn("SshInstall.redeemGrant")(
    function* (input) {
      const hash = yield* sha256(Redacted.value(input.grant));
      const now = yield* Clock.currentTimeMillis;
      // Spent on first sight, whatever comes next.
      const grant = yield* Effect.sync(() => {
        const found = grants.get(hash);
        grants.delete(hash);
        return found;
      });
      const run = grant === undefined ? undefined : runs.get(grant.runId);
      const registering = run?.steps.find((step) => step.id === "register")?.state === "running";
      if (
        grant === undefined ||
        grant.expiresAtMs <= now ||
        run === undefined ||
        run.state !== "running" ||
        run.closing ||
        !registering ||
        run.environmentId !== null ||
        !isEnvironmentCredentialHash(input.credentialHash)
      ) {
        return yield* new SshInstallInvalidGrantError({});
      }
      const environmentId = yield* registry.register({
        approvedBy: run.ownerUserId,
        name: run.name,
        os: input.os.slice(0, 64),
        hostname: input.hostname.slice(0, 255),
        credentialHash: input.credentialHash,
        dedicatedSpaceId: run.spaceId,
        via: { _tag: "ssh", host: run.host },
      });
      // Recorded and checked in one step: an undo that started meanwhile removes it here.
      const late = yield* Effect.sync(() => {
        run.environmentId = environmentId;
        return run.closing;
      });
      if (late) {
        yield* registry
          .remove({ actorUserId: run.ownerUserId, environmentId, via: "ssh" })
          .pipe(Effect.ignore({ log: true }));
        run.environmentId = null;
        return yield* new SshInstallInvalidGrantError({});
      }
      return {
        status: "approved",
        environmentId,
        hubEnvironmentId: registry.hubId,
        name: run.name,
        dedicatedSpace: { id: run.spaceId, name: run.spaceName },
      } as const;
    },
  );

  // A machine removed (from Settings, `t3 leave`, or an undo): its kept key and record go too.
  const forgotten = yield* PubSub.unbounded<EnvironmentId>();
  const forget: SshInstall["Service"]["forget"] = Effect.fn("SshInstall.forget")(
    function* (environmentId) {
      yield* secrets.remove(keptKeySecretName(environmentId));
      yield* sql`DELETE FROM environment_ssh_hosts WHERE environment_id = ${environmentId}`;
    },
    Effect.mapError((cause) => new SshInstallForgetError({ cause })),
  );
  yield* registry.removed.pipe(
    Stream.runForEach((environmentId) =>
      forget(environmentId).pipe(
        Effect.andThen(PubSub.publish(forgotten, environmentId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("SSH install: could not forget a removed machine's key", { cause }),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );
  // What a failed forget left (a removed machine's key or host record): tried again here.
  yield* sql<{ readonly environmentId: EnvironmentId }>`
    SELECT h.environment_id AS "environmentId" FROM environment_ssh_hosts h
    LEFT JOIN environments e ON e.environment_id = h.environment_id
    WHERE e.environment_id IS NULL OR e.revoked_at IS NOT NULL
  `.pipe(
    Effect.flatMap(Effect.forEach((row) => forget(row.environmentId), { discard: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("SSH install: could not forget removed machines' keys", { cause }),
    ),
  );

  const awaitFinished: SshInstall["Service"]["awaitFinished"] = Effect.fn(
    "SshInstall.awaitFinished",
  )(function* (runId) {
    const run = yield* find(runId);
    yield* Deferred.await(run.done);
    return viewOf(run);
  });

  return SshInstall.of({
    start,
    confirm,
    cancel,
    status,
    awaitFinished,
    redeemGrant,
    forget,
    forgotten: PubSub.subscribe(forgotten),
  });
});

export const layer = Layer.effect(SshInstall, make);
