// @effect-diagnostics nodeBuiltinImport:off -- finds a dev Hub's checkout from its entry point.
/**
 * Which Sandbox runtime a Hub runs, if any. `T3CODE_SANDBOX_RUNTIME` picks one (`podman`, or
 * `process` for development; `off` for none). Unset, a production Hub runs Podman when rootless
 * Podman is here and the Sandbox image is built; otherwise it offers no Sandbox. See
 * docs/internals/sandboxes.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SANDBOXES_NEED_PODMAN } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as PodmanSandboxRuntime from "./PodmanSandboxRuntime.ts";
import { hostExposureRefusal, listeningOutsideLoopback } from "./hostExposure.ts";
import * as ProcessSandboxRuntime from "./ProcessSandboxRuntime.ts";
import { checkoutOf, configuredSandboxImage } from "./SandboxImage.ts";
import { SandboxHubAddress } from "./SandboxRuntime.ts";

const SANDBOX_RUNTIME_SETTING = "T3CODE_SANDBOX_RUNTIME";
/** Ports of a machine its Sandboxes (dedicated or lent) may reach, comma-separated (`22,443`). */
const SANDBOX_HOST_PORTS_SETTING = "T3CODE_SANDBOX_HOST_PORTS";
/** The older name of the same setting, still read. */
const DEDICATED_HOST_PORTS_SETTING = "T3CODE_DEDICATED_HOST_PORTS";

const optionalSetting = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * What a dev Hub mounts of its checkout, read-only, for its Sandboxes to run the server from
 * source: the server, the workspace packages and the installed modules; nothing else of it.
 */
export const devCodeMounts = (checkout: string) =>
  ["apps/server", "packages", "node_modules"]
    .map((dir) => NodePath.join(checkout, dir))
    .filter((dir) => NodeFS.existsSync(dir));

/**
 * Whether a Hub bound to `host` may run Podman Sandboxes: only one listening on loopback alone,
 * since a container reaches every address of the host but its loopback.
 */
export const hubHostAllowsPodman = (host: string | undefined) =>
  host !== undefined &&
  (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host));

/** Whether rootless Podman is here and has `image`: asked once per Hub, a few seconds at most. */
let podmanDetection: Promise<{ rootless: boolean; image: boolean }> | undefined;
const detectPodman = (image: string) =>
  Effect.promise(() => {
    podmanDetection ??= Effect.runPromise(
      Effect.all(
        [
          PodmanSandboxRuntime.detectRootlessPodman(),
          PodmanSandboxRuntime.runPodman(["image", "exists", image], { timeoutMs: 5_000 }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.map(([rootless, exists]) => ({ rootless, image: exists.exitCode === 0 }))),
    );
    return podmanDetection;
  });

/**
 * The Podman runtime as a Hub runs it. The base image runs its own `t3`. A Hub run from source
 * (`src/bin.ts`, a dev Hub) given a dev image (one it did not build: node and git only) mounts
 * {@link devCodeMounts} and runs its source with the image's Node.
 */
const podmanForHub = (
  config: { readonly devUrl: URL | undefined },
  image: string,
  rootDir?: string,
) => {
  const entry = process.argv[1];
  const checkout = entry !== undefined && entry.endsWith(".ts") ? checkoutOf(entry) : undefined;
  return PodmanSandboxRuntime.layer({
    image,
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(checkout === undefined || entry === undefined
      ? {}
      : {
          devServer: {
            serverCommand: ["node", NodePath.resolve(entry)],
            codeMounts: devCodeMounts(checkout),
          },
        }),
    devUrl: config.devUrl?.toString(),
  });
};

/**
 * The runtime a dedicated machine runs its one Sandbox with, reaching the Hub at `hubUrl` (its
 * https address): Podman by default, which must be rootless with the Sandbox image built; the
 * process one only when `T3CODE_SANDBOX_RUNTIME=process` asks for it (development and tests).
 * Fails with why there is none, as `t3 status` shows it.
 */
/** Why a dedicated machine runs nothing, and whether it waits (its image missing) and asks again. */
export interface DedicatedRuntimeRefusal {
  readonly message: string;
  readonly waits: boolean;
}
const refused = (message: string, waits = false) =>
  Result.fail<DedicatedRuntimeRefusal>({ message, waits });

/**
 * The host ports its owner lets Sandboxes reach: `T3CODE_SANDBOX_HOST_PORTS`, and the older
 * `T3CODE_DEDICATED_HOST_PORTS` too, comma-separated.
 */
export const allowedHostPorts = Effect.gen(function* () {
  const listed = [
    Option.getOrElse(yield* optionalSetting(SANDBOX_HOST_PORTS_SETTING), () => ""),
    Option.getOrElse(yield* optionalSetting(DEDICATED_HOST_PORTS_SETTING), () => ""),
  ].join(",");
  return new Set(
    listed
      .split(",")
      .map((port) => Number.parseInt(port.trim(), 10))
      .filter(Number.isFinite),
  );
});

export const dedicatedRuntimeFromConfig = Effect.fn("dedicatedRuntimeFromConfig")(function* (
  hubUrl: string,
  options: {
    readonly recheck?: boolean;
    /** Where its homes go; a lent machine's are apart from any other runtime's on it. */
    readonly rootDir?: string;
  } = {},
) {
  const setting = Option.getOrUndefined(yield* optionalSetting(SANDBOX_RUNTIME_SETTING));
  const config = yield* ServerConfig.ServerConfig;
  const address = Layer.succeed(
    SandboxHubAddress,
    SandboxHubAddress.of({ loopbackUrl: Effect.succeed(hubUrl) }),
  );
  if (setting === "process") {
    const processRuntime = ProcessSandboxRuntime.forHub(config, options.rootDir);
    return Option.isNone(processRuntime)
      ? refused("this server has no entry point to run its Sandbox's server with.")
      : Result.succeed(processRuntime.value.pipe(Layer.provide(address)));
  }
  if (setting !== undefined && setting !== "podman") {
    return refused(
      `a dedicated machine runs its work in a Sandbox container, and ${SANDBOX_RUNTIME_SETTING}=${setting} runs none.`,
    );
  }
  const image = yield* configuredSandboxImage;
  // Asked again, Podman answers anew: what it said when this server started is not kept.
  if (options.recheck === true) podmanDetection = undefined;
  const detected = yield* detectPodman(image);
  if (!detected.rootless) {
    // On a recheck (rootless Podman was here, only the image missing) it is a slow or failed
    // `podman info`, not Podman gone: the wait goes on.
    return refused(
      "a dedicated machine runs its work in a Sandbox container, and rootless Podman is not available here.",
      options.recheck === true,
    );
  }
  if (!detected.image) {
    return refused(
      `Podman is here but the Sandbox image ${image} is not: build it (\`t3 sandbox image build\`) or set T3CODE_SANDBOX_IMAGE.`,
      true,
    );
  }
  // The container reaches every address of this machine but its loopback, and rootless Podman
  // cannot firewall that: nothing may listen there unless the Owner named it.
  const allowed = yield* allowedHostPorts;
  const exposed = hostExposureRefusal(
    // This server's own port answers only `/health`.
    listeningOutsideLoopback().filter((listener) => listener.port !== config.port),
    allowed,
  );
  if (exposed !== undefined) return refused(exposed);
  return Result.succeed(podmanForHub(config, image, options.rootDir).pipe(Layer.provide(address)));
});

/** Whether rootless Podman is here, as `t3 join --dedicated` checks before asking. */
export const rootlessPodmanHere = () => PodmanSandboxRuntime.detectRootlessPodman();

/** Why a Hub runs no Sandboxes: logged at startup, and what placement and the composer say. */
const LOOPBACK_ONLY =
  "Podman Sandboxes need the Hub to listen on loopback only (T3CODE_HOST=127.0.0.1, published through a reverse proxy or `t3 up`), since a container reaches every other address of this machine.";

/**
 * The Sandbox runtime this Hub runs, or none with why (`unavailable`, which placement and the
 * composer show). Unset, only a production Hub looks for Podman: a dev Hub or a joined machine
 * runs none.
 */
export const fromConfig = Effect.gen(function* () {
  const setting = Option.getOrUndefined(yield* optionalSetting(SANDBOX_RUNTIME_SETTING));
  const config = yield* ServerConfig.ServerConfig;
  // `turnedOff`: the Owner chose none, so Threads in Sandboxes need an environment; any other
  // reason (no image yet after an upgrade, Podman away for now) may pass, and they wait.
  const none = (unavailable: string, turnedOff = false) =>
    ({ runtime: Option.none(), unavailable, turnedOff }) as const;
  if (setting === "off") {
    return none(`Sandboxes are turned off on this Hub (${SANDBOX_RUNTIME_SETTING}=off).`, true);
  }
  if (setting !== undefined && setting !== "process" && setting !== "podman") {
    yield* Effect.logWarning(
      `Sandboxes are off: ${SANDBOX_RUNTIME_SETTING}=${setting} is not podman, process or off.`,
    );
    return none(
      `Sandboxes are off on this Hub: ${SANDBOX_RUNTIME_SETTING}=${setting} is not podman, process or off.`,
    );
  }
  // A joined machine runs no Hub Sandboxes (a dedicated one runs its own, through
  // `dedicatedRuntimeFromConfig`); unset, only a production Hub looks for Podman, not a dev Hub.
  if (config.joinedHub !== undefined) {
    return none("A joined machine runs no Sandboxes for the Hub.");
  }
  if (setting === undefined && config.devUrl !== undefined) {
    return none(
      `This development Hub runs no Sandboxes: start it with ${SANDBOX_RUNTIME_SETTING}=process (or podman).`,
    );
  }
  const hubUrl = ProcessSandboxRuntime.sandboxHubLoopbackUrl(config);
  const addressOf = (url: string) =>
    Layer.succeed(SandboxHubAddress, SandboxHubAddress.of({ loopbackUrl: Effect.succeed(url) }));
  if (setting === "process") {
    const unavailable = "Sandboxes need the Hub to listen on loopback, and this Hub does not.";
    if (hubUrl === undefined) {
      yield* Effect.logWarning("Sandboxes are off: the Hub does not listen on loopback.");
      return none(unavailable);
    }
    const runtime = Option.map(
      ProcessSandboxRuntime.forHub(config),
      Layer.provide(addressOf(hubUrl)),
    );
    return Option.isNone(runtime)
      ? none("The process Sandbox runtime needs the Hub's own entry point.")
      : { runtime, unavailable: null, turnedOff: false };
  }
  const image = yield* configuredSandboxImage;
  if (hubUrl === undefined || !hubHostAllowsPodman(config.host)) {
    // Said whenever Podman could have run them, so a Hub left on 0.0.0.0 learns why it has none.
    if (setting === "podman" || (yield* detectPodman(image)).rootless) {
      yield* Effect.logWarning(`Sandboxes are off: Podman is here, but ${LOOPBACK_ONLY}`);
      return none(LOOPBACK_ONLY);
    }
    return none(SANDBOXES_NEED_PODMAN);
  }
  const detected = yield* detectPodman(image);
  if (!detected.rootless) {
    if (setting === "podman") {
      yield* Effect.logWarning("Sandboxes are off: rootless Podman is not available here.");
    }
    return none(SANDBOXES_NEED_PODMAN);
  }
  if (setting === undefined && !detected.image) {
    yield* Effect.logInfo(
      `Sandboxes are off: Podman is here but the image ${image} is not built. Build it with \`t3 sandbox image build\` and restart the Hub.`,
    );
    return none(
      `Sandboxes need the Sandbox image ${image}, which is not built on this Hub yet: build it (Build image, or t3 sandbox image build) and restart the Hub.`,
    );
  }
  return {
    runtime: Option.some(podmanForHub(config, image).pipe(Layer.provide(addressOf(hubUrl)))),
    unavailable: null,
    turnedOff: false,
  };
});

/**
 * Whether this server's own machine runs agents. A joined machine always does. A Hub does only in
 * development: `T3CODE_HUB_RUNS_AGENTS` is honored only under the dev runner (`T3CODE_DEV_RUNNER=1`
 * with `--dev-url`), and unset there it is on without a Sandbox runtime. See sandboxes.md.
 */
const HUB_RUNS_AGENTS_SETTING = "T3CODE_HUB_RUNS_AGENTS";
/** Set by `vp run dev` (scripts/dev-runner.ts) for the servers it starts, and nothing else. */
const DEV_RUNNER_SETTING = "T3CODE_DEV_RUNNER";

export const hubRunsAgentsFromConfig = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.joinedHub !== undefined) return true;
  const setting = Option.getOrUndefined(yield* optionalSetting(HUB_RUNS_AGENTS_SETTING))
    ?.trim()
    .toLowerCase();
  const devRunner =
    config.devUrl !== undefined &&
    Option.getOrUndefined(yield* optionalSetting(DEV_RUNNER_SETTING)) === "1";
  if (!devRunner) {
    if (setting !== undefined && setting !== "" && setting !== "0" && setting !== "false") {
      yield* Effect.logError(
        `${HUB_RUNS_AGENTS_SETTING}=${setting} is ignored: only a development Hub started by \`vp run dev\` runs agents in its own process. This Hub runs none.`,
      );
    }
    return false;
  }
  if (setting === "1" || setting === "true") return true;
  if (setting === "0" || setting === "false") return false;
  if (setting !== undefined && setting !== "") {
    yield* Effect.logWarning(
      `${HUB_RUNS_AGENTS_SETTING}=${setting} is not 1, true, 0 or false: the Hub machine runs no Threads.`,
    );
    return false;
  }
  const runtime = Option.getOrUndefined(yield* optionalSetting(SANDBOX_RUNTIME_SETTING));
  return runtime !== "process" && runtime !== "podman";
});

/**
 * The Sandbox image this machine would run (`T3CODE_SANDBOX_IMAGE`, else this version's), and
 * whether it is built here, as `t3 join --dedicated` checks before asking.
 */
export const sandboxImageHere = Effect.gen(function* () {
  const image = yield* configuredSandboxImage;
  const exists = yield* PodmanSandboxRuntime.runPodman(["image", "exists", image], {
    timeoutMs: 15_000,
  });
  return { image, built: exists.exitCode === 0 };
});
